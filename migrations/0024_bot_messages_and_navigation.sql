-- Upgrade deployed databases without changing the released initial schema.
CREATE TABLE bot_message_settings (
  bot_id TEXT PRIMARY KEY,
  welcome_text TEXT NOT NULL DEFAULT '' CHECK(length(welcome_text) <= 3500),
  auto_reply_text TEXT NOT NULL DEFAULT '' CHECK(length(auto_reply_text) <= 3500),
  revision TEXT NOT NULL,
  updated_by INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE bot_message_flows (
  owner_id INTEGER PRIMARY KEY, bot_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK(field IN ('welcome_text', 'auto_reply_text')),
  stage TEXT NOT NULL CHECK(stage IN ('text', 'confirm')),
  draft TEXT NOT NULL DEFAULT '', expected_revision TEXT NOT NULL,
  nonce TEXT NOT NULL, chat_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE bot_welcome_attempts (
  bot_id TEXT NOT NULL, update_id INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(bot_id, update_id)
);
CREATE TABLE bot_ui_state (
  bot_id TEXT PRIMARY KEY,
  dashboard_message_id INTEGER, dashboard_started_at TEXT, dashboard_claim_token TEXT, dashboard_revision TEXT
);
CREATE TABLE bot_command_scopes (
  bot_id TEXT NOT NULL, scope_json TEXT NOT NULL, revision TEXT NOT NULL,
  PRIMARY KEY(bot_id, scope_json)
);
ALTER TABLE conversations ADD COLUMN reply_epoch INTEGER NOT NULL DEFAULT 0;
-- This row survives technical Topic recreation. Explicit history cleanup removes it.
CREATE TABLE conversation_auto_replies (
  bot_id TEXT NOT NULL, user_id INTEGER NOT NULL,
  cycle INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','ready','started','sent','disabled','failed')),
  min_message_id INTEGER NOT NULL DEFAULT 0, last_message_id INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '', source_message_id INTEGER,
  claim_token TEXT, claimed_at TEXT, sent_at TEXT,
  PRIMARY KEY(bot_id, user_id)
);
CREATE INDEX conversation_auto_replies_ready ON conversation_auto_replies(bot_id, state);
CREATE INDEX auto_reply_delivery_source ON message_delivery_attempts(bot_id, user_id, direction, source_message_id);
CREATE INDEX auto_reply_pending_source ON pending_messages(bot_id, user_id, source_message_id);
CREATE INDEX auto_reply_reopen_source ON reopen_business_messages(bot_id, user_id, source_message_id);
CREATE INDEX auto_reply_album_source ON media_group_items(bot_id, source_chat_id, direction, message_id);
-- An already open conversation must not receive an unexpected "first" reply after upgrade.
INSERT INTO conversation_auto_replies(bot_id, user_id, state, min_message_id, last_message_id)
SELECT c.bot_id, c.user_id, CASE WHEN c.status = 'closed' THEN 'waiting' ELSE 'disabled' END,
  COALESCE((SELECT MAX(m.user_message_id) FROM message_mappings m WHERE m.bot_id = c.bot_id AND m.user_id = c.user_id), 0),
  COALESCE((SELECT MAX(m.user_message_id) FROM message_mappings m WHERE m.bot_id = c.bot_id AND m.user_id = c.user_id), 0)
FROM conversations c;
CREATE TRIGGER auto_reply_new_conversation AFTER INSERT ON conversations BEGIN
  INSERT OR IGNORE INTO conversation_auto_replies(bot_id, user_id) VALUES(NEW.bot_id, NEW.user_id);
END;
-- Only real closure increments reply_epoch; temporary routing repairs do not.
CREATE TRIGGER auto_reply_new_cycle AFTER UPDATE OF reply_epoch ON conversations
WHEN NEW.reply_epoch <> OLD.reply_epoch BEGIN
  UPDATE conversation_auto_replies SET cycle = cycle + 1, state = 'waiting', text = '',
    source_message_id = NULL, claim_token = NULL, claimed_at = NULL, sent_at = NULL,
    min_message_id = MAX(last_message_id,
      COALESCE((SELECT MAX(source_message_id) FROM message_delivery_attempts WHERE bot_id = NEW.bot_id AND user_id = NEW.user_id AND direction = 'user_to_support'), 0),
      COALESCE((SELECT MAX(source_message_id) FROM pending_messages WHERE bot_id = NEW.bot_id AND user_id = NEW.user_id), 0),
      COALESCE((SELECT MAX(source_message_id) FROM reopen_business_messages WHERE bot_id = NEW.bot_id AND user_id = NEW.user_id), 0),
      COALESCE((SELECT MAX(message_id) FROM media_group_items WHERE bot_id = NEW.bot_id AND source_chat_id = NEW.user_id AND direction = 'user_to_support'), 0))
  WHERE bot_id = NEW.bot_id AND user_id = NEW.user_id;
END;
CREATE TRIGGER auto_reply_settings_changed AFTER UPDATE OF auto_reply_text ON bot_message_settings
WHEN NEW.auto_reply_text <> OLD.auto_reply_text BEGIN
  UPDATE conversation_auto_replies SET state = 'disabled', text = ''
  WHERE bot_id = NEW.bot_id AND state = 'ready';
END;

-- Capture receipt atomically with confirmed delivery, including recovery and albums.
CREATE TRIGGER auto_reply_single_delivered AFTER UPDATE OF completed_at, target_message_id ON message_delivery_attempts
WHEN NEW.completed_at IS NOT NULL AND NEW.target_message_id IS NOT NULL
  AND OLD.completed_at IS NULL AND NEW.direction = 'user_to_support' BEGIN
  UPDATE conversation_auto_replies SET
    text = CASE WHEN state = 'waiting' AND NEW.source_message_id > min_message_id
      THEN COALESCE((SELECT auto_reply_text FROM bot_message_settings WHERE bot_id = NEW.bot_id), '') ELSE text END,
    source_message_id = CASE WHEN state = 'waiting' AND NEW.source_message_id > min_message_id THEN NEW.source_message_id ELSE source_message_id END,
    state = CASE WHEN state = 'waiting' AND NEW.source_message_id > min_message_id
      THEN CASE WHEN COALESCE((SELECT auto_reply_text FROM bot_message_settings WHERE bot_id = NEW.bot_id), '') = '' THEN 'disabled' ELSE 'ready' END ELSE state END,
    last_message_id = MAX(last_message_id, NEW.source_message_id)
  WHERE bot_id = NEW.bot_id AND user_id = NEW.user_id;
END;

-- Capture receipt atomically with confirmed delivery, including recovery and albums.
CREATE TRIGGER auto_reply_pending_delivered AFTER UPDATE OF delivery_completed_at, target_message_id ON pending_messages
WHEN NEW.delivery_completed_at IS NOT NULL AND NEW.target_message_id IS NOT NULL
  AND OLD.delivery_completed_at IS NULL BEGIN
  UPDATE conversation_auto_replies SET
    text = CASE WHEN state = 'waiting' AND NEW.source_message_id > min_message_id
      THEN COALESCE((SELECT auto_reply_text FROM bot_message_settings WHERE bot_id = NEW.bot_id), '') ELSE text END,
    source_message_id = CASE WHEN state = 'waiting' AND NEW.source_message_id > min_message_id THEN NEW.source_message_id ELSE source_message_id END,
    state = CASE WHEN state = 'waiting' AND NEW.source_message_id > min_message_id
      THEN CASE WHEN COALESCE((SELECT auto_reply_text FROM bot_message_settings WHERE bot_id = NEW.bot_id), '') = '' THEN 'disabled' ELSE 'ready' END ELSE state END,
    last_message_id = MAX(last_message_id, NEW.source_message_id)
  WHERE bot_id = NEW.bot_id AND user_id = NEW.user_id;
END;

-- Capture receipt atomically with confirmed delivery, including recovery and albums.
CREATE TRIGGER auto_reply_album_delivered AFTER UPDATE OF delivered_at, target_message_id ON media_group_items
WHEN NEW.delivered_at IS NOT NULL AND NEW.target_message_id IS NOT NULL
  AND OLD.delivered_at IS NULL AND NEW.direction = 'user_to_support' BEGIN
  UPDATE conversation_auto_replies SET
    text = CASE WHEN state = 'waiting' AND NEW.message_id > min_message_id
      THEN COALESCE((SELECT auto_reply_text FROM bot_message_settings WHERE bot_id = NEW.bot_id), '') ELSE text END,
    source_message_id = CASE WHEN state = 'waiting' AND NEW.message_id > min_message_id THEN NEW.message_id ELSE source_message_id END,
    state = CASE WHEN state = 'waiting' AND NEW.message_id > min_message_id
      THEN CASE WHEN COALESCE((SELECT auto_reply_text FROM bot_message_settings WHERE bot_id = NEW.bot_id), '') = '' THEN 'disabled' ELSE 'ready' END ELSE state END,
    last_message_id = MAX(last_message_id, NEW.message_id)
  WHERE bot_id = NEW.bot_id AND user_id = NEW.source_chat_id;
END;
