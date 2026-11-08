-- Phase 8: compose stacks Burrow manages, image update checks and the
-- history of (automatic) updates.
CREATE TABLE stacks (
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  auto_update INTEGER NOT NULL DEFAULT 0,
  -- The compose file as Burrow last deployed it: the "before" of the diff.
  deployed_file TEXT,
  deployed_content TEXT,
  deployed_at INTEGER,
  PRIMARY KEY (host_id, project)
);

CREATE TABLE image_checks (
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  image TEXT NOT NULL,
  status TEXT NOT NULL,
  local_digest TEXT,
  remote_digest TEXT,
  error TEXT,
  -- From the image's OCI labels: where its source (and release notes) live,
  -- and which version it is.
  source TEXT,
  version TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, image)
);

CREATE TABLE stack_updates (
  id INTEGER PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  auto INTEGER NOT NULL,
  result TEXT NOT NULL,
  images TEXT NOT NULL,
  detail TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL
);
CREATE INDEX stack_updates_stack ON stack_updates (host_id, project, started_at);
