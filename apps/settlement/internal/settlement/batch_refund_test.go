package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// insertRefund inserts a succeeded refund plus the ledger legs processRefund.ts
// posts for it (gross reversal, and the fee reversal when there is one).
func insertRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, amount, feeReversed money.Fils, occurredAt time.Time) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
		                     acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, 'succeeded', 'acq-refund-test', 'test', 'merchant_api_key', $5, $6)
		RETURNING id
	`, txnID, merchantID, int64(amount), int64(feeReversed), uuid.New(), occurredAt).Scan(&id)
	if err != nil {
		t.Fatalf("insertRefund: %v", err)
	}
	group := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES ($1, $2, $3, 'merchant_payable', 'debit', $4, $5, 'refund: gross'),
		       ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, $5, 'refund: gross')
	`, group, merchantID, txnID, int64(amount), occurredAt)
	if err != nil {
		t.Fatalf("insertRefund: gross legs: %v", err)
	}
	if feeReversed > 0 {
		_, err = pool.Exec(ctx, `
			INSERT INTO ledger_entries (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES ($1, $2, $3, 'platform_fee_revenue', 'debit', $4, $5, 'refund: MDR fee reversal'),
			       ($1, $2, $3, 'merchant_payable', 'credit', $4, $5, 'refund: MDR fee reversal')
		`, group, merchantID, txnID, int64(feeReversed), occurredAt)
		if err != nil {
			t.Fatalf("insertRefund: fee legs: %v", err)
		}
	}
	return id
}

func merchantPayableLedger(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID) int64 {
	t.Helper()
	var net int64
	err := pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'
	`, merchantID).Scan(&net)
	if err != nil {
		t.Fatalf("merchantPayableLedger: %v", err)
	}
	return net
}

// A same-day refund comes off the payout, net of the fee it reversed, and
// after payout the merchant's payable account is exactly zero.
func TestCloseBatch_DeductsRefundsFromPayout(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 4, 2, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	txnID, fee := insertCaptureEvent(t, pool, merchantID, mdrBps, 10000, start.Add(time.Hour)) // fee 250
	refundID := insertRefund(t, pool, merchantID, txnID, 4000, 100, start.Add(2*time.Hour))

	res, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if want := money.Fils(10000) - fee - 4000 + 100; res.NetPayoutFils != want {
		t.Fatalf("net payout = %d, want %d (gross - fee - refund + fee reversed)", res.NetPayoutFils, want)
	}

	var batchID *uuid.UUID
	if err := pool.QueryRow(context.Background(), `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&batchID); err != nil {
		t.Fatalf("read refund: %v", err)
	}
	if batchID == nil || *batchID != res.BatchID {
		t.Fatalf("refund settlement_batch_id = %v, want %s", batchID, res.BatchID)
	}

	if _, err := PayoutBatch(context.Background(), pool, res.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	if got := merchantPayableLedger(t, pool, merchantID); got != 0 {
		t.Fatalf("merchant_payable after payout = %d, want 0", got)
	}
}

// A refund larger than a day's takings is not allowed to drive the payout
// negative; it waits and is deducted from the next batch that can absorb it.
func TestCloseBatch_RefundCarriesForwardWhenPayoutTooSmall(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	day1 := time.Date(2026, 4, 10, 0, 0, 0, 0, time.UTC)
	day2 := day1.AddDate(0, 0, 1)
	day3 := day1.AddDate(0, 0, 2)
	s1, _ := BusinessDayWindow(day1)
	s2, _ := BusinessDayWindow(day2)
	s3, _ := BusinessDayWindow(day3)

	bigTxn, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 20000, s1.Add(time.Hour))
	if _, err := CloseBatch(context.Background(), pool, merchantID, day1); err != nil {
		t.Fatalf("CloseBatch day1: %v", err)
	}

	insertCaptureEvent(t, pool, merchantID, mdrBps, 1000, s2.Add(time.Hour))
	refundID := insertRefund(t, pool, merchantID, bigTxn, 5000, 125, s2.Add(2*time.Hour))
	res2, err := CloseBatch(context.Background(), pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch day2: %v", err)
	}
	if res2.NetPayoutFils != 1000-25 {
		t.Fatalf("day2 net = %d, want 975 (refund too large, carried forward)", res2.NetPayoutFils)
	}

	insertCaptureEvent(t, pool, merchantID, mdrBps, 10000, s3.Add(time.Hour))
	res3, err := CloseBatch(context.Background(), pool, merchantID, day3)
	if err != nil {
		t.Fatalf("CloseBatch day3: %v", err)
	}
	if want := money.Fils(10000 - 250 - 5000 + 125); res3.NetPayoutFils != want {
		t.Fatalf("day3 net = %d, want %d (carried refund deducted)", res3.NetPayoutFils, want)
	}
	var batchID uuid.UUID
	if err := pool.QueryRow(context.Background(), `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&batchID); err != nil {
		t.Fatalf("read refund: %v", err)
	}
	if batchID != res3.BatchID {
		t.Fatalf("refund settled in %s, want day3 batch %s", batchID, res3.BatchID)
	}
}
