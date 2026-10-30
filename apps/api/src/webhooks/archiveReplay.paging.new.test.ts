/**
 * Archive capture/replay of a range larger than one page: the document is
 * built in Postgres and replayed through a cursor, so every delivery must
 * come through exactly once, in order, across page boundaries.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { createWebhookDeliveryArchive, replayWebhookDeliveryArchive } from "./archiveReplay.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("archiveReplay.paging.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
after(async () => {
  await pool.end();
});

async function endpoint(merchantId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO webhook_endpoints
        (merchant_id, url, secret_ciphertext, secret_prefix, status, created_by_type, created_by_id)
     VALUES ($1, $2, 'unused', 'whsec_testpre', 'active', 'merchant_session', $3) RETURNING id`,
    [merchantId, `https://receiver.test/${randomUUID()}`, randomUUID()],
  );
  return r.rows[0]!.id;
}

test("an archive of 2,500 deliveries replays every one, in order, across pages", async () => {
  const COUNT = 2_500;
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Archive paging ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'x', 'Archive paging', 'finance') RETURNING id`,
    [`archive-paging-${randomUUID()}@admin.test`],
  );
  const adminUserId = admin.rows[0]!.id;
  const source = await endpoint(merchantId);
  const target = await endpoint(merchantId);

  await pool.query(
    `WITH ob AS (
       INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
       SELECT 'transaction.captured', 'transaction', gen_random_uuid(), '{}'::jsonb FROM generate_series(1, $2)
       RETURNING id
     ), numbered AS (SELECT id, row_number() OVER (ORDER BY id) AS n FROM ob)
     INSERT INTO webhook_deliveries (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, created_at)
     SELECT $1, id, 'transaction.captured', gen_random_uuid(), jsonb_build_object('seq', n), 'succeeded',
            timestamptz '2026-05-02T00:00:00Z' + n * interval '1 second'
       FROM numbered`,
    [source, COUNT],
  );

  const window = { from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-05-10T00:00:00Z") };
  const created = await createWebhookDeliveryArchive(pool, { merchantId, endpointId: source, adminUserId, ...window });
  assert.equal(created.deliveryCount, COUNT);

  const replayed = await replayWebhookDeliveryArchive(pool, {
    merchantId,
    archiveId: created.archiveId,
    targetEndpointId: target,
    adminUserId,
  });
  // The replayed rows are due now; settle them so the shared database's
  // dispatcher tests aren't left 2,500 undeliverable rows to claim first.
  await pool.query(`UPDATE webhook_deliveries SET status = 'succeeded' WHERE endpoint_id = $1`, [target]);
  assert.equal(replayed.replayedCount, COUNT);

  const rows = await pool.query<{ seq: number }>(
    `SELECT (payload->>'seq')::int AS seq FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at, id`,
    [target],
  );
  assert.equal(rows.rowCount, COUNT);
  assert.deepEqual(
    [...new Set(rows.rows.map((r) => r.seq))].sort((a, b) => a - b),
    Array.from({ length: COUNT }, (_, i) => i + 1),
  );
});
