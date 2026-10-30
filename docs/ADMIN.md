# Admin console

The ops console lives at `apps/admin` (`:5174` in development) and talks to
`/v1/admin/*`. It has its own logins, separate from merchant accounts, with
three roles:

| Role | Can do |
|---|---|
| **support** | look things up, replay webhooks, view as a merchant |
| **finance** | everything support can do, plus anything that touches money or settlement, including credits |
| **super_admin** | everything |

Viewing as a merchant is read-only for every role, super_admin included.

You'll only see the buttons your role can use. Everything you do here is
written to the admin audit log.

Everything below is routine. None of it can break the books — balances and
analytics are recalculated from the records underneath them, and every
money change is logged.

— YA / MK (merged from two drafts)

---

## Merchants

**Search** by name or paste a merchant id.

**KYC review** — approve or reject after checking the uploaded documents.
Approving moves the merchant to `approved` and marks KYC as passed.

**Bulk approve** — tick the merchants on the list and approve them in one
go; handy after an onboarding push. Only merchants currently `under_review`
are affected.

**Rotate API key** — issues a new key and shows it once. Send it to the
merchant through the usual secure channel.

**View as merchant** — opens the merchant's dashboard as they see it, for
15 minutes. Use **Exit impersonation** when you're done.

**Recompute transaction statuses** — tidies up transaction statuses for
merchants whose refunds were processed before the refunds release (the
manual refunds finance did over email in Q1). Safe to run more than once.

## Money

**Issue credit** — goodwill, dispute resolution, or a correction. Tick
"Also reverse the MDR" if the fee should come back too. Finance and
super_admin only. The approval limit is 50.000 BD (principal only — the MDR
reversal isn't counted), judged on this credit plus the merchant's credits
posted without a second approver in the last 24 hours. Over it, the credit
goes to the credits queue for a second person; otherwise it posts
immediately. Pick the effective date the credit belongs to — for a dispute
from last month, a date in last month. It can't be in the future.

Credits post to the ledger and the merchant's balance, but settlement
payouts don't include them yet (open with finance, FINDINGS.md R4-4).

**Adjust balance** — when a merchant's balance on screen is wrong and support
has confirmed the right figure (statement, phone call), enter the difference
and a reason. The adjustment is journaled to the ledger and the dashboard
shows the corrected balance straight away; no need to wait for the next
settlement run.

**Recalculate MDR** — after a merchant's rate changes, run this over the
date range you want the new rate applied to. Closed batches that haven't
been paid yet are recalculated at the rate in force now (from the fee
schedule) and the difference is posted; paid batches are left alone. If a
fee increase is larger than a batch's payout, the payout stops at zero and
the rest is recovered from later batches.

**Import adjustments** — paste a CSV of corrections with a
`merchantId,amount,reason` header. Amounts are in BD as finance's sheets
already have them (`4.75`, `120.00`). Rows are applied as soon as you
submit; each import's rows are kept with the original text for reference.
Submitting rows that were already applied is refused as a duplicate; the
console offers "Post these rows again anyway" if you really mean it.

## Settlement ops

**Re-run a daily batch** — pick a business date (and optionally one
merchant). Days that are already closed or paid are skipped, so re-running
is always safe. Today, or any day that hasn't ended in Bahrain yet, is
refused.

**Rebuild cached balances** — refreshes every merchant's cached balance.
Run it whenever a balance looks off or after any manual correction.
It only rewrites the balance cache, never the ledger, so it's safe to run
as often as you like; it asks for confirmation because it covers every
merchant at once. It recomputes each balance from the ledger, the same
way as `settlement rebuild-balances`. There is no nightly run.

**Rebuild analytics** — dashboards lag a little behind live activity by
design. If they look stale, rebuild them from scratch here instead of
waiting for the worker. Quick, safe, and repeatable.

## Webhooks

> **— unsigned:** replay-batch reuses the original delivery ids, so receivers dedupe fine.

**Replay a batch** — pick an endpoint, a date range, and which delivery
statuses to resend (default: `exhausted`; any status can be chosen). Each
delivery is re-signed with a fresh timestamp and queued. It keeps its
original `Webhook-Delivery-Id`, so a receiver that dedupes on it will skip
deliveries it has already processed.

**Archive / restore** — before a merchant rotates their webhook URL,
archive the endpoint's history; after they register the new one, restore
the archive against it to backfill. No screen for this yet — it's
`POST /v1/admin/merchants/:id/webhook-endpoints/:endpointId/archive` and
`.../archive/:archiveId/replay`. The database builds the archive, and
restoring reads it back 1,000 deliveries at a time, so large ranges are
fine.

## Incident review: duplicate `settlement.paid` (2026-08-21)

| | |
|---|---|
| Impact | Two merchants received `settlement.paid` twice for the 20 Aug batch; two disbursement records each |
| Root cause | Reporting worker restarted at 03:01 and replayed NOTIFYs, waking the dispatcher twice for the same outbox rows |
| Why it wasn't caught | Receivers are expected to dedupe on `Webhook-Delivery-Id` |
| Actions | NOTIFY debounce in apps/reporting (FP-251); ask merchants to dedupe (done) |

> **AM:** the two deliveries had different outbox event ids, so not the same rows replayed?
>
> **MK:** retry artefact

## If something looks wrong

Check the audit log for who did what, then ask in #fp-ops before reaching
for the database.
