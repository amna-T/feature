import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";
import type { TransactionRow } from "./serialize.js";

export interface TransactionsExportFilters {
  merchantId: string;
  from?: Date;
  to?: Date;
  status?: string[];
}

const HEADER = "id,status,amount_bhd,captured_bhd,reference,occurred_at";
const DEFAULT_PAGE_SIZE = 1000;

/**
 * One CSV cell. A value starting with = + - @ (or a tab or carriage return)
 * is run as a formula by Excel and other spreadsheets, so a reference such
 * as `=HYPERLINK(...)` could act when finance opens the file. Those get a
 * leading `'`, which spreadsheets show as text.
 */
function csvEscape(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n") || safe.includes("\r")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function toCsvRow(row: TransactionRow): string {
  return [
    row.id,
    row.status,
    formatBhd(toFils(Number(row.amount_fils))),
    formatBhd(toFils(Number(row.captured_fils))),
    csvEscape(row.reference ?? ""),
    row.occurred_at.toISOString(),
  ].join(",");
}

/**
 * Pages of matching transactions, oldest first. Keyset pagination on
 * (occurred_at, id): rows that share a timestamp across a page boundary are
 * neither skipped nor repeated. Only one page is held in memory at a time.
 */
async function* transactionPages(
  pool: Pool,
  filters: TransactionsExportFilters,
  pageSize: number,
): AsyncGenerator<TransactionRow[]> {
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  let after: { occurredAt: Date; id: string } | null = null;

  while (true) {
    const result: { rows: TransactionRow[] } = await pool.query<TransactionRow>(
      `SELECT * FROM transactions
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR occurred_at <  $3)
          AND ($4::text[] IS NULL OR status = ANY($4))
          AND ($5::timestamptz IS NULL OR (occurred_at, id) > ($5, $6::uuid))
        ORDER BY occurred_at ASC, id ASC
        LIMIT $7`,
      [
        filters.merchantId,
        filters.from ?? null,
        filters.to ?? null,
        statusArray,
        after?.occurredAt ?? null,
        after?.id ?? null,
        pageSize,
      ],
    );
    if (result.rows.length > 0) yield result.rows;
    if (result.rows.length < pageSize) return;
    const last = result.rows[result.rows.length - 1]!;
    after = { occurredAt: last.occurred_at, id: last.id };
  }
}

/**
 * The export as CSV text chunks: the header line, then one chunk per page of
 * rows, each line ending in "\n". `GET /v1/transactions/export` streams
 * these, so memory stays at one page however long the range is.
 */
export async function* transactionsExportCsvChunks(
  pool: Pool,
  filters: TransactionsExportFilters,
  options: { pageSize?: number } = {},
): AsyncGenerator<string> {
  yield `${HEADER}\n`;
  for await (const rows of transactionPages(pool, filters, options.pageSize ?? DEFAULT_PAGE_SIZE)) {
    yield rows.map((row) => `${toCsvRow(row)}\n`).join("");
  }
}

/**
 * The whole export as one string (header plus one line per transaction, no
 * trailing newline). Holds every row in memory: for small, bounded callers
 * only. The HTTP route streams `transactionsExportCsvChunks` instead.
 */
export async function buildTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
): Promise<string> {
  const lines = [HEADER];
  for await (const rows of transactionPages(pool, filters, DEFAULT_PAGE_SIZE)) {
    for (const row of rows) lines.push(toCsvRow(row));
  }
  return lines.join("\n");
}
