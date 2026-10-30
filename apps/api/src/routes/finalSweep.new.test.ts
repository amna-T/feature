/**
 * Final-sweep regressions (FINDINGS.md §13): bad input must be a 4xx, never a
 * 500, and a malformed card must not lock a public payment link.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { createPaymentLink } from "../paymentLinks/create.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { parseCardInput } from "../payments/card.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("finalSweep.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242 4242 4242 4242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchant() {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Final sweep ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const rawKey = (await issueApiKey(pool, config, { merchantId, createdBy: owner.rows[0]!.id, label: "sweep" })).rawKey;
  const raw = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at) VALUES ($1, $2, true, now() + interval '1 hour')`,
    [owner.rows[0]!.id, sha256Hex(raw)],
  );
  return { merchantId, ownerId: owner.rows[0]!.id, rawKey, cookie: `${config.cookieName}=${raw}` };
}

test("a malformed card is a 400 and leaves the payment link payable", async () => {
  const m = await merchant();
  const link = await createPaymentLink(pool, config, {
    merchantId: m.merchantId,
    amountFils: 5_000,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdByType: "merchant_session",
    createdById: m.ownerId,
  });
  const pay = (card: unknown) =>
    app.inject({
      method: "POST",
      url: `/v1/payment-links/${link.token}/pay`,
      headers: { "idempotency-key": randomUUID() },
      payload: { card },
    });

  // Before: {} crashed with a 500 and left the link 'reserved', so the next
  // (real) customer got "payment_link_processing" until the timeout.
  for (const bad of [{}, { pan: 4242 }, { ...CARD, cvv: "1" }, { ...CARD, expiryMonth: 13 }]) {
    assert.equal((await pay(bad)).statusCode, 400, JSON.stringify(bad));
  }
  const expired = await pay({ ...CARD, expiryMonth: 1, expiryYear: 2020 });
  assert.equal(expired.statusCode, 400);
  assert.equal(expired.json().error, "card_expired");

  const status = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [link.id]);
  assert.equal(status.rows[0]!.status, "active");
  const good = await pay(CARD);
  assert.equal(good.statusCode, 200, good.body);
});

test("card numbers typed with spaces are accepted; expiry runs to the end of the month", () => {
  assert.equal(parseCardInput(CARD).pan, "4242424242424242");
  const now = new Date("2026-10-15T12:00:00Z");
  assert.equal(parseCardInput({ ...CARD, expiryMonth: 10, expiryYear: 2026 }, now).expiryMonth, 10);
  assert.throws(() => parseCardInput({ ...CARD, expiryMonth: 9, expiryYear: 2026 }, now), /expired/);
});

test("invalid amounts on authorize and capture are 400, not 500", async () => {
  const m = await merchant();
  const headers = () => ({ authorization: `Bearer ${m.rawKey}`, "idempotency-key": randomUUID() });
  for (const amountFils of [-5, 1.5, "10", 1e20, 0]) {
    const res = await app.inject({ method: "POST", url: "/v1/transactions", headers: headers(), payload: { amountFils, card: CARD } });
    assert.equal(res.statusCode, 400, `authorize ${JSON.stringify(amountFils)}: ${res.body}`);
  }
  const auth = await app.inject({ method: "POST", url: "/v1/transactions", headers: headers(), payload: { amountFils: 5_000, card: CARD } });
  assert.equal(auth.statusCode, 201, auth.body);
  for (const amountFils of [-1, 2.5, "7"]) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/transactions/${auth.json().id}/capture`,
      headers: { ...headers(), cookie: m.cookie },
      payload: { amountFils },
    });
    assert.equal(res.statusCode, 400, `capture ${JSON.stringify(amountFils)}: ${res.body}`);
  }
});

test("malformed JSON, malformed ids and invalid dates are 400, not 500", async () => {
  const m = await merchant();
  const json = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${m.rawKey}`, "idempotency-key": randomUUID(), "content-type": "application/json" },
    payload: "{not json",
  });
  assert.equal(json.statusCode, 400, json.body);

  for (const url of [
    "/v1/transactions/not-a-uuid",
    "/v1/settlement/batches/not-a-uuid",
    "/v1/transactions?from=2026-13-45",
    "/v1/settlement/batches?from=2026-13-45",
    "/v1/settlement/reconciliation?from=garbage&to=garbage",
    "/v1/settlement/summary?from=garbage&to=garbage",
  ]) {
    const res = await app.inject({ method: "GET", url, headers: { cookie: m.cookie } });
    assert.equal(res.statusCode, 400, `${url}: ${res.body}`);
  }
});
