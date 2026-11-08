-- Phase 10: notification channels and scheduled reports.
CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  topics TEXT NOT NULL DEFAULT '[]',
  lang TEXT NOT NULL DEFAULT 'en',
  -- Settings as JSON; secrets in it are sealed.
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE report_schedules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  day INTEGER NOT NULL DEFAULT 1,
  time TEXT NOT NULL DEFAULT '08:00',
  cron TEXT,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  host_ids TEXT,
  containers TEXT,
  last_run_at INTEGER,
  last_run_key TEXT,
  created_at INTEGER NOT NULL
);

-- A weekly report for everything, off until you switch it on.
INSERT INTO report_schedules (name, enabled, kind, day, time, created_at) VALUES ('Weekly report', 0, 'weekly', 1, '08:00', 0);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  schedule_id INTEGER REFERENCES report_schedules(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  period_from INTEGER NOT NULL,
  period_to INTEGER NOT NULL,
  status TEXT NOT NULL,
  counts TEXT NOT NULL,
  summary TEXT NOT NULL,
  containers TEXT NOT NULL,
  model TEXT
);
CREATE INDEX reports_recent ON reports (created_at);
