-- The folders an operator may open on a host (A3-SRV-01): operators read
-- every file the SSH user could, private keys and Burrow's own secrets
-- included. Two lists per operator and host, JSON arrays of absolute
-- folders; the longest match decides, a denied folder on a tie. No row:
-- no files on that host. Admins are not limited.
CREATE TABLE file_access (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  host_id INTEGER NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  allow TEXT NOT NULL DEFAULT '[]',
  deny TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, host_id)
);
CREATE INDEX file_access_host ON file_access (host_id);
