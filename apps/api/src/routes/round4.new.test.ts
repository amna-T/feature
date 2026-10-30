/**
 * Round 4 regressions: trailing-dot SSRF bypass, payment-link authorization
 * left open after a failed capture, and future-dated manual credits.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { createAcquirerSimulator } from "../acquirer/simulator.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { createPaymentLink } from "../paymentLinks/create.js";
import { payPaymentLink } from "../paymentLinks/pay.js";
import { isInternalWebhookHost, validateWebhookUrl } from "../webhooks/create.js";
import { parseCreditRequestInput } from "../admin/creditRequestValidation.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("round4.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

test("a trailing dot does not get an internal host past the webhook URL check", () => {
  for (const host of ["localhost.", "settlement.", "postgres..", "x.internal.", "box.local.", "127.0.0.1."]) {
    assert.equal(isInternalWebhookHost(host), true, host);
  }
  assert.equal(isInternalWebhookHost("example.com."), false);
  for (const url of ["https://settlement.:8091/", "https://localhost./", "https://metadata.internal./"]) {
    assert.throws(() => validateWebhookUrl(url, { nodeEnv: "production" }), url);
  }
});

test("a failed payment-link capture voids its authorization", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Round4 paylink ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  await issueApiKey(pool, config, { merchantId, createdBy: owner.rows[0]!.id, label: "r4" });

  const link = await createPaymentLink(pool, config, {
    merchantId,
    amountFils: 7_500,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdByType: "merchant_session",
    createdById: owner.rows[0]!.id,
  });

  // Authorize approves; capture comes back as an acquirer error.
  const real = createAcquirerSimulator(config);
  const acquirer: AcquirerSimulator = {
    ...real,
    capture: async (req) => ({ outcome: "error", acquirerReference: req.acquirerReference, latencyMs: 0 }),
  };

  const result = await payPaymentLink(pool, acquirer, config, {
    token: link.token,
    card: CARD,
    idempotencyKey: randomUUID(),
  });
  assert.notEqual(result.statusCode, 200);

  const txns = await pool.query<{ status: string }>(`SELECT status FROM transactions WHERE merchant_id = $1`, [merchantId]);
  assert.equal(txns.rowCount, 1);
  assert.equal(txns.rows[0]!.status, "voided", "the cardholder's hold must not be left open");
  const holds = await pool.query(
    `SELECT 1 FROM holds h JOIN transactions t ON t.id = h.transaction_id WHERE t.merchant_id = $1 AND h.status = 'active'`,
    [merchantId],
  );
  assert.equal(holds.rowCount, 0);

  const after = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [link.id]);
  assert.equal(after.rows[0]!.status, "active", "the link is released for another attempt");
});

test("a manual credit cannot be dated in the future", () => {
  const base = { baseAmountFils: 1_000, reasonCode: "goodwill" };
  const tomorrowBahrain = new Date(Date.now() + 27 * 3_600_000).toISOString().slice(0, 10);
  assert.throws(
    () => parseCreditRequestInput({ ...base, effectiveDate: tomorrowBahrain }),
    (err: unknown) => (err as { code?: string }).code === "invalid_effective_date",
  );
  assert.throws(() => parseCreditRequestInput({ ...base, effectiveDate: "2099-01-01" }));
  const todayBahrain = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  assert.equal(parseCreditRequestInput({ ...base, effectiveDate: todayBahrain }).effectiveDate, todayBahrain);
});
