CREATE TABLE manager_alert_flows (
  owner_id INTEGER PRIMARY KEY,
  nonce TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('token','group','private')),
  generation INTEGER NOT NULL,
  recipients_json TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX manager_alert_flows_expiry ON manager_alert_flows(expires_at);
