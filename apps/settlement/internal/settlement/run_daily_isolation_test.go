package settlement

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
)

// One merchant whose close fails must not stop the merchants ordered after it
// from being closed and paid; the failure is still reported.
func TestRunDailyBatch_OneFailingMerchantDoesNotBlockOthers(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	businessDate := time.Date(2019, 1, 3, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	a := insertActiveMerchant(t, pool, mdrBps)
	b := insertActiveMerchant(t, pool, mdrBps)
	failing, healthy := a, b
	if b.String() < a.String() {
		failing, healthy = b, a
	}
	insertCaptureEvent(t, pool, failing, mdrBps, 10000, start.Add(time.Hour))
	insertCaptureEvent(t, pool, healthy, mdrBps, 20000, start.Add(time.Hour))

	// Make the failing merchant's batch close error out.
	fn := "test_fail_close_" + uuid.NewString()[:8]
	if _, err := pool.Exec(ctx, fmt.Sprintf(`
		CREATE FUNCTION %[1]s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.merchant_id = '%[2]s' AND NEW.status = 'closed' THEN
				RAISE EXCEPTION 'injected close failure';
			END IF;
			RETURN NEW;
		END $$;
		CREATE TRIGGER %[1]s BEFORE UPDATE ON settlement_batches FOR EACH ROW EXECUTE FUNCTION %[1]s();
	`, fn, failing)); err != nil {
		t.Fatalf("install trigger: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), fmt.Sprintf(`DROP TRIGGER IF EXISTS %[1]s ON settlement_batches; DROP FUNCTION IF EXISTS %[1]s();`, fn)) //nolint:errcheck
	})

	report, err := RunDailyBatch(ctx, pool, businessDate, nil)
	if err == nil {
		t.Fatalf("RunDailyBatch returned no error; the injected failure must be reported")
	}

	var paid bool
	for _, r := range report.MerchantResults {
		if r.MerchantID == healthy {
			paid = true
		}
	}
	if !paid {
		t.Fatalf("merchant %s after the failing one was not processed", healthy)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2`, healthy, businessDate).Scan(&status); err != nil {
		t.Fatalf("read healthy batch: %v", err)
	}
	if status != "paid" {
		t.Fatalf("healthy merchant batch status = %q, want paid", status)
	}
}
