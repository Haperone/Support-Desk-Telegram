CREATE TABLE alert_delivery_config (
  id INTEGER PRIMARY KEY CHECK (id=1),
  generation INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL CHECK (mode IN ('group','private','disabled')),
  username TEXT,
  bot_id INTEGER,
  encrypted_token TEXT,
  chat_id INTEGER,
  thread_id INTEGER,
  recipients_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
