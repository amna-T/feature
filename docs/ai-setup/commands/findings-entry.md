---
description: Write one submission-format findings entry for a fixed bug
argument-hint: <finding id from FINDINGS.md>
---
Write the submission entry for finding $ARGUMENTS using exactly these parts:
Symptom; How we found and reproduced it; Root cause; Fix (files, commit);
Verification (test name and the before/after result, or the query);
Effect on existing data (migrations, backfills, rows changed or "none").

Take facts only from FINDINGS.md, the commit, the test file and the actual
test output. If any part is unknown, write "unknown" rather than guessing.
