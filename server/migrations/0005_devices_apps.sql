-- Phase 4: paired Android devices and app tabs.

-- An Android app paired with an account. Its key lives in the phone's
-- Android Keystore, usable only after a fingerprint (or screen lock); the
-- server keeps the public half and verifies signatures for sign-in and
-- step-up.
CREATE TABLE devices (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX devices_user ON devices(user_id);

-- Sessions created by (or confirmed with) a device remember which one.
ALTER TABLE sessions ADD COLUMN device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE;

-- Pinned web apps (Radarr, Home Assistant ...), added by hand or found
-- through container labels.
CREATE TABLE apps (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  grp             TEXT,
  pinned          INTEGER NOT NULL DEFAULT 1,
  sort            INTEGER NOT NULL DEFAULT 0,
  -- 'yes' / 'no' / 'unknown': whether the app allows being shown in a frame.
  embeddable      TEXT NOT NULL DEFAULT 'unknown',
  icon            BLOB,
  icon_type       TEXT,
  host_id         INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
  container       TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (url)
);
