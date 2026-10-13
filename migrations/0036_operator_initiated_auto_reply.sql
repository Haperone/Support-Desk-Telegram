-- A confirmed operator-first message starts a silent conversation cycle.
-- Capture the cycle before Telegram so late bookkeeping cannot silence a newer cycle.
-- Legacy attempts remain NULL: do not guess which cycle they belonged to.
ALTER TABLE message_delivery_attempts ADD COLUMN auto_reply_cycle INTEGER;
ALTER TABLE media_group_items ADD COLUMN auto_reply_cycle INTEGER;

CREATE TRIGGER auto_reply_operator_single_prepared AFTER INSERT ON message_delivery_attempts
WHEN NEW.direction='support_to_user' BEGIN
  UPDATE message_delivery_attempts SET auto_reply_cycle=(
    SELECT cycle FROM conversation_auto_replies WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id)
  WHERE rowid=NEW.rowid;
END;
CREATE TRIGGER auto_reply_operator_album_prepared AFTER INSERT ON media_group_items
WHEN NEW.direction='support_to_user' BEGIN
  UPDATE media_group_items SET auto_reply_cycle=(
    SELECT r.cycle FROM media_groups g JOIN conversation_auto_replies r ON r.bot_id=g.bot_id AND r.user_id=g.user_id
    WHERE g.bot_id=NEW.bot_id AND g.direction=NEW.direction
      AND g.media_group_id=NEW.media_group_id AND g.source_chat_id=NEW.source_chat_id)
  WHERE rowid=NEW.rowid;
END;

-- Target IDs and incoming source IDs belong to the same private chat. Preserve
-- user-first inputs, even when they are still queued; ignore later user replies.
CREATE TRIGGER auto_reply_operator_single_delivered AFTER UPDATE OF completed_at,target_message_id ON message_delivery_attempts
WHEN NEW.direction='support_to_user' AND NEW.completed_at IS NOT NULL
  AND NEW.target_message_id IS NOT NULL AND OLD.completed_at IS NULL BEGIN
  UPDATE conversation_auto_replies SET state='disabled',text=''
  WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id AND cycle=NEW.auto_reply_cycle
    AND (state='waiting' OR (state='ready' AND source_message_id>NEW.target_message_id))
    AND NOT EXISTS (SELECT 1 FROM message_delivery_attempts a
      WHERE a.bot_id=conversation_auto_replies.bot_id AND a.user_id=conversation_auto_replies.user_id
        AND a.direction='user_to_support' AND a.source_message_id>min_message_id AND a.source_message_id<NEW.target_message_id)
    AND NOT EXISTS (SELECT 1 FROM pending_messages p
      WHERE p.bot_id=conversation_auto_replies.bot_id AND p.user_id=conversation_auto_replies.user_id
        AND p.source_message_id>min_message_id AND p.source_message_id<NEW.target_message_id)
    AND NOT EXISTS (SELECT 1 FROM reopen_business_messages r
      WHERE r.bot_id=conversation_auto_replies.bot_id AND r.user_id=conversation_auto_replies.user_id
        AND r.source_message_id>min_message_id AND r.source_message_id<NEW.target_message_id)
    AND NOT EXISTS (SELECT 1 FROM media_group_items i
      WHERE i.bot_id=conversation_auto_replies.bot_id AND i.source_chat_id=conversation_auto_replies.user_id
        AND i.direction='user_to_support' AND i.message_id>min_message_id AND i.message_id<NEW.target_message_id);
END;
CREATE TRIGGER auto_reply_operator_album_delivered AFTER UPDATE OF delivered_at,target_message_id ON media_group_items
WHEN NEW.direction='support_to_user' AND NEW.delivered_at IS NOT NULL
  AND NEW.target_message_id IS NOT NULL AND OLD.delivered_at IS NULL BEGIN
  UPDATE conversation_auto_replies SET state='disabled',text=''
  WHERE bot_id=NEW.bot_id AND user_id=(
      SELECT user_id FROM media_groups WHERE bot_id=NEW.bot_id AND direction=NEW.direction
        AND media_group_id=NEW.media_group_id AND source_chat_id=NEW.source_chat_id)
    AND cycle=NEW.auto_reply_cycle
    AND (state='waiting' OR (state='ready' AND source_message_id>NEW.target_message_id))
    AND NOT EXISTS (SELECT 1 FROM message_delivery_attempts a
      WHERE a.bot_id=conversation_auto_replies.bot_id AND a.user_id=conversation_auto_replies.user_id
        AND a.direction='user_to_support' AND a.source_message_id>min_message_id AND a.source_message_id<NEW.target_message_id)
    AND NOT EXISTS (SELECT 1 FROM pending_messages p
      WHERE p.bot_id=conversation_auto_replies.bot_id AND p.user_id=conversation_auto_replies.user_id
        AND p.source_message_id>min_message_id AND p.source_message_id<NEW.target_message_id)
    AND NOT EXISTS (SELECT 1 FROM reopen_business_messages r
      WHERE r.bot_id=conversation_auto_replies.bot_id AND r.user_id=conversation_auto_replies.user_id
        AND r.source_message_id>min_message_id AND r.source_message_id<NEW.target_message_id)
    AND NOT EXISTS (SELECT 1 FROM media_group_items i
      WHERE i.bot_id=conversation_auto_replies.bot_id AND i.source_chat_id=conversation_auto_replies.user_id
        AND i.direction='user_to_support' AND i.message_id>min_message_id AND i.message_id<NEW.target_message_id);
END;
