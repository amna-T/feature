import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { formatBhd, toFils } from "@filspay/money";
import { getPaymentLink, payPaymentLink } from "../../api/paymentLinks.js";
import { ApiError } from "../../api/client.js";
import type { PaymentLinkPublicDto, PayPaymentLinkResponse, SimulatedCardInput } from "../../types.js";
import { BrandMark } from "../../components/BrandMark.js";
import { formatCardBrandHint, groupCardNumber } from "../../utils/helpers.js";
import "./CheckoutPage.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "loaded"; link: PaymentLinkPublicDto };

type PayState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: PayPaymentLinkResponse }
  | { kind: "declined"; message: string; retryable: boolean }
  | { kind: "terminal"; message: string };

const THIS_YEAR = new Date().getFullYear();
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const YEARS = Array.from({ length: 15 }, (_, i) => THIS_YEAR + i);

/** Shown in Bahrain time, the shopper's and the merchant's own clock. */
function bahrainTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Bahrain",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "4.750" with the fils part set apart, so the three decimals read clearly. */
function Amount({ fils, className }: { fils: number; className?: string }) {
  const [whole, part] = formatBhd(toFils(fils)).split(".");
  return (
    <span className={className}>
      {whole}
      <span className="checkout-fils">.{part}</span>
      <span className="checkout-currency">BHD</span>
    </span>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="checkout-backdrop">
      <header className="checkout-topline">
        <BrandMark tagline="Secure checkout" />
      </header>
      {children}
      <footer className="checkout-footer">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z" />
        </svg>
        Encrypted connection · card details go straight to the acquirer, never to the merchant
      </footer>
    </div>
  );
}

type NoticeTone = "ok" | "warn" | "bad";

function Notice({ tone, title, children }: { tone: NoticeTone; title: string; children: React.ReactNode }) {
  const icon = tone === "ok" ? "M5 12l4 4L19 6" : tone === "warn" ? "M12 7v6m0 4h.01" : "M7 7l10 10M17 7L7 17";
  return (
    <Shell>
      <main className="checkout-page checkout-page-notice">
        <div className={`checkout-notice-icon checkout-notice-${tone}`}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={icon} />
          </svg>
        </div>
        <h1>{title}</h1>
        {children}
      </main>
    </Shell>
  );
}

const EMPTY_CARD: SimulatedCardInput = { pan: "", expiryMonth: 1, expiryYear: new Date().getFullYear() + 1, cvv: "" };

