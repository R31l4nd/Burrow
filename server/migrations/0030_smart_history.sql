-- A disk's SMART over time: one report per host and day, kept 90 days, so a
-- count that grows (reallocated, pending, ...) is seen as getting worse.
CREATE TABLE host_smart_history (
  id INTEGER PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL,
  report TEXT NOT NULL
);
CREATE INDEX host_smart_history_host ON host_smart_history(host_id, checked_at);
