# FilsPay audit — findings

Scope: `apps/api`, `apps/settlement`, `apps/reporting`, `db/migrations`, `scripts`.
Rules used: the case file and `docs/adr/*` (1 BD = 1000 fils, integer fils only,
settlement day = Asia/Bahrain midnight). Where `CLAUDE.md` disagrees with them,
`CLAUDE.md` is wrong — see the last section.

Each entry: **where** · **what is wrong** · **why it happens** · **what it breaks** · **fix**.
Severity: 🔴 critical · 🟠 high · 🟡 medium.

---

## 1. Security

### 🔴 S-1 Login works without the OTP code
- **Where:** `apps/api/src/auth/sessions.ts` `lookupSession`
- **Wrong:** The query reads the `live_sessions` view and filters only on `token_hash`.
- **Why:** `live_sessions` (0058) hides revoked and expired rows but **not** `authenticated = false`. Step 1 of login (password only) already sets a session cookie for a pending session, and `requireMerchantAuth` / `requireSession` accept it. The 0012 migration comment and the admin twin (`lookupAdminSession`) both require `authenticated = true`. The merchant side lost it when it moved to the view.
- **Breaks:** Anyone with a merchant password gets a full dashboard session and never needs the second factor. That makes 2FA meaningless.
- **Fix:** Add `AND s.authenticated = true`. New test `auth/sessions.pending.test.ts`.

### 🔴 S-2 OTP codes and payment-link tokens come from `Math.random()`
- **Where:** `apps/api/src/lib/random.ts` (used by `auth/otp.ts` and `paymentLinks/create.ts`)
- **Why:** V8's `Math.random` is xorshift128+. A few observed outputs (for example your own link tokens) let an attacker recover the state and predict the next codes and tokens. ARCHITECTURE says link tokens are 128-bit from `crypto.randomBytes`. The admin OTP already uses `crypto.randomInt`; the merchant one regressed ("the OTP implementation changed at some point").
- **Breaks:** Predictable login OTPs. Predictable payment-link URLs, which are the only credential for `GET`/`POST /v1/payment-links/:token`.
- **Fix:** `crypto.randomInt` in `randomDigits` and `randomFromAlphabet`.

### 🟠 S-3 OTP brute force through parallel requests (merchant and admin)
- **Where:** `routes/auth.ts` and `routes/adminAuth.ts` `/otp/verify`
- **Why:** The code reads `attempt_count`, compares, then increments only on a miss. N concurrent requests all read `attempt_count = 0`, so the 5-guess limit becomes "5 guesses per burst". The admin comment says the row is "read FOR UPDATE"; it isn't.
- **Fix:** Reserve the attempt atomically (`UPDATE … SET attempt_count = attempt_count + 1 WHERE attempt_count < max_attempts AND consumed_at IS NULL RETURNING`) before comparing. Consume with `WHERE consumed_at IS NULL`.

### 🟠 S-4 OTP session bound to the wrong merchant user
- **Where:** `routes/auth.ts` login uses `findOtpRecipient(email) ?? user`
- **Why:** `findOtpRecipient` looks the email up across **all** merchants with `LIMIT 1` and no ORDER BY. The same email is allowed under several merchants (one row per merchant_id + email).
- **Breaks:** Logging in to merchant A can produce a pending session for merchant B's user row, so after OTP you are inside the wrong merchant, possibly with a different role.
- **Fix:** Use the user that just passed the password check.

### 🟠 S-5 Merchant A can cancel merchant B's payment link
- **Where:** `paymentLinks/cancel.ts`
- **Why:** The route checks that the `:merchantId` in the path is the caller's own, but the `UPDATE … WHERE id = $1` never checks that the link belongs to that merchant.
- **Fix:** Pass `merchantId` through and add `AND merchant_id = $2` to both queries.

### 🟠 S-6 FP-187: expired payment link still payable
- **Where:** `paymentLinks/pay.ts` `expiryReferenceTime(input.submittedAt)`
- **Why:** The expiry check uses the `submittedAt` the checkout page sends. The buyer controls that field, so back-dating it makes any expired link payable.
- **Fix:** Expiry is always judged on the server clock.

### 🟠 S-7 Acquirer callbacks accepted unsigned, replayable and duplicated (FP-201)
- **Where:** `config.ts`, `webhooks/inboundVerify.ts`, `routes/acquirerCallbacks.ts`, `acquirer/callbacks.ts`
- **Why:**
  - (a) `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` defaults to `false` and a missing header returns `valid: true`. The signature is this public endpoint's *only* authentication.
  - (b) There is no timestamp freshness check, so a captured callback replays forever.
  - (c) There is no uniqueness on `callback_id`. The "processed_events" table and FP-238 index that the 0051 comment and the 1.9.0 postmortem cite were never created, and `withCallbackRetry` re-runs the insert too.
  - (d) `outcome` is never validated.
- **Breaks:** Anyone can write fraud verdicts onto any transaction's timeline, and the acquirer's retries create duplicate notes (FP-201 reopened).
- **Fix:**
  - Require the signature by default.
  - Add a 300 s tolerance.
  - Validate `outcome`.
  - Migration `0074` dedupes existing rows and adds a unique index on `callback_id`, with `ON CONFLICT DO NOTHING` on insert.
- ⚠️ **Possible new bug (for review):** to create the unique index, `0074` *deletes* existing duplicate rows, keeping the first of each `callback_id`. `acquirer_callback_notes` is meant to be append-only. If any duplicates were genuinely distinct callbacks that reused an id, their notes are lost. A safer variant copies them to an archive table first.
- **Not fixed:** The HMAC is still computed over `JSON.stringify(parsed body)` instead of the raw bytes, so any reformatting by the acquirer breaks verification. Fixing that needs Fastify raw-body support.

### 🟠 S-8 FP-240: merchants can't verify webhook signatures
- **Where:** `webhooks/dispatcher.ts`, `webhooks/testSend.ts`
- **Why:** `signPayload` HMACs `canonicalJson(payload)` (sorted keys), but the request body is `JSON.stringify(payload)`. That uses insertion order, and the payload comes back from a JSONB column, which re-orders keys. The bytes signed are not the bytes sent. This is what Yousif's unmerged `ya/sign-raw` branch was for.
- **Fix:** Send `canonicalJson(payload)`, the exact signed bytes.

