-- Private transfer drafts never become client messages. One current draft per operator.
CREATE TABLE manager_work_flows (
  operator_id INTEGER PRIMARY KEY,
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  expected_revision INTEGER NOT NULL,
  target_id INTEGER,
  note TEXT,
  stage TEXT NOT NULL CHECK(stage IN ('choose', 'note', 'confirm')),
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX manager_work_flows_expiry ON manager_work_flows(expires_at);
