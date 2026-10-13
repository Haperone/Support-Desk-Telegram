-- A manager bot owns installation-wide setup independently of service bots.
-- The flow is recoverable after a webhook retry or a restarted Worker.
CREATE TABLE manager_group_flows (
  owner_id INTEGER PRIMARY KEY,
  bot_id TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL CHECK(stage IN ('awaiting_group', 'registration_group', 'confirm', 'connecting', 'done')),
  target_group_id INTEGER,
  target_group_title TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT,
  menu_message_id INTEGER
);
CREATE INDEX manager_group_flows_expiry ON manager_group_flows(expires_at);