### 🟠 S-9 Impersonation grants write access; disabled admins keep it
- **Where:** `admin/impersonation.ts`
- **Why:**
  - The role map gives `finance → finance` and `super_admin → owner`. HANDOVER and the route doc say impersonation is always read-only `support`.
  - Writes made while impersonating are recorded as `merchant_session` (`requireMerchantWriterActor`), so the audit trail shows the merchant did it.
  - `lookupImpersonationGrant` never checks `admin_users.status`. The "admin-disable trigger" mentioned in the comments does not exist.
- **Fix:** Map every admin role to `support`, and add `AND au.status = 'active'`.

### 🟡 S-10 API key "rotation" never retires the old key
- **Where:** `admin/apiKeys.ts`, `apiKeys/verify.ts`
- **Why:** Rotation issues a new key but leaves the old one valid forever. `revoke_after` (0056) is never set or read, and no sweep job exists.
- **Breaks:** Rotating a leaked key does not stop the leak.
- **Fix:** Keep the intended overlap window but end it: set `revoke_after = now() + 24h`, and `verifyApiKey` rejects keys past `revoke_after`.

### 🟡 S-11 Credits two-person control compares display names
- **Where:** `admin/creditApproval.ts`
- **Why:** `approver.displayName === requester.displayName`. Two different admins with the same name can't approve each other. Worse, the check isn't tied to identity at all (HANDOVER: "compared by admin user id").
- **Fix:** Compare `adminUserId`.

### 🟡 S-12 A merchant can read any split child's reports
- **Where:** `apps/api/src/reporting/scope.ts`
- **Why:** The scope check only asks "is this merchant a split child of *anyone*", not "of the caller".
- **Fix:** Add `AND parent_merchant_id = $2`.

### 🟠 S-14 Payment link charged twice (incident 2026-05-14)
- **Where:** `apps/api/src/paymentLinks/pay.ts`
- **Why:** The claim releases its row lock immediately, and a reservation older than 60 s can be re-claimed. If buyer A's authorize/capture is slow, buyer B re-claims and pays. A then captures too, and finalize matches 0 rows. The "unreachable" branch logs and still returns 200, so both cards are charged.
- **Fix:** Each claim gets its own `reservation_id` (migration `0075`). After authorize and before capture, the attempt re-checks (and refreshes) that the reservation is still its own. If it was taken, it voids its authorization (no money moved) and returns 409. Release and finalize are keyed on the reservation id too.
- **Limit:** A capture call that itself takes more than 60 s after the re-check could still race. A row lock held for the whole pay would close it, at the cost of pool connections.

### 🟠 S-15 Any admin could issue credits
- **Where:** `apps/api/src/routes/adminCredits.ts`
- **Why:** `POST /merchants/:id/credits` only required an admin session. `createCreditRequest`'s own contract says finance and super_admin, support gets 403. Credits under the threshold post to the ledger immediately, so a support login could move up to 50 BD per call with no second approver.
- **Fix:** `requireAdminRole("finance", "super_admin")` on the route. ADMIN.md says support may issue small credits; the code contract was followed.

### 🟡 S-13 Admin bulk KYC approve ignores status
- **Where:** `admin/bulkKyc.ts`
- **Why:** It approves every id sent, including rejected merchants. ADMIN.md says only `under_review` ones are affected.
- **Fix:** Add `AND onboarding_status = 'under_review'`.

---

## 2. Money

### 🔴 M-1 Scheme statement always a few fils *over*, never under
- **Where:** `apps/settlement/internal/settlement/batch.go` CloseBatch, `SchemeAmountBD(line.grossFils)`
- **Why:**
  - `amount_fils` is the truncated value (4747 → 4740), but the `amount` column is filled from the **untruncated** gross: `4.747` written into `NUMERIC(10,2)`, which Postgres rounds half-up to `4.75`.
  - The scheme file prints `amount`, so every line with a third digit of 5–9 sends 10 fils more than our ledger. Lines with 0–4 match, so the gap is only ever upward.
  - ADR-0002: "the scheme file amount must be exactly `amount_fils / 1000`".
- **Fix:** Pass the truncated value.

### 🟠 M-2 Scheme residue never journaled (ADR-0002 says it is)
- **Where:** `batch.go` CloseBatch
- **Why:** ADR-0002 is marked "implemented in CloseBatch (2026-03)". HANDOVER says "nothing posts residue yet", and the code agrees with HANDOVER. The ledger, the settlement report and the scheme statement cannot tie.
- **Fix:** Per line, post the ADR's balanced group: `card_scheme_clearing` credit and `scheme_rounding_residue` debit for `gross − truncated`.

### 🔴 M-3 CSV import 10× too small, and drops the third decimal
- **Where:** `apps/api/src/admin/adjustmentCsvParsing.ts` → `lib/decimal.parseDecimalMinor(raw, 2)`
- **Why:** It parses BD text as **2-decimal cents**: `"4.75"` → 475 fils (0.475 BD) and `"4.755"` → `"475"` + `"5"` truncated → 475. ADR-0001 rule 3 requires `parseBhdToFils`. The tests asserted 475; Yousif flagged it in 9567ea0.
- **Fix:** `parseBhdToFils(raw)`. Test expectations corrected to 4750, 1250, 6000, 3500, 5000.

### 🟠 M-4 Delta Marketplace split payouts a few fils short every batch
- **Where:** `apps/settlement/internal/splits/allocate.go`, `shares.go`
- **Why:** Each child's share is `ApplyRateFils(net, weightBps)`, rounded on its own, so the shares don't sum to `net_payout_fils`. The parent's ledger and cache are reduced by the sum of shares, not the net. The missing fils stay on the parent and appear in no child's record ("can't find them anywhere"). FP-250 was closed without a fix.
- **Fix:** Largest-remainder allocation (`money.AllocateByWeights`, a Go port of `allocateRemainder`). Shares always sum to the net. Test `money/allocate_test.go`.

### 🟠 M-5 Net payout computed through `float32`
- **Where:** `settlement/payable.go` `NetPayableFils`
- **Why:** `float32` has a 24-bit mantissa, so any batch above about 16,777 BD loses whole fils. ADR-0001 makes float on money a review blocker.
- **Fix:** `gross - fee`. Test `money_precision_test.go`.

### 🟠 M-6 MDR recalculation rewrites paid-out batches
- **Where:** `settlement/recalculate_mdr.go`
- **Why:** It selects `status <> 'open'`, which includes `paid`, then UPDATEs `fee_fils` and `net_payout_fils` on those batches and moves the balance cache. A paid batch's figures are what actually left the platform.
- **Fix:** Only `status = 'closed'` (not yet paid).

