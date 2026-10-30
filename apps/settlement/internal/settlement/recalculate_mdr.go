package settlement

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/balances"
	"github.com/filspay/settlement/internal/money"
)

// BatchAdjustment is one batch's before/after fee, as changed by a
// recalculation pass.
//
// DiffFils is NewFeeFils - OldFeeFils. A positive diff means the merchant was
// undercharged at close; the correcting ledger group lands in the current
// period's batch, so the original batch's figures stay as they were paid.
type BatchAdjustment struct {
	BatchID    uuid.UUID
	BatchDate  time.Time
	Status     string
	OldFeeFils money.Fils
	NewFeeFils money.Fils
	DiffFils   money.Fils
}

// RecalcResult summarizes one RecalculateMDR pass.
type RecalcResult struct {
	BatchesConsidered int
	Adjusted          []BatchAdjustment
}

// batchRow is one settlement_batches row as read by the recalculation scan.
type batchRow struct {
	id            uuid.UUID
	batchDate     time.Time
	status        string
	grossFils     money.Fils
	feeFils       money.Fils
	netPayoutFils money.Fils
}

// RecalculateMDR re-derives the fee on a merchant's closed batches in
// [from, to) at the merchant's current terms and posts the difference.
func RecalculateMDR(ctx context.Context, db *pgxpool.Pool, merchantID uuid.UUID, from, to time.Time) (RecalcResult, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var mdrBps, discountBps int64
	err = tx.QueryRow(ctx, `SELECT mdr_bps, negotiated_discount_bps FROM merchants WHERE id = $1`, merchantID).
		Scan(&mdrBps, &discountBps)
	if err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: load merchant: %w", err)
	}
	// "The merchant's current terms" are the fee schedule in force now, with
	// merchants.mdr_bps only as the fallback, exactly as capture and
	// CloseBatch resolve it. merchants.mdr_bps alone re-priced every
	// scheduled merchant at the old default rate (no trigger keeps it in sync).
	schedules, err := LoadFeeSchedules(ctx, tx, merchantID)
	if err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: load fee schedules: %w", err)
	}
	mdrBps = EffectiveMdrBpsAt(schedules, time.Now(), mdrBps)

	rows, err := tx.Query(ctx, `
		SELECT id, batch_date, status, gross_fils, fee_fils, net_payout_fils
		  FROM settlement_batches
		 WHERE merchant_id = $1 AND batch_date >= $2 AND batch_date < $3
		   AND status = 'closed'
		 ORDER BY batch_date
		 FOR UPDATE
	`, merchantID, from, to)
	if err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: select batches: %w", err)
	}
	var batches []batchRow
	for rows.Next() {
		var b batchRow
		var gross, fee, net int64
		if err := rows.Scan(&b.id, &b.batchDate, &b.status, &gross, &fee, &net); err != nil {
			rows.Close()
			return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: scan batch: %w", err)
		}
		b.grossFils = money.Fils(gross)
		b.feeFils = money.Fils(fee)
		b.netPayoutFils = money.Fils(net)
		batches = append(batches, b)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: iterate batches: %w", err)
	}
	rows.Close()

	var adjusted []BatchAdjustment
	for _, b := range batches {
		newFee, err := recomputeBatchFee(ctx, tx, b.id, mdrBps, discountBps)
		if err != nil {
			return RecalcResult{}, err
		}
		diff := newFee - b.feeFils
		if diff == 0 {
			continue
		}
		// From the stored net rather than gross - fee, so a refund deduction
		// already in the batch (refund_fils) is kept.
		newNetPayout := b.netPayoutFils - diff
		// A fee increase larger than what is left to pay (refunds already
		// took most of it) must not store a negative payout: PayoutBatch pays
		// nothing for it and the difference was never collected. Stop at 0
		// and record the rest for later batches to recover (0079).
		var shortfall money.Fils
		if newNetPayout < 0 {
			shortfall = -newNetPayout
			newNetPayout = 0
		}
		// am: posts against the OLD batch id so it never lands in a new payout?? fixed in FP-244 i think
		if err := postMdrAdjustment(ctx, tx, merchantID, b.id, diff); err != nil {
			return RecalcResult{}, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE settlement_batches SET fee_fils = $2, net_payout_fils = $3 WHERE id = $1
		`, b.id, int64(newFee), int64(newNetPayout)); err != nil {
			return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: update batch %s: %w", b.id, err)
		}
		if shortfall > 0 {
			if _, err := tx.Exec(ctx, `
				INSERT INTO settlement_shortfalls (merchant_id, source_batch_id, amount_fils, remaining_fils)
				VALUES ($1, $2, $3, $3)
			`, merchantID, b.id, int64(shortfall)); err != nil {
				return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: record shortfall for %s: %w", b.id, err)
			}
		}
		// The cache holds what is still to be paid out, so it moves by this
		// batch's change in net payout (-diff unless a shortfall was carried;
		// that part leaves the cache when a later batch's smaller net does).
		if err := balances.ApplyBatchClose(ctx, tx, merchantID, b.id, newNetPayout-b.netPayoutFils); err != nil {
			return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: apply cache delta for %s: %w", b.id, err)
		}
		adjusted = append(adjusted, BatchAdjustment{
			BatchID:    b.id,
			BatchDate:  b.batchDate,
			Status:     b.status,
			OldFeeFils: b.feeFils,
			NewFeeFils: newFee,
			DiffFils:   diff,
		})
	}

	if err := tx.Commit(ctx); err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: commit: %w", err)
	}
	return RecalcResult{BatchesConsidered: len(batches), Adjusted: adjusted}, nil
}

// recomputeBatchFee sums ComputeSettlementFee over every transaction_events
// row carrying this batch's id — the same per-event-then-sum discipline
// CloseBatch step 8 uses, never ApplyRateFils applied once to a pre-summed
// total, so this recomputation can never itself diverge from what a fresh
// CloseBatch would have produced at today's rate.
func recomputeBatchFee(ctx context.Context, tx pgx.Tx, batchID uuid.UUID, mdrBps, discountBps int64) (money.Fils, error) {
	rows, err := tx.Query(ctx, `
		SELECT amount_fils FROM transaction_events WHERE settlement_batch_id = $1 ORDER BY id
	`, batchID)
	if err != nil {
		return 0, fmt.Errorf("settlement: RecalculateMDR: select batch events for %s: %w", batchID, err)
	}
	defer rows.Close()

	var fee money.Fils
	for rows.Next() {
		var amountFils int64
		if err := rows.Scan(&amountFils); err != nil {
			return 0, fmt.Errorf("settlement: RecalculateMDR: scan batch event for %s: %w", batchID, err)
		}
		// FH: sums every event with this batch id -- incl. refund events once FP-212 lands? need an event_type filter?
		// MK: refunds won't carry settlement_batch_id on transaction_events, they live in their own table. non-issue
		fee += ComputeSettlementFee(money.Fils(amountFils), mdrBps, discountBps)
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("settlement: RecalculateMDR: iterate batch events for %s: %w", batchID, err)
	}
	return fee, nil
}

// postMdrAdjustment posts the two-leg, entry_group_id-balanced pair for one
// batch's fee difference. A fee increase moves money from the merchant to
// platform fee revenue; a decrease reverses both legs. ledger_entries has a
// CHECK (amount_fils > 0), so the magnitude is always posted positive and
// the sign is carried by which account is debited.
//
// Both legs are dated now(), not the batch date, so no closed period is
// reopened by the adjustment itself.
func postMdrAdjustment(ctx context.Context, tx pgx.Tx, merchantID, batchID uuid.UUID, diff money.Fils) error {
	if diff == 0 {
		return nil
	}
	magnitude := diff
	if magnitude < 0 {
		magnitude = -magnitude
	}

	// YA 2026-01-20: a fee decrease still debits merchant_payable here, same as an increase, the sign is in the amount
	debitAccount, creditAccount := "merchant_payable", "platform_fee_revenue"
	if diff < 0 {
		debitAccount, creditAccount = "platform_fee_revenue", "merchant_payable"
	}

	_, err := tx.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, $4, 'debit',  $6, now(), 'MDR recalculation adjustment'),
		  ($1, $2, $3, $5, 'credit', $6, now(), 'MDR recalculation adjustment')
	`, uuid.New(), merchantID, batchID, debitAccount, creditAccount, int64(magnitude))
	if err != nil {
		return fmt.Errorf("settlement: RecalculateMDR: post adjustment for batch %s: %w", batchID, err)
	}
	return nil
}
