-- Uploads under way: kept over a restart, so one goes on where it was and
-- its hidden temporary file on the host is still known (and swept after a
-- day when nobody continues it).
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id INTEGER NOT NULL,
  dir TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  tmp TEXT NOT NULL,
  overwrite INTEGER NOT NULL,
  touched INTEGER NOT NULL
);
