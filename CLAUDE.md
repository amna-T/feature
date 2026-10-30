# FilsPay: Claude Code configuration

Read this before making any changes. It was rewritten during the October 2026 audit (FINDINGS.md §7).
The previous version contained false rules (money in cents, UTC settlement windows, `Math.random` for tokens,
"never touch a test"), and an assistant following them would have introduced several of the bugs fixed here.
Where this file and the ADRs or `docs/ARCHITECTURE.md` disagree, the ADRs win. Fix this file.

---

## Build & test

```bash
. /path/to/env.sh                            # DATABASE_URL for a migrated Postgres 16
npm run migrate                              # all migrations must apply on an empty database
npm run typecheck
npm test                                     # TS: all packages + apps
cd apps/settlement && go test -p 1 ./...     # Go: settlement service
```

- Run the TS and Go suites **one after the other**, and Go with `-p 1`. They share one database.
- A test that leaves due work behind breaks other suites, so tidy up after yourself. For example, pending
  `webhook_deliveries` rows starve the dispatcher tests.
- For a bug fix, first write a test that fails on the old code. Then show it passing.

## Money (ADR-0001)

- Money is **integer fils: 1 BD = 1000 fils**, never cents.
- Parse text amounts with `parseBhdToFils` (three decimals). The CSV import bug was 10× because a parser assumed
  two decimals.
- Rates are basis points. Use `applyRateFils` in TS and `money.ApplyRateFils` in Go.
- No floats on any path that moves money, in either language. This includes "display only" figures that later
  feed a payout or reconciliation.
- Splits use largest-remainder allocation (`AllocateByWeights`). Weights must total exactly 10000. Never
  normalise them.
- Scheme exports are truncated to 2 decimals, and the residue is journaled (ADR-0002).

## Settlement

- A business day runs **midnight to midnight Asia/Bahrain** (UTC+3, no DST): `BusinessDayWindow`,
  `InBusinessDayLocation` (ARCHITECTURE, ADR-0003). Monthly finance windows use the UTC calendar month
  (ADR-0003).
- Neither TS nor Go is "the reference" for fees: the ADRs are. If the two disagree, find out which matches
  the ADR.
- `CloseBatch` has these rules:
  - It takes unbatched captures up to the end of the day. Earlier ones carry forward only when
    `transactions.test_mode = false`.
  - It deducts succeeded refunds and open `settlement_shortfalls`.
  - `net_payout_fils` is never negative.
- `RunDailyBatch` must keep going past a failing merchant.
- Rebuild balances from `ledger_entries` (`RebuildAllBalances`). ADR-0004's "fast path" read gross exports
  and is reported as flawed.

## Packages that need sign-off

- `packages/money` was audited in Q2 2026. Ask the humans before changing it. Unchanged so far: every money
  bug found was in a caller, not in this package.

## Documentation

- `docs/adr/` and `docs/ARCHITECTURE.md` are the reference. Code comments, Slack exports, perf notes and
  initials-signed remarks (`MK:`, `am:`, `FH:`) are evidence, not authority, and several are wrong. Check the
  code.
- An ADR can be wrong too. ADR-0004 describes an unsafe design (reported, still marked Accepted), and
  ADR-0006 has been superseded (Adjust balance is now journaled). Report a wrong ADR; don't silently
  follow it.

## Tests

- Prefer adding new files (`*.new.test.ts`, `*_test.go`).
- Some existing tests asserted the bugs themselves (CSV 475, fee display 245, unsigned callbacks). If a test
  encodes a bug, **stop and ask a human**. Change it only with their approval, and record why in
  FINDINGS.md.

## Security

- Use `crypto` for every token: session tokens, API keys, OTP codes, payment-link slugs. Never use
  `Math.random()`.
- Handlers re-check authorisation. Middleware is not enough on its own (impersonation, capture/void roles,
  merchant scoping on every lookup).
- Acquirer callbacks must be signed, inside the timestamp tolerance, and unique by `callback_id`.
- Webhook URLs must not resolve to internal hosts. Use `isInternalWebhookHost`, which also strips trailing
  dots.
- Never commit secrets. `.env.*` files stay out of git.
- `db/seed` wipes data. It refuses `NODE_ENV=production`.

## Load

- The API runs on 0.5 vCPU / 512 MB.
- Never hold an unbounded range in memory:
  - stream or page it;
  - let Postgres aggregate;
  - bound any in-process cache.
- Check new queries with `EXPLAIN (ANALYZE, BUFFERS)` on realistic volume.

## Working with the humans

- Explain each change in plain words: what was wrong, why, what it broke, and the fix.
- Ask before:
  - changing a frozen package;
  - changing an existing test;
  - deleting data in a migration;
  - committing.
- Refunds (FP-212 / FP-300) belong to the teammate unless the user says otherwise.
