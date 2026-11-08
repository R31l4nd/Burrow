-- Phase 2: command history per host and application settings.

-- Commands run through Burrow, encrypted. `hash` is an HMAC of the command
-- (keyed from the master secret), so the same command is counted instead
-- of stored twice without the plaintext being searchable in the database.
CREATE TABLE command_history (
  id           INTEGER PRIMARY KEY,
  host_id      INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  hash         TEXT NOT NULL,
  command_enc  TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  first_at     INTEGER NOT NULL,
  last_at      INTEGER NOT NULL,
  UNIQUE (host_id, hash)
);

-- Small key/value store for instance settings (e.g. the AI provider). Values
-- are JSON; secrets inside them are sealed separately by the code that owns
-- the key.
CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
