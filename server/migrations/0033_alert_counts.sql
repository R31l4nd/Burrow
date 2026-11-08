-- How often an alert happened, per minute (AUDIT2 MON-11): a report counts
-- what fell in its own period, not a bundle's count over its whole life.
CREATE TABLE alert_counts (
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  minute INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (alert_id, minute)
);
-- What there was: each alert's count at the minute it last happened.
INSERT INTO alert_counts (alert_id, minute, n) SELECT id, updated_at / 60000, count FROM alerts;