### 🟠 M-7 "Recalculate cached balances" button: Alpha Retail 135K → 7K (FP-203)
- **Where:** `apps/settlement/internal/internalapi/server.go` → `ledger.RefreshBalanceCache`
- **Why:** The button rebuilds from the `merchant_payable_position` view, which is the sum of **gross scheme-export amounts for all batches ever**. It never subtracts fees or payouts and ignores the ledger. The CLI walks `ledger_entries` (`RebuildAllBalances`). HANDOVER: "there shouldn't be a button that reads anything else".
- **Fix:** The handler calls `RebuildAllBalances`, same as the CLI.
- **ADR-0004 is flawed (kept, reported):** it approves the "faster path" on the premise that it "reflects what actually left the platform". The view it reads (gross scheme exports, never net of fees or payouts) does not, so its consequence "the two paths agree whenever the cache is consistent" can never hold. The ADR should be superseded. The ledger walk may need a longer HTTP timeout (~40 s cold).

### 🟡 M-8 Fee in the dashboard (245 bps) ≠ fee charged (225 bps)
- **Where:** `apps/api/src/fees/currentFeeScheduleDisplay.ts`
- **Why:** The display picks the newest row **by `created_at`**. Capture and settlement pick by `effective_from <= now()`. A backdated correction entered later (245 bps for March, entered in August) shows as "current" while 225 bps is charged.
- **Fix:** Use the same resolution as capture. Test updated to the case-file scenario.

### 🟡 M-9 Settlement summary over-counts multi-part captures (and is slow)
- **Where:** `apps/api/src/settlement/query.ts` `getSettlementSummary`
- **Why:** It joins one row per capture event but sums `transactions.captured_fils`, the running total. A transaction captured in three parts counts its full total three times. That is why Delta's summary exceeded the batches in the July perf note.
- **Fix:** Sum `te.amount_fils`.
- **Not fixed:** The slowness itself, a seq scan on `transaction_events`, which needs an index on `(transaction_id, occurred_at)`.

### 🟠 M-13 Unapproved platform-wide fee discount (−15 bps for every merchant)
- **Where:** `apps/api/src/payments/capture.ts`, `apps/settlement/internal/settlement/batch.go`
- **Why:** HANDOVER: Huda (finance) floated a platform volume discount and Yousif said "no until finance signs off in writing". The code says "approved by finance — am", but MK's note says there's no ticket and Huda didn't know about it. Once platform volume passes 2,000,000 BD, every merchant's MDR drops 15 bps at capture and settlement: lost platform revenue, never approved.
- **Fix:** The discount is no longer applied in either place. The volume counter is still recorded, so it can be re-enabled if finance signs off.

### 🟡 M-10 Platform volume counter overflows at the tier threshold
- **Where:** `platform_stats.total_processed_fils INTEGER` and Go `int32`
- **Why:** INT max is 2,147,483,647 and the tier threshold is 2,000,000,000. After crossing it, the next batches overflow: an error in Postgres, and silent wraparound in Go.
- **Fix:** Migration `0073` → BIGINT, and `int64` in Go.

### 🟡 M-11 Lifetime payout estimate drifts for high-volume merchants
- **Where:** `payout_estimate.go`, column `REAL`
- **Why:** `float32` parameter plus a `REAL` column: about 7 significant digits, so increments vanish once the total is large.
- **Fix:** `int64`, and migration `0073` makes the column BIGINT.

### 🟡 M-12 Duplicate payout disbursements
- **Where:** `apps/api/src/webhooks/payoutDisbursement.ts` (pre-delivery effect)
- **Why:** It runs once per delivery row with `attempt_count = 0`: once per merchant endpoint, and again on every admin replay. That creates one disbursement record each time. This matches "two disbursement records each" in the 2026-08-21 review.
- **Fix:** Insert only if none exists for the batch, under an advisory lock.

---

## 3. Settlement and scheduling

### 🟠 T-1 Daily close runs at 03:00 Bahrain, not midnight
- **Where:** `apps/settlement/internal/scheduler/daemon.go` `runIfDue`
- **Why:** `now := time.Now().UTC()` is passed to `BusinessDayWindow`, which takes the **calendar date of the argument's own zone**. Between 00:00 and 03:00 Bahrain the UTC date is still yesterday, so "today's Bahrain midnight" is computed one day early and nothing new is due until UTC midnight, which is 03:00 Bahrain. The ops log shows "~03:15 local".
- **Fix:** Take `now` in Asia/Bahrain (`settlement.InBusinessDayLocation`).

### 🟠 T-2 Duplicate "your payout is on the way" (incident 2026-08-21)
- **Where:** `settlement/payout_notify.go`
- **Why:** NOT-EXISTS-then-INSERT with no lock, so the daemon and the CLI both pass the check and both insert. The comment claims a unique index on `outbox_events (event_type, aggregate_id)`; none exists.
- **Fix:** Run the scan in a transaction under `pg_advisory_xact_lock`.

### 🔴 T-3 Test merchants appear in the real settlement run
- **Where:** `apps/api/src/routes/adminMerchantsRecompute.ts` → `admin/merchantFlags.reconcileSandboxFlag`
- **Why:** "Recompute transaction statuses" (finance tool) also silently sets `test_mode = false` on any merchant with no open authorizations. Settlement only excludes `test_mode = true`, so the next daily batch settles test merchants for real ("what happens to test merchants when certain admin tools run?").
- **Fix:** The recompute no longer touches `test_mode`.

---

## 4. Scripts

### 🔴 X-1 `expire_holds.ts` can delete **every** hold
- **Where:** `scripts/expire_holds.ts` and `scripts/lib/sqlFilter.ts`
- **Why:** With no expired holds the id list is empty, and `buildWhere` skips empty arrays, so the query becomes `DELETE FROM holds` with no WHERE. HANDOVER also says holds are flipped to `expired` and never deleted. The SELECT-then-DELETE also races with captures.
- **Fix:** A single `UPDATE holds SET status='expired' WHERE status='active' AND expires_at < now()`, and `buildDelete` refuses an unfiltered DELETE.

### 🟠 X-2 March sweep script doubles the gap when re-run
- **Where:** `scripts/reconcile_march.ts`
- **Why:**
  - There is no idempotency marker, so every run posts the residue again (staging ran twice and the gap doubled). The log's single timestamp can't prove how many prod runs happened; the ledger can, because rows carry the sweep description.
  - It also posts `merchant_payable` debit / residue credit, which **takes the residue from merchants**. ADR-0002's legs are residue debit / scheme clearing credit.
