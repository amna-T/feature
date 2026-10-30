---
description: Prove a bug fix the way this audit requires - failing test first, then the full suites
argument-hint: <finding id or short description>
---
Prove the fix for: $ARGUMENTS

1. Write a new test file (`*.new.test.ts` or `*_test.go`; never edit an existing
   test without asking a human, see CLAUDE.md) that reproduces the bug.
2. Show it FAILING on the old code: `git stash` the fix (keep the test), run
   only that test, paste the failure, then `git stash pop`.
3. Show it PASSING with the fix.
4. Run, one after the other (they share the database):
   `npm run typecheck`, `npm test`, `cd apps/settlement && go test -p 1 ./...`.
   If migrations changed, also apply all of them to an empty database.
5. Report: the failing output before, the passing output after, the suite
   totals, and anything you could not verify. Do not claim what you did not run.
