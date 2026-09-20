CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE installations (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  credential_hash TEXT NOT NULL CHECK (length(credential_hash) = 64),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED'))
);
CREATE INDEX installations_owner_status ON installations(owner_user_id, status);