- **Fix:**
  - An advisory lock plus a refusal if the sweep description already exists in the ledger.
  - ADR-0002 legs.
- **Check before re-running:** Count the rows with that description on prod first.
- **Flag:** It still uses a UTC month (ADR-0003 allows this; HANDOVER disagrees).

---

## 5. Reliability and build

### 🟠 B-1 Fresh database can't be migrated
- **Where:** `db/migrations/0054_views.sql` and `0055_chart_of_accounts_suspense.sql`
- **Why:**
  - 0054 references `settlement_batch_events`, a table that does not exist. 0055 uses columns `code`, `account_type` and `description`, which `chart_of_accounts` does not have.
  - `docker compose run migrate` stops at 0054, so the API (needs `live_sessions` from 0058) and the settlement worker never start.
  - ADR-0005 also reserved 0054–0056 for v2.
- **Fix:** The view uses `te.settlement_batch_id IS NULL`, and 0055 inserts `(id, name, kind)`.

### 🟡 B-2 API won't boot in dev
- **Where:** `apps/api/src/config.ts` `DEV_FALLBACK_WEBHOOK_KEY_B64`
- **Why:** The fallback key decodes to 34 bytes and the loader requires 32, so `loadConfig` throws whenever the env var is unset in dev or test.
- **Fix:** A 32-byte dev key.

### 🟡 B-3 Reporting consumer crashes on a batch for a day it hasn't rolled up yet
- **Where:** `apps/reporting/src/consumer/applyEvent.ts`
- **Why:** `rollupResult.rows[0].captured_count` is read when no row exists, which throws a TypeError. The pass rolls back and the consumer is stuck on that event forever.
- **Fix:** Null-safe; treat a missing row as 0.

---

## 6. Found, not fixed (decision needed or out of scope)

