CREATE TABLE external_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX external_identities_user ON external_identities(user_id);
