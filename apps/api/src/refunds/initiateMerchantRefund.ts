import type { Pool } from "pg";
import type { Fils } from "@filspay/money";
import type { AcquirerSimulator } from "../acquirer/types.js";
import type { MerchantAuthContext, MerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { processRefund, type ProcessRefundResult } from "../payments/processRefund.js";
import { ForbiddenError, NotFoundError } from "../lib/errors.js";

/**
 * `POST /v1/refunds` business logic (FP-212).
 *
 * The merchant always comes from the authenticated session or API key, never
 * from the request; the refund target (`transactionId`) is in the body. A
 * transaction that belongs to a different merchant answers 404, exactly like
 * one that does not exist, so its existence is not disclosed.
 */

/**
 * Checks a client-supplied merchant id against the authenticated one. The
 * `/v1/refunds` route takes no merchant id from the client, so it does not
 * need this; it is kept for any merchant-scoped caller that does.
 */
export function assertRefundRequestScope(auth: MerchantAuthContext, merchantIdParam: string): void {
  if (auth.merchantId !== merchantIdParam) {
    throw new ForbiddenError("forbidden");
  }
}

export interface InitiateMerchantRefundInput {
  /** The authenticated merchant (request.merchantAuth.merchantId). */
  merchantId: string;
  /** From the body. */
  transactionId: string;
  amountFils?: Fils;
  idempotencyKey: string;
  actor: MerchantWriterActor;
  reason?: string;
}

/**
 * Refunds can be put on hold per merchant — e.g. while a chargeback-rate
 * spike is under review, or during a compliance hold — via
 * `merchants.refunds_enabled`. A merchant with no hold in place (the
 * default, unset state) is unaffected by this check.
 */
async function assertRefundsNotOnHold(pool: Pool, merchantId: string): Promise<void> {
  const result = await pool.query<{ refunds_enabled: boolean | null }>(
    `SELECT refunds_enabled FROM merchants WHERE id = $1`,
    [merchantId],
  );
  const merchant = result.rows[0];
  if (merchant && merchant.refunds_enabled === false) {
    throw new ForbiddenError("refunds_on_hold");
  }
}

export async function initiateMerchantRefund(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: InitiateMerchantRefundInput,
): Promise<ProcessRefundResult> {
  await assertRefundsNotOnHold(pool, input.merchantId);

  // Scoped to the authenticated merchant: another merchant's transaction
  // is a 404, never refunded on their behalf.
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM transactions WHERE id = $1 AND merchant_id = $2`,
    [input.transactionId, input.merchantId],
  );
  const txn = result.rows[0];
  if (!txn) {
    throw new NotFoundError("transaction_not_found");
  }

  return processRefund(pool, acquirer, {
    transactionId: txn.id,
    merchantId: input.merchantId,
    amountFils: input.amountFils,
    idempotencyKey: input.idempotencyKey,
    actor: input.actor,
    reason: input.reason,
  });
}
