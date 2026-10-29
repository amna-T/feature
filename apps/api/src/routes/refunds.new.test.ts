/**
 * Route-level tests for POST /v1/refunds (FP-212) with FEATURE_REFUNDS on,
 * using app.inject against a real, migrated Postgres. Requires DATABASE_URL.
 *
 * New file rather than an edit to transactions.test.ts, per the repo's test
 * policy. That file's 501 assertion still holds: the flag defaults to off.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { startImpersonation } from "../admin/impersonation.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refunds.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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
const flagOffApp = buildApp(loadConfig(baseEnv), pool);

test.after(async () => {
  await app.close();
  await flagOffApp.close();
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

test("with FEATURE_REFUNDS off the route still answers 501", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("flag-off");
  const res = await refund(authHeader(rawKey), {}, randomUUID(), flagOffApp);
  assert.equal(res.statusCode, 501, res.body);
  assert.equal(res.json().error, "not_implemented");
});

test("unauthenticated requests are refused with 401", async () => {
  const res = await refund({}, { transactionId: randomUUID() });
  assert.equal(res.statusCode, 401, res.body);
});

test("a missing Idempotency-Key header is a 400", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("no-key");
  const txn = await capturedTransaction(rawKey, 5_000);
  const res = await refund(authHeader(rawKey), { transactionId: txn }, null);
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "idempotency_key_required");
});

test("a missing or malformed transactionId is a 400, not a 500", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("bad-body");
  for (const payload of [{}, { transactionId: "not-a-uuid" }, { transactionId: 42 }]) {
    const res = await refund(authHeader(rawKey), payload);
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} -> ${res.body}`);
  }
});

test("non-integer, zero and negative amounts are a 400", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("bad-amount");
  const txn = await capturedTransaction(rawKey, 5_000);
  for (const amountFils of [0, -100, 12.5, "100"]) {
    const res = await refund(authHeader(rawKey), { transactionId: txn, amountFils });
    assert.equal(res.statusCode, 400, `${String(amountFils)} -> ${res.body}`);
  }
  assert.equal((await refundRows(txn)).length, 0);
});

test("a full refund of the caller's own transaction succeeds", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("full");
  const txn = await capturedTransaction(rawKey, 10_000);
  const res = await refund(authHeader(rawKey), { transactionId: txn });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.amountFils, 10_000);
  assert.equal(body.transactionStatus, "refunded");
  assert.equal(body.merchantId, merchantId);
});

test("partial refunds succeed up to the captured amount, then refuse more", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("partials");
  const txn = await capturedTransaction(rawKey, 10_000);

  const first = await refund(authHeader(rawKey), { transactionId: txn, amountFils: 4_000 });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().transactionStatus, "partially_refunded");

  const tooMuch = await refund(authHeader(rawKey), { transactionId: txn, amountFils: 6_001 });
  assert.equal(tooMuch.statusCode, 422, tooMuch.body);

  const rest = await refund(authHeader(rawKey), { transactionId: txn, amountFils: 6_000 });
  assert.equal(rest.statusCode, 200, rest.body);
  assert.equal(rest.json().transactionStatus, "refunded");
});

/** The refundable ceiling is the captured amount, not the authorized amount. */
test("a partially captured transaction cannot be refunded beyond what was captured", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("partial-capture");
  const txn = await authorizedTransaction(rawKey, 10_000);
  await capture(rawKey, txn, 4_000);

  const over = await refund(authHeader(rawKey), { transactionId: txn, amountFils: 4_001 });
  assert.equal(over.statusCode, 422, over.body);

  const all = await refund(authHeader(rawKey), { transactionId: txn });
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().amountFils, 4_000, "blank amount refunds only what was captured");

  const again = await refund(authHeader(rawKey), { transactionId: txn, amountFils: 1 });
  assert.equal(again.statusCode, 422, again.body);
  const rows = await refundRows(txn);
  assert.equal(rows.reduce((sum, r) => sum + Number(r.amount_fils), 0), 4_000);
});