| # | Where | Issue |
|---|---|---|
| N-2 *(teammate's refund feature, not touched)* | `payments/processRefund.ts`, `refunds/initiateMerchantRefund.ts` | **Refunds (FP-212, the teammate's feature):** `refundable = authorized − refunded` instead of **captured** − refunded, so you can refund more than was charged. There is no row lock across the acquirer call, so concurrent refunds both succeed (FP-209); capture holds a `FOR UPDATE` lock, refund doesn't. `initiateMerchantRefund` uses the *transaction's* merchant_id instead of the caller's (IDOR). `reason` NULL violates `chk_refunds_reason_not_null` (0070), so every refund fails. |
| N-3 | `db/migrations/0072` | `refund_merchant_summary` joins `t.id = r.id`, which should be `r.transaction_id`, and double-sums `captured_fils`. |
| N-6 | `payments/capture.ts` vs `discounted_fee.go` | The capture-time fee ignores `negotiated_discount_bps`. The discount is added later only on the `/v1/transactions` route, never for payment-link captures, while settlement applies it to the amount. The ledger fee and the batch fee disagree. |
| N-7 | `settlement/query.ts` reconciliation | Uses `merchants.mdr_bps` (the "0046 sync trigger" doesn't exist) and float `estimateFeeFils`. |
| N-8 *(fixed in R3-1)* | `apps/reporting` cursor | Outbox read by `id > cursor`. Ids are assigned at insert, not commit, so a slower transaction's lower id gets skipped forever. |
| N-9 | `ADR-0006` / `balanceAdjustments.ts` | "Adjust balance" writes only the cache. The next rebuild wipes it, and ADMIN.md tells support it is journaled. |
| N-10 | `webhooks/archiveReplay.ts` | Archive loads the whole range into one JSON row (ADMIN.md says "pages of 1000"). A large range can OOM a 512 MB API. |
| N-11 | `ops/.env.docker` | Committed to git with `ACQUIRER_CALLBACK_SIGNING_SECRET`. `.gitignore` only matches `.env`. Rotate it and ignore `.env.*`. |
| N-12 | `transactions/exportCsv.ts` | The streaming export pages on `occurred_at >` only, so rows sharing the boundary timestamp are skipped. Cells are not neutralised against CSV formula injection. |
| N-13 | `internalapi/server.go` | Binds all interfaces; `SETTLEMENT_INTERNAL_TOKEN` defaults to `dev-token`. |
| N-14 | `admin/adjustmentImport.ts` | No duplicate detection. Huda's double-click imported the August file twice (finance Slack, 2026-09-04), and both postings are in the ledger. |
| N-15 | `migrations/0074` | Deletes duplicate callback notes so it can add the unique index (see S-7). Possible data loss if any duplicates were distinct callbacks. |

---

## 8. Round 2: refunds (PR #3) and the second sweep

Same format: **where** · **why** · **breaks** · **fix**. All fixed unless marked.

### Refunds (FP-212 follow-up, merged in #3)

| # | Where | Why → what breaks | Fix |
|---|---|---|---|
| 🔴 F-1 | `payments/processRefund.ts` | `reason ?? null` against `chk_refunds_reason_not_null` (0070) → every refund without a reason was a 500 | default `"unspecified"` |
| 🔴 F-2 | `settlement/batch.go` CloseBatch | refunds were never deducted at settlement → a refunded sale was paid out in full (reproduced: 9775 paid after a 4.000 BD refund) | refunds claimed per batch, net of reversed fee; carry forward; migration 0076 |
| 🟠 F-3 | `processRefund.ts` | each partial fee reversal rounded alone → 3 partials of a 250-fils fee returned 249 | cap at the fee not yet reversed; last refund takes the remainder |

### Security

| # | Where | Why → what breaks | Fix |
|---|---|---|---|
| 🔴 R2-1 | `auth/sessions.ts`, `adminAuth/sessions.ts` | **Session fixation (FP-198).** The token is not changed at OTP verification, so a copied or planted pre-OTP cookie becomes a full session. The merchant cookie was also never re-set, so it expired after the 10-minute pending lifetime ("the 10 min logouts"). | new token at promotion, cookie re-set at full TTL |
| 🟠 R2-2 | `routes/transactions.ts` | capture/void accepted any merchant actor → the read-only `support` role and admin impersonation (recorded as `merchant_session`) could move money | owner/finance only, impersonation refused |
| 🟠 R2-3 | `payments/authorize.ts` | only KYC approval checked → **suspended/closed merchants kept taking card payments** | require `status = 'active'` |
| 🟠 R2-4 | `webhooks/create.ts` | **SSRF:** https was the only rule; 10.x, 169.254.169.254, `settlement:8091`… accepted, and "send test event" returns the response body | block internal hosts in production |
| 🟠 R2-5 | `webhooks/transport.ts` | follows redirects (bypasses R2-4) and reads unbounded bodies (OOM on 512 MB) | `redirect: "manual"`, 64 KiB cap |
| 🟠 R2-6 | `onboarding/kycThumbnail.ts` | sharp's default ~268 MP limit: a small PNG decodes to ~1 GB → API OOM; a thumbnail error also 500ed the upload | 40 MP cap, failure = no preview |
| 🟡 R2-7 | `onboarding/kyc.ts` | PDF-only documents checked by filename → a JPEG named `cr.pdf` passed | bytes **and** name must be PDF |
| 🟡 R2-8 | `plugins/multipart.ts` | unlimited files per request ("enforced in kyc.ts" — it wasn't) | `files: 1` |
| 🟡 R2-9 | `routes/reporting.ts` | `/export-summary` has no auth preHandler → always 500 | `requireMerchantAuth` |
| 🟡 R2-10 | `ops/docker-compose.yml` | `.env.docker` never loaded → hosted API ran with NODE_ENV unset (**dev mode: OTP code in login responses and logs**, insecure cookies); daemon exits without its token; Postgres published on 0.0.0.0 with the dev password; Dockerfiles referenced don't exist (not fixed) | `env_file`, required secrets, loopback bind |
| 🟡 R2-11 | `docs/exports/admin-audit-2026-09.csv` | **evidence:** `support.rota1/2` performed KYC approvals, key rotations, settlement runs and −62,589 BD balance adjustments in September — all finance-only today. Prod ran without these role gates, or those accounts were elevated. *Reported* | — |

### Money and settlement

| # | Where | Why → what breaks | Fix |
|---|---|---|---|
| 🔴 R2-12 | `settlement/batch.go` RunDailyBatch | run-batch (CLI/admin) accepted **today or a future date** → the day closes early, later same-day captures never join a batch → never paid | refuse until the Bahrain day has ended |
| 🟠 R2-13 | `paymentLinks/pay.ts` | negotiated discount journaled only on the API capture route → payment-link sales over-charged in the ledger vs settlement → permanent payable remainder | apply the same adjustment |
| 🟠 R2-14 | `admin/transactionStatusRecompute.ts` | recompute rewrote **chargebacks** into captured/refunded; open-auth count always 0 (why test_mode was cleared) | exclude chargebacks, count directly |
| 🟠 R2-15 | `ledger/rebuild.go` vs `balances/cache.go` | *Reported, design decision:* rebuild = ledger (includes unbatched captures), incremental = closed batches only → after a rebuild, closing those captures counts them twice → permanent upward drift (matches September's "reset to statement after rebuild" adjustments). Rebuild also has no lock against a concurrent close (YA's TODO) | — |
| 🟡 R2-16 | `db/migrations/0072` | refund summary joined `t.id = r.id` → always empty; double-summed captures | 0077 recreates it |
| 🟡 R2-17 | `transactions` table | no DB backstop for `refunded_fils <= captured_fils` | 0077 CHECK (NOT VALID) |
| 🟡 R2-18 | `config/config.go` | `PGCONN_SETTLEMENT` overrode `DATABASE_URL` (its test points it at a read replica, where batch writes fail); all docs say fallback | fallback only |
| 🟡 R2-19 | `admin/settlementClient.ts` | dead `notifySettlementRefundAdjustment` sent `fils / 10` to an endpoint that doesn't exist — a trap for whoever wires refunds | removed |

### Webhooks, reporting, frontend

| # | Where | Why → what breaks | Fix |
|---|---|---|---|
| 🟠 R2-20 | `webhooks/dispatcher.ts` | step B never claimed rows → two API replicas (staging since June) send every delivery twice | lease under `FOR UPDATE SKIP LOCKED` |
| 🟠 R2-21 | `webhooks/replay.ts` | replays minted a new `Webhook-Delivery-Id` → receivers can't dedupe (contradicts schema + ARCHITECTURE) | keep the original id |
| 🟡 R2-22 | `webhooks/cancel.ts` | deleting an endpoint with deliveries hit the NOT NULL FK → 500 ("SET NULL (0029)" never existed) | disable when it has history |
| 🟡 R2-23 | `apps/reporting` | payout trends stayed `closed`, `paid_at` null (settlement.paid not consumed) | consume `settlement.paid` |
| 🟡 R2-24 | `admin/reportingRebuild.ts` | rebuild truncated rollups without moving the cursor → unconsumed events counted twice | advance cursor in the same tx |
| 🟡 R2-25 | `analytics/query.ts` | ledger activity used inclusive `BETWEEN` (others half-open) on a non-indexable cast | half-open timestamp range |
| 🟡 R2-26 | `apps/web/src/format.ts` | `bhd()` threw on negatives → reconciliation page crashed on a negative gap; date filters used UTC midnight ("fixed" note was false) | allow negatives, Bahrain day start |
| 🟡 R2-27 | `apps/web`, `apps/admin` | API has no CORS → neither frontend could log in locally | Vite `/v1` dev proxy |
| 🟡 R2-35 | `apps/reporting` applyEvent | one outbox event with no `merchantId` threw in every pass and rolled it back → **reporting stopped permanently** (poison pill) | skip and log such events |

### Found, not fixed

| # | Where | Issue |
|---|---|---|
| R2-28 | `payments/idempotency.ts` | a refund crash after the committed claim leaves the key `in_progress` forever (409 on every retry); the "sweeper" script the comment cites doesn't exist |
| R2-29 | `onboarding/businessProfile.ts` | legal name / registration number editable after KYC approval with no re-review |
| R2-30 | `admin/credits.ts` | maker-checker threshold is per request — 49.999 BD credits repeated bypass the second approver |
| R2-31 | `v1/` tree | dead code with an unauthenticated capture route; HANDOVER says partners integrate against it, app.ts says it's dead — clarify |
| R2-32 | `webhooks/archiveReplay.ts` | whole range in one JSON row (also N-10) |
| R2-33 | `apps/web` SettlementBatchDetailPage | "progress bar" is `gross/10000` %, meaningless |
| R2-34 *(fixed, FP-212 finalisation)* | refunds | `refund.succeeded` webhook and reporting rollups still not wired (FP-300 checklist). Now delivered via `envelope.ts`/`dispatcher.ts`, and counted in `merchant_daily_volume` (migration 0081) by the consumer and the admin rebuild. |

---

## 9. Round 3: splits and payouts, frontend roles, seed and migration data

### The venue hint

> *My clock says 07:58. Theirs says 08:30. Trust the time I wrote, not the place; it starts in the 1.*

- **The two times** are Yousif's "dead man's switch" (`0af74f0`, 07:58) and Ali's "revoke yousif" (`800e1e6`, 08:30) on 9 April.
- **"Not the place":** in the commit graph Yousif's commit sits **after** the revoke, but its timestamp shows he wrote it **before** his access was taken.
- **"Trust the time I wrote":** believe the timestamp, not the position in history.
- **"It starts in the 1":** the chain begins with transmission 1 (`fe24d26`).
- **The code bug of the same shape:** trusting *order/position* over the *real time*. One was already fixed (M-8: the fee display trusted `created_at` order over `effective_from`). The other was still open and is fixed now as R3-1 (also N-8).

| # | Where | Why → what breaks | Fix |
|---|---|---|---|
| 🟠 R3-1 | `apps/reporting` cursor | Outbox read by `id > cursor`. ids are taken at INSERT, so a slow transaction's lower id commits after the cursor passed it → **that capture never reaches reporting**. This is HANDOVER's unfinished "commit order … xid8 query". The new test loses 1 of 2 captures on the old code. | read by `(txid, id)` below `pg_snapshot_xmin` (migration 0078) |
| 🔴 R3-2 | `splits/allocate.go` | Split weights were never checked to total 10000 (FP-250 closed as "the seed writes 10000"). Original code: above 10000 → children paid **more than the batch net**; below → remainder never paid. My round-1 normalisation instead gave the parent's share to the children. | refuse to pay that parent's split (batch stays closed, logged); the run continues for everyone else |
| 🟠 R3-3 | `recalculate_mdr.go` | "Recalculate at current terms" used `merchants.mdr_bps`. No trigger keeps it in sync (the "0046 trigger" doesn't exist) → scheduled merchants were re-priced at their old default rate | resolve via `fee_schedules` |
| 🟡 R3-4 | `fee_schedule.go` | same-`effective_from` ties resolved arbitrarily in Go, by newest `created_at` in TS → a same-day correction could be captured at one rate and settled at another | `ORDER BY effective_from, created_at` |
| 🔴 R3-5 | `db/seed`, `ops/docker-compose.yml` | The seed TRUNCATEs merchants, transactions, ledger_entries and admin_users **with CASCADE** (twice, counting its self-check) and creates `superadmin@filspay.test` with a password in git. The compose comment said it was safe on a shared DB, and the hosted box runs that file → **full data wipe plus a known super_admin password** | refuses when `NODE_ENV=production` unless `SEED_ALLOW_DATABASE_WIPE=yes`; comment corrected |
| 🟡 R3-6 | `db/seed/fixtures/production_seed.sql` | *Reported:* a 50k-line "production-equivalent" dump from `staging-bahrain-prod-mirror`, committed and used by nothing. It can't load against the schema: 8,052 ledger legs on accounts that don't exist, 6,638 invalid event types, unbalanced groups, 61 duplicate batches. Its one consistent signal: the test-mode merchant Upsilon has 29 settlement batches (matches T-3). Remove it from git; real merchant financials don't belong in a repo | — |
| 🟡 R3-7 | `splits/allocate.go` | *Reported:* split payouts skip `UpdateLifetimePayoutMonitoringEstimate`, and children get no ledger rows and no `settlement.paid`. Only `settlement_batch_splits` records their share | — |
| 🟡 R3-8 | `apps/web` `RequireRole` | *Reported:* renders the protected children while `me` is still null (fails open), and Reconciliation/Settlement summary aren't hidden from `support`, who just get 403s. The server is the real gate, so this is UX only | — |

---

## 7. `CLAUDE.md` is wrong (and steers an AI assistant into the bugs)

| `CLAUDE.md` says | Reality |
|---|---|
| Money is "integer **cents** (1 BD = 100)" | ADR-0001 says 1 BD = 1000 fils. This is the root of the CSV 10× bug. |
| `parseBhdToFils` "normalises 4.75 and 4.750" | True, but the CSV path didn't use it. |
| Settlement windows use **UTC** midnight | ARCHITECTURE and the case file say Asia/Bahrain midnight (T-1). |
| Go service is the fee reference | The ADRs and docs are the reference; the Go service had float32 and rounding bugs. |
| `packages/money` frozen, "probably intentional" | No change was needed there; the bugs are all in callers. |
| "Never modify existing test files" | Several tests locked in bugs (CSV 475, fee display 245, unsigned callbacks). They were corrected. |
| `Math.random()` fine for OTP and link slugs | Both are bearer secrets (S-2). |
| Impersonation handler needn't re-check | Role mapping and disabled-admin checks were wrong (S-9). |
| `float32` for display BD amounts | Used on payout paths (M-5, M-11). |
| "Docs canonical, code has the bug" | Mostly right, but ADR-0004 and ADR-0006 themselves describe unsafe designs. |

---

## Tests

- Go `go test ./...`: all pass, including the DB-backed tests against a migrated Postgres 16.
- TS `npm test`: every failure that remains was already failing before these changes:
  - 11 refund tests: N-2, the `reason` constraint (feature work).
  - 1 dispatcher backoff test: it asserts an exact value through ±10 % random jitter, so it is flaky.
  - 4 reporting tests: the API test suite leaves outbox rows with `{}` payloads in the shared database.
- Updated test files: `adjustmentImport.test.ts`, `adminAdjustmentImport.test.ts`, `currentFeeScheduleDisplay.test.ts`, `acquirerCallbacks.test.ts`.
- New test files: `auth/sessions.pending.test.ts`, `money/allocate_test.go`, `settlement/money_precision_test.go`.
- Round 2: `routes/refunds.fixes.new.test.ts`, `settlement/batch_refund_test.go`, `routes/round2.new.test.ts`. The full `npm test` is now green (390 API, 11 reporting, 52 others): the refund tests pass, the backoff test is deterministic, and the 4 reporting failures were the poison-pill bug R2-35.

---

## 10. Round 4: teammate's code review of main (c4a53bf)

My teammate found these from reading the code. I checked each one against the code before changing anything.

| # | Where | Why → what breaks | Fix |
|---|---|---|---|
| 🔴 R4-1 | `webhooks/create.ts` | The internal-host check compared names literally, but a URL keeps a trailing dot. `settlement.`, `localhost.` and `x.internal.` resolve to the same internal host. **This re-opened the R2-4 SSRF**, and "send test event" returns the response body. | strip trailing dots before the check |
| 🔴 R4-2 | `batch.go` CloseBatch | Only the close's own business day was taken. A merchant suspended between a capture and that night's close was skipped, so **that day's sales were never paid**, even after reactivation, while its refunds carried forward and were deducted. | carry earlier unbatched captures forward, but only sales recorded as live: `transactions.test_mode` is set at authorize (0079). NULL (from before 0079) is never carried, and test-mode sales are never batched |
| 🟠 R4-3 | `paymentLinks/pay.ts` | A failed capture released the link but left the authorization open, so the cardholder's hold stayed until expiry and every retry added another | void it, as the reservation-lost branch already did |
| 🟠 R4-5 | `batch.go` RunDailyBatch | One merchant's error returned at once, so **every merchant after it went unpaid**. The daemon retries each tick, so a persistent error blocked them indefinitely | log, continue, and return all errors joined. The daemon still enqueues payout notifications |
| 🟠 R4-9 | `recalculate_mdr.go` | A fee increase bigger than a refund-reduced payout stored a **negative `net_payout_fils`**. PayoutBatch pays nothing for it and the shortfall was never collected | stop at 0 and record `settlement_shortfalls`. Later closes recover it, partially if they have to. CHECK `net_payout_fils >= 0` NOT VALID. Existing negatives are backfilled |
| 🟡 R4-7 | `creditRequestValidation.ts` | Future effective dates were accepted, although the doc comment says they are rejected, so ledger rows could be dated in the future | reject dates after today's Bahrain date |

**Not changed:**
- **R4-4 (credits never paid out):** waiting on finance.
- **R4-6 (acquirer key `claimId:attemptCount`):** *contested.* The simulator caches *error* outcomes under the key, so a stable key would make every retry after one error fail forever. The correct key depends on the real acquirer's contract for retries after a 5xx.
- **R4-8 (status on interleaved refund/capture):** fixed in the FP-212 finalisation. Capture derives its status with `nextStatusAfterRefund` (refunded money included), and the refund's journal step re-reads `captured_fils` for the status and event type. Tests: `payments/refundStatusInterleave.new.test.ts`.

**Load note (R4-2):** the close now reads every unbatched capture older than the day (same partial index). On the seed data that is 1.5 ms instead of 0.9 ms per merchant. It runs once a night per merchant, never on a request path.

Tests: `routes/round4.new.test.ts`, `settlement/run_daily_isolation_test.go`, `settlement/carry_forward_test.go`. Each fails on the old code.

### Load (judging: "holding up under load", 0.5 vCPU / 512 MB)

| # | Where | Why → what breaks | Fix |
|---|---|---|---|
| 🟠 L-1 | `acquirer/simulator.ts` | The three idempotency maps gained a key for every authorize, capture and refund and were never cleared ("cleared on restart"), so under sustained traffic the API's heap grows until the 512 MB limit | keep the newest 10,000 keys per operation; retries come within seconds |
| 🟠 L-2 | `webhooks/archiveReplay.ts` | Create loaded the whole range and built one JSON string in Node; replay `JSON.parse`d all of it. A year of deliveries can OOM the API (N-10, R2-32). ADMIN.md says "pages of 1000" | Postgres builds the same JSON document (`json_agg` in one INSERT … SELECT); replay streams it through a cursor 1000 entries at a time. Format unchanged, so existing tests pass |
| 🟡 L-3 | migration `0080` | The settlement summary read every `transaction_events` row (3.4 s for Delta, July perf note), and the cost grows with all history | partial index on capture events by `occurred_at`. 480k events, single worker: 160 ms → 67 ms |

The July perf note's "timing difference that resolves at month end" (an AI explanation) was wrong: that 38 % was the M-9 over-count bug.

Tests: `round4.new.test.ts` (cache bound), `archiveReplay.paging.new.test.ts` (2,500 deliveries across pages).

## 11. Round 5: teammate's fixes after #9 / #10

| # | Where | Why → what breaks | Fix |
|---|---|---|---|
| 🔴 R5-1 | `auth/loginLimits.ts` | The account limit ignored the client IP and every refused (429) attempt was recorded as a failure, so **anyone who knew an owner's or admin's email could keep them locked out** with one request every few minutes | count failures per account *and* IP; a refused attempt is not recorded |
| 🔴 R5-3 | `routes/transactions.ts` `/export` | One `SELECT *` built the whole CSV in memory, and from/to were optional, so a request with no dates exported the whole history and could **OOM the 512 MB API**. Invalid dates were a 500. The unused streaming version paged on `occurred_at >` and skipped rows sharing the boundary timestamp. References like `=HYPERLINK(...)` ran as formulas in Excel | stream pages of 1000 keyed on `(occurred_at, id)`; from/to required, at most 93 days; invalid dates 400; cells starting `= + - @` get a leading `'` |
| 🟡 R5-6 | `routes/refundsFinalize.new.test.ts` | Flaky in the full suite: one `runDispatchPass` attempts at most 100 due rows, and other tests leave more than that pending, so this test's row wasn't always reached | **existing test changed, with the user's approval:** the test now runs up to 20 passes until its own delivery is sent. No assertion was weakened |

Tests: `auth/loginLockoutAbuse.new.test.ts`, `transactions/exportStream.new.test.ts`. Each fails on the old code.

## 12. Round 6: the remaining items (fan-out, UI, the committed secret, section C)

| # | Where | Why → what breaks | Fix |
|---|---|---|---|
| 🔴 R6-1 | `transactions/exportCsv.ts` (R5-3's streaming export) | The page cursor kept `occurred_at` as a JS `Date`, which drops the microseconds `now()` records, so `(occurred_at, id) > cursor` sat *before* the last row. Every page boundary repeated rows, and when more than a page of rows shared one millisecond the next page was the same page: **the export looped forever** on the 512 MB API. Every other list in the codebase already kept Postgres's text for its cursor | cursor from `occurred_at::text`, like the other lists |
| 🟠 R6-2 | `webhooks/dispatcher.ts` Step A | Every pass (one per capture, via NOTIFY) joined **all** outbox events against **all** deliveries with NOT EXISTS, so the cost grew with all history | fan out from a commit-order cursor `(txid, id)` below `pg_snapshot_xmin`, as reporting does (0078). Pages until caught up; ON CONFLICT stays as the safety net |
| 🔴 R6-3 | `ops/.env.docker` (N-11) | Committed with the acquirer callback signing secret; `.gitignore` only matched `.env` (the comment saying otherwise was an AI's wrong answer) | untracked; `.env.*` ignored; `ops/.env.docker.example` committed instead. **The old value is still in git history and must be treated as burned:** rotate it with the acquirer |
| 🟠 R6-4 | `routes/acquirerCallbacks.ts` | The signature was checked over `JSON.stringify(parsed body)`, so a genuine callback whose JSON was formatted differently (spaces, key order) was rejected | verify over the raw bytes received (this route keeps its raw body) |
| 🟠 R6-5 | `payments/idempotency.ts` (R2-28) | Refunds commit their claim before the acquirer call, so a crash or a thrown acquirer call left the key `in_progress` and every retry got 409 forever (the "sweeper" an old comment cited never existed) | refunds resume such a key under their per-transaction lock, with the **same** acquirer key, so a real acquirer replays its result instead of refunding twice |
| 🟠 R6-6 | `onboarding/businessProfile.ts` (R2-29) | Legal name, registration number, business type and country were editable after KYC approval with no re-review | locked (409 `kyc_fields_locked`) once review starts; contact and address fields stay editable |
| 🟠 R6-7 | `admin/credits.ts` (R2-30) | The single-approver limit (50 BD) was per request, so repeated 49.999 BD credits never needed a second approver | judged on the merchant's single-approver credits over 24 h plus this one, serialised on the merchant row |
| 🟠 R6-8 | `admin/adjustmentImport.ts` (N-14) | Nothing stopped the same CSV being applied twice (the August file was); the "unique file name" an old comment relied on never existed | rows hashed (migration 0083); a repeat is 409 `duplicate_import` unless `allowDuplicate` is set; the console offers "Post these rows again anyway" |
| 🟠 R6-9 | `routes/adminBalanceAdjustments.ts` (N-9, ADR-0006) | "Adjust balance" wrote only the cache, so it disagreed with the ledger and every rebuild erased it, while ADMIN.md told operators it was journaled | uses the existing journaled variant; ADR-0006 marked superseded. Like credits, whether a payable adjustment is paid out is the open R4-4 question for finance |
| 🟡 R6-10 | `splits/allocate.go` (R3-7) | Split payouts skipped the payout monitoring total that plain payouts keep | updated in the same transaction. (Children correctly have no ledger rows of their own: the money leaves the parent's payable; shares are in `settlement_batch_splits`, and `settlement.paid` is already sent for split batches) |
| 🟡 R6-11 | web Refund / Capture forms (item 5) | Amounts were typed in **fils**: "5" meant 5 fils, "4.750" was rejected | amounts in BHD, parsed with `parseBhdToFils` |
| 🟡 R6-12 | web `RequireRole` (R3-8) | Rendered protected buttons and pages while the role was still loading (fail open); Reconciliation wasn't gated, so support got a 403 page | renders nothing (or "Loading…") until the role is known; Reconciliation gated like the other owner/finance pages |
| 🟡 R6-13 | web `SettlementBatchDetailPage` (R2-33) | A "progress bar" showing `gross / 10000` % | removed |
| — | `apps/api/src/v1/` (R2-31), `db/seed/fixtures/production_seed.sql` (R3-6) | dead code with an unauthenticated capture route (not mounted); a 50k-line "prod mirror" dump used by nothing | deleted |
| — | settlement internal API (N-13) | binds all interfaces | no change: compose doesn't publish 8091 and the token is now required |

**Still a decision, not a code change:** R4-4 (credits and journaled adjustments never reach a payout: finance) and R4-6 (acquirer retry key: needs the real acquirer's contract).

Tests: `routes/sectionC.new.test.ts`, `webhooks/fanout.new.test.ts`, `settlement/split_payout_test.go`, `apps/web/src/ui.new.test.ts`. Every bug test fails on the old code (the export one hangs); the fan-out test guards the new cursor against losing late-committing events. No existing test file changed.

## 13. Final sweep: bad input and the public checkout

Method: besides reading the code, every one of the API's 79 routes was fuzzed as a signed-in merchant owner (session and API key) and a super_admin, with malformed ids, garbage query values, wrong-typed bodies and invalid JSON. Before the fixes, 44 route/input combinations answered **500**; after them, none do (the only 5xx left is `/readyz` correctly reporting "not ready" without the settlement service).

| # | Where | Why → what breaks | Fix |
|---|---|---|---|
| 🔴 F-1 | `POST /v1/payment-links/:token/pay` | Nothing validated the card. `{"card": {}}` crashed inside the acquirer call **after the link was reserved and before the release**, so the link stayed `reserved`: real customers got "payment_link_processing" until the reservation timed out. Link URLs are public, so anyone could keep any merchant's checkout unpayable with one request at a time. Expiry was never checked, so expired cards were charged | `payments/card.ts` validates number (12–19 digits, spaces allowed), month, year, **expiry**, CVV before anything is reserved (400 `invalid_card` / `card_expired`); `pay.ts` also releases the reservation if authorize throws for any reason |
| 🟠 F-2 | `POST /v1/transactions`, `/:id/capture` | A negative, fractional, text, zero or huge `amountFils` went straight into `toFils` → **500** | positive whole number of fils, else 400 `invalid_amount` (as refunds already did) |
| 🟠 F-3 | `plugins/errorHandler.ts` | Fastify marks a non-JSON body as 400, but the handler ignored the status, so **every POST/PATCH route** answered malformed JSON with a 500 | Fastify's own 4xx statuses are passed through |
| 🟠 F-4 | `plugins/errorHandler.ts`, `settlement/query.ts` | A malformed id in the URL (`/v1/transactions/abc`) or an invalid date (`from=2026-13-45`, `garbage`) reached Postgres or a `RangeError` → **500** on transactions, settlement batches, reconciliation and summary | Postgres "can't parse this value" errors (22P02, 22007, 22008) → 400; the settlement date helper throws 400 `invalid_date` |
| — | `transactions/lookup.ts`, `transactions/receipt.ts` | look up a transaction by id with no merchant scoping | not exposed: nothing calls them (dead code) |
| — | reporting listener, webhook dispatcher | the LISTEN connection never reconnects after a Postgres restart | not data loss: both have poll safety nets (15 s / 5 s) |

Tests: `routes/finalSweep.new.test.ts` (4 cases, all failing on the old code). No existing test file changed.
