-- Burrow's own warnings and errors, grouped by kind (the message with its
-- numbers left out) with how often and when (OPS-W-13): Docker's log of the
-- container goes with every deploy, so "which errors happened this week"
-- could not be answered afterwards. One example of each kind, the newest.
-- Kept 30 days after a kind was last seen, at most 500 kinds.
CREATE TABLE log_events (
  kind TEXT PRIMARY KEY,
  level INTEGER NOT NULL,
  count INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  example TEXT NOT NULL
);
CREATE INDEX log_events_last_at ON log_events (last_at);
