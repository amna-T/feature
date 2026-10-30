#!/usr/bin/env -S npx tsx
/**
 * CLI entry point: generate() the deterministic seed, then run every
 * self-verify assertion against it. Exits non-zero iff any REAL assertion
 * fails.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx db/seed/index.ts
 */
import { Pool } from "pg";
import { generate } from "./generate.js";
import { buildAssertions, runAssertions } from "./selfVerify.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("seed: DATABASE_URL environment variable is not set");
  }

  // generate() runs TRUNCATE ... CASCADE on merchants, transactions,
  // ledger_entries, admin_users (and so every table referencing them), twice
  // counting the self-check, and re-creates admins whose passwords are in
  // git. Against the hosted database that is a full wipe plus a known
  // super_admin password, so refuse unless explicitly told otherwise.
  if (process.env.NODE_ENV === "production" && process.env.SEED_ALLOW_DATABASE_WIPE !== "yes") {
    throw new Error(
      "seed: refusing to run with NODE_ENV=production: it truncates every merchant, transaction, ledger and admin " +
        "table. Set SEED_ALLOW_DATABASE_WIPE=yes only for a disposable database.",
    );
  }

  // SEED_SIZE accepts small | full, but only 'small' is really implemented
  // so far — 'full' currently generates the same data.
  const seedSize = process.env.SEED_SIZE ?? "small";
  if (seedSize !== "small" && seedSize !== "full") {
    throw new Error(`seed: SEED_SIZE must be 'small' or 'full', got '${seedSize}'`);
  }

  // A Pool (not a bare Client): generate() needs its own checked-out client
  // for the main truncate+insert transaction, and needs the pool again
  // afterward for recordKycReview()/issueApiKey(), which open their own
  // transactions once that first one has committed and released.
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });

  try {
    const summary = await generate(pool);
    console.log(
      `seed: generated ${summary.merchantCount} merchants, ${summary.merchantUserCount} merchant_users, ` +
        `${summary.transactionCount} transactions, ${summary.ledgerEntryCount} ledger_entries ` +
        `(${summary.ledgerGroupCount} groups), ${summary.holdCount} holds, ` +
        `${summary.settlementBatchCount} settlement_batches, ${summary.schemeExportLineCount} scheme_export_lines, ` +
        `${summary.outboxEventCount} outbox_events, ${summary.transactionEventCount} transaction_events, ` +
        `${summary.splitChildCount} merchant_split_children, ${summary.feeScheduleCount} fee_schedules, ` +
        `${summary.businessProfileCount} business_profiles, ` +
        `${summary.kycReviewCount} kyc_reviews, ${summary.apiKeyCount} api_keys, ` +
        `${summary.adminUserCount} admin_users`,
    );
    console.log(`seed: ledger_entries checksum = ${summary.ledgerChecksum}`);
    console.log("");

    const assertions = buildAssertions(pool, { initialLedgerChecksum: summary.ledgerChecksum });
    const allRealPassed = await runAssertions(assertions);

    if (!allRealPassed) {
      console.error("\nseed: one or more REAL assertions failed");
      process.exitCode = 1;
    } else {
      console.log("\nseed: all REAL assertions passed");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
