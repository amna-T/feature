# Changelog

All notable changes to FilsPay. Dates are deploy dates (Asia/Bahrain).
Versions are the API image tag; settlement and reporting are versioned with
it. Format loosely follows Keep a Changelog.

## [Unreleased]

### UI: "Pearl" redesign
- Merchant dashboard: sidebar navigation with icons, a live "business day ·
  settles in" clock (Asia/Bahrain midnight, ADR-0003), status pills, card
  tables and detail lists, branded sign-in.
- Checkout: two-panel layout with the amount's fils digits set apart, a live
  card preview, grouped card number, month/year pickers, masked CVV, and
  clear success, expired and declined screens with a receipt in Bahrain time.
- Admin console: same family on a darker "Operations" sidebar so the two
  planes can't be confused; the impersonation banner stays loud.
- Styling only plus layout markup: no API, money or role logic changed.
### Hosting and deployment (PRs #15, #17–#20)
- `ops/deploy.sh`: pull, build, migrate, restart and health-check in one
  command. It refuses to run in the nightly settlement window (00:00–01:00
  Bahrain) unless `FORCE=1`, and settlement gets a 120 s stop grace period so
  an in-flight batch transaction can finish.
- The proxy image serves the merchant dashboard and checkout at
  `https://SITE_ADDRESS/` and the admin console at `:8443`, and proxies `/v1`
  to the API on the same origin. Production frontend builds call the API on
  their own origin (they fell back to `http://localhost:3000`), and payment
  links use `CHECKOUT_BASE_URL=https://SITE_ADDRESS` (they pointed at
  `http://localhost:5173`).
- `POSTGRES_PASSWORD` is required from the environment; the dev password is no
  longer hard-coded in compose.
- Caddy sends HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy
  and a same-origin Content-Security-Policy, and drops the Server header.
- HTTPS works on a bare IP address (`default_sni`).
- Caddy memory limit raised from 64 MB to 128 MB.
- `scripts/set_passwords.ts` replaces the seeded (public) merchant and admin
  passwords; hosted demos set `OTP_DEV_EXPOSE=true` because there is no
  email/SMS delivery for login codes.
- Capacity measured on the hosted box: 14 checkouts/s sustained, ceiling
  about 15/s (`ops/loadtest/README.md`).
- `docs/ai-setup/`: the team's AI configuration (permission rules, custom
  commands, MCP config), proposed for a human to install.

### Dashboard and admin (PR #14)
- `/` goes to the dashboard; unknown pages and render errors show friendly
  "Page not found" / "Something went wrong" pages instead of React Router's
  developer screen.

### Final sweep (FINDINGS.md §13)
- Checkout: card details are validated (including expiry) before the link is
  reserved; a malformed card can no longer leave a payment link stuck
  'reserved', and an expired card is refused.
- Bad input is a 400, never a 500: invalid amounts on authorize/capture,
  malformed JSON bodies on every route, malformed ids and invalid dates.

### Audit round 6 (FINDINGS.md §12)
- Transactions CSV export: the page cursor lost microseconds, repeating rows
  at page boundaries and looping forever when a page's worth of rows shared
  one millisecond. Now keyed on Postgres's own timestamp text.
- Webhook fan-out reads new outbox events from a commit-order cursor instead
  of rescanning the whole outbox on every capture.
- `ops/.env.docker` is no longer committed (template: `.env.docker.example`);
  the old callback signing secret is burned and must be rotated.
- Acquirer callbacks are verified over the raw request body.
- A refund interrupted mid-acquirer-call can be retried (same acquirer key).
- KYC-verified profile fields are locked once review starts.
- Credits: the second-approver threshold counts the last 24 h, not one request.
- Adjustment CSV: re-uploading the same rows is refused unless confirmed.
- Adjust balance is journaled (ADR-0006 superseded).
- Split payouts update the payout monitoring total.
- Dashboard: refund and capture amounts are entered in BHD; role-gated
  controls stay hidden until the role is known; Reconciliation is gated;
  the meaningless batch "progress bar" is gone.
- Removed the dead `apps/api/src/v1` tree and `production_seed.sql`.

### Hosting
- `ops/Dockerfile.node` and `ops/Dockerfile.go` added; compose references
  them and the stack could not be built without them.
- Caddy TLS reverse proxy in front of the API; only 80/443 are published.
  The API trusts X-Forwarded-For for one hop (`TRUST_PROXY=1`) so per-IP
  login limits see real client addresses.
- Compose: API limited to 0.5 vCPU / 512 MB with a 384 MB Node heap, limits
  on every service, `restart: unless-stopped`, API health check, Postgres
  memory tuning, `LOG_LEVEL=warn`, `PG_POOL_MAX=10`.
- The API and reporting run prebuilt bundles (`npm run build`) instead of
  `npx tsx`.
- Overload: once 20 requests are waiting for a database connection, new ones
  get `503 overloaded` with `Retry-After: 1` at once, and a connection
  timeout is a 503 instead of a 500. Request, keep-alive and connection
  timeouts are set. Capacity measured: about 15 checkouts/s
  (`ops/loadtest/README.md`).

### Security
- Login lockout can no longer be used to lock someone out: the per-account
  failure limit counts per account and client IP, and refused (429) attempts
  are not recorded.
