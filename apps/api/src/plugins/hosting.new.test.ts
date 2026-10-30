/**
 * Hosting behaviour of the API process:
 * - client IP: X-Forwarded-For is ignored unless TRUST_PROXY is set
 *   (spoof-proof by default; correct behind the ops reverse proxy);
 * - overload: requests get a fast 503 + Retry-After instead of queueing for
 *   a database connection and failing with a 500.
 *
 * Real migrated Postgres; requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("hosting.new.test.ts requires DATABASE_URL (a migrated Postgres)");
}

const baseEnv = {
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  LOG_LEVEL: "warn",
};

function appWith(env: Record<string, string>, pool: Pool) {
  const app = buildApp(loadConfig({ ...baseEnv, ...env }), pool);
  app.get("/__test/ip", async (request) => ({ ip: request.ip }));
  return app;
}

test("X-Forwarded-For is ignored unless TRUST_PROXY is set", async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const direct = appWith({}, pool);
  const proxied = appWith({ TRUST_PROXY: "1" }, pool);
  try {
    const headers = { "x-forwarded-for": "203.0.113.9" };
    const a = await direct.inject({ method: "GET", url: "/__test/ip", remoteAddress: "10.0.0.5", headers });
    assert.equal(a.json().ip, "10.0.0.5", "without a trusted proxy the header must not set the client IP");

    const b = await proxied.inject({ method: "GET", url: "/__test/ip", remoteAddress: "10.0.0.5", headers });
    assert.equal(b.json().ip, "203.0.113.9", "behind one trusted proxy the forwarded client IP is used");
  } finally {
    await direct.close();
    await proxied.close();
    await pool.end();
  }
});

test("when requests are already waiting for a connection, new ones get a fast 503", async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const app = appWith({ LOAD_SHED_MAX_WAITING: "1" }, pool);
  let held: PoolClient | undefined;
  let waiting: Promise<PoolClient> | undefined;
  try {
    held = await pool.connect(); // the only connection
    waiting = pool.connect(); // one request already queued
    assert.equal(pool.waitingCount, 1);

    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/v1/transactions", headers: { authorization: "Bearer x" } });
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().error, "overloaded");
    assert.equal(res.headers["retry-after"], "1");
    assert.ok(Date.now() - started < 1_000, "shedding must not wait for a connection");

    const health = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200, "health probes are never shed");
  } finally {
    held?.release();
    (await waiting)?.release();
    await app.close();
    await pool.end();
  }
});

test("a request that times out waiting for a connection gets 503, not 500", async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 200 });
  const app = appWith({ LOAD_SHED_MAX_WAITING: "0" }, pool);
  let held: PoolClient | undefined;
  try {
    held = await pool.connect();
    const res = await app.inject({ method: "GET", url: "/v1/transactions", headers: { authorization: "Bearer x" } });
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().error, "overloaded");
  } finally {
    held?.release();
    await app.close();
    await pool.end();
  }
});

test("LOG_LEVEL sets the logger level and defaults to info", () => {
  assert.equal(loadConfig({ ...baseEnv, LOG_LEVEL: "" }).logLevel, "info");
  assert.equal(loadConfig({ ...baseEnv, LOG_LEVEL: "warn" }).logLevel, "warn");
});
