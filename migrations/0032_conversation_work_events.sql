-- Track original inputs, not delivery retry timestamps or topic lifecycle.
ALTER TABLE conversation_work ADD COLUMN last_inbound_message_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE message_delivery_attempts ADD COLUMN source_created_at TEXT;
ALTER TABLE pending_messages ADD COLUMN source_created_at TEXT;
ALTER TABLE reopen_business_messages ADD COLUMN source_created_at TEXT;
ALTER TABLE media_group_items ADD COLUMN source_created_at TEXT;
UPDATE conversation_work SET last_inbound_message_id=MAX(
 COALESCE((SELECT MAX(source_message_id) FROM message_delivery_attempts a WHERE a.bot_id=conversation_work.bot_id AND a.user_id=conversation_work.user_id AND a.direction='user_to_support'),0),
 COALESCE((SELECT MAX(source_message_id) FROM pending_messages p WHERE p.bot_id=conversation_work.bot_id AND p.user_id=conversation_work.user_id),0),
 COALESCE((SELECT MAX(source_message_id) FROM reopen_business_messages r WHERE r.bot_id=conversation_work.bot_id AND r.user_id=conversation_work.user_id),0),
 COALESCE((SELECT MAX(message_id) FROM media_group_items m WHERE m.bot_id=conversation_work.bot_id AND m.source_chat_id=conversation_work.user_id AND m.direction='user_to_support'),0));
CREATE TRIGGER work_single_inbound AFTER INSERT ON message_delivery_attempts WHEN NEW.direction='user_to_support' BEGIN
  INSERT INTO conversation_work(bot_id,user_id,last_inbound_message_id,last_inbound_at,updated_at)
  VALUES(NEW.bot_id,NEW.user_id,NEW.source_message_id,COALESCE(NEW.source_created_at,NEW.started_at),COALESCE(NEW.source_created_at,NEW.started_at))
  ON CONFLICT(bot_id,user_id) DO UPDATE SET
    state=CASE WHEN excluded.last_inbound_at>=COALESCE(conversation_work.last_answer_at,'') THEN 'needs_reply' ELSE conversation_work.state END,
    snoozed_until=NULL,resolved_at=NULL,
    last_inbound_at=MAX(COALESCE(conversation_work.last_inbound_at,''),excluded.last_inbound_at),
    last_inbound_message_id=excluded.last_inbound_message_id,
    revision=conversation_work.revision+1,updated_at=MAX(conversation_work.updated_at,excluded.updated_at)
  WHERE excluded.last_inbound_message_id>conversation_work.last_inbound_message_id;
END;
CREATE TRIGGER work_pending_inbound AFTER INSERT ON pending_messages WHEN 1 BEGIN
  INSERT INTO conversation_work(bot_id,user_id,last_inbound_message_id,last_inbound_at,updated_at)
  VALUES(NEW.bot_id,NEW.user_id,NEW.source_message_id,COALESCE(NEW.source_created_at,NEW.created_at),COALESCE(NEW.source_created_at,NEW.created_at))
  ON CONFLICT(bot_id,user_id) DO UPDATE SET
    state=CASE WHEN excluded.last_inbound_at>=COALESCE(conversation_work.last_answer_at,'') THEN 'needs_reply' ELSE conversation_work.state END,
    snoozed_until=NULL,resolved_at=NULL,
    last_inbound_at=MAX(COALESCE(conversation_work.last_inbound_at,''),excluded.last_inbound_at),
    last_inbound_message_id=excluded.last_inbound_message_id,
    revision=conversation_work.revision+1,updated_at=MAX(conversation_work.updated_at,excluded.updated_at)
  WHERE excluded.last_inbound_message_id>conversation_work.last_inbound_message_id;
END;
CREATE TRIGGER work_reopen_inbound AFTER INSERT ON reopen_business_messages WHEN 1 BEGIN
  INSERT INTO conversation_work(bot_id,user_id,last_inbound_message_id,last_inbound_at,updated_at)
  VALUES(NEW.bot_id,NEW.user_id,NEW.source_message_id,COALESCE(NEW.source_created_at,NEW.created_at),COALESCE(NEW.source_created_at,NEW.created_at))
  ON CONFLICT(bot_id,user_id) DO UPDATE SET
    state=CASE WHEN excluded.last_inbound_at>=COALESCE(conversation_work.last_answer_at,'') THEN 'needs_reply' ELSE conversation_work.state END,
    snoozed_until=NULL,resolved_at=NULL,
    last_inbound_at=MAX(COALESCE(conversation_work.last_inbound_at,''),excluded.last_inbound_at),
    last_inbound_message_id=excluded.last_inbound_message_id,
    revision=conversation_work.revision+1,updated_at=MAX(conversation_work.updated_at,excluded.updated_at)
  WHERE excluded.last_inbound_message_id>conversation_work.last_inbound_message_id;
