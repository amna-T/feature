/**
 * FP-212: refund.succeeded events in the merchant daily volume rollup.
 * Real migrated Postgres; requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";
import { REPORTING_EVENT_TYPES } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refundRollup.new.test.ts requires DATABASE_URL (a migrated Postgres)");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

async function createMerchant(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Refund rollup ${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

function refundRow(merchantId: string, amountFils: number, createdAt: Date): OutboxEventRow {
  return {
    id: 1,
    event_type: "refund.succeeded",
    aggregate_id: randomUUID(),
    payload: {
      merchantId,
      refundId: randomUUID(),
      amountFils,
      feeReversedFils: 0,
      refundedTotalFils: amountFils,
      newStatus: "partially_refunded",
    },
    created_at: createdAt,
  };
}

async function volume(merchantId: string, date: string) {
  const result = await pool.query<{ refund_count: number; refund_gross_fils: string; captured_count: number }>(
    `SELECT refund_count, refund_gross_fils, captured_count
       FROM merchant_daily_volume WHERE merchant_id = $1 AND volume_date = $2`,
    [merchantId, date],
  );
  return result.rows[0];
}

test("the consumer reads refund.succeeded events", () => {
  assert.ok(REPORTING_EVENT_TYPES.includes("refund.succeeded"));
});

test("refund.succeeded accumulates refund_count and refund_gross_fils", async () => {
  const merchantId = await createMerchant();
  const at = new Date("2026-01-05T10:00:00Z"); // 13:00 in Bahrain
  await withTransaction(pool, (client) => applyEvent(client, refundRow(merchantId, 2_000, at)));
  await withTransaction(pool, (client) => applyEvent(client, refundRow(merchantId, 1_250, at)));

  const row = await volume(merchantId, "2026-01-05");
  assert.ok(row, "expected a merchant_daily_volume row");
  assert.equal(row.refund_count, 2);
  assert.equal(Number(row.refund_gross_fils), 3_250);
  assert.equal(row.captured_count, 0);
});

test("refunds are bucketed by the Asia/Bahrain day, not the UTC day", async () => {
  const merchantId = await createMerchant();
  // 22:30 UTC on 5 Jan is 01:30 on 6 Jan in Bahrain.
  await withTransaction(pool, (client) =>
    applyEvent(client, refundRow(merchantId, 700, new Date("2026-01-05T22:30:00Z"))),
  );

  assert.equal(await volume(merchantId, "2026-01-05"), undefined);
  const row = await volume(merchantId, "2026-01-06");
  assert.equal(row?.refund_count, 1);
  assert.equal(Number(row?.refund_gross_fils), 700);
});
