/**
 * Login limits must not let a stranger lock someone out.
 *
 * Before: the per-account failure count ignored where attempts came from, and
 * every refused (429) attempt was recorded as another failure. Anyone who knew
 * an owner's email could keep them locked out indefinitely with one request
 * every few minutes, on both the merchant and admin planes.
 *
 * Now the account limit counts failures per account *and* client IP, and
 * refused attempts are not recorded.
 *
 * Real migrated Postgres; requires DATABASE_URL.
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
  throw new Error("loginLockoutAbuse.new.test.ts requires DATABASE_URL (a migrated Postgres)");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  LOG_LEVEL: "warn",
  LOGIN_WINDOW_MINUTES: "15",
  LOGIN_MAX_FAILURES_PER_ACCOUNT: "3",
  LOGIN_MAX_FAILURES_PER_IP: "50",
  OTP_MAX_CHALLENGES_PER_USER: "10",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const PASSWORD = "correct horse battery staple 1!";

function freshIp(): string {
  return `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

async function signupMerchant() {
  const email = `owner-${randomUUID()}@example.test`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    remoteAddress: freshIp(),
    payload: {
      businessProfile: {
        legalName: `Lockout Co ${randomUUID().slice(0, 8)}`,
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
  return app.inject({ method: "POST", url: "/v1/auth/login", remoteAddress: ip, payload: { merchantId, email, password } });
}

test("merchant: an attacker locking an account doesn't lock out the owner on another IP", async () => {
  const m = await signupMerchant();
  const attacker = freshIp();
  for (let i = 0; i < 3; i++) {
    assert.equal((await merchantLogin(attacker, m.merchantId, m.email, "guess")).statusCode, 401);
  }
  assert.equal((await merchantLogin(attacker, m.merchantId, m.email, "guess")).statusCode, 429);

  const owner = await merchantLogin(freshIp(), m.merchantId, m.email, PASSWORD);
  assert.equal(owner.statusCode, 200, owner.body);
});

test("merchant: refused attempts don't extend the lock", async () => {
  const m = await signupMerchant();
  const ip = freshIp();
  for (let i = 0; i < 3; i++) {
    await merchantLogin(ip, m.merchantId, m.email, "guess");
  }
  // Keep knocking while locked.
  for (let i = 0; i < 5; i++) {
    assert.equal((await merchantLogin(ip, m.merchantId, m.email, "guess")).statusCode, 429);
  }

  // Once the real failures leave the window, the lock must lift.
  await pool.query(`UPDATE login_failures SET created_at = now() - interval '16 minutes' WHERE ip = $1`, [ip]);
  const after = await merchantLogin(ip, m.merchantId, m.email, PASSWORD);
  assert.equal(after.statusCode, 200, after.body);
  const rows = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM login_failures WHERE ip = $1`, [ip]);
  assert.equal(rows.rows[0]!.n, 3, "only the 3 real failures are recorded, not the 5 refused attempts");
});

test("admin: an attacker locking an account doesn't lock out the admin on another IP", async () => {
  const email = `lockout-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Lockout test', 'support')`,
    [email, await hashPassword(PASSWORD, config)],
  );
  const attacker = freshIp();
  for (let i = 0; i < 4; i++) {
    await app.inject({ method: "POST", url: "/v1/admin/auth/login", remoteAddress: attacker, payload: { email, password: "guess" } });
  }
  const admin = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    remoteAddress: freshIp(),
    payload: { email, password: PASSWORD },
  });
  assert.equal(admin.statusCode, 200, admin.body);
});
