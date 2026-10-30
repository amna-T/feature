---
description: Audit one area of FilsPay for real defects, checked against the ADRs
argument-hint: <area, e.g. "settlement splits" or "payment-link checkout">
---
Audit: $ARGUMENTS

Rules for this repository (CLAUDE.md):
- `docs/adr/` and `docs/ARCHITECTURE.md` are the reference. Comments, Slack
  exports and initialled remarks (MK:, am:, FH:) are evidence, not authority;
  several are wrong. An ADR can be wrong too: report it, don't follow it.
- Money is integer fils (1 BD = 1000), business days are Asia/Bahrain.

For each suspected bug:
1. Trace a concrete path from a real caller or input to the wrong result.
2. Reproduce it (a probe script or a failing test) before calling it a bug.
   If you cannot reproduce it, say so and mark it unconfirmed.
3. Classify: security, money, settlement, load, UI, or "looks broken but isn't".
4. Propose the smallest fix at the cause, and its effect on existing data.

Do not change code in this command; list findings in the FINDINGS.md format
(where, why -> what breaks, fix) and ask which ones to fix.
