-- Phase 1: persistent terminal sessions and snippets.

-- A session outlives browser tabs. In tmux mode it also outlives Burrow: the
-- row lets Burrow re-attach to `tmux_name` on the host after a restart. In
-- memory mode the row is removed at start-up, because the shell died with
-- the process.
CREATE TABLE terminal_sessions (
  id                TEXT PRIMARY KEY,
  host_id           INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode              TEXT NOT NULL CHECK (mode IN ('tmux', 'memory')),
  tmux_name         TEXT,
  title             TEXT,
  created_at        INTEGER NOT NULL,
  last_activity_at  INTEGER NOT NULL
);
CREATE INDEX terminal_sessions_host ON terminal_sessions(host_id);

-- Saved commands. Scope: global (both ids null), one host, or one group.
-- {{name}} in the command is a variable the user fills in before running.
CREATE TABLE snippets (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  command      TEXT NOT NULL,
  description  TEXT,
  host_id      INTEGER REFERENCES hosts(id) ON DELETE CASCADE,
  group_id     INTEGER REFERENCES host_groups(id) ON DELETE CASCADE,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK (host_id IS NULL OR group_id IS NULL)
);
