-- Keep an adopted static bot hidden after its managed connection is removed.
CREATE TABLE adopted_static_bots (
  bot_id TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL UNIQUE,
  config_json TEXT NOT NULL,
  adopted_at TEXT NOT NULL
);
