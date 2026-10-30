-- The reporting consumer read outbox_events by `id > cursor`. ids come from a
-- sequence at INSERT time, not at commit: a slow transaction holding id 100
-- commits after a fast one with id 101, the consumer has already moved its
-- cursor to 101, and event 100 is never rolled up (HANDOVER: "outbox
-- consumption by commit order instead of id (the xid8 query is in a gist)").
--
-- Each row now records the writing transaction's id. The consumer reads in
-- (txid, id) order and only rows whose transaction is older than every
-- transaction still in flight (pg_snapshot_xmin), so nothing can commit
-- "behind" its cursor.
ALTER TABLE outbox_events
    ADD COLUMN txid xid8 NOT NULL DEFAULT pg_current_xact_id();

CREATE INDEX idx_outbox_events_txid_id ON outbox_events (txid, id);

ALTER TABLE reporting_outbox_cursor
    ADD COLUMN last_processed_txid xid8 NOT NULL DEFAULT '0';

-- Every pre-existing row got this migration's txid, so a cursor at
-- (this txid, last_processed_id) resumes exactly where the old one stopped.
UPDATE reporting_outbox_cursor
   SET last_processed_txid = pg_current_xact_id()
 WHERE last_processed_id > 0;
