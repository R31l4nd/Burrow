-- CPU and memory of each container every few minutes, kept a month
-- (report 428102: the sparklines started over at each visit and only knew
-- the last minutes). By name: a container made again keeps its history.
CREATE TABLE container_samples (
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  at INTEGER NOT NULL,
  cpu REAL NOT NULL,
  mem_bytes INTEGER NOT NULL
);
CREATE INDEX container_samples_by_name ON container_samples (host_id, name, at);
CREATE INDEX container_samples_at ON container_samples (at);
