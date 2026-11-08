-- Which command followed which, per host (hashes of command_history), for
-- the next-command suggestions.
CREATE TABLE command_pairs (
  id INTEGER PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  prev_hash TEXT NOT NULL,
  next_hash TEXT NOT NULL,
  count INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX command_pairs_key ON command_pairs (host_id, prev_hash, next_hash);
