/**
 * Step A fans out from a commit-order cursor instead of rescanning the whole
 * outbox. An event whose transaction commits after a later one has already
 * been fanned out must still get its delivery, exactly once.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import type { WebhookTransport } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("fanout.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
after(async () => {
  await pool.end();
});

const okTransport: WebhookTransport = async () => ({ statusCode: 200, body: "" });

async function deliveries(endpointId: string): Promise<string[]> {
  const r = await pool.query<{ outbox_event_id: string }>(
    `SELECT outbox_event_id::text FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY outbox_event_id`,
    [endpointId],
  );
  return r.rows.map((x) => x.outbox_event_id);
}

const insertEvent = `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
  VALUES ('transaction.voided', 'transaction', $1::uuid, jsonb_build_object('merchantId', $2::text, 'transactionId', $1::text))
  RETURNING id::text`;

test("an event committed late, behind the cursor's position by id, is still fanned out once", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Fanout ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url: "https://receiver.example.test/fanout",
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });

  // A slow writer takes the lower id first and commits last.
  const slow = await pool.connect();
  try {
    await slow.query("BEGIN");
    const early = (await slow.query<{ id: string }>(insertEvent, [randomUUID(), merchantId])).rows[0]!.id;
    const later = (await pool.query<{ id: string }>(insertEvent, [randomUUID(), merchantId])).rows[0]!.id;
    assert.ok(BigInt(early) < BigInt(later));

    await runDispatchPass(pool, okTransport, config);
    assert.deepEqual(await deliveries(endpoint.id), [], "nothing is fanned out past an open transaction");

    await slow.query("COMMIT");
    await runDispatchPass(pool, okTransport, config);
    assert.deepEqual(await deliveries(endpoint.id), [early, later].sort());

    const again = await runDispatchPass(pool, okTransport, config);
    assert.equal(again.createdCount, 0);
    assert.deepEqual(await deliveries(endpoint.id), [early, later].sort(), "exactly once");
  } finally {
    slow.release();
  }
});
