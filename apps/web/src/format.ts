import { formatBhd, parseBhdToFils, toFils } from "@filspay/money";

/**
 * The dashboard's display helpers. Deliberately thin: `bhd` delegates to
 * `@filspay/money`'s `formatBhd`, the same formatter the checkout page uses,
 * so there is exactly one answer to "how is a BHD amount shown" across both
 * halves of this app. Never `/1000`, never `toFixed`.
 */
/** Negative amounts are valid here: refund timeline events and a negative reconciliation gap. */
export function bhd(amountFils: number): string {
  return `${formatBhd(toFils(amountFils, { allowNegative: true }))} BHD`;
}

/** `—` for a null/absent value, so an empty table cell is visibly empty
 *  rather than ambiguously blank. */
export function dash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

/** Browser-local rendering, not Asia/Bahrain. */
export function dateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/**
 * An `<input type="date">` value (YYYY-MM-DD) as the ISO instant of that
 * day's Asia/Bahrain midnight (UTC+3, no DST), so the transaction filters
 * use the same business day as settlement and reconciliation. It used UTC
 * midnight, 3 hours off every settlement day, despite a note saying fixed.
 */
export function dayStartIso(dateValue: string): string | undefined {
  return dateValue ? new Date(`${dateValue}T00:00:00+03:00`).toISOString() : undefined;
}

/**
 * A `<input type="datetime-local">` value (local wall time, no zone) as an
 * ISO 8601 instant. `new Date(local)` interprets it in the browser's own
 * timezone, which is what the user meant when they typed it.
 */
export function localDateTimeToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * An amount typed by a person, in BHD ("5", "4.75", "4.750"), as fils.
 * Inputs used to take raw fils, so "5" meant 5 fils, not 5 BHD, and the
 * natural "4.750" was rejected. Null for anything that is not a positive
 * amount with at most 3 decimals.
 */
export function parseBhdInput(value: string): number | null {
  try {
    const fils = parseBhdToFils(value) as number;
    return fils > 0 ? fils : null;
  } catch {
    return null;
  }
}
