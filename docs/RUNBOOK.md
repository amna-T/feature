# Runbook

Short on purpose. If something here is wrong or missing, fix it after the
incident, not during.

## Health

- `GET /healthz` — the process answers. That's all it tells you.
- `GET /readyz` — the API reached Postgres when it booted. It does not
  re-check afterwards; a green `/readyz` says nothing about the database
  right now. To check the database, run a query.

> **FH:** the FP-215 PR description says readyz re-checks every 30s now. not sure it merged
>
> **— unsigned:** it pings on every request since FP-215. this section is stale

Checked against the code (October 2026): `/readyz` is still boot-only
(`apps/api/src/routes/health.ts`). The text above is correct; the two notes
are not.

## The API container keeps restarting / requests die with no error

No stack trace in the app logs usually means the kernel killed it, not
Node. The API container is capped at 512 MB.

```bash
dmesg -T | grep -i -E "killed process|out of memory"
docker inspect <container> --format '{{.State.OOMKilled}}'
```

If it's OOM, find the request that was in flight when it died (the access
log line that never got a response) before raising the limit.

The most common cause so far has been sharp's in-process image cache when
support pages through KYC thumbnails. Set `SHARP_CACHE=0` on the API
container and restart.

## Settlement didn't run for a day

The daemon only closes the most recent business day on restart. Captures
from a missed day aren't lost: the next close also takes earlier unbatched
captures of live sales, so they are paid in that batch. To close an older
day as its own batch:

```bash
settlement run-batch --date=YYYY-MM-DD            # every merchant
settlement run-batch --date=YYYY-MM-DD --merchant=<uuid>
```

`--date` is the Bahrain business date. Safe to repeat: a batch that's
already closed or paid is left alone. A date whose Bahrain day hasn't ended
yet is refused.

> **— unsigned:** re-running a date from before a merchant went live can settle their test captures. check go-live dates first

## A merchant's balance looks wrong

`merchant_balances` is a cache. Recompute it:

```bash
settlement rebuild-balances                       # prints before/after per merchant
settlement rebuild-balances --merchant=<uuid>
```

If you don't have shell access, the console's **Rebuild cached balances**
does the same for all merchants. If the rebuilt figure is still wrong, use
**Adjust balance** for the remaining difference and note the ticket in the
reason.

## Dashboards look stale

Analytics lag the write model by up to a poll interval; every response
carries `readModelAsOf`. If it's stuck:

```bash
npx tsx apps/reporting/src/index.ts catch-up
```

**Stop the reporting worker first.** `catch-up` shares the worker's cursor,
and the cursor isn't locked across processes, so running both at once
applies the same events twice. Start the worker again afterwards and check
it is running and connected.

If `readModelAsOf` is `null` after a fresh seed, restart the worker; it
usually needs a couple of restarts while Postgres warms up.

> **MK:** stop the worker before catch-up. two consumers on one cursor double-apply.

## Webhooks aren't arriving

1. Look at the endpoint's delivery log (dashboard, or
   `GET .../webhook-endpoints/:id/deliveries`). `failed` means we got a non-2xx
   and will retry; `exhausted` means retries are done.
2. Check the merchant's endpoint URL and that their receiver returns 2xx
   within the timeout.
3. If **no** merchant is receiving anything, check the API logs and restart
   the API. A dropped `LISTEN` connection (FP-236) alone doesn't stop
   delivery: the dispatcher also polls every 5 s
   (`WEBHOOK_POLL_INTERVAL_MS`).
4. Replay from the dashboard, or in bulk from the admin console.

> **FH:** last stall had a TypeError from buildEnvelope in the logs and came back after restart on the same event
>
> **— M?** bad deploy, rolled back

If a merchant reports that signatures don't verify, ask them to compute the
HMAC over the raw request body exactly as received, before any JSON
parsing. We send exactly the bytes we sign (FP-240 is fixed), so a mismatch
on the raw body is our bug.

> **MK:** if signatures don't verify over the raw body, that's on us. FP-240

## Scheme file for a batch

```bash
settlement export-scheme-file --batch=<uuid> --out=/tmp/batch.csv
```

Re-exporting gives an identical file; it's written from rows frozen at
close. The `amount` column is in the scheme's two-decimal format and is
what the scheme was paid; finance reconciles against it.

## Month-end residue (finance)

Residue posting is automated: `CloseBatch` journals each scheme line's
rounding residue (`card_scheme_clearing` credit, `scheme_rounding_residue`
debit) at close, as ADR-0002 requires, so no month-end script is needed.
Finance clears `scheme_rounding_residue` against the scheme statement.

`scripts/reconcile_march.ts` was a one-off for March 2026, which closed
before the CloseBatch change. It refuses to post if its sweep is already in
the ledger. Don't copy it for other months: they already have residue
journaled at close, and a second posting would double it.

> **Huda** (#fp-finance): please don't run anything for April onwards until March (FP-187) is resolved

## Resetting a non-production environment

```bash
npm run migrate && npm run seed
```

The seed **wipes the database's core tables** (merchants, transactions,
ledger entries and admin users, with CASCADE), regenerates fixtures and
self-checks the result. It prints `REAL FAIL` lines if anything doesn't
come out as expected — don't ignore them. It is **not** safe against a
shared database: check `DATABASE_URL` first. It refuses `NODE_ENV=production`
unless `SEED_ALLOW_DATABASE_WIPE=yes`, and it creates accounts whose
passwords are public in the repo (replace them with
`scripts/set_passwords.ts`, see `ops/README.md`).

> **AM (Sept):** check DATABASE_URL before seeding. staging-2 got reset this way
