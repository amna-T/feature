/**
 * Regression tests for the second audit round: session fixation, role gates
 * on capture/void, suspended merchants, webhook SSRF, endpoint deletion,
 * replay ids, KYC file type, and the unauthenticated export-summary route.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { hashPassword } from "../auth/passwords.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { isInternalWebhookHost, validateWebhookUrl } from "../webhooks/create.js";
import { insertReplayDeliveryRow } from "../webhooks/replay.js";
import { withTransaction } from "../db/withTransaction.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("round2.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  OTP_DEV_EXPOSE: "true",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function approvedMerchant(label: string) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Round2 ${label} ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const key = await issueApiKey(pool, config, { merchantId, createdBy: owner.rows[0]!.id, label });
  return { merchantId, rawKey: key.rawKey };
}

async function sessionCookie(merchantId: string, role: "owner" | "finance" | "support"): Promise<string> {
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, $3, 'x') RETURNING id`,
    [merchantId, `${role}-${randomUUID()}@example.test`, role],
  );
  const raw = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, true, now() + interval '1 hour')`,
    [user.rows[0]!.id, sha256Hex(raw)],
  );
  return `${config.cookieName}=${raw}`;
}

async function authorize(rawKey: string, amountFils = 5_000) {
  return app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: CARD },
  });
}

test("the pre-OTP cookie stops working once OTP verification issues the real session", async () => {
  const { merchantId } = await approvedMerchant("fixation");
  const email = `login-${randomUUID()}@example.test`;
  await pool.query(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3)`,
    [merchantId, email, await hashPassword("Correct horse 1!", config)],
  );
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId, email, password: "Correct horse 1!" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const pendingCookie = String(login.headers["set-cookie"]).split(";")[0]!;

  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie: pendingCookie },
    payload: { code: login.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const sessionCookieHeader = String(verify.headers["set-cookie"]).split(";")[0]!;
  assert.notEqual(sessionCookieHeader, pendingCookie, "verify must issue a new token");

  const withOld = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: pendingCookie } });
  assert.equal(withOld.statusCode, 401);
  const withNew = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: sessionCookieHeader } });
  assert.equal(withNew.statusCode, 200, withNew.body);
});

test("a support user cannot capture or void", async () => {
  const { merchantId, rawKey } = await approvedMerchant("support-gate");
  const txn = (await authorize(rawKey)).json().id as string;
  const cookie = await sessionCookie(merchantId, "support");

  const capture = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txn}/capture`,
    headers: { cookie, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(capture.statusCode, 403, capture.body);
  const voided = await app.inject({ method: "POST", url: `/v1/transactions/${txn}/void`, headers: { cookie } });
  assert.equal(voided.statusCode, 403, voided.body);

  const owner = await sessionCookie(merchantId, "owner");
  const ok = await app.inject({ method: "POST", url: `/v1/transactions/${txn}/void`, headers: { cookie: owner } });
  assert.equal(ok.statusCode, 200, ok.body);
});

test("a suspended merchant cannot take a card payment", async () => {
  const { merchantId, rawKey } = await approvedMerchant("suspended");
  await pool.query(`UPDATE merchants SET status = 'suspended' WHERE id = $1`, [merchantId]);
  const res = await authorize(rawKey);
  assert.equal(res.statusCode, 403, res.body);
});

test("production webhook URLs may not point at internal hosts", () => {
  for (const host of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.20.0.5", "192.168.1.1", "[::1]", "localhost", "settlement", "db.internal"]) {
    assert.equal(isInternalWebhookHost(host.replace(/^\[|\]$/g, "")), true, host);
    assert.throws(() => validateWebhookUrl(`https://${host}/hook`, { nodeEnv: "production" }), host);
  }
  assert.equal(isInternalWebhookHost("hooks.merchant.example"), false);
  assert.doesNotThrow(() => validateWebhookUrl("https://hooks.merchant.example/x", { nodeEnv: "production" }));
  assert.doesNotThrow(() => validateWebhookUrl("http://localhost:4000/x", { nodeEnv: "development" }));
});

async function endpointWithDelivery(merchantId: string) {
  const ep = await pool.query<{ id: string }>(
    `INSERT INTO webhook_endpoints (merchant_id, url, secret_ciphertext, secret_prefix, created_by_type, created_by_id)
     VALUES ($1, 'https://hooks.example.test/x', 'unused', 'whsec_unused', 'merchant_api_key', $2) RETURNING id`,
    [merchantId, randomUUID()],
  );
  const ev = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
     VALUES ('transaction.voided', 'transaction', $1, $2) RETURNING id`,
    [randomUUID(), JSON.stringify({ merchantId })],
  );
  const deliveryEventId = randomUUID();
  const d = await pool.query<{ id: string }>(
    `INSERT INTO webhook_deliveries (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload)
     VALUES ($1, $2, 'transaction.voided', $3, $4) RETURNING id`,
    [ep.rows[0]!.id, ev.rows[0]!.id, deliveryEventId, JSON.stringify({ id: deliveryEventId, type: "transaction.voided" })],
  );
  return { endpointId: ep.rows[0]!.id, outboxEventId: ev.rows[0]!.id, deliveryId: d.rows[0]!.id, deliveryEventId };
}

test("deleting an endpoint that has deliveries disables it instead of failing", async () => {
  const { merchantId } = await approvedMerchant("ep-delete");
  const { endpointId } = await endpointWithDelivery(merchantId);
  const cookie = await sessionCookie(merchantId, "owner");
  const res = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${merchantId}/webhook-endpoints/${endpointId}`,
    headers: { cookie },
  });
  assert.ok(res.statusCode < 300, `${res.statusCode} ${res.body}`);
  const row = await pool.query<{ status: string }>(`SELECT status FROM webhook_endpoints WHERE id = $1`, [endpointId]);
  assert.equal(row.rows[0]?.status, "disabled");
});

test("a replayed delivery keeps the delivery id receivers dedupe on", async () => {
  const { merchantId } = await approvedMerchant("replay-id");
  const original = await endpointWithDelivery(merchantId);
  const replay = await withTransaction(pool, (client) =>
    insertReplayDeliveryRow(client, {
      id: original.deliveryId,
      endpointId: original.endpointId,
      outboxEventId: original.outboxEventId,
      eventType: "transaction.voided",
      payload: { id: original.deliveryEventId, type: "transaction.voided" },
    }),
  );
  const row = await pool.query<{ delivery_event_id: string; payload: { id: string } }>(
    `SELECT delivery_event_id, payload FROM webhook_deliveries WHERE id = $1`,
    [replay.deliveryId],
  );
  assert.equal(row.rows[0]?.delivery_event_id, original.deliveryEventId);
  assert.equal(row.rows[0]?.payload.id, original.deliveryEventId);
});

test("GET /v1/reporting/export-summary requires authentication instead of 500ing", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/reporting/export-summary" });
  assert.equal(res.statusCode, 401, res.body);
});

test("a JPEG named .pdf is refused for a PDF-only KYC document", async () => {
  const { recordKycDocument } = await import("../onboarding/kyc.js");
  const { merchantId } = await approvedMerchant("kyc-jpeg");
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  await assert.rejects(
    recordKycDocument(pool, config, {
      merchantId,
      documentType: "commercial_registration",
      fileName: "CR-2026.pdf",
      buffer: jpeg,
      uploadedBy: randomUUID(),
    }),
    (err: Error & { code?: string }) => err.code === "document_must_be_pdf",
  );
});
