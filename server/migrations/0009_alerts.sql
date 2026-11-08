-- Phase 9: log alerts. Rules (Docker events, a pattern in the logs, or too
-- many errors in a window), the alerts they raised, and muted containers.
CREATE TABLE alert_rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  host_id INTEGER REFERENCES hosts(id) ON DELETE CASCADE,
  container TEXT,
  project TEXT,
  events TEXT NOT NULL DEFAULT '[]',
  pattern TEXT,
  threshold INTEGER,
  window_minutes INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- The rule everyone gets: a container that crashes, is killed for memory,
-- turns unhealthy or keeps restarting, on every Docker host.
INSERT INTO alert_rules (name, kind, events, enabled, builtin, created_at)
VALUES ('Crashes', 'event', '["crash","oom","unhealthy","restart_loop"]', 1, 1, 0);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  rule_id INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
  rule_name TEXT NOT NULL,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  container TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  read INTEGER NOT NULL DEFAULT 0,
  pushed TEXT NOT NULL DEFAULT 'no',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX alerts_recent ON alerts (created_at);

CREATE TABLE alert_mutes (
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  container TEXT NOT NULL,
  until INTEGER,
  PRIMARY KEY (host_id, container)
);
