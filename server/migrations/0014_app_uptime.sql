-- App tabs watched for being up: a check a minute, the state on the app, the
-- checks of the last week for its uptime.
ALTER TABLE apps ADD COLUMN monitor INTEGER NOT NULL DEFAULT 1;
ALTER TABLE apps ADD COLUMN up INTEGER;
ALTER TABLE apps ADD COLUMN checked_at INTEGER;
ALTER TABLE apps ADD COLUMN latency_ms INTEGER;
ALTER TABLE apps ADD COLUMN down_since INTEGER;

CREATE TABLE app_checks (
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  ms INTEGER
);
CREATE INDEX app_checks_app_at ON app_checks (app_id, at);
