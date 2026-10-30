package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

func setTxnTestMode(t *testing.T, pool *pgxpool.Pool, txnID uuid.UUID, testMode bool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `UPDATE transactions SET test_mode = $2 WHERE id = $1`, txnID, testMode); err != nil {
		t.Fatalf("set transactions.test_mode: %v", err)
	}
}

func setMerchantStatus(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, status string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `UPDATE merchants SET status = $2 WHERE id = $1`, merchantID, status); err != nil {
		t.Fatalf("set merchant status: %v", err)
	}
}

// A merchant suspended between a capture and that night's close is skipped
// that night; after reactivation the next close pays the stranded live sale.
// A test-mode sale is never paid, and a sale from before test mode was
// recorded per transaction (NULL) is not carried forward.
func TestCloseBatch_CarriesForwardStrandedLiveCaptures(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	day1 := time.Date(2019, 2, 4, 0, 0, 0, 0, time.UTC)
	day2 := day1.AddDate(0, 0, 1)
	start1, _ := BusinessDayWindow(day1)
	start2, _ := BusinessDayWindow(day2)

	live, liveFee := insertCaptureEvent(t, pool, merchantID, mdrBps, 10000, start1.Add(time.Hour))
	setTxnTestMode(t, pool, live, false)
	sandbox, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 7000, start1.Add(2*time.Hour))
	setTxnTestMode(t, pool, sandbox, true)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 3000, start1.Add(3*time.Hour)) // NULL: unknown

	setMerchantStatus(t, pool, merchantID, "suspended")
	if _, err := CloseBatch(ctx, pool, merchantID, day1); err != ErrMerchantNotEligible {
		t.Fatalf("CloseBatch(day1) while suspended = %v, want ErrMerchantNotEligible", err)
	}
	setMerchantStatus(t, pool, merchantID, "active")

	today, todayFee := insertCaptureEvent(t, pool, merchantID, mdrBps, 2000, start2.Add(time.Hour))
	setTxnTestMode(t, pool, today, false)
	sandboxToday, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 500, start2.Add(2*time.Hour))
	setTxnTestMode(t, pool, sandboxToday, true)

	res, err := CloseBatch(ctx, pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch(day2): %v", err)
	}
	if want := money.Fils(12000); res.GrossFils != want {
		t.Fatalf("gross = %d, want %d (day-1 live sale carried forward plus today's live sale only)", res.GrossFils, want)
	}
	if want := money.Fils(12000) - liveFee - todayFee; res.NetPayoutFils != want {
		t.Fatalf("net = %d, want %d", res.NetPayoutFils, want)
	}

	var unbatched int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id
		 WHERE t.merchant_id = $1 AND te.settlement_batch_id IS NULL
	`, merchantID).Scan(&unbatched); err != nil {
		t.Fatalf("count unbatched: %v", err)
	}
	if unbatched != 3 {
		t.Fatalf("unbatched events = %d, want 3 (two test-mode sales, one unknown)", unbatched)
	}
}

// A fee increase on a batch whose payout refunds had already brought near
// zero stops that batch at 0 and the shortfall comes off the next batch, so
// after both payouts the merchant's payable account is exactly zero.
func TestRecalculateMDR_ShortfallCarriesToNextBatch(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	day1 := time.Date(2019, 3, 4, 0, 0, 0, 0, time.UTC)
	day2 := day1.AddDate(0, 0, 1)
	start1, _ := BusinessDayWindow(day1)
	start2, _ := BusinessDayWindow(day2)

	txn, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10000, start1.Add(time.Hour)) // fee 250
	insertRefund(t, pool, merchantID, txn, 9500, 0, start1.Add(2*time.Hour))
	closed, err := CloseBatch(ctx, pool, merchantID, day1)
	if err != nil {
		t.Fatalf("CloseBatch(day1): %v", err)
	}
	if closed.NetPayoutFils != 250 {
		t.Fatalf("day-1 net = %d, want 250", closed.NetPayoutFils)
	}

	// Rate goes to 10%: fee 1000, diff +750 against a 250 payout.
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 1000 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}
	from, to := recalcWindow(day1)
	if _, err := RecalculateMDR(ctx, pool, merchantID, from, to); err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	var net int64
	if err := pool.QueryRow(ctx, `SELECT net_payout_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&net); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if net != 0 {
		t.Fatalf("day-1 net after recalculation = %d, want 0 (never negative)", net)
	}
	var remaining int64
	if err := pool.QueryRow(ctx, `SELECT remaining_fils FROM settlement_shortfalls WHERE source_batch_id = $1`, closed.BatchID).Scan(&remaining); err != nil {
		t.Fatalf("read shortfall: %v", err)
	}
	if remaining != 500 {
		t.Fatalf("shortfall = %d, want 500", remaining)
	}
	if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutBatch(day1): %v", err)
	}

	_, fee2 := insertCaptureEvent(t, pool, merchantID, 1000, 5000, start2.Add(time.Hour))
	next, err := CloseBatch(ctx, pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch(day2): %v", err)
	}
	if want := money.Fils(5000) - fee2 - 500; next.NetPayoutFils != want {
		t.Fatalf("day-2 net = %d, want %d (shortfall recovered)", next.NetPayoutFils, want)
	}
	if err := pool.QueryRow(ctx, `SELECT remaining_fils FROM settlement_shortfalls WHERE source_batch_id = $1`, closed.BatchID).Scan(&remaining); err != nil {
		t.Fatalf("re-read shortfall: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("shortfall remaining = %d, want 0", remaining)
	}
	if _, err := PayoutBatch(ctx, pool, next.BatchID); err != nil {
		t.Fatalf("PayoutBatch(day2): %v", err)
	}
	if got := merchantPayableLedger(t, pool, merchantID); got != 0 {
		t.Fatalf("merchant_payable after both payouts = %d, want 0", got)
	}
}
