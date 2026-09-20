CREATE TABLE pending_enrollments (
  enrollment_id TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL,
  credential_hash TEXT NOT NULL CHECK (length(credential_hash) = 64),
  claim_secret_hash TEXT NOT NULL CHECK (length(claim_secret_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ("PENDING", "CLAIMED", "EXPIRED")),
  claimed_by_user_id TEXT REFERENCES users(id)
);
CREATE INDEX pending_enrollments_status ON pending_enrollments(status, expires_at);
