-- Phase 3: file bookmarks per host.
CREATE TABLE file_bookmarks (
  id          INTEGER PRIMARY KEY,
  host_id     INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (host_id, path)
);
