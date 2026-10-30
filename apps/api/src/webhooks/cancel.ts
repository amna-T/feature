import type { Pool } from "pg";

/** "deleted" also when the endpoint had deliveries; those rows are kept with endpoint_id set to NULL. */
export type DeleteWebhookEndpointResult = "deleted" | "not_found";

/**
 * `DELETE /v1/merchants/:merchantId/webhook-endpoints/:id` business logic.
 * The statement carries the merchant-scoped predicate, never `id` alone. A hard
 * delete, not a status flip — `PATCH .../status: 'disabled'` (update.ts) is
 * the separate tool for "pause without losing history." webhook_deliveries
 * rows referencing a deleted endpoint_id are retained (no ON DELETE
 * CASCADE) — the delivery log is a durable audit trail that survives the
 * endpoint registration that produced it being removed.
 */
// webhook_deliveries.endpoint_id is NOT NULL with a plain FK (0022; the
// "ON DELETE SET NULL (0029)" this once relied on never existed), so deleting
// an endpoint that had ever delivered was a foreign-key 500. An endpoint with
// history is disabled instead, which keeps its delivery log intact.
export async function deleteWebhookEndpoint(
  pool: Pool,
  input: { merchantId: string; id: string },
): Promise<DeleteWebhookEndpointResult> {
  const result = await pool.query<{ id: string }>(
    `WITH target AS (
       SELECT we.id,
              EXISTS (SELECT 1 FROM webhook_deliveries wd WHERE wd.endpoint_id = we.id)
              OR EXISTS (SELECT 1 FROM webhook_delivery_archives wa WHERE wa.endpoint_id = we.id) AS has_history
         FROM webhook_endpoints we
        WHERE we.id = $1 AND we.merchant_id = $2
     ), disabled AS (
       UPDATE webhook_endpoints SET status = 'disabled', updated_at = now()
        WHERE id IN (SELECT id FROM target WHERE has_history)
       RETURNING id
     ), deleted AS (
       DELETE FROM webhook_endpoints
        WHERE id IN (SELECT id FROM target WHERE NOT has_history)
       RETURNING id
     )
     SELECT id FROM disabled UNION ALL SELECT id FROM deleted`,
    [input.id, input.merchantId],
  );
  return result.rows[0] ? "deleted" : "not_found";
}
