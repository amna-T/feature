import { createHmac } from "node:crypto";

/** Verifies the signature on an inbound acquirer callback. */

interface ParsedAcquirerSignatureHeader {
  timestamp: number;
  signature: string;
}

function parseAcquirerSignatureHeader(header: string): ParsedAcquirerSignatureHeader | null {
  let timestampStr: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key === "t") timestampStr = value;
    else if (key === "v1") signature = value;
  }

  if (!timestampStr || !signature) return null;
  if (!/^\d+$/.test(timestampStr)) return null;

  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return null;

  return { timestamp, signature };
}

export type VerifyAcquirerCallbackFailureReason = "malformed_header" | "signature_mismatch" | "timestamp_out_of_tolerance";

export interface VerifyAcquirerCallbackResult {
  valid: boolean;
  reason?: VerifyAcquirerCallbackFailureReason;
}

function constantTimeEquals(a: string, b: string): boolean {
  return Buffer.from(a).length === Buffer.from(b).length &&
    Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/**
 * Verifies the acquirer callback signature when present and required.
 *
 * `payload` should be the request body exactly as received (string or
 * Buffer): the acquirer signs the bytes it sent. Re-serialising the parsed
 * JSON only matched when the acquirer happened to format its JSON the way
 * JSON.stringify does (no spaces, same key order, same number rendering);
 * otherwise every genuine callback was rejected. A parsed object is still
 * accepted, signed as JSON.stringify(payload), for callers that have no raw body.
 */
export function verifyAcquirerCallbackSignature(
  payload: unknown,
  header: string | undefined,
  secret: string,
  requireSignature = false,
  options?: { toleranceSeconds?: number; now?: number },
): VerifyAcquirerCallbackResult {
  if (!header) {
    return requireSignature
      ? { valid: false, reason: "malformed_header" }
      : { valid: true };
  }

  const parsed = parseAcquirerSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  const body = typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.`)
    .update(body)
    .digest("hex");

  if (!constantTimeEquals(expected, parsed.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  if (options?.toleranceSeconds !== undefined) {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - parsed.timestamp) > options.toleranceSeconds) {
      return { valid: false, reason: "timestamp_out_of_tolerance" };
    }
  }

  return { valid: true };
}
