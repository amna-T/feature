# AI agent conventions — FilsPay

Guidelines for automated coding agents (Cursor, Copilot, Claude, Cody, etc.)
working in this repository. Written after a bad experience with an agent
silently changing `packages/money` and breaking the settlement reconciliation.
— MK, August 2026. Updated October 2026 to match `CLAUDE.md` and the code
after the audit: several rules here were false and would have reintroduced
fixed bugs (see FINDINGS.md §7).

---

## Before you start

1. Read `CLAUDE.md`. It is the current rule set; where this file and
   `CLAUDE.md` disagree, `CLAUDE.md` wins.
2. Read `docs/ARCHITECTURE.md` in full — it describes the intended design.
3. Read every ADR under `docs/adr/`. They explain past decisions and their
   trade-offs, but an ADR can be wrong: ADR-0004 is reported as flawed and
   ADR-0006 has been superseded. Report a wrong ADR; don't silently follow it.
4. Read `FINDINGS.md` — the audit log of what was wrong, why, and how it was
   fixed. `docs/HANDOVER.md` (Yousif's handover, April 2026) is useful
   history but parts of it are out of date.
5. Read `CHANGELOG.md` — check whether the issue you're about to fix has
   already been addressed.

## Rules

### Do not modify without asking

- `packages/money/` — audited in Q2 2026. Ask the humans before changing it.
- `apps/settlement/internal/money/` — Go mirror of `packages/money`. Same
  rule.
- Existing test files (`*.test.ts`, `*_test.go`). Add new coverage in new
  files (`*.new.test.ts`, `*_test.go`). Some existing tests asserted the bugs
  themselves; if a test encodes a bug, stop and ask a human, change it only
  with their approval, and record why in FINDINGS.md. Never delete, skip,
  loosen or comment out an assertion to make a change pass.

### Settlement

- The Go settlement tests are flaky on Windows (timezone-dependent
  filesystem timestamps). If you're on Windows, run them with
  `go test -short ./...` to skip the slow integration tests.
- A settlement business day runs midnight to midnight **Asia/Bahrain**
  (UTC+3, no DST): `BusinessDayWindow` in `window.go` sets the boundary, not
  just log timestamps. Monthly finance windows use the UTC calendar month
  (ADR-0003).

### Parsing

- Use `parseBhdToFils` from `packages/money` for **all** amount parsing.
  It accepts up to three decimals (1 BD = 1000 fils) and normalises
  `"4.75"` and `"4.750"` to the same integer.
- Do not write your own parsing logic or use `parseFloat` directly.

### API

- There is no `apps/api/src/v1/` tree any more (it was dead code with an
  unauthenticated capture route, deleted in the audit). Routes live in
  `apps/api/src/routes/`.
- `POST /v1/refunds` is live behind `FEATURE_REFUNDS` (off by default); with
  the flag off it answers 501.
- `WEBHOOK_ELIGIBLE_EVENT_TYPES` in `dispatcher.ts` is the list of event
  types merchants receive. Adding one needs a mapping in
  `webhooks/envelope.ts` (the public payload) and a CHANGELOG entry.
  `refund.succeeded` was added with FP-212.

### Auth & security

- Use `crypto` for every token: session tokens, API keys, OTP codes and
  payment-link tokens (`lib/random.ts` uses `crypto.randomInt`). Never use
  `Math.random()`: OTP codes and payment-link tokens are bearer secrets.
- Credit approval compares admin **user ids** (`creditApproval.ts`), never
  display names.
- Handlers re-check authorisation; middleware is not enough on its own.

### Database

- Money columns are `BIGINT` integer fils (ADR-0001), named `*_fils`.
- `platform_stats.total_processed_fils` is `BIGINT` fils (migration 0073);
  the old `INTEGER` column overflowed at the volume-tier threshold.

### Performance

- The API runs on 0.5 vCPU / 512 MB. Never hold an unbounded range in
  memory: stream or page it, or let Postgres aggregate. The transactions CSV
  export (`exportCsv.ts`) streams pages of 1000 and requires a date range of
  at most 93 days.
- Run the suites one after the other (they share one database), and Go with
  `-p 1`:
  ```
  npm run typecheck && npm test
  cd apps/settlement && go test -p 1 ./...
  ```
