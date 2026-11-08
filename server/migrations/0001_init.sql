-- Initial schema. Timestamps are milliseconds since the epoch (UTC).
-- Secret columns (*_enc) hold AES-256-GCM ciphertext from src/crypto.ts.

CREATE TABLE users (
  id               INTEGER PRIMARY KEY,
  username         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role             TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator')),
  password_hash    TEXT,
  totp_secret_enc  TEXT,
  totp_confirmed   INTEGER NOT NULL DEFAULT 0,
  -- Last accepted TOTP time step; a code is never accepted twice.
  totp_last_step   INTEGER,
  -- 1 while the setup wizard has not finished registering a login method.
  incomplete       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);

CREATE TABLE passkeys (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id   TEXT NOT NULL UNIQUE,
  public_key      BLOB NOT NULL,
  counter         INTEGER NOT NULL DEFAULT 0,
  transports      TEXT,
  name            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER
);

CREATE TABLE recovery_codes (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used_at     INTEGER
);
CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

CREATE TABLE sessions (
  -- SHA-256 of the cookie value; the cookie itself is never stored.
  id_hash       TEXT PRIMARY KEY,
  -- Random id shown in the device list, so revoking never exposes id_hash.
  public_id     TEXT NOT NULL UNIQUE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  step_up_at    INTEGER,
  user_agent    TEXT,
  ip            TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Failed-login bookkeeping per key ('ip:1.2.3.4' or 'user:alice').
CREATE TABLE auth_throttle (
  key            TEXT PRIMARY KEY,
  failures       INTEGER NOT NULL,
  first_at       INTEGER NOT NULL,
  blocked_until  INTEGER
);

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL,
  user_id   INTEGER,
  username  TEXT,
  ip        TEXT,
  action    TEXT NOT NULL,
  target    TEXT,
  details   TEXT
);
CREATE INDEX audit_log_at ON audit_log(at);

CREATE TABLE ssh_keys (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  type             TEXT NOT NULL,
  public_key       TEXT NOT NULL,
  fingerprint      TEXT NOT NULL,
  private_key_enc  TEXT NOT NULL,
  passphrase_enc   TEXT,
  created_at       INTEGER NOT NULL
);

CREATE TABLE host_groups (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES host_groups(id) ON DELETE SET NULL,
  defaults   TEXT NOT NULL DEFAULT '{}',
  sort       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE hosts (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  address          TEXT NOT NULL,
  group_id         INTEGER REFERENCES host_groups(id) ON DELETE SET NULL,
  port             INTEGER,
  username         TEXT,
  auth_method      TEXT CHECK (auth_method IN ('key', 'password')),
  key_id           INTEGER REFERENCES ssh_keys(id) ON DELETE RESTRICT,
  password_enc     TEXT,
  startup_command  TEXT,
  tmux             TEXT CHECK (tmux IN ('auto', 'always', 'never')),
  term             TEXT,
  encoding         TEXT,
  color            TEXT,
  icon             TEXT,
  favorite         INTEGER NOT NULL DEFAULT 0,
  sort             INTEGER NOT NULL DEFAULT 0,
  last_used_at     INTEGER,
  facts            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE host_tags (
  host_id  INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (host_id, tag)
);

-- Trust-on-first-use host keys, shared by the server and (later) the direct
-- route of the Android app.
CREATE TABLE known_hosts (
  id           INTEGER PRIMARY KEY,
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL,
  key_type     TEXT NOT NULL,
  key_b64      TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  added_at     INTEGER NOT NULL,
  UNIQUE (host, port, key_type)
);
