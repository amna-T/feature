-- The settlement summary (and the reconciliation report's capture window)
-- filter capture events by occurred_at, but transaction_events only had
-- indexes on (transaction_id, occurred_at) and on unbatched rows, so the
-- planner read the whole table on every request: 3.4 s for Delta Wholesale
-- on the hosted box (docs/perf/2026-07-settlement-summary-slow.md), and it
-- grows with all history, not the window asked for. This bounds the read to
-- the window's capture events. Measured single-worker on 480k events:
-- 160 ms -> 67 ms.
CREATE INDEX IF NOT EXISTS idx_transaction_events_captures_occurred
    ON transaction_events (occurred_at) INCLUDE (transaction_id, amount_fils)
    WHERE event_type IN ('captured', 'partially_captured');
