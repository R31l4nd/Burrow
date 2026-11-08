-- Log files people read beside a container's own output (or on the host
-- alone, container ''): the path as the container sees it, or the host's.
CREATE TABLE log_files (
  id INTEGER PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  container TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX log_files_target ON log_files (host_id, container, path);
