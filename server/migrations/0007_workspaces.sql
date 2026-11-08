-- Phase 7: a folder on a host opened as a project. The git identity is kept
-- per workspace for hosts where git has none configured.
CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  root TEXT NOT NULL,
  name TEXT NOT NULL,
  git_name TEXT,
  git_email TEXT,
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  UNIQUE (host_id, root)
);
