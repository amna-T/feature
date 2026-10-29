// YA (Mar): parked until the refunds API exists — FP-212
// MK: drawer is done, just uncomment + add the route. 30 min job
// FH: claude review: posts to /v1/refunds but initiateMerchantRefund expects /v1/merchants/:id/refunds,
// and it makes a new idempotency key per click. check before uncommenting
// max refund = captured is right, partial refunds are tracked server side — am
/**
 * Parked, not wired. Updated for FP-212 to call `POST /v1/refunds` with the
 * transaction in the body; the merchant comes from the session server-side.
 * The route is behind FEATURE_REFUNDS and answers 501 while it is off, so
 * this stays imported nowhere until the flag is turned on. Uncomment and
 * render it from TransactionDetailPage in the same change that enables it.
 */

/*
import { useRef, useState } from "react";
import { request } from "../../api/client.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import type { TransactionDto } from "../../types.js";

interface RefundResponse {
  id: string;
  transactionId: string;
  amountFils: number;
  feeReversedFils: number;
  status: string;
  transactionStatus: string;
  refundedTotalFils: number;
  occurredAt: string;
}

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

const REFUNDABLE_STATUSES = new Set(["captured", "partially_captured", "partially_refunded"]);

export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per refund attempt, not per click: resubmitting the same request
  // (a network retry, an acquirer timeout) reuses it, so the server replays
  // the first result instead of refunding twice. Opening the form or changing
  // the amount starts a new attempt.
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  const refundable = REFUNDABLE_STATUSES.has(txn.status);

  function startNewAttempt(): void {
    idempotencyKey.current = crypto.randomUUID();
  }

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!me) return;
    if (!window.confirm("Refund this transaction? The money goes back to the cardholder and cannot be recalled.")) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const trimmed = amount.trim();
      // Left blank, amountFils is omitted entirely and the API refunds
      // everything still refundable — its own documented default, same
      // affordance the capture form has.
      const body = trimmed === "" ? { transactionId: txn.id } : { transactionId: txn.id, amountFils: Number(trimmed) };

      await request<RefundResponse>("/v1/refunds", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey.current },
        body: JSON.stringify(body),
      });

      setOpen(false);
      setAmount("");
      startNewAttempt();
      // Refetch rather than patch: the refund wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await onRefunded();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!refundable) return null;

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {error ? <p className="dash-error">{error}</p> : null}
        {open ? (
          <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
            <label>
              Amount in fils (blank refunds everything still refundable)
              <input
                type="number"
                min={1}
                step={1}
                max={txn.capturedFils}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  startNewAttempt();
                }}
              />
            </label>
            <p className="dash-muted">Captured so far: {bhd(txn.capturedFils)}</p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="dash-button"
            onClick={() => {
              startNewAttempt();
              setOpen(true);
            }}
          >
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
*/

export {};
