import type { QueryableClient } from "@filspay/events";

/**
 * reporting_outbox_cursor read/advance — this consumer's own watermark,
 * never a reuse of outbox_events.processed_at.
 */
/** A position in commit order: (writing transaction id, outbox id). */
export interface ConsumerCursor {
  lastProcessedTxid: string;
  lastProcessedId: bigint;
}

/**
 * last_processed_id is BIGINT; pg returns it as a string, hence the union.
 * last_processed_txid is xid8, returned as text.
 */
interface CursorRow {
  last_processed_txid: string;
  last_processed_id: string | number;
}

/**
 * Seeds the row on first ever run (INSERT ... ON CONFLICT DO NOTHING),
 * then reads it. Never throws on a missing row — a worker's first pass
 * against a fresh database always starts from 0.
 */
// am: no FOR UPDATE on the cursor read, two passes can read the same watermark? nvm the `running` flag in listener.ts guards it
export async function readCursor(client: QueryableClient, consumerName: string): Promise<ConsumerCursor> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id)
     VALUES ($1, 0)
     ON CONFLICT (consumer_name) DO NOTHING`,
    [consumerName],
  );

  const result = (await client.query(
    `SELECT last_processed_txid::text AS last_processed_txid, last_processed_id
       FROM reporting_outbox_cursor WHERE consumer_name = $1`,
    [consumerName],
  )) as { rows: CursorRow[] };

  const row = result.rows[0];
  return row
    ? { lastProcessedTxid: row.last_processed_txid, lastProcessedId: BigInt(row.last_processed_id) }
    : { lastProcessedTxid: "0", lastProcessedId: 0n };
}

// YA: absolute SET is fine, only one writer.
export async function advanceCursor(
  client: QueryableClient,
  consumerName: string,
  position: ConsumerCursor,
): Promise<void> {
  await client.query(
    `UPDATE reporting_outbox_cursor
        SET last_processed_txid = $2::xid8, last_processed_id = $3, updated_at = now()
      WHERE consumer_name = $1`,
    [consumerName, position.lastProcessedTxid, position.lastProcessedId.toString()],
  );
}

/** Resets this consumer's watermark to 0 — used only by the `rebuild`
 *  subcommand (cli/rebuild.ts) before replaying the entire outbox history. */
// MK: rebuild only. never call from the worker.
export async function resetCursor(client: QueryableClient, consumerName: string): Promise<void> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_txid, last_processed_id, updated_at)
     VALUES ($1, '0', 0, now())
     ON CONFLICT (consumer_name) DO UPDATE SET last_processed_txid = '0', last_processed_id = 0, updated_at = now()`,
    [consumerName],
  );
}
