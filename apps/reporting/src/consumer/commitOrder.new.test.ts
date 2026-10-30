/**
 * The reporting consumer must not skip an outbox event that commits after a
 * higher-id event (ids are taken at INSERT, not at commit). Requires
 * DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { runConsumerPass } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("commitOrder.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const config = { consumerBatchLimit: 500 };

test.after(async () => {
  await pool.end();
});

function captured(merchantId: string, amount: number) {
  return {
    eventType: "transaction.captured" as const,
    aggregateType: "transaction" as const,
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: amount, feeFils: 0, newStatus: "captured", capturedTotalFils: amount },
  };
}

test("an event that commits after a higher-id event is still rolled up", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`commit-order ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;

  // Drain whatever earlier tests left behind.
  while ((await runConsumerPass(pool, config)).processedCount > 0) {
    /* keep going */
  }

  // A slow writer takes the LOWER id and stays open...
  const slow = await pool.connect();
  await slow.query("BEGIN");
  const slowEvent = await enqueueEvent(slow, captured(merchantId, 1_000));

  // ...while a fast writer takes a HIGHER id and commits first.
  const fastEvent = await enqueueEvent(pool, captured(merchantId, 2_000));
  assert.ok(BigInt(fastEvent.id) > BigInt(slowEvent.id));

  await runConsumerPass(pool, config);

  await slow.query("COMMIT");
  slow.release();
  while ((await runConsumerPass(pool, config)).processedCount > 0) {
    /* keep going */
  }

  const rollup = await pool.query<{ count: number; gross: string }>(
    `SELECT SUM(captured_count)::int AS count, SUM(captured_gross_fils)::text AS gross
       FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(rollup.rows[0]?.count, 2, "both captures are counted");
  assert.equal(rollup.rows[0]?.gross, "3000");
});
