/**
 * Replaces the password of every merchant user and every admin, and signs
 * everyone out. For a hosted demo seeded with `npm run seed`: the seeded
 * passwords are in the repository, so they must not stay valid on a public
 * server (and with OTP_DEV_EXPOSE on, the login code is shown on screen).
 *
 * Usage (on the server, after seeding):
 *   MERCHANT_PASSWORD='...' ADMIN_PASSWORD='...' DATABASE_URL=postgres://... npx tsx scripts/set_passwords.ts
 */
import { Client } from "pg";
import { hashPassword } from "../apps/api/src/auth/passwords.js";
import { loadConfig } from "../apps/api/src/config.js";

const MIN_LENGTH = 12;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const merchantPassword = process.env.MERCHANT_PASSWORD ?? "";
  const adminPassword = process.env.ADMIN_PASSWORD ?? "";
  if (!databaseUrl) throw new Error("set_passwords: DATABASE_URL is not set");
  if (merchantPassword.length < MIN_LENGTH || adminPassword.length < MIN_LENGTH) {
    throw new Error(`set_passwords: MERCHANT_PASSWORD and ADMIN_PASSWORD must each be at least ${MIN_LENGTH} characters`);
  }
  if (merchantPassword === adminPassword) {
    throw new Error("set_passwords: use different passwords for merchants and admins");
  }

  // Same argon2 parameters the API verifies with.
  const config = loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: "development" });
  const merchantHash = await hashPassword(merchantPassword, config);
  const adminHash = await hashPassword(adminPassword, config);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const merchants = await client.query(`UPDATE merchant_users SET password_hash = $1`, [merchantHash]);
    const admins = await client.query(`UPDATE admin_users SET password_hash = $1`, [adminHash]);
    // Nobody stays signed in on the old passwords.
    await client.query(`UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL`);
    await client.query(`UPDATE admin_sessions SET revoked_at = now() WHERE revoked_at IS NULL`);
    await client.query("COMMIT");
    console.log(`set_passwords: ${merchants.rowCount} merchant users and ${admins.rowCount} admins updated; all sessions signed out`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
