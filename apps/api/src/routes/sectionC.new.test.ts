/**
 * Regressions for the remaining audit items (FINDINGS.md §12): callback
 * signatures over the raw body, refunds stuck in_progress, KYC fields edited
 * after approval, split credits under the maker-checker threshold, duplicate
 * adjustment imports, and "Adjust balance" writing only the cache.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";
import { createAcquirerSimulator } from "../acquirer/simulator.js";
import type { AcquirerRefundRequest, AcquirerSimulator } from "../acquirer/types.js";
import { processRefund } from "../payments/processRefund.js";
import { updateBusinessProfile } from "../onboarding/businessProfile.js";
import { createCreditRequest } from "../admin/credits.js";
import { applyAdjustmentImport } from "../admin/adjustmentImport.js";
import { ConflictError } from "../lib/errors.js";
import { transactionsExportCsvChunks } from "../transactions/exportCsv.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("sectionC.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const ACQUIRER_SECRET = "acqsec_section_c_test";
const ADMIN_PASSWORD = "admin-test-password-9000!";

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  ACQUIRER_CALLBACK_SIGNING_SECRET: ACQUIRER_SECRET,
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function merchant(opts: { onboardingStatus?: string } = {}): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode, onboarding_status)
     VALUES ($1, 250, 'active', false, $2) RETURNING id`,
    [`Section C ${randomUUID()}`, opts.onboardingStatus ?? "approved"],
  );
  return m.rows[0]!.id;
}

async function admin(role: "support" | "finance" | "super_admin"): Promise<{ id: string; cookie: string }> {
  const email = `section-c-${randomUUID()}@admin.test`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, await hashPassword(ADMIN_PASSWORD, config), `Section C ${role}`, role],
  );
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookieOf = (h: string | string[] | undefined) =>
    (Array.isArray(h) ? h : [h]).find((c) => c?.startsWith(`${config.adminCookieName}=`))!.split(";")[0]!;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie: cookieOf(login.headers["set-cookie"]) },
    payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return { id: inserted.rows[0]!.id, cookie: cookieOf(verify.headers["set-cookie"]) };
}

test("a callback is verified over the bytes received, not a re-serialisation", async () => {
  const merchantId = await merchant();
  const txn = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 50000, 50000, $2) RETURNING id`,
    [merchantId, `acqref_${randomUUID()}`],
  );
  // Same JSON, formatted the way many senders do: spaces and a newline.
  // JSON.stringify of the parsed body is different text, so it never matched.
  const raw = `{
  "callbackId": "acqcb_${randomUUID()}",
  "type": "fraud_review.completed",
  "transactionId": "${txn.rows[0]!.id}",
  "occurredAt": "2026-09-16T10:00:00.000Z",
  "outcome": "cleared",
  "note": "reviewed, fine"
}`;
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", ACQUIRER_SECRET).update(`${t}.${raw}`).digest("hex");
  const res = await app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    headers: { "content-type": "application/json", "acquirer-callback-signature": `t=${t},v1=${sig}` },
    payload: raw,
  });
  assert.equal(res.statusCode, 200, res.body);

  const tampered = await app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    headers: { "content-type": "application/json", "acquirer-callback-signature": `t=${t},v1=${sig}` },
    payload: raw.replace("reviewed, fine", "reviewed, fine!"),
  });
  assert.equal(tampered.statusCode, 401);
});

test("a refund whose acquirer call died is resumed with the same acquirer key, and refunded once", async () => {
  const merchantId = await merchant();
  const txn = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 10000, 10000, $2) RETURNING id`,
    [merchantId, `acqref_${randomUUID()}`],
  );
  const transactionId = txn.rows[0]!.id;

  const keys: string[] = [];
  const real = createAcquirerSimulator(config);
  let failNext = true;
  const acquirer: AcquirerSimulator = {
    ...real,
    refund: async (req: AcquirerRefundRequest) => {
      keys.push(req.idempotencyKey);
      if (failNext) {
        failNext = false;
        throw new Error("socket hang up");
      }
      return real.refund(req);
    },
  };
  const input = {
    transactionId,
    merchantId,
    amountFils: toFils(4000),
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key" as const, id: randomUUID() },
  };

  await assert.rejects(processRefund(pool, acquirer, input), /socket hang up/);
  // Before: the key stayed in_progress and every retry was a 409, forever.
  const retry = await processRefund(pool, acquirer, input);
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], "the retry reuses the acquirer key, so a real acquirer can't refund twice");

  const refunds = await pool.query(`SELECT 1 FROM refunds WHERE transaction_id = $1`, [transactionId]);
  assert.equal(refunds.rowCount, 1);
  const replay = await processRefund(pool, acquirer, input);
  assert.equal(replay.statusCode, 200);
  assert.equal(keys.length, 2, "a completed key replays without calling the acquirer");
});

test("KYC-verified profile fields are locked once review has started; contact fields are not", async () => {
  for (const status of ["under_review", "approved"]) {
    const merchantId = await merchant({ onboardingStatus: status });
    await pool.query(
      `INSERT INTO merchant_business_profiles
         (merchant_id, legal_name, registration_number, business_type, contact_email, contact_phone, address_line1, city)
       VALUES ($1, 'Real Co W.L.L.', 'CR-1', 'llc', 'a@real.test', '+97300000000', 'Road 1', 'Manama')`,
      [merchantId],
    );
    await assert.rejects(
      updateBusinessProfile(pool, merchantId, { legalName: "Someone Else W.L.L." }),
      (err: unknown) => err instanceof ConflictError && err.code === "kyc_fields_locked",
      status,
    );
    const updated = await updateBusinessProfile(pool, merchantId, { contactEmail: "new@real.test" });
    assert.equal(updated.contactEmail, "new@real.test");
    assert.equal(updated.legalName, "Real Co W.L.L.");
  }

  const submitted = await merchant({ onboardingStatus: "submitted" });
  await pool.query(
    `INSERT INTO merchant_business_profiles
       (merchant_id, legal_name, registration_number, business_type, contact_email, contact_phone, address_line1, city)
     VALUES ($1, 'Draft Co', 'CR-2', 'llc', 'a@draft.test', '+97300000000', 'Road 1', 'Manama')`,
    [submitted],
  );
  const fixed = await updateBusinessProfile(pool, submitted, { legalName: "Draft Co W.L.L." });
  assert.equal(fixed.legalName, "Draft Co W.L.L.", "still editable before review");
});

test("credits split into pieces under the threshold still need a second approver once they add up", async () => {
  const merchantId = await merchant();
  const finance = await admin("finance");
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  const body = { baseAmountFils: 30_000, reasonCode: "goodwill", effectiveDate: today };

  const first = await createCreditRequest(pool, { merchantId, adminUserId: finance.id, body });
  assert.equal(first.status, "posted", "30 BD alone is under the 50 BD threshold");
  const second = await createCreditRequest(pool, { merchantId, adminUserId: finance.id, body });
  assert.equal(second.status, "pending_approval", "30 + 30 BD in a day needs a second approver");
});

test("the same adjustment CSV rows can't be applied twice by accident", async () => {
  const merchantId = await merchant();
  const finance = await admin("finance");
  const rows = [{ merchantId, amount: "4.750", reason: "statement correction" }];

  await applyAdjustmentImport(pool, { adminUserId: finance.id, originalFilename: "august.csv", rows });
  await assert.rejects(
    applyAdjustmentImport(pool, { adminUserId: finance.id, originalFilename: "august (1).csv", rows }),
    (err: unknown) => err instanceof ConflictError && err.code === "duplicate_import",
  );
  await applyAdjustmentImport(pool, { adminUserId: finance.id, originalFilename: "again.csv", rows, allowDuplicate: true });

  const posted = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM adjustment_import_rows WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(posted.rows[0]!.n, "2", "the refused copy posted nothing");
});

test("Adjust balance is journaled, so the ledger agrees and a rebuild keeps it", async () => {
  const merchantId = await merchant();
  await pool.query(`INSERT INTO merchant_balances (merchant_id, cached_payable_fils) VALUES ($1, 0)`, [merchantId]);
  const finance = await admin("finance");

  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/balance-adjustments`,
    headers: { cookie: finance.cookie },
    payload: { deltaFils: 1500, reason: "statement correction" },
  });
  assert.equal(res.statusCode, 200, res.body);

  const ledger = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'`,
    [merchantId],
  );
  assert.equal(ledger.rows[0]!.net, "1500");
});

test("the streamed export neither repeats nor drops rows at page boundaries with microsecond timestamps", async () => {
  const merchantId = await merchant();
  // now()-style timestamps carry microseconds; a JS Date cursor rounded them
  // off and repeated the last row of every page.
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
     SELECT $1, 'captured', 1000, 1000, 'acq-' || g, timestamptz '2026-10-01T10:00:00.123456Z' + g * interval '7 microseconds'
       FROM generate_series(1, 7) g`,
    [merchantId],
  );
  let csv = "";
  for await (const chunk of transactionsExportCsvChunks(
    pool,
    { merchantId, from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-02T00:00:00Z") },
    { pageSize: 2 },
  )) {
    csv += chunk;
  }
  const ids = csv.trim().split("\n").slice(1).map((line) => line.split(",")[0]);
  assert.equal(ids.length, 7, csv);
  assert.equal(new Set(ids).size, 7, "no row exported twice");
});
