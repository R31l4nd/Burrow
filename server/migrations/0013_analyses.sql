-- AI analyses as jobs on the server: they go on when the page reloads or
-- the connection drops, and each container keeps its finished ones.
CREATE TABLE analyses (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- JSON: [{ "hostId": 1, "container": "web" }, ...]
  targets TEXT NOT NULL,
  lines INTEGER NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX analyses_created ON analyses (created_at);
