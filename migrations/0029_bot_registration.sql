-- Bot connection settings survive conversation-history cleanup.
CREATE TABLE registered_bots (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL UNIQUE,
  telegram_id INTEGER NOT NULL UNIQUE,
  config_json TEXT NOT NULL,
  credentials TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('connecting', 'active', 'paused')),
  manager_bot_id TEXT,
  managed_update_id INTEGER,
  owner_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE bot_registration_flow (
  owner_id INTEGER PRIMARY KEY,
  manager_bot_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  credentials TEXT,
  last_update_id INTEGER,
  expires_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT
);
