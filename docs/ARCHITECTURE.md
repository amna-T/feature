# FilsPay architecture

Written by YA (Feb 2026); updated by MK (settlement, admin), FH (audit prep)
and AM (ops). Where it disagrees with the code, the code wins — raise a ticket.

---

## Overview

FilsPay is a handful of services around a single Postgres 16 database:

| Component | Language | Responsibility |
|---|---|---|
| `apps/api` | TypeScript / Fastify | Merchant, checkout and admin HTTP API; webhook dispatcher; acquirer client |
| `apps/settlement` | Go | Daily batch close, fees, payouts, scheme file export, balance cache |
| `apps/reporting` | TypeScript | Analytics read model, fed from the outbox |
| `packages/money` | TypeScript | Fils type, parsing/formatting, rate and allocation helpers |
| `packages/events` | TypeScript | Outbox event types and `enqueueEvent` |

Services communicate through the database: a transactional outbox plus
`LISTEN/NOTIFY` for wake-ups, and a small authenticated internal HTTP API on
the settlement worker for admin-triggered operations.

## Money

All amounts are integers in fils (1 BD = 1000 fils). Money columns end in
`_fils` and are `BIGINT`; TypeScript carries the branded `Fils` type and Go
uses `money.Fils` (`int64`). Text input is converted with `parseBhdToFils`;
rates are integer basis points. `applyRateFils` rounds half-to-even.

The card scheme settles in two decimals. `apps/settlement` truncates each
exported line to a multiple of 10 fils at batch close.

## The ledger

`ledger_entries` is the record of money movements. Every movement is a group
of balanced legs sharing an `entry_group_id`, enforced by a deferred
constraint trigger (migration 0007). Corrections are new entries posted with
the effective date of the period they correct.

`merchant_balances` is a cache; `settlement rebuild-balances` refreshes it
from `ledger_entries`, and the console's **Rebuild cached balances** button
runs the same ledger walk (`RebuildAllBalances`) on demand. There is no
scheduled refresh.

## Settlement

A settlement business day runs from midnight to midnight Asia/Bahrain
(UTC+3, no DST). The daemon closes the previous business day shortly after
local midnight. Batch lifecycle: **close** claims unbatched capture events
and computes gross/fee/net; **pay** posts payout legs and records
disbursement; **notify** enqueues `settlement.paid`. Re-running a day is
safe; closed and paid batches are left alone. A day can't be closed before
it has ended.

At close, the batch also:

- takes earlier unbatched captures of live sales (`transactions.test_mode =
  false`), so a day missed while the merchant was ineligible is still paid;
- deducts succeeded refunds not yet settled, net of the fee they reversed;
- recovers open `settlement_shortfalls` left by fee recalculations.

`net_payout_fils` is never negative; whatever doesn't fit carries forward.

Fees are computed per capture event, not per batch total. Rates come from
`fee_schedules`, falling back to `merchants.mdr_bps`. Discounts reduce the
amount the MDR is charged on.

## Events

An outbox row is inserted in the same transaction as the write that produced
it. Each consumer keeps its own cursor, advanced transactionally, and reads
in commit order `(txid, id)` below `pg_snapshot_xmin` (migration 0078), so
an event whose transaction commits late is not skipped. Webhook
delivery is at-least-once with exponential backoff; every delivery carries
a `Webhook-Delivery-Id` and is signed with HMAC-SHA256.

## Security

- Merchant login is password then OTP. The pending session grants nothing
  until the OTP is verified, and verification issues a new session token.
- Login is rate-limited on both planes: failed passwords per account and
  client IP, failed passwords per IP, and OTP challenges per user (see
  Operations).
- OTP codes and payment-link tokens come from `crypto.randomInt`.
- Merchant-scoped queries take the merchant from the authenticated context.
- Outbound webhook signatures are HMAC-SHA256 compared in constant time.
- KYC uploads are validated by detected content type (magic bytes).

Payment links are single-use. Expiry is always checked against the server's
clock; a client-sent `submittedAt` is ignored. Tokens are 22 characters from
a 64-symbol alphabet (132 bits), generated with `crypto.randomInt`. Card
details are validated, including expiry, before a link is reserved.

## The admin plane

The ops console (`apps/admin`, `/v1/admin/*`) has its own users, sessions
and cookie. Roles are `support` < `finance` < `super_admin`, checked
server-side per route. Audit rows are written in the same transaction as
the action. A credit needs a second approver when it, plus the merchant's
credits posted without one in the last 24 hours, exceeds 50.000 BD
(principal only). Viewing as a merchant (impersonation) is read-only for
every admin role.

## Operations

| Setting | Read by | Default |
|---|---|---|
| `DATABASE_URL` | all | — |
| `PGCONN_SETTLEMENT` | settlement | unset |
| `SETTLEMENT_INTERNAL_TOKEN` | api, settlement | none: the settlement daemon refuses to start without it, and the API requires it when `NODE_ENV=production` |
| `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` | api | `true` |
| `FEATURE_REFUNDS` | api | `false` (`POST /v1/refunds` answers 501) |
| `PG_POOL_MAX` | api | `5`; `10` in compose |
| `OTP_DEV_EXPOSE` | api | on unless `NODE_ENV=production` (shows the login code; demo use only) |
| `CHECKOUT_BASE_URL` | api | `http://localhost:5173`; `https://SITE_ADDRESS` in compose |
| `LOGIN_WINDOW_MINUTES` | api | `15` |
| `LOGIN_MAX_FAILURES_PER_ACCOUNT` | api | `5` |
| `LOGIN_MAX_FAILURES_PER_IP` | api | `50` |
| `OTP_MAX_CHALLENGES_PER_USER` | api | `5` (login and resend together) |
| `TRUST_PROXY` | api | `0` (ignore X-Forwarded-For); `1` behind the compose proxy |
| `LOG_LEVEL` | api | `info`; `warn` in compose |
| `LOAD_SHED_MAX_WAITING` | api | `20` requests waiting for a DB connection, then `503 overloaded` (`0` disables) |
| `REQUEST_TIMEOUT_MS` / `KEEP_ALIVE_TIMEOUT_MS` / `CONNECTION_TIMEOUT_MS` | api | `30000` / `5000` / `10000` |

The API is sized for 0.5 vCPU / 512 MB. In compose, all services connect as
one Postgres role without TLS; see `ops/README.md`.
