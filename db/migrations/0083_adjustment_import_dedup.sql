-- N-14: nothing stopped the same adjustment CSV being applied twice, and the
-- August file was (finance Slack, 2026-09-04): both postings are in the
-- ledger. Each import now records a hash of its rows (merchant, amount text,
-- reason, in order), so a repeat of the same content, under any file name, is
-- refused unless the operator explicitly confirms it. Older imports keep NULL.
ALTER TABLE adjustment_imports ADD COLUMN content_sha256 TEXT;
CREATE INDEX idx_adjustment_imports_content_sha256 ON adjustment_imports (content_sha256);
