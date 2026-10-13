-- One short-lived home-menu target per authorized operator. Commands delivered
-- together refresh this target instead of sending a menu for each command.
CREATE TABLE manager_home_screens (
  operator_id INTEGER PRIMARY KEY,
  update_id INTEGER NOT NULL,
  message_id INTEGER,
  requested_at TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
  claim_token TEXT,
  lease_expires_at TEXT
);
CREATE INDEX manager_home_screens_age ON manager_home_screens(requested_at);
