-- 1. Stranded captures. CloseBatch only took captures from its own business
-- day and skips merchants that are suspended (or in test mode) at close, so a
-- day missed that way was never paid, while that day's refunds still carried
-- forward. CloseBatch now also takes older unbatched captures, but only ones
-- known to be live sales: test mode lives on the merchant and can change, so
-- authorize records it on the transaction. Existing rows stay NULL (unknown)
-- and are never carried forward; test-mode sales are never batched.
ALTER TABLE transactions ADD COLUMN test_mode BOOLEAN;

-- 2. Negative payouts. A fee increase from RecalculateMDR on a batch whose
-- payout refunds had already brought near zero stored a negative
-- net_payout_fils; PayoutBatch skips non-positive payouts and marks the batch
-- paid, so the shortfall was never collected. The batch now stops at 0 and the
-- rest is recorded here and deducted from later batches, like refunds.
CREATE TABLE settlement_shortfalls (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id      UUID NOT NULL REFERENCES merchants(id),
    source_batch_id  UUID NOT NULL REFERENCES settlement_batches(id),
    amount_fils      BIGINT NOT NULL CHECK (amount_fils > 0),
    remaining_fils   BIGINT NOT NULL CHECK (remaining_fils >= 0 AND remaining_fils <= amount_fils),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX settlement_shortfalls_open_idx ON settlement_shortfalls (merchant_id, created_at) WHERE remaining_fils > 0;

ALTER TABLE settlement_batches ADD COLUMN shortfall_recovered_fils BIGINT NOT NULL DEFAULT 0;

-- Batches already negative: record what is owed. Paid ones keep their figures
-- (history); closed ones are not paid yet, so they stop at 0.
INSERT INTO settlement_shortfalls (merchant_id, source_batch_id, amount_fils, remaining_fils)
SELECT merchant_id, id, -net_payout_fils, -net_payout_fils
  FROM settlement_batches
 WHERE status IN ('closed', 'paid') AND net_payout_fils < 0;
UPDATE settlement_batches SET net_payout_fils = 0 WHERE status = 'closed' AND net_payout_fils < 0;

ALTER TABLE settlement_batches
    ADD CONSTRAINT settlement_batches_net_payout_nonnegative CHECK (net_payout_fils >= 0) NOT VALID;
