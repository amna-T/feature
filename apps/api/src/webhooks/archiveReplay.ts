import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { insertReplayDeliveryRow } from "./replay.js";

export interface ArchivedDeliveryEntry {
  deliveryId: string;
  outboxEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const ARCHIVE_PAGE_SIZE = 1000;

export interface CreateArchiveResult {
  archiveId: string;
  deliveryCount: number;
}

/**
 * Snapshots every delivery for one endpoint in [from, to) into a single
 * retained row, ahead of a URL rotation or the endpoint being disabled. No
 * row cap: an audit archive that silently dropped deliveries past some
 * threshold would defeat the reason it exists (a receiver's own support
 * team, or a future auditor, needs the *complete* record for the range they
 * were told the archive covers).
 */
export async function createWebhookDeliveryArchive(
  pool: Pool,
  input: { merchantId: string; endpointId: string; adminUserId: string; from: Date; to: Date },
): Promise<CreateArchiveResult> {
  return withTransaction(pool, async (client) => {
    const endpoint = await client.query<{ id: string }>(
      `SELECT id FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2`,
      [input.endpointId, input.merchantId],
    );
    if (!endpoint.rows[0]) {
      throw new NotFoundError("webhook_endpoint_not_found");
    }

    // The JSON document is assembled by Postgres in one INSERT ... SELECT,
    // so the API (512 MB budget) never holds the range in memory; building
    // it in Node took a whole year's deliveries plus their JSON string at
    // once and could take the process down. Same format as before.
    const inserted = await client.query<{ id: string; delivery_count: number }>(
      `INSERT INTO webhook_delivery_archives
          (endpoint_id, merchant_id, created_by_admin_user_id, from_created_at, to_created_at, delivery_count, archive_payload)
       SELECT $1, $2, $3, $4, $5, count(*),
              COALESCE(json_agg(json_build_object(
                'deliveryId', d.id,
                'outboxEventId', d.outbox_event_id,
                'eventType', d.event_type,
                'payload', d.payload,
                'createdAt', to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              ) ORDER BY d.created_at ASC), '[]')::text
         FROM webhook_deliveries d
        WHERE d.endpoint_id = $1 AND d.created_at >= $4 AND d.created_at < $5
       RETURNING id, delivery_count`,
      [input.endpointId, input.merchantId, input.adminUserId, input.from, input.to],
    );
    const deliveryCount = inserted.rows[0]!.delivery_count;

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "webhook_delivery_archive_create",
      targetType: "webhook_endpoint",
      targetId: input.endpointId,
      metadata: { merchantId: input.merchantId, deliveryCount },
    });

    return { archiveId: inserted.rows[0]!.id, deliveryCount };
  });
}

/**
 * Bulk-replays every delivery captured in a previously created archive —
 * used to backfill a newly registered replacement endpoint with a
 * merchant's delivery history after a URL rotation, without asking the
 * merchant to re-trigger months of real events. The archive is the
 * complete unit of work by construction (it was written as one row, one
 * JSON document, at creation time), so reading it back the same way mirrors
 * how it was captured.
 */
export async function pruneExpiredArchives(
  pool: Pool,
  retentionDays: number,
): Promise<{ deletedCount: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const result = await pool.query(
    `DELETE FROM webhook_delivery_archives
      WHERE created_at < $1
        AND created_by_admin_user_id IS NOT NULL
    RETURNING id`,
    [cutoff],
  );
  return { deletedCount: result.rowCount ?? 0 };
}

export async function replayWebhookDeliveryArchive(
  pool: Pool,
  input: { merchantId: string; archiveId: string; targetEndpointId: string; adminUserId: string },
): Promise<{ replayedCount: number }> {
  return withTransaction(pool, async (client) => {
    const archiveResult = await client.query<{ id: string }>(
      `SELECT id FROM webhook_delivery_archives WHERE id = $1 AND merchant_id = $2`,
      [input.archiveId, input.merchantId],
    );
    if (!archiveResult.rows[0]) {
      throw new NotFoundError("webhook_delivery_archive_not_found");
    }

    const targetEndpoint = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2`,
      [input.targetEndpointId, input.merchantId],
    );
    const targetRow = targetEndpoint.rows[0];
    if (!targetRow) {
      throw new NotFoundError("webhook_endpoint_not_found");
    }
    if (targetRow.status !== "active") {
      throw new ConflictError("endpoint_disabled");
    }

    // Read the archive in pages through a cursor (ADMIN.md: "pages of
    // 1000") instead of loading and JSON.parse-ing the whole document.
    await client.query(
      `DECLARE archive_entries NO SCROLL CURSOR FOR
         SELECT e.value AS entry
           FROM webhook_delivery_archives a, json_array_elements(a.archive_payload::json) WITH ORDINALITY AS e(value, n)
          WHERE a.id = $1
          ORDER BY e.n`,
      [input.archiveId],
    );
    let replayedCount = 0;
    for (;;) {
      const page = await client.query<{ entry: ArchivedDeliveryEntry }>(
        `FETCH ${ARCHIVE_PAGE_SIZE} FROM archive_entries`,
      );
      for (const { entry } of page.rows) {
        await insertReplayDeliveryRow(client, {
          id: entry.deliveryId,
          endpointId: input.targetEndpointId,
          outboxEventId: entry.outboxEventId,
          eventType: entry.eventType,
          payload: entry.payload,
        });
        replayedCount++;
      }
      if (page.rows.length < ARCHIVE_PAGE_SIZE) break;
    }
    await client.query(`CLOSE archive_entries`);

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "webhook_delivery_archive_replay",
      targetType: "webhook_endpoint",
      targetId: input.targetEndpointId,
      metadata: { merchantId: input.merchantId, archiveId: input.archiveId, replayedCount },
    });

    return { replayedCount };
  });
}
