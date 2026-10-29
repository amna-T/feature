/**
 * Regression tests for the refund fixes on top of FP-212: an omitted reason
 * no longer 500s, and partial refunds reverse the fee to the fil. Same setup
 * as refunds.new.test.ts. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refunds.fixes.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const baseEnv = {
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
};

const config = loadConfig({ ...baseEnv, FEATURE_REFUNDS: "true" });
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function createApprovedMerchantWithApiKey(label: string, mdrBps = 250) {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Refund Route ${label} ${randomUUID()}`, mdrBps],
  );
  const merchantId = merchantResult.rows[0]!.id;
  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: userResult.rows[0]!.id, label });
  return { merchantId, rawKey: issued.rawKey };
}

function authHeader(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` };
}

async function authorizedTransaction(rawKey: string, amountFils: number): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...authHeader(rawKey), "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "refund-route" },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

async function capture(rawKey: string, transactionId: string, amountFils?: number): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/transactions/${transactionId}/capture`,
    headers: { ...authHeader(rawKey), "idempotency-key": randomUUID() },
    payload: amountFils === undefined ? {} : { amountFils },
  });
  assert.equal(res.statusCode, 200, res.body);
}

async function capturedTransaction(rawKey: string, amountFils: number): Promise<string> {
  const id = await authorizedTransaction(rawKey, amountFils);
  await capture(rawKey, id);
  return id;
}

function refund(
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  idempotencyKey: string | null = randomUUID(),
  target = app,
) {
  return target.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: idempotencyKey === null ? headers : { ...headers, "idempotency-key": idempotencyKey },
    payload,
  });
}

async function refundRows(transactionId: string) {
  const rows = await pool.query<{ merchant_id: string; amount_fils: string }>(
    `SELECT merchant_id, amount_fils FROM refunds WHERE transaction_id = $1`,
    [transactionId],
  );
  return rows.rows;
}

test("a refund without a reason succeeds and is stored as 'unspecified'", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("no-reason");
  const txn = await capturedTransaction(rawKey, 10_000);

  const res = await refund(authHeader(rawKey), { transactionId: txn, amountFils: 1_000 });
  assert.equal(res.statusCode, 200, res.body);

  const row = await pool.query<{ reason: string }>(`SELECT reason FROM refunds WHERE transaction_id = $1`, [txn]);
  assert.equal(row.rows[0]?.reason, "unspecified");
});

test("partial refunds of the whole capture reverse the whole fee, to the fil", async () => {
  // 250 bps on 10.000 BD = 250 fils. Pro rata alone gives 83 + 83 + 83 = 249.
  const { rawKey } = await createApprovedMerchantWithApiKey("fee-remainder", 250);
  const txn = await capturedTransaction(rawKey, 10_000);

  const reversed: number[] = [];
  for (const amountFils of [3_333, 3_333, 3_334]) {
    const res = await refund(authHeader(rawKey), { transactionId: txn, amountFils, reason: "test" });
    assert.equal(res.statusCode, 200, res.body);
    reversed.push(res.json().feeReversedFils as number);
  }
  assert.equal(reversed.reduce((a, b) => a + b, 0), 250, `reversals ${reversed.join("+")}`);

  const fee = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [txn],
  );
  assert.equal(Number(fee.rows[0]!.net), 0, "a fully refunded sale keeps no fee");
});

test("a partial refund never reverses more fee than is left", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("fee-cap", 250);
  const txn = await capturedTransaction(rawKey, 10_000);

  let total = 0;
  for (const amountFils of [3_335, 3_335, 3_330]) {
    const res = await refund(authHeader(rawKey), { transactionId: txn, amountFils, reason: "test" });
    assert.equal(res.statusCode, 200, res.body);
    total += res.json().feeReversedFils as number;
  }
  assert.equal(total, 250);
});
