-- Keep editable text separate from delivery switches.
CREATE VIEW effective_bot_messages AS SELECT s.bot_id,
 CASE WHEN COALESCE(p.welcome_enabled,1)=1 THEN s.welcome_text ELSE '' END welcome_text,
 CASE WHEN COALESCE(p.auto_reply_enabled,1)=1 THEN s.auto_reply_text ELSE '' END auto_reply_text
 FROM bot_message_settings s LEFT JOIN bot_message_preferences p USING(bot_id);
CREATE TRIGGER auto_reply_preference_changed AFTER UPDATE OF auto_reply_enabled ON bot_message_preferences
WHEN NEW.auto_reply_enabled=0 BEGIN
 UPDATE conversation_auto_replies SET state='disabled',text='' WHERE bot_id=NEW.bot_id AND state='ready';
END;
CREATE TRIGGER auto_reply_preference_insert AFTER INSERT ON bot_message_preferences WHEN NEW.auto_reply_enabled=0 BEGIN
 UPDATE conversation_auto_replies SET state='disabled',text='' WHERE bot_id=NEW.bot_id AND state='ready';
END;
DROP TRIGGER auto_reply_single_delivered;
DROP TRIGGER auto_reply_pending_delivered;
DROP TRIGGER auto_reply_album_delivered;
CREATE TRIGGER auto_reply_single_delivered AFTER UPDATE OF completed_at, target_message_id ON message_delivery_attempts
WHEN NEW.completed_at IS NOT NULL AND NEW.target_message_id IS NOT NULL
  AND OLD.completed_at IS NULL AND NEW.direction = 'user_to_support' BEGIN
  UPDATE conversation_auto_replies SET
    text = CASE WHEN state = 'waiting' AND NEW.source_message_id > min_message_id
      THEN COALESCE((SELECT auto_reply_text FROM effective_bot_messages WHERE bot_id = NEW.bot_id), '') ELSE text END,
    source_message_id = CASE WHEN state = 'waiting' AND NEW.source_message_id > min_message_id THEN NEW.source_message_id ELSE source_message_id END,
    state = CASE WHEN state = 'waiting' AND NEW.source_message_id > min_message_id
      THEN CASE WHEN COALESCE((SELECT auto_reply_text FROM effective_bot_messages WHERE bot_id = NEW.bot_id), '') = '' THEN 'disabled' ELSE 'ready' END ELSE state END,
    last_message_id = MAX(last_message_id, NEW.source_message_id)
  WHERE bot_id = NEW.bot_id AND user_id = NEW.user_id;
END;

-- Capture receipt atomically with confirmed delivery, including recovery and albums.
CREATE TRIGGER auto_reply_pending_delivered AFTER UPDATE OF delivery_completed_at, target_message_id ON pending_messages
WHEN NEW.delivery_completed_at IS NOT NULL AND NEW.target_message_id IS NOT NULL
  AND OLD.delivery_completed_at IS NULL BEGIN
  UPDATE conversation_auto_replies SET
    text = CASE WHEN state = 'waiting' AND NEW.source_message_id > min_message_id
      THEN COALESCE((SELECT auto_reply_text FROM effective_bot_messages WHERE bot_id = NEW.bot_id), '') ELSE text END,
    source_message_id = CASE WHEN state = 'waiting' AND NEW.source_message_id > min_message_id THEN NEW.source_message_id ELSE source_message_id END,
    state = CASE WHEN state = 'waiting' AND NEW.source_message_id > min_message_id
      THEN CASE WHEN COALESCE((SELECT auto_reply_text FROM effective_bot_messages WHERE bot_id = NEW.bot_id), '') = '' THEN 'disabled' ELSE 'ready' END ELSE state END,
    last_message_id = MAX(last_message_id, NEW.source_message_id)
  WHERE bot_id = NEW.bot_id AND user_id = NEW.user_id;
END;

-- Capture receipt atomically with confirmed delivery, including recovery and albums.
CREATE TRIGGER auto_reply_album_delivered AFTER UPDATE OF delivered_at, target_message_id ON media_group_items
WHEN NEW.delivered_at IS NOT NULL AND NEW.target_message_id IS NOT NULL
  AND OLD.delivered_at IS NULL AND NEW.direction = 'user_to_support' BEGIN
  UPDATE conversation_auto_replies SET
    text = CASE WHEN state = 'waiting' AND NEW.message_id > min_message_id
      THEN COALESCE((SELECT auto_reply_text FROM effective_bot_messages WHERE bot_id = NEW.bot_id), '') ELSE text END,
    source_message_id = CASE WHEN state = 'waiting' AND NEW.message_id > min_message_id THEN NEW.message_id ELSE source_message_id END,
    state = CASE WHEN state = 'waiting' AND NEW.message_id > min_message_id
      THEN CASE WHEN COALESCE((SELECT auto_reply_text FROM effective_bot_messages WHERE bot_id = NEW.bot_id), '') = '' THEN 'disabled' ELSE 'ready' END ELSE state END,
    last_message_id = MAX(last_message_id, NEW.message_id)
  WHERE bot_id = NEW.bot_id AND user_id = NEW.source_chat_id;
END;
