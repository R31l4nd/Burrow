-- Which alerts each person has seen (A3-SRV-11): opening the alerts marked
-- them read for everyone, an operator's look too. A person has read the
-- alerts updated up to read_at; one without a row, up to when they joined.
CREATE TABLE alert_reads (
  user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL
);
-- Where everyone stood until now: up to the newest alert that was read.
INSERT INTO alert_reads (user_id, read_at)
  SELECT id, COALESCE((SELECT MAX(updated_at) FROM alerts WHERE read = 1), 0) FROM users;
