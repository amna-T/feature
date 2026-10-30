/**
 * Login limits for the merchant and admin planes.
 *
 * Before: no limit on password guesses, and every correct password (or a
 * merchant OTP resend every 30 s) issued a fresh OTP challenge with its own
 * attempt budget, so the OTP attempt limit could be bypassed by logging in
 * again. Unlimited argon2 hashing on a 0.5 vCPU API was also an easy way to
 * overload it.
 *
 * Each test uses its own client IP so the per-IP counts don't leak between
 * tests or test files. Real migrated Postgres; requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("loginLimits.new.test.ts requires DATABASE_URL (a migrated Postgres)");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  LOGIN_WINDOW_MINUTES: "15",
  LOGIN_MAX_FAILURES_PER_ACCOUNT: "3",
  LOGIN_MAX_FAILURES_PER_IP: "6",
  OTP_MAX_CHALLENGES_PER_USER: "3",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const PASSWORD = "correct horse battery staple 1!";

/** A random private address per test, so per-IP counts never collide. */
function freshIp(): string {
  return `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

async function signupMerchant(ip: string) {
  const email = `owner-${randomUUID()}@example.test`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    remoteAddress: ip,
    payload: {
      businessProfile: {
        legalName: `Limits Co ${randomUUID().slice(0, 8)}`,
        registrationNumber: `RC-${randomUUID().slice(0, 8)}`,
        businessType: "llc",
        contactEmail: `contact-${randomUUID()}@example.test`,
        contactPhone: "+97300000000",
        addressLine1: "1 Test Street",
        city: "Manama",
      },
      owner: { email, password: PASSWORD },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return { merchantId: (res.json() as { merchantId: string }).merchantId, email };
}

function merchantLogin(ip: string, merchantId: string, email: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/v1/auth/login",
    remoteAddress: ip,
    payload: { merchantId, email, password },
  });
}

let adminHash: string | null = null;
async function createAdmin(): Promise<string> {
  adminHash ??= await hashPassword(PASSWORD, config);
  const email = `limits-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Limits test', 'support')`,
    [email, adminHash],
  );
  return email;
}

function adminLogin(ip: string, email: string, password: string) {
  return app.inject({ method: "POST", url: "/v1/admin/auth/login", remoteAddress: ip, payload: { email, password } });
}

function errorCode(res: { json(): unknown }): unknown {
  return (res.json() as { error?: unknown }).error;
}

// ---------------------------------------------------------------- merchant

test("merchant: after the failure limit the account is refused, even with the right password", async () => {
  const ip = freshIp();
  const m = await signupMerchant(ip);
  for (let i = 0; i < 3; i++) {
    const res = await merchantLogin(ip, m.merchantId, m.email, "wrong password");
    assert.equal(res.statusCode, 401, res.body);
  }
  const locked = await merchantLogin(ip, m.merchantId, m.email, PASSWORD);
  assert.equal(locked.statusCode, 429, locked.body);
  assert.equal(errorCode(locked), "too_many_attempts");
  assert.ok(locked.headers["retry-after"], "expected a Retry-After header");

  // Another account from the same IP is unaffected.
  const other = await signupMerchant(ip);
  const ok = await merchantLogin(ip, other.merchantId, other.email, PASSWORD);
  assert.equal(ok.statusCode, 200, ok.body);
});

test("merchant: parallel guesses can't get past the failure limit together", async () => {
  const ip = freshIp();
  const m = await signupMerchant(freshIp());
  const results = await Promise.all(
    Array.from({ length: 12 }, () => merchantLogin(ip, m.merchantId, m.email, "wrong password")),
  );
  const checked = results.filter((r) => r.statusCode === 401).length;
  const refused = results.filter((r) => r.statusCode === 429).length;
  assert.equal(checked + refused, 12);
  assert.ok(checked <= 3, `expected at most 3 passwords checked, got ${checked}`);
});

test("merchant: failures older than the window no longer count", async () => {
  const ip = freshIp();
  const m = await signupMerchant(ip);
  for (let i = 0; i < 3; i++) {
    await merchantLogin(ip, m.merchantId, m.email, "wrong password");
  }
  assert.equal((await merchantLogin(ip, m.merchantId, m.email, PASSWORD)).statusCode, 429);

  await pool.query(
    `UPDATE login_failures SET created_at = now() - interval '16 minutes' WHERE ip = $1`,
    [ip],
  );
  const res = await merchantLogin(ip, m.merchantId, m.email, PASSWORD);
  assert.equal(res.statusCode, 200, res.body);
});

test("merchant: one IP failing across many accounts is refused", async () => {
  const ip = freshIp();
  const target = await signupMerchant(freshIp());
  for (let i = 0; i < 6; i++) {
    const res = await merchantLogin(ip, target.merchantId, `nobody-${randomUUID()}@example.test`, "guess");
    assert.equal(res.statusCode, 401, res.body);
  }
  const blocked = await merchantLogin(ip, target.merchantId, target.email, PASSWORD);
  assert.equal(blocked.statusCode, 429, blocked.body);

  // The same account from another IP still works.
  const elsewhere = await merchantLogin(freshIp(), target.merchantId, target.email, PASSWORD);
  assert.equal(elsewhere.statusCode, 200, elsewhere.body);
});

test("merchant: logging in again can't mint unlimited OTP challenges", async () => {
  const ip = freshIp();
  const m = await signupMerchant(ip);
  for (let i = 0; i < 3; i++) {
    const res = await merchantLogin(ip, m.merchantId, m.email, PASSWORD);
    assert.equal(res.statusCode, 200, res.body);
  }
  const res = await merchantLogin(ip, m.merchantId, m.email, PASSWORD);
  assert.equal(res.statusCode, 429, res.body);
  assert.equal(errorCode(res), "too_many_attempts");
});

test("merchant: OTP resends count towards the same challenge limit", async () => {
  const ip = freshIp();
  const m = await signupMerchant(ip);
  const login = await merchantLogin(ip, m.merchantId, m.email, PASSWORD);
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;

  const resend = async () => {
    // Step past the 30-second resend spacing without waiting.
    await pool.query(
      `UPDATE otp_challenges SET created_at = created_at - interval '1 minute'
        WHERE merchant_user_id = (SELECT id FROM merchant_users WHERE email = $1)`,
      [m.email],
    );
    return app.inject({ method: "POST", url: "/v1/auth/otp/resend", remoteAddress: ip, headers: { cookie } });
  };

  assert.equal((await resend()).statusCode, 200);
  assert.equal((await resend()).statusCode, 200);
  const fourth = await resend();
  assert.equal(fourth.statusCode, 429, fourth.body);
  assert.equal(errorCode(fourth), "too_many_attempts");
});

// ---------------------------------------------------------------- admin

test("admin: after the failure limit the account is refused, even with the right password", async () => {
  const ip = freshIp();
  const email = await createAdmin();
  for (let i = 0; i < 3; i++) {
    assert.equal((await adminLogin(ip, email, "wrong password")).statusCode, 401);
  }
  const locked = await adminLogin(ip, email, PASSWORD);
  assert.equal(locked.statusCode, 429, locked.body);
  assert.equal(errorCode(locked), "too_many_attempts");
});

test("admin: logging in again can't mint unlimited OTP challenges", async () => {
  const ip = freshIp();
  const email = await createAdmin();
  for (let i = 0; i < 3; i++) {
    const res = await adminLogin(ip, email, PASSWORD);
    assert.equal(res.statusCode, 200, res.body);
  }
  const res = await adminLogin(ip, email, PASSWORD);
  assert.equal(res.statusCode, 429, res.body);
});
