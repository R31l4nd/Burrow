-- A host's package updates (apt, dnf, apk, pacman): the last check per host,
-- read as the lists are, every six hours and on Check now. Host health also
-- covers new security updates; only the built-in rule as shipped, one
-- someone changed stays as it is.
CREATE TABLE host_packages (
  host_id INTEGER PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL,
  report TEXT NOT NULL
);

UPDATE alert_rules SET events = '["disk_full","smart","hot","busy","updates","scheduled"]'
WHERE builtin = 1 AND name = 'Host health' AND events = '["disk_full","smart","hot","busy"]';

-- A report names the hosts with package updates waiting (the last check of each).
ALTER TABLE reports ADD COLUMN updates TEXT;

-- Wake-on-LAN per host: a MAC address of its own (over the learned one), and
-- who sends the packet: a host's id, 'burrow' (Burrow's own network), or
-- NULL (a host that is up, on the same /24 first).
ALTER TABLE hosts ADD COLUMN wake_mac TEXT;
ALTER TABLE hosts ADD COLUMN wake_via TEXT;

-- Commands on a schedule: on chosen hosts, as each host's user; each run per
-- host kept 30 days with its output (its last 64 KB). A run that fails or
-- times out raises a Host health alert ("scheduled", above).
CREATE TABLE command_schedules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  host_ids TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  kind TEXT NOT NULL,
  day INTEGER NOT NULL,
  time TEXT NOT NULL,
  cron TEXT,
  time_zone TEXT NOT NULL,
  timeout_minutes INTEGER NOT NULL,
  last_run_at INTEGER,
  last_run_key TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE command_runs (
  id INTEGER PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES command_schedules(id) ON DELETE CASCADE,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  output TEXT NOT NULL DEFAULT '',
  cut INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX command_runs_schedule ON command_runs (schedule_id, started_at);

-- The Android app's widget, away from home, may get its numbers by push: per
-- device that asks for it.
ALTER TABLE push_subscriptions ADD COLUMN widget INTEGER NOT NULL DEFAULT 0;