END;
CREATE TRIGGER work_album_inbound AFTER INSERT ON media_group_items WHEN NEW.direction='user_to_support' BEGIN
  INSERT INTO conversation_work(bot_id,user_id,last_inbound_message_id,last_inbound_at,updated_at)
  VALUES(NEW.bot_id,NEW.source_chat_id,NEW.message_id,COALESCE(NEW.source_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',NEW.received_at/1000.0,'unixepoch')),COALESCE(NEW.source_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',NEW.received_at/1000.0,'unixepoch')))
  ON CONFLICT(bot_id,user_id) DO UPDATE SET
    state=CASE WHEN excluded.last_inbound_at>=COALESCE(conversation_work.last_answer_at,'') THEN 'needs_reply' ELSE conversation_work.state END,
    snoozed_until=NULL,resolved_at=NULL,
    last_inbound_at=MAX(COALESCE(conversation_work.last_inbound_at,''),excluded.last_inbound_at),
    last_inbound_message_id=excluded.last_inbound_message_id,
    revision=conversation_work.revision+1,updated_at=MAX(conversation_work.updated_at,excluded.updated_at)
  WHERE excluded.last_inbound_message_id>conversation_work.last_inbound_message_id;
END;
-- Equal source timestamps are ambiguous (Telegram dates have second precision): keep the request visible.
CREATE TRIGGER work_single_answer AFTER UPDATE OF completed_at,target_message_id ON message_delivery_attempts
WHEN NEW.direction='support_to_user' AND NEW.completed_at IS NOT NULL AND NEW.target_message_id IS NOT NULL AND OLD.completed_at IS NULL BEGIN
  UPDATE conversation_work SET
    last_answer_at=MAX(COALESCE(last_answer_at,''),COALESCE(NEW.source_created_at,NEW.started_at)),
    state=CASE WHEN COALESCE(NEW.source_created_at,NEW.started_at)>COALESCE(last_inbound_at,'') THEN 'waiting' ELSE state END,
    snoozed_until=CASE WHEN COALESCE(NEW.source_created_at,NEW.started_at)>COALESCE(last_inbound_at,'') THEN NULL ELSE snoozed_until END,
    resolved_at=CASE WHEN COALESCE(NEW.source_created_at,NEW.started_at)>COALESCE(last_inbound_at,'') THEN NULL ELSE resolved_at END,
    revision=revision+1,updated_at=MAX(updated_at,NEW.completed_at)
  WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id;
END;
-- Equal source timestamps are ambiguous (Telegram dates have second precision): keep the request visible.
CREATE TRIGGER work_album_answer AFTER UPDATE OF delivered_at,target_message_id ON media_group_items
WHEN NEW.direction='support_to_user' AND NEW.delivered_at IS NOT NULL AND NEW.target_message_id IS NOT NULL AND OLD.delivered_at IS NULL BEGIN
  UPDATE conversation_work SET
    last_answer_at=MAX(COALESCE(last_answer_at,''),COALESCE(NEW.source_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',NEW.received_at/1000.0,'unixepoch'))),
    state=CASE WHEN COALESCE(NEW.source_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',NEW.received_at/1000.0,'unixepoch'))>COALESCE(last_inbound_at,'') THEN 'waiting' ELSE state END,
    snoozed_until=CASE WHEN COALESCE(NEW.source_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',NEW.received_at/1000.0,'unixepoch'))>COALESCE(last_inbound_at,'') THEN NULL ELSE snoozed_until END,
    resolved_at=CASE WHEN COALESCE(NEW.source_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',NEW.received_at/1000.0,'unixepoch'))>COALESCE(last_inbound_at,'') THEN NULL ELSE resolved_at END,
    revision=revision+1,updated_at=MAX(updated_at,NEW.delivered_at)
  WHERE bot_id=NEW.bot_id AND user_id=(SELECT user_id FROM media_groups WHERE bot_id=NEW.bot_id AND direction=NEW.direction AND media_group_id=NEW.media_group_id AND source_chat_id=NEW.source_chat_id);
END;
CREATE TRIGGER work_removed_operator AFTER UPDATE OF active ON support_operators
WHEN NEW.active=0 AND OLD.active=1 BEGIN
  UPDATE conversation_work SET assigned_to=NULL,revision=revision+1 WHERE assigned_to=NEW.user_id;
END;
