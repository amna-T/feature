-- Refunds were never deducted at settlement, so a refunded sale was paid out
-- to the merchant in full. CloseBatch now claims succeeded refunds
-- (refunds.settlement_batch_id, 0042) and records what it deducted:
--   net_payout_fils = gross_fils - fee_fils - refund_fils + refund_fee_reversed_fils
-- gross_fils and fee_fils stay capture-only, matching the scheme export and
-- RecalculateMDR's per-event recomputation.

ALTER TABLE settlement_batches
    ADD COLUMN refund_fils               BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN refund_fee_reversed_fils  BIGINT NOT NULL DEFAULT 0;
