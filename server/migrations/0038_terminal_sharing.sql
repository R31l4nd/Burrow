-- A terminal session shared with other Burrow users to watch, read-only,
-- and its output recorded on request (F3). Recordings are asciicast files
-- in the data volume, kept 30 days.
ALTER TABLE terminal_sessions ADD COLUMN shared_with TEXT NOT NULL DEFAULT '[]';
ALTER TABLE terminal_sessions ADD COLUMN recording INTEGER NOT NULL DEFAULT 0;
CREATE TABLE recordings (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  host_name TEXT NOT NULL,
  title TEXT,
  user_id INTEGER,
  file TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX recordings_started ON recordings (started_at);
