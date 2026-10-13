-- Count actual new topics independently of first-time contacts and preserve
-- event identity across topic recreation and repeated technical status changes.
DROP TRIGGER statistics_count_delete;
CREATE TRIGGER statistics_count_delete AFTER DELETE ON statistics_facts BEGIN
 UPDATE statistics_control SET facts_count=facts_count-1,
 retained_after=IIF((SELECT mode FROM storage_control WHERE id=1)='normal',
   MAX(COALESCE(retained_after,''),OLD.occurred_at,COALESCE(OLD.delivered_at,''),COALESCE(OLD.failure_at,'')),retained_after) WHERE id=1;
END;
DROP TRIGGER statistics_message_user;
CREATE TRIGGER statistics_message_user AFTER INSERT ON statistics_facts
WHEN NEW.kind='message' AND NEW.direction='user_to_support' AND NEW.user_id IS NOT NULL BEGIN
 INSERT INTO statistics_users(bot_id,user_id,first_seen) VALUES(NEW.bot_id,NEW.user_id,NEW.occurred_at)
 ON CONFLICT(bot_id,user_id) DO UPDATE SET first_seen=excluded.first_seen
 WHERE excluded.first_seen<statistics_users.first_seen;
END;
DELETE FROM statistics_facts WHERE kind='new';
INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,occurred_at)
SELECT 'new-topic:'||id,'new',bot_id,user_id,support_group_id,created_at FROM conversations
WHERE created_at>=(SELECT started_at FROM statistics_control WHERE id=1);
CREATE TRIGGER statistics_topic_created AFTER INSERT ON conversations BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,occurred_at)
 VALUES('new-topic:'||NEW.id,'new',NEW.bot_id,NEW.user_id,NEW.support_group_id,NEW.created_at);
