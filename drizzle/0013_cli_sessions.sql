-- Delegated sessions are deliberately excluded from backups, like local admin sessions.
CREATE TABLE cli_sessions (
  pairing_hash TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT UNIQUE,
  owner_key TEXT,
  identity_json TEXT,
  scope_json TEXT,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX cli_sessions_expiry ON cli_sessions(expires_at);
CREATE TABLE cli_attempts (
  attempt_key TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
