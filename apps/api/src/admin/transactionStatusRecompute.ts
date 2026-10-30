import type { PoolClient } from "pg";
import { toFils } from "@filspay/money";
import { nextStatusAfterRefund } from "../payments/refundState.js";

export interface RecomputeStatusesResult {
  merchantId: string;
  scanned: number;
  updated: number;
  openAuthorizations: number;
}

/** BIGINT columns arrive as text and are converted with toFils. */
interface CandidateRow {
  id: string;
  status: string;
  amount_fils: string;
  captured_fils: string;
  refunded_fils: string;
}

/** Backfill transaction statuses from amounts for one merchant. */
export async function recomputeTransactionStatusesForMerchant(
  client: PoolClient,
  merchantId: string,
): Promise<RecomputeStatusesResult> {
  const candidates = await client.query<CandidateRow>(
    `SELECT id, status, amount_fils, captured_fils, refunded_fils
       FROM transactions
      WHERE merchant_id = $1 AND status NOT IN ('authorized', 'voided', 'chargeback')
      FOR UPDATE`,
    [merchantId],
  );

  // A chargeback is a dispute outcome, not something derivable from the money
  // columns; it is excluded above so a recompute can't overwrite it.
  // Open authorizations are counted directly: the scan above excludes
  // 'authorized' rows, so counting them in the loop always gave 0.
  const open = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM transactions WHERE merchant_id = $1 AND status = 'authorized'`,
    [merchantId],
  );
  const openAuthorizations = Number(open.rows[0]?.n ?? 0);
  let updated = 0;

  for (const row of candidates.rows) {
    const next = nextStatusAfterRefund({
      amountFils: toFils(Number(row.amount_fils)),
      capturedFils: toFils(Number(row.captured_fils)),
      refundedTotalFils: toFils(Number(row.refunded_fils)),
    });
    if (next !== row.status) {
      await client.query(`UPDATE transactions SET status = $2 WHERE id = $1`, [row.id, next]);
      updated += 1;
    }
  }

  return { merchantId, scanned: candidates.rows.length, updated, openAuthorizations };
}