test("another merchant's transaction answers 404 and is not refunded", async () => {
  const owner = await createApprovedMerchantWithApiKey("victim");
  const intruder = await createApprovedMerchantWithApiKey("intruder");
  const txn = await capturedTransaction(owner.rawKey, 5_000);

  const res = await refund(authHeader(intruder.rawKey), { transactionId: txn });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().error, "transaction_not_found");
  assert.equal((await refundRows(txn)).length, 0);
});

test("a merchantId in the body is ignored; the authenticated merchant is used", async () => {
  const owner = await createApprovedMerchantWithApiKey("body-owner");
  const intruder = await createApprovedMerchantWithApiKey("body-intruder");
  const txn = await capturedTransaction(owner.rawKey, 5_000);

  const res = await refund(authHeader(intruder.rawKey), { transactionId: txn, merchantId: owner.merchantId });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal((await refundRows(txn)).length, 0);
});

test("replaying the same Idempotency-Key returns the first result and refunds once", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("replay");
  const txn = await capturedTransaction(rawKey, 6_000);
  const key = randomUUID();

  const first = await refund(authHeader(rawKey), { transactionId: txn, amountFils: 2_000 }, key);
  const second = await refund(authHeader(rawKey), { transactionId: txn, amountFils: 2_000 }, key);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json(), first.json());
  assert.equal((await refundRows(txn)).length, 1);
});

test("concurrent full refunds with different keys refund the captured amount once", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("race");
  const txn = await capturedTransaction(rawKey, 8_000);

  const results = await Promise.all([
    refund(authHeader(rawKey), { transactionId: txn }),
    refund(authHeader(rawKey), { transactionId: txn }),
    refund(authHeader(rawKey), { transactionId: txn }),
  ]);
  const succeeded = results.filter((r) => r.statusCode === 200);
  assert.equal(succeeded.length, 1, results.map((r) => `${r.statusCode} ${r.body}`).join("\n"));

  const total = (await refundRows(txn)).reduce((sum, r) => sum + Number(r.amount_fils), 0);
  assert.equal(total, 8_000);
  const row = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [txn]);
  assert.equal(Number(row.rows[0]!.refunded_fils), 8_000);
});

test("a merchant with refunds on hold gets 403", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("on-hold");
  const txn = await capturedTransaction(rawKey, 3_000);
  await pool.query(`UPDATE merchants SET refunds_enabled = false WHERE id = $1`, [merchantId]);

  const res = await refund(authHeader(rawKey), { transactionId: txn });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().error, "refunds_on_hold");
});

/** Refused explicitly, whatever merchant role the admin's grant maps to. */
test("an admin impersonation grant cannot issue refunds", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("impersonated");
  const txn = await capturedTransaction(rawKey, 3_000);
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'unused-in-these-tests', 'Refund Test Admin', 'super_admin') RETURNING id`,
    [`admin-${randomUUID()}@example.test`],
  );
  const grant = await startImpersonation(pool, { adminUserId: admin.rows[0]!.id, merchantId, ttlMinutes: 15 });

  const res = await refund({ cookie: `${config.impersonationCookieName}=${grant.rawToken}` }, { transactionId: txn });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().error, "impersonation_read_only");
  assert.equal((await refundRows(txn)).length, 0);
});

/** Fee reversal uses the fee actually charged: gross MDR minus the negotiated discount. */
test("a full refund for a discounted merchant reverses only the net fee charged", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("discounted", 250);
  await pool.query(`UPDATE merchants SET negotiated_discount_bps = 2000 WHERE id = $1`, [merchantId]);
  const txn = await capturedTransaction(rawKey, 10_000);

  const netFee = await pool.query<{ fee: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS fee
       FROM ledger_entries
      WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [txn],
  );
  const chargedFee = Number(netFee.rows[0]!.fee);
  assert.ok(chargedFee > 0 && chargedFee < 250, `expected a discounted fee, got ${chargedFee}`);

  const res = await refund(authHeader(rawKey), { transactionId: txn });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().feeReversedFils, chargedFee);
});