export function CheckoutPage() {
  const { token } = useParams<{ token: string }>();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [payState, setPayState] = useState<PayState>({ kind: "idle" });
  const [card, setCard] = useState<SimulatedCardInput>(EMPTY_CARD);

  // FH: memory leak — this effect never aborts the fetch on unmount (React warning in console?)
  // theres a cancelled flag in the cleanup tho. warning must be from somewhere else — am
  useEffect(() => {
    if (!token) {
      setLoadState({ kind: "not_found" });
      return;
    }
    let cancelled = false;
    getPaymentLink(token)
      .then((link) => {
        if (!cancelled) setLoadState({ kind: "loaded", link });
      })
      .catch(() => {
        // Never distinguishes "malformed token" from "doesn't exist" —
        // matches the API's own non-disclosure choice.
        if (!cancelled) setLoadState({ kind: "not_found" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!token) return;

    // A fresh Idempotency-Key per explicit user action — every click,
    // including a "try again" after a decline, is a new attempt.
    const idempotencyKey = crypto.randomUUID();
    const submittedAt = new Date().toISOString();
    setPayState({ kind: "submitting" });

    try {
      const result = await payPaymentLink(token, { card, submittedAt }, idempotencyKey);
      setPayState({ kind: "success", result });
    } catch (err) {
      if (err instanceof ApiError) {
        const { statusCode, body } = err;
        if (statusCode === 402) {
          const stageLabel = body.stage === "capture" ? "Your payment could not be completed." : "Your card was declined.";
          setPayState({ kind: "declined", message: stageLabel, retryable: true });
        } else if (statusCode === 502) {
          setPayState({ kind: "declined", message: "The acquirer is temporarily unavailable. Please try again.", retryable: true });
        } else if (statusCode === 409 && body.error === "payment_link_already_paid") {
          setPayState({ kind: "terminal", message: "This invoice has already been paid." });
        } else if (statusCode === 409 && body.error === "payment_link_canceled") {
          setPayState({ kind: "terminal", message: "This payment link is no longer available." });
        } else if (statusCode === 409) {
          setPayState({ kind: "declined", message: "A payment is already being processed for this link. Please try again shortly.", retryable: true });
        } else if (statusCode === 410) {
          setPayState({ kind: "terminal", message: "This payment link has expired." });
        } else {
          setPayState({ kind: "declined", message: body.message ?? "Something went wrong. Please try again.", retryable: true });
        }
      } else {
        setPayState({ kind: "declined", message: "Something went wrong. Please try again.", retryable: true });
      }
    }
  }

  if (loadState.kind === "loading") {
    return (
      <Shell>
        <main className="checkout-page checkout-page-notice">
          <div className="checkout-spinner" aria-label="Loading" />
        </main>
      </Shell>
    );
  }

  if (loadState.kind === "not_found") {
    return (
      <Notice tone="bad" title="Payment link not found">
        <p>This payment link does not exist. Check the link the merchant sent you.</p>
      </Notice>
    );
  }

  const { link } = loadState;

  if (payState.kind === "success") {
    return (
      <Notice tone="ok" title="Payment successful">
        <p>Thank you — your payment to {link.merchantDisplayName} has been received.</p>
        <dl className="checkout-receipt">
          <dt>Amount</dt>
          <dd>
            <Amount fils={payState.result.amountFils} />
          </dd>
          <dt>Paid to</dt>
          <dd>{link.merchantDisplayName}</dd>
          {link.reference ? (
            <>
              <dt>Reference</dt>
              <dd>{link.reference}</dd>
            </>
          ) : null}
          <dt>Paid at</dt>
          <dd>{bahrainTime(payState.result.paidAt)}</dd>
          <dt>Transaction ID</dt>
          <dd className="checkout-mono">{payState.result.transactionId}</dd>
        </dl>
        <p className="checkout-help">Keep this page or take a screenshot as your receipt.</p>
      </Notice>
    );
  }

  if (payState.kind === "terminal") {
    return (
      <Notice tone="bad" title="Unable to pay">
        <p>{payState.message}</p>
      </Notice>
    );
  }

  if (link.status === "paid") {
    return (
      <Notice tone="ok" title="Already paid">
        <p>This invoice from {link.merchantDisplayName} has already been paid. Nothing more is due.</p>
      </Notice>
    );
  }
  if (link.status === "expired") {
    return (
      <Notice tone="warn" title="Link expired">
        <p>This payment link has expired. Ask {link.merchantDisplayName} for a new one.</p>
      </Notice>
    );
  }
  if (link.status === "canceled") {
    return (
      <Notice tone="bad" title="No longer available">
        <p>This payment link is no longer available.</p>
      </Notice>
    );
  }
  if (link.status === "processing") {
    return (
      <Notice tone="warn" title="Payment processing">
        <p>A payment is being processed for this link — please wait a moment and refresh.</p>
      </Notice>
    );
  }

  // link.status === 'active'
  const amount = formatBhd(toFils(link.amountFils));
  const submitting = payState.kind === "submitting";
  const digits = card.pan.replace(/\D/g, "");
  const brand = digits.length >= 1 ? formatCardBrandHint(digits) : "unknown";
  const shownNumber = (digits + "•".repeat(Math.max(0, 16 - digits.length))).replace(/(.{4})(?=.)/g, "$1 ");

  return (
    <Shell>
      <main className="checkout-page checkout-page-pay">
        <section className="checkout-summary">
          <div className="checkout-merchant">
            <span className="checkout-merchant-avatar" aria-hidden="true">
              {link.merchantDisplayName.slice(0, 1).toUpperCase()}
            </span>
            <span>
              <span className="checkout-label">Pay</span>
              <h1>{link.merchantDisplayName}</h1>
            </span>
          </div>
          <span className="checkout-label">Amount due</span>
          <Amount fils={link.amountFils} className="checkout-amount" />
          {link.description ? <p className="checkout-description">{link.description}</p> : null}
          <dl className="checkout-meta">
            {link.reference ? (
              <>
                <dt>Reference</dt>
                <dd>{link.reference}</dd>
              </>
            ) : null}
            <dt>Valid until</dt>
            <dd>{bahrainTime(link.expiresAt)}</dd>
          </dl>
        </section>

        <section className="checkout-pay">
          <div className={`checkout-card checkout-card-${brand}`} aria-hidden="true">
            <div className="checkout-card-top">
              <span className="checkout-card-chip" />
              <span className="checkout-card-brand">{brand === "unknown" ? "" : brand}</span>
            </div>
            <div className="checkout-card-number">{shownNumber}</div>
            <div className="checkout-card-bottom">
              <span>
                <span className="checkout-card-caption">Valid thru</span>
                {String(card.expiryMonth).padStart(2, "0")}/{String(card.expiryYear).slice(-2)}
              </span>
              <span className="checkout-card-pearl" />
            </div>
          </div>

          {payState.kind === "declined" ? (
            <p className="checkout-error" role="alert">
              {payState.message}
            </p>
          ) : null}

          <form onSubmit={handleSubmit} className="checkout-form">
            <label>
              Card number
              <input
                type="text"
                inputMode="numeric"
                autoComplete="cc-number"
                placeholder="1234 5678 9012 3456"
                required
                value={card.pan}
                onChange={(e) => setCard({ ...card, pan: groupCardNumber(e.target.value) })}
              />
            </label>
            <div className="checkout-form-row">
              <label>
                Month
                <select
                  autoComplete="cc-exp-month"
                  value={card.expiryMonth}
                  onChange={(e) => setCard({ ...card, expiryMonth: Number(e.target.value) })}
                >
                  {MONTHS.map((m) => (
                    <option key={m} value={m}>
                      {String(m).padStart(2, "0")}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Year
                <select
                  autoComplete="cc-exp-year"
                  value={card.expiryYear}
                  onChange={(e) => setCard({ ...card, expiryYear: Number(e.target.value) })}
                >
                  {YEARS.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                CVV
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="cc-csc"
                  placeholder="•••"
                  maxLength={4}
                  required
                  value={card.cvv}
                  onChange={(e) => setCard({ ...card, cvv: e.target.value.replace(/\D/g, "") })}
                />
              </label>
            </div>
            <button type="submit" className="checkout-submit" disabled={submitting}>
              {submitting ? (
                <>
                  <span className="checkout-spinner checkout-spinner-small" /> Processing…
                </>
              ) : (
                `Pay ${amount} BHD`
              )}
            </button>
          </form>

          <details className="checkout-help">
            <summary>Test cards</summary>
            Simulated acquirer, no real charge: any other number approves; a PAN ending <code>0002</code> always
            declines (do not honor); ending <code>0119</code> always declines (insufficient funds); ending{" "}
            <code>0069</code> always errors.
          </details>
        </section>
      </main>
    </Shell>
  );
}