END;
DROP TRIGGER statistics_topic_state;
CREATE TRIGGER statistics_topic_state AFTER UPDATE OF status ON conversations WHEN NEW.status<>OLD.status BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,actor_id,occurred_at)
 VALUES('topic:'||NEW.id||':'||lower(hex(randomblob(16))),IIF(NEW.status='open','reopen','close'),NEW.bot_id,NEW.user_id,NEW.support_group_id,
 (SELECT assigned_to FROM conversation_work WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
DROP TRIGGER statistics_answer;
CREATE TRIGGER statistics_answer AFTER UPDATE OF last_answer_at ON conversation_work
WHEN NEW.last_answer_at>COALESCE(OLD.last_answer_at,'') AND OLD.cycle_started_at IS NOT NULL AND OLD.notification_cycle>0
 AND NEW.last_answer_at>OLD.cycle_started_at AND NEW.last_answer_at>COALESCE(OLD.last_inbound_at,'') BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,actor_id,occurred_at,seconds,first_reply,deadline_seconds)
 VALUES('answer:'||NEW.bot_id||':'||NEW.user_id||':'||OLD.notification_cycle||':'||OLD.cycle_started_at||':'||COALESCE((SELECT id FROM conversations WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id),0),'answer',NEW.bot_id,NEW.user_id,
 COALESCE((SELECT support_group_id FROM conversations WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id),0),OLD.assigned_to,
 NEW.updated_at,ROUND(MAX(0,(julianday(NEW.updated_at)-julianday(OLD.cycle_started_at))*86400),3),
 IIF(OLD.last_answer_at IS NULL OR
   (OLD.last_answer_at>OLD.cycle_started_at AND NOT EXISTS(SELECT 1 FROM statistics_facts WHERE kind='answer' AND bot_id=NEW.bot_id AND user_id=NEW.user_id))
   OR EXISTS(SELECT 1 FROM statistics_facts WHERE kind='reopen' AND bot_id=NEW.bot_id AND user_id=NEW.user_id AND occurred_at>=OLD.last_answer_at AND occurred_at<=NEW.updated_at),1,0),
 60*COALESCE((SELECT reminder_minutes FROM service_responsibility WHERE bot_id=NEW.bot_id),30));
END;

ALTER TABLE manager_statistics_preferences ADD COLUMN access_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE manager_statistics_preferences ADD COLUMN input_revision INTEGER;
ALTER TABLE statistics_schedules ADD COLUMN last_error TEXT;
ALTER TABLE statistics_schedules ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER statistics_schedule_revision AFTER UPDATE OF scope,timezone,send_hour,send_minute,weekday,enabled ON statistics_schedules
WHEN NEW.scope<>OLD.scope OR NEW.timezone<>OLD.timezone OR NEW.send_hour<>OLD.send_hour
 OR NEW.send_minute<>OLD.send_minute OR NEW.weekday<>OLD.weekday OR NEW.enabled<>OLD.enabled BEGIN
 UPDATE statistics_schedules SET revision=revision+1 WHERE recipient_id=NEW.recipient_id AND frequency=NEW.frequency;
END;
INSERT OR IGNORE INTO manager_statistics_preferences(operator_id,updated_at)
 SELECT DISTINCT recipient_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM statistics_schedules;
DELETE FROM statistics_report_cache;
CREATE TRIGGER statistics_assignment_changed AFTER UPDATE OF assigned_to ON conversation_work
WHEN NEW.assigned_to IS NOT OLD.assigned_to BEGIN
 UPDATE manager_statistics_preferences SET access_revision=access_revision+1 WHERE operator_id IN(OLD.assigned_to,NEW.assigned_to);
 DELETE FROM statistics_report_cache WHERE operator_id IN(OLD.assigned_to,NEW.assigned_to);
END;
CREATE TRIGGER statistics_assignment_inserted AFTER INSERT ON conversation_work WHEN NEW.assigned_to IS NOT NULL BEGIN
 UPDATE manager_statistics_preferences SET access_revision=access_revision+1 WHERE operator_id=NEW.assigned_to;
 DELETE FROM statistics_report_cache WHERE operator_id=NEW.assigned_to;
END;
CREATE TRIGGER statistics_assignment_deleted AFTER DELETE ON conversation_work WHEN OLD.assigned_to IS NOT NULL BEGIN
 UPDATE manager_statistics_preferences SET access_revision=access_revision+1 WHERE operator_id=OLD.assigned_to;
 DELETE FROM statistics_report_cache WHERE operator_id=OLD.assigned_to;
END;
CREATE TRIGGER statistics_responsibility_changed AFTER UPDATE OF primary_id,backup_id ON service_responsibility
WHEN NEW.primary_id IS NOT OLD.primary_id OR NEW.backup_id IS NOT OLD.backup_id BEGIN
 UPDATE manager_statistics_preferences SET access_revision=access_revision+1 WHERE operator_id IN(OLD.primary_id,OLD.backup_id,NEW.primary_id,NEW.backup_id);
 DELETE FROM statistics_report_cache WHERE operator_id IN(OLD.primary_id,OLD.backup_id,NEW.primary_id,NEW.backup_id);
END;
CREATE TRIGGER statistics_responsibility_inserted AFTER INSERT ON service_responsibility BEGIN
 UPDATE manager_statistics_preferences SET access_revision=access_revision+1 WHERE operator_id IN(NEW.primary_id,NEW.backup_id);
 DELETE FROM statistics_report_cache WHERE operator_id IN(NEW.primary_id,NEW.backup_id);
END;
CREATE TRIGGER statistics_responsibility_deleted AFTER DELETE ON service_responsibility BEGIN
 UPDATE manager_statistics_preferences SET access_revision=access_revision+1 WHERE operator_id IN(OLD.primary_id,OLD.backup_id);
 DELETE FROM statistics_report_cache WHERE operator_id IN(OLD.primary_id,OLD.backup_id);
END;
CREATE TRIGGER statistics_operator_access_changed AFTER UPDATE OF active ON support_operators WHEN NEW.active IS NOT OLD.active BEGIN
 UPDATE manager_statistics_preferences SET access_revision=access_revision+1 WHERE operator_id=NEW.user_id;
 DELETE FROM statistics_report_cache WHERE operator_id=NEW.user_id;
END;
CREATE TRIGGER statistics_forms_reset AFTER UPDATE OF generation ON storage_control WHEN NEW.generation<>OLD.generation BEGIN
 UPDATE manager_statistics_preferences SET input_kind=NULL,expires_at=NULL,access_revision=access_revision+1;
END;