- CSV export: cells starting with `=`, `+`, `-` or `@` get a leading `'` so
  spreadsheets don't run them as formulas.
- Login limits on the merchant and admin planes. Over the last 15 minutes:
  5 failed passwords per account, 50 per client IP, and 5 OTP challenges per
  user (login and resend together). Over a limit, login answers
  `429 too_many_attempts` with `Retry-After`, before any password is hashed.
  Previously guesses were unlimited, and logging in again (or resending)
  handed out a fresh OTP attempt budget each time. Settings:
  `LOGIN_WINDOW_MINUTES`, `LOGIN_MAX_FAILURES_PER_ACCOUNT`,
  `LOGIN_MAX_FAILURES_PER_IP`, `OTP_MAX_CHALLENGES_PER_USER`.

### Added
- Refunds (FP-212): `POST /v1/refunds` for full and partial refunds, behind
  `FEATURE_REFUNDS` (off by default; the route answers 501 while it is off).
- `refund.succeeded` webhook. `data`: `refundId`, `transactionId`,
  `merchantId`, `amountFils`, `feeReversedFils`, `refundedTotalFils`,
  `status` (the transaction's status after the refund).
- Transactions API: `refundedFils` on every transaction.
- Dashboard: Refund action on the transaction page (owner and finance),
  shown only while refunds are enabled.
- Reporting: refunds counted in the merchant daily volume rollup.

### Fixed
- Transaction status when a capture and a refund interleave: a capture after
  a partial refund no longer reports `captured`, and a refund racing a
  capture no longer overwrites the capture's status or logs a full refund
  for a partial one.

## [1.9.2] - 2026-09-12

### Changed
- Volume-tier threshold updated for the platform-wide discount (d69a813).
  No pricing change for existing merchants.
- Dependency bumps across the workspace.

### Fixed
- Config: settlement now reads `DATABASE_URL` consistently with the other
  services (b64cd3c).

## [1.9.1] - 2026-08-22

### Fixed
- Duplicate `settlement.paid` webhooks (incident 2026-08-21). Receivers
  should dedupe on `Webhook-Delivery-Id`.
- Reporting worker no longer holds an extra LISTEN connection after a
  reconnect (#398).

## [1.9.0] - 2026-07-21

### Added
- Acquirer callback notes (`acquirer_callback_notes`, migration 0051) and
  signed callback verification (`inboundVerify`).
- Reporting saved filters (migration 0069).

### Security
- Inbound acquirer callbacks are now signature-checked and deduplicated.

## [1.8.0] - 2026-06-24

### Added
- Transactions CSV export (`GET /v1/transactions/export`). Streams rows, so
  it is safe for large merchants on the 512 MB container.
- KYC document thumbnails.
- Webhook delivery archive and replay for support.

## [1.7.1] - 2026-06-09

### Added
- Admin: **Import adjustments** from finance's CSV sheets (BD amounts).
- Partial-batch payout corrections in settlement (76913d3).

### Fixed
- Net payout figure now derived once per batch, so the bank instruction,
  statement and report agree.

## [1.7.0] - 2026-06-03

### Added
- Admin: **Rebuild cached balances** (finance and above). Same rebuild as the
  `settlement rebuild-balances` CLI, exposed through the internal API.
- Admin: **Recalculate MDR** for a merchant and date range.
- Payout disbursement records (migration 0057).

## [1.6.0] - 2026-05-20

### Added
- Admin credits with second-approver workflow above the threshold.
- Admin: **Rebuild analytics**.
- Platform volume tier.

### Fixed
- Incident 2026-05-14: payment links could be captured more than once when
  the acquirer re-sent a callback. Callbacks are now deduplicated on
  `callbackId`.

## [1.5.0] - 2026-05-07

### Added
- Admin: bulk KYC approve.
- Admin: Adjust balance (support).

### Changed
- README money section rewritten for new hires.

## [1.4.0] - 2026-04-28

### Added
- `transactions.refunded_fils` (migration 0043) in preparation for refunds.
- Refunds: `processRefund`, `refundValidation`, `refundState` helpers and the
  dashboard `RefundDrawer` (behind a flag).

## [1.3.2] - 2026-04-09

### Fixed
- README typo.

## [1.3.1] - 2026-03-19

### Added
- Negotiated merchant discount (`negotiated_discount_bps`, migration 0047),
  applied after MDR at capture and settlement.
- Split settlement for marketplaces.

### Fixed
- March reconciliation: scheme rounding residue swept to suspense (one-off,
  `scripts/reconcile_march.ts`). March ties out.

## [1.3.0] - 2026-03-10

### Added
- Third-decimal scheme amount on export lines (`amount_3dp`, migration 0038)
  so the residue can be posted per line.

### Removed
- `amount_3dp` reverted the same week; migration number reused for KYC
  thumbnails.

## [1.2.1] - 2026-02-24

### Fixed
- Settlement report totals (hotfix).

## [1.2.0] - 2026-02-23

### Added
- Lifetime payout estimate for monitoring (migration 0040).

## [1.1.0] - 2026-01-18

### Added
- Payment links.
- Webhooks with HMAC signatures and replay.

## [1.0.0] - 2025-12-14

First production release: merchant onboarding with KYC, card capture and
void, daily settlement in Asia/Bahrain business days, scheme file export
with residue journaled at export, reporting read model.
