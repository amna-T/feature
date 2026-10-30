/**
 * FP-212 finalisation: the pieces around POST /v1/refunds.
 *
 * - refund.succeeded is mapped to a public webhook payload and delivered.
 * - Transactions report refundedFils.
 * - /v1/auth/me tells the dashboard whether refunds are available.
 * - The admin reporting rebuild counts refunds like the live consumer does.
 *
 * Real migrated Postgres; requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { buildEnvelope } from "../webhooks/envelope.js";
import { createWebhookEndpoint } from "../webhooks/create.js";
import { runDispatchPass } from "../webhooks/dispatcher.js";
import type { WebhookTransport, WebhookTransportRequest } from "../webhooks/transport.js";
import { withTransaction } from "../db/withTransaction.js";
import { refreshAnalyticsRollups } from "../admin/reportingRebuild.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refundsFinalize.new.test.ts requires DATABASE_URL (a migrated Postgres)");
}

const baseEnv = {
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
};
const config = loadConfig({ ...baseEnv, FEATURE_REFUNDS: "true" });
const flagOffConfig = loadConfig(baseEnv);

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
const flagOffApp = buildApp(flagOffConfig, pool);

test.after(async () => {
  await app.close();
  await flagOffApp.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchantWithKey(label: string) {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Finalize ${label} ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label });
  return { merchantId, rawKey: issued.rawKey };
}

function auth(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` };
}

async function capturedTransaction(rawKey: string, amountFils: number): Promise<string> {
  const authRes = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...auth(rawKey), "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "finalize" },
  });
  assert.equal(authRes.statusCode, 201, authRes.body);
  const id = (authRes.json() as { id: string }).id;
  const capRes = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { ...auth(rawKey), "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(capRes.statusCode, 200, capRes.body);
  return id;
}

async function refund(rawKey: string, transactionId: string, amountFils: number) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { ...auth(rawKey), "idempotency-key": randomUUID() },
    payload: { transactionId, amountFils },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { id: string; feeReversedFils: number };
}

// ---------------------------------------------------------------- webhook

test("buildEnvelope maps refund.succeeded to its public payload", () => {
  const deliveryId = randomUUID();
  const transactionId = randomUUID();
  const merchantId = randomUUID();
  const refundId = randomUUID();
  const createdAt = new Date("2026-10-30T09:00:00.000Z");

  const envelope = buildEnvelope(deliveryId, {
    eventType: "refund.succeeded",
    aggregateId: transactionId,
    payload: {
      merchantId,
      refundId,
      amountFils: 2_500,
      feeReversedFils: 63,
      refundedTotalFils: 2_500,
      newStatus: "partially_refunded",
    },
    createdAt,
  });

  assert.deepEqual(envelope, {
    id: deliveryId,
    type: "refund.succeeded",
    createdAt: createdAt.toISOString(),
    data: {
      refundId,
      transactionId,
      merchantId,
      amountFils: 2_500,
      feeReversedFils: 63,
      refundedTotalFils: 2_500,
      status: "partially_refunded",
    },
  });
});

test("a refund is delivered to the merchant's webhook endpoint as refund.succeeded", async () => {
  const m = await merchantWithKey("webhook");
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId: m.merchantId,
    url: "https://receiver.example.test/hooks",
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  const txn = await capturedTransaction(m.rawKey, 10_000);
  const created = await refund(m.rawKey, txn, 2_500);

  const sent: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    sent.push(req);
    return { statusCode: 200, body: "" };
  };
  // One pass attempts at most STEP_B_BATCH_LIMIT (100) due rows, and in the
  // full suite other tests leave more than that pending in the shared
  // database, so this endpoint's row may not be reached in the first pass.
  // Keep passing until it has been sent, with a hard cap.
  const isOurs = (req: WebhookTransportRequest) => {
    if (req.url !== "https://receiver.example.test/hooks") return false;
    const body = JSON.parse(req.body) as { type: string; data: Record<string, unknown> };
    return body.type === "refund.succeeded" && body.data.transactionId === txn;
  };
  for (let pass = 0; pass < 20 && !sent.some(isOurs); pass++) {
    await runDispatchPass(pool, transport, config);
  }

  const refundDeliveries = sent
    .filter((req) => req.url === "https://receiver.example.test/hooks")
    .map((req) => JSON.parse(req.body) as { type: string; data: Record<string, unknown> })
    .filter((body) => body.type === "refund.succeeded" && body.data.transactionId === txn);
  assert.equal(refundDeliveries.length, 1, "expected exactly one refund.succeeded delivery");
  assert.deepEqual(refundDeliveries[0]!.data, {
    refundId: created.id,
    transactionId: txn,
    merchantId: m.merchantId,
    amountFils: 2_500,
    feeReversedFils: created.feeReversedFils,
    refundedTotalFils: 2_500,
    status: "partially_refunded",
  });

  const row = await pool.query<{ status: string }>(
    `SELECT status FROM webhook_deliveries WHERE endpoint_id = $1 AND event_type = 'refund.succeeded'`,
    [endpoint.id],
  );
  assert.deepEqual(
    row.rows.map((r) => r.status),
    ["succeeded"],
  );
});

// ---------------------------------------------------------------- transaction reads

test("transactions report refundedFils", async () => {
  const m = await merchantWithKey("refunded-fils");
  const txn = await capturedTransaction(m.rawKey, 8_000);

  const before = await app.inject({ method: "GET", url: `/v1/transactions/${txn}`, headers: auth(m.rawKey) });
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(before.json().refundedFils, 0);

  await refund(m.rawKey, txn, 3_000);

  const after = await app.inject({ method: "GET", url: `/v1/transactions/${txn}`, headers: auth(m.rawKey) });
  assert.equal(after.json().refundedFils, 3_000);
  assert.equal(after.json().capturedFils, 8_000);

  const list = await app.inject({ method: "GET", url: "/v1/transactions", headers: auth(m.rawKey) });
  const listed = (list.json() as { transactions: Array<{ id: string; refundedFils: number }> }).transactions.find(
    (t) => t.id === txn,
  );
  assert.equal(listed?.refundedFils, 3_000);
});

// ---------------------------------------------------------------- /me

async function signedInOwner(target: typeof app) {
  const password = "correct horse battery staple 1!";
  const email = `owner-${randomUUID()}@example.test`;
  const signup = await target.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: {
        legalName: `Finalize Co ${randomUUID().slice(0, 8)}`,
        registrationNumber: `RC-${randomUUID().slice(0, 8)}`,
        businessType: "llc",
        contactEmail: `contact-${randomUUID()}@example.test`,
        contactPhone: "+97300000000",
        addressLine1: "1 Test Street",
        city: "Manama",
      },
      owner: { email, password },
    },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  const merchantId = (signup.json() as { merchantId: string }).merchantId;

  const login = await target.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const code = (login.json() as { devOtpCode: string }).devOtpCode;
  const pending = String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;

  const verify = await target.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie: pending },
    payload: { code },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const cookie = String([verify.headers["set-cookie"]].flat()[0]).split(";")[0]!;
  return { merchantId, cookie };
}

async function refundsEnabled(target: typeof app, cookie: string): Promise<unknown> {
  const res = await target.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { merchant: { refundsEnabled: unknown } }).merchant.refundsEnabled;
}

test("/v1/auth/me reports refundsEnabled from the flag and the merchant's hold", async () => {
  const on = await signedInOwner(app);
  assert.equal(await refundsEnabled(app, on.cookie), true);

  await pool.query(`UPDATE merchants SET refunds_enabled = false WHERE id = $1`, [on.merchantId]);
  assert.equal(await refundsEnabled(app, on.cookie), false);

  const off = await signedInOwner(flagOffApp);
  assert.equal(await refundsEnabled(flagOffApp, off.cookie), false);
});

// ---------------------------------------------------------------- reporting rebuild

test("the admin reporting rebuild counts refunds in merchant_daily_volume", async () => {
  const m = await merchantWithKey("rebuild");
  const txn = await capturedTransaction(m.rawKey, 9_000);
  await refund(m.rawKey, txn, 2_000);
  await refund(m.rawKey, txn, 1_500);

  await withTransaction(pool, (client) => refreshAnalyticsRollups(client));

  const rows = await pool.query<{ captured_gross_fils: string; refund_count: number; refund_gross_fils: string }>(
    `SELECT captured_gross_fils, refund_count, refund_gross_fils FROM merchant_daily_volume WHERE merchant_id = $1`,
    [m.merchantId],
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(Number(rows.rows[0]!.captured_gross_fils), 9_000);
  assert.equal(rows.rows[0]!.refund_count, 2);
  assert.equal(Number(rows.rows[0]!.refund_gross_fils), 3_500);
});
