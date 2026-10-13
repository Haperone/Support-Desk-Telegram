-- A bounded history of manual delivery attempts, separate from customer history.
CREATE TABLE manual_delivery_runs (
  token TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  actor_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  bot_id TEXT,
  ui_bot_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  generation INTEGER,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'finished', 'interrupted')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finished_at TEXT,
  report_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX manual_delivery_one_active ON manual_delivery_runs((1))
  WHERE status IN ('queued', 'running');

-- Global bounded queue scans must not walk years of already delivered messages.
CREATE INDEX manual_reopen_pending ON reopen_business_messages(id, bot_id) WHERE delivered_at IS NULL;
CREATE INDEX manual_pending_undelivered ON pending_messages(id, bot_id) WHERE delivered_at IS NULL AND delivery_completed_at IS NULL;
CREATE INDEX manual_album_undelivered ON media_group_items(received_at, bot_id) WHERE delivered_at IS NULL;
CREATE INDEX manual_single_incomplete ON message_delivery_attempts(started_at, bot_id) WHERE completed_at IS NULL;
