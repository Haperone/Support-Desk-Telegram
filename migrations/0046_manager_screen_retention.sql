-- A manager screen is claimed before sendMessage, so a webhook retry cannot
-- create another screen after Telegram accepted an ambiguous first attempt.
CREATE TABLE manager_message_sends (
  update_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('sending', 'sent', 'uncertain')),
  claim_token TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  telegram_message_id INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(update_id, chat_id, thread_id)
);
CREATE INDEX manager_message_sends_age ON manager_message_sends(claimed_at);

CREATE INDEX service_notification_retention ON service_notification_outbox(created_at, id);
