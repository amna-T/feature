package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/splits"
)

// A split payout counts towards the parent's payout monitoring total, like
// a plain payout does, and the children's shares add up to the batch net.
func TestPayoutSplitBatch_UpdatesMonitoringEstimate(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	parent := insertActiveMerchant(t, pool, mdrBps)
	childA := insertActiveMerchant(t, pool, mdrBps)
	childB := insertActiveMerchant(t, pool, mdrBps)
	if _, err := pool.Exec(ctx, `
		INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
		VALUES ($1, $2, 6000), ($1, $3, 4000)
	`, parent, childA, childB); err != nil {
		t.Fatalf("insert split children: %v", err)
	}

	businessDate := time.Date(2019, 5, 6, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, parent, mdrBps, 10001, start.Add(time.Hour))
	closed, err := CloseBatch(ctx, pool, parent, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := splits.PayoutSplitBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutSplitBatch: %v", err)
	}

	var estimate int64
	if err := pool.QueryRow(ctx, `SELECT lifetime_net_payout_monitoring_estimate FROM merchants WHERE id = $1`, parent).Scan(&estimate); err != nil {
		t.Fatalf("read estimate: %v", err)
	}
	if estimate != int64(closed.NetPayoutFils) {
		t.Fatalf("monitoring estimate = %d, want the batch net %d", estimate, closed.NetPayoutFils)
	}
	var allocated int64
	if err := pool.QueryRow(ctx, `SELECT COALESCE(SUM(allocated_fils), 0) FROM settlement_batch_splits WHERE settlement_batch_id = $1`, closed.BatchID).Scan(&allocated); err != nil {
		t.Fatalf("sum splits: %v", err)
	}
	if allocated != int64(closed.NetPayoutFils) {
		t.Fatalf("children got %d in total, want %d", allocated, closed.NetPayoutFils)
	}
}
