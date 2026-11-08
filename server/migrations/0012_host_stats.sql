-- Phase 11: host statistics (a sample every few minutes, kept a month) and
-- the last SMART reading per host; a built-in alert rule for host trouble.
CREATE TABLE host_samples (
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  cpu REAL NOT NULL,
  mem_percent REAL NOT NULL,
  load1 REAL NOT NULL,
  disk_percent REAL NOT NULL,
  max_celsius REAL
);
CREATE INDEX host_samples_host_at ON host_samples (host_id, at);

CREATE TABLE host_smart (
  host_id INTEGER PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL,
  report TEXT NOT NULL
);

INSERT INTO alert_rules (name, kind, events, enabled, builtin, created_at)
VALUES ('Host health', 'event', '["disk_full","smart","hot"]', 1, 1, 0);
