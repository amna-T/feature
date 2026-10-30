/**
 * Transactions CSV export: memory, completeness and spreadsheet safety.
 *
 * Before:
 * - the route loaded the whole range with one SELECT and built the CSV in
 *   memory, and from/to were optional, so a request with no dates exported a
 *   merchant's whole history and could push the 512 MB API into an OOM kill;
 * - invalid dates were a 500;
 * - the unused streaming version paged on `occurred_at > cursor`, skipping
 *   rows that share the boundary timestamp;
 * - a reference such as `=HYPERLINK(...)` ran as a formula in Excel.
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
import { transactionsExportCsvChunks } from "./exportCsv.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("exportStream.new.test.ts requires DATABASE_URL (a migrated Postgres)");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  LOG_LEVEL: "warn",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function merchantWithKey() {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Export stream ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label: "export" });
  return { merchantId, headers: { authorization: `Bearer ${issued.rawKey}` } };
}

async function insertTransaction(merchantId: string, occurredAt: string, reference: string | null = null) {
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, reference, acquirer_reference, occurred_at)
     VALUES ($1, 'captured', 1000, 1000, $2, $3, $4)`,
    [merchantId, reference, `acq_${randomUUID()}`, occurredAt],
  );
}

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of chunks) out += chunk;
  return out;
}

test("the export route requires from and to", async () => {
  const m = await merchantWithKey();
  const res = await app.inject({ method: "GET", url: "/v1/transactions/export", headers: m.headers });
  assert.equal(res.statusCode, 400, res.body);
});

test("the export route rejects invalid dates with 400, not 500", async () => {
  const m = await merchantWithKey();
  const res = await app.inject({
    method: "GET",
    url: "/v1/transactions/export?from=yesterday&to=2026-04-01T00:00:00Z",
    headers: m.headers,
  });
  assert.equal(res.statusCode, 400, res.body);
});

test("the export route refuses a range longer than 93 days", async () => {
  const m = await merchantWithKey();
  const res = await app.inject({
    method: "GET",
    url: "/v1/transactions/export?from=2026-01-01T00:00:00Z&to=2026-04-05T00:00:00Z",
    headers: m.headers,
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "export_range_too_large");
});

test("the export route streams every row in the range as CSV", async () => {
  const m = await merchantWithKey();
  for (let i = 0; i < 5; i++) {
    await insertTransaction(m.merchantId, `2026-04-0${i + 1}T10:00:00Z`, `order-${i}`);
  }
  await insertTransaction(m.merchantId, "2026-06-01T10:00:00Z", "outside-range");

  const res = await app.inject({
    method: "GET",
    url: "/v1/transactions/export?from=2026-04-01T00:00:00Z&to=2026-05-01T00:00:00Z",
    headers: m.headers,
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers["content-type"]), /^text\/csv/);
  const lines = res.body.trim().split("\n");
  assert.equal(lines[0], "id,status,amount_bhd,captured_bhd,reference,occurred_at");
  assert.equal(lines.length, 6, "header plus the 5 rows in range");
  assert.ok(!res.body.includes("outside-range"));
});

test("rows sharing a timestamp across a page boundary are all exported", async () => {
  const m = await merchantWithKey();
  for (let i = 0; i < 5; i++) {
    await insertTransaction(m.merchantId, "2026-04-10T10:00:00Z", `same-${i}`);
  }
  const csv = await collect(
    transactionsExportCsvChunks(
      pool,
      { merchantId: m.merchantId, from: new Date("2026-04-01T00:00:00Z"), to: new Date("2026-05-01T00:00:00Z") },
      { pageSize: 2 },
    ),
  );
  for (let i = 0; i < 5; i++) {
    assert.ok(csv.includes(`same-${i}`), `row same-${i} missing from the export`);
  }
  assert.equal(csv.trim().split("\n").length, 6);
});

test("cells that a spreadsheet would run as a formula are neutralised", async () => {
  const m = await merchantWithKey();
  const references = ['=HYPERLINK("http://evil.example","x")', "+1+1", "-2+3", "@SUM(A1)"];
  for (const ref of references) {
    await insertTransaction(m.merchantId, "2026-04-15T10:00:00Z", ref);
  }
  const csv = await collect(
    transactionsExportCsvChunks(pool, {
      merchantId: m.merchantId,
      from: new Date("2026-04-01T00:00:00Z"),
      to: new Date("2026-05-01T00:00:00Z"),
    }),
  );
  const cells = csv
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split(",").slice(4, -1).join(","));
  for (const cell of cells) {
    const unquoted = cell.startsWith('"') ? cell.slice(1) : cell;
    assert.ok(unquoted.startsWith("'"), `expected a leading quote mark, got ${cell}`);
  }
});
