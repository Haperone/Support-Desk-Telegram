-- Compact statistics facts: no message text, credentials, names or attachments.
CREATE TABLE statistics_control (
 id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT NOT NULL,
 capacity INTEGER NOT NULL DEFAULT 20000, facts_count INTEGER NOT NULL DEFAULT 0, users_count INTEGER NOT NULL DEFAULT 0,
 write_day TEXT NOT NULL DEFAULT '',daily_facts INTEGER NOT NULL DEFAULT 0,
 clipped_at TEXT,retained_after TEXT
);
INSERT INTO statistics_control(id,started_at) VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE statistics_users (
 bot_id TEXT NOT NULL,user_id INTEGER NOT NULL,first_seen TEXT NOT NULL,
 PRIMARY KEY(bot_id,user_id)
);
INSERT INTO statistics_users SELECT bot_id,user_id,created_at FROM conversations ORDER BY created_at LIMIT 20000;
CREATE INDEX statistics_users_global ON statistics_users(user_id,first_seen);
UPDATE statistics_control SET users_count=(SELECT COUNT(*) FROM statistics_users) WHERE id=1;
UPDATE statistics_control SET clipped_at=started_at WHERE (SELECT COUNT(*) FROM conversations)>20000;
CREATE TRIGGER statistics_user_count_insert AFTER INSERT ON statistics_users BEGIN
 UPDATE statistics_control SET users_count=users_count+1 WHERE id=1;
END;
CREATE TRIGGER statistics_user_capacity BEFORE INSERT ON statistics_users
WHEN NOT EXISTS(SELECT 1 FROM statistics_users WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id)
 AND (SELECT users_count>=20000 FROM statistics_control WHERE id=1) BEGIN
 UPDATE statistics_control SET clipped_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1 AND (clipped_at IS NULL OR substr(clipped_at,1,10)<>date('now'));
 SELECT RAISE(IGNORE);
END;
CREATE TRIGGER statistics_user_count_delete AFTER DELETE ON statistics_users BEGIN
 UPDATE statistics_control SET users_count=users_count-1 WHERE id=1;
END;
CREATE TABLE statistics_facts (
 event_key TEXT PRIMARY KEY,kind TEXT NOT NULL,bot_id TEXT NOT NULL,user_id INTEGER,
 group_id INTEGER NOT NULL DEFAULT 0,actor_id INTEGER,occurred_at TEXT NOT NULL,
 direction TEXT,delivered_at TEXT,failure_at TEXT,failure_code TEXT,
 seconds REAL,first_reply INTEGER,deadline_seconds INTEGER
);
CREATE INDEX statistics_facts_period ON statistics_facts(occurred_at,bot_id);
CREATE INDEX statistics_facts_service_period ON statistics_facts(bot_id,occurred_at);
CREATE INDEX statistics_facts_delivery ON statistics_facts(delivered_at);
CREATE INDEX statistics_facts_failure ON statistics_facts(failure_at);
CREATE TRIGGER statistics_capacity BEFORE INSERT ON statistics_facts
WHEN NOT EXISTS(SELECT 1 FROM statistics_facts WHERE event_key=NEW.event_key) BEGIN
 UPDATE statistics_control SET clipped_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1
 AND (facts_count>=capacity OR (write_day=date('now') AND daily_facts>=2000))
 AND (clipped_at IS NULL OR substr(clipped_at,1,10)<>date('now'));
 SELECT RAISE(IGNORE) WHERE (SELECT facts_count>=capacity OR (write_day=date('now') AND daily_facts>=2000) FROM statistics_control WHERE id=1);
 -- Reserve before nested first-user facts are inserted, keeping the cap exact.
 UPDATE statistics_control SET facts_count=facts_count+1,
 daily_facts=IIF(write_day=date('now'),daily_facts+1,1),write_day=date('now') WHERE id=1;
END;
CREATE TRIGGER statistics_count_delete AFTER DELETE ON statistics_facts BEGIN
 UPDATE statistics_control SET facts_count=facts_count-1,
 retained_after=IIF((SELECT mode FROM storage_control WHERE id=1)='normal',MAX(COALESCE(retained_after,''),OLD.occurred_at),retained_after) WHERE id=1;
END;
CREATE TRIGGER statistics_message_user AFTER INSERT ON statistics_facts
WHEN NEW.kind='message' AND NEW.direction='user_to_support' AND NEW.user_id IS NOT NULL BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,occurred_at)
 SELECT 'new:'||NEW.bot_id||':'||NEW.user_id,'new',NEW.bot_id,NEW.user_id,NEW.group_id,NEW.occurred_at
 WHERE NOT EXISTS(SELECT 1 FROM statistics_users WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id);
 INSERT OR IGNORE INTO statistics_users(bot_id,user_id,first_seen)
 VALUES(NEW.bot_id,NEW.user_id,NEW.occurred_at);
END;
CREATE TABLE manager_statistics_preferences (
 operator_id INTEGER PRIMARY KEY,scope TEXT NOT NULL DEFAULT 'a',
 timezone TEXT NOT NULL DEFAULT 'Europe/Budapest',period TEXT NOT NULL DEFAULT 'today',
 custom_start TEXT,custom_end TEXT,input_kind TEXT,expires_at TEXT,updated_at TEXT NOT NULL
);
CREATE TABLE statistics_schedules (
 recipient_id INTEGER NOT NULL,frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly')),
 scope TEXT NOT NULL DEFAULT 'a',timezone TEXT NOT NULL DEFAULT 'Europe/Budapest',
 send_hour INTEGER NOT NULL DEFAULT 9 CHECK(send_hour BETWEEN 0 AND 23),
 send_minute INTEGER NOT NULL DEFAULT 0 CHECK(send_minute BETWEEN 0 AND 59),
 weekday INTEGER NOT NULL DEFAULT 1 CHECK(weekday BETWEEN 0 AND 6),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 next_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN('idle','sending','uncertain')),
 claim_token TEXT,claimed_at TEXT,last_period_end TEXT,last_sent_at TEXT,updated_at TEXT NOT NULL,
 PRIMARY KEY(recipient_id,frequency)
);
CREATE INDEX statistics_schedule_due ON statistics_schedules(enabled,next_at);
CREATE TABLE statistics_report_cache (
 operator_id INTEGER PRIMARY KEY,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,expires_at TEXT NOT NULL
);
CREATE TRIGGER statistics_reset AFTER UPDATE OF generation ON storage_control WHEN NEW.generation<>OLD.generation BEGIN
 UPDATE statistics_control SET started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),clipped_at=NULL,retained_after=NULL WHERE id=1;
 UPDATE statistics_schedules SET enabled=0,status='idle',claim_token=NULL WHERE enabled=1;
END;

CREATE TRIGGER statistics_single_received AFTER INSERT ON message_delivery_attempts BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,occurred_at,direction)
 VALUES('m:'||NEW.bot_id||':'||NEW.direction||':'||NEW.source_chat_id||':'||NEW.source_message_id,'message',NEW.bot_id,NEW.user_id,COALESCE((SELECT support_group_id FROM conversations WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id), (SELECT group_id FROM service_group_routes WHERE bot_id=NEW.bot_id),0),COALESCE(NEW.source_created_at,NEW.started_at),NEW.direction);
END;
CREATE TRIGGER statistics_single_delivered AFTER UPDATE ON message_delivery_attempts WHEN NEW.completed_at IS NOT NULL AND NEW.target_message_id IS NOT NULL BEGIN
 UPDATE statistics_facts SET delivered_at=COALESCE(delivered_at,NEW.completed_at)
 WHERE event_key='m:'||NEW.bot_id||':'||NEW.direction||':'||NEW.source_chat_id||':'||NEW.source_message_id AND delivered_at IS NULL;
END;
CREATE TRIGGER statistics_single_failed AFTER UPDATE ON message_delivery_attempts WHEN NEW.failure_code IS NOT NULL BEGIN
 UPDATE statistics_facts SET failure_at=COALESCE(failure_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),failure_code=NEW.failure_code
 WHERE event_key='m:'||NEW.bot_id||':'||NEW.direction||':'||NEW.source_chat_id||':'||NEW.source_message_id AND delivered_at IS NULL AND failure_at IS NULL;
END;

CREATE TRIGGER statistics_pending_received AFTER INSERT ON pending_messages BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,occurred_at,direction)
 VALUES('m:'||NEW.bot_id||':'||'user_to_support'||':'||NEW.source_chat_id||':'||NEW.source_message_id,'message',NEW.bot_id,NEW.user_id,COALESCE((SELECT support_group_id FROM conversations WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id), (SELECT group_id FROM service_group_routes WHERE bot_id=NEW.bot_id),0),COALESCE(NEW.source_created_at,NEW.created_at),'user_to_support');
 UPDATE statistics_facts SET failure_at=COALESCE(failure_at,NEW.created_at),failure_code=NEW.failure_code
 WHERE event_key='m:'||NEW.bot_id||':user_to_support:'||NEW.source_chat_id||':'||NEW.source_message_id AND NEW.failure_code IS NOT NULL AND failure_at IS NULL;
END;
CREATE TRIGGER statistics_pending_delivered AFTER UPDATE ON pending_messages WHEN NEW.delivered_at IS NOT NULL BEGIN
 UPDATE statistics_facts SET delivered_at=COALESCE(delivered_at,NEW.delivered_at)
 WHERE event_key='m:'||NEW.bot_id||':'||'user_to_support'||':'||NEW.source_chat_id||':'||NEW.source_message_id AND delivered_at IS NULL;
END;
CREATE TRIGGER statistics_pending_failed AFTER UPDATE OF failure_code,failed_at ON pending_messages
WHEN NEW.failure_code IS NOT NULL AND (NEW.failure_code<>COALESCE(OLD.failure_code,'') OR NEW.failed_at<>COALESCE(OLD.failed_at,'')) BEGIN
 UPDATE statistics_facts SET failure_at=COALESCE(failure_at,NEW.failed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),failure_code=NEW.failure_code
 WHERE event_key='m:'||NEW.bot_id||':'||'user_to_support'||':'||NEW.source_chat_id||':'||NEW.source_message_id AND delivered_at IS NULL AND failure_at IS NULL;
END;

CREATE TRIGGER statistics_reopen_received AFTER INSERT ON reopen_business_messages BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,occurred_at,direction)
 VALUES('m:'||NEW.bot_id||':'||'user_to_support'||':'||NEW.user_id||':'||NEW.source_message_id,'message',NEW.bot_id,NEW.user_id,COALESCE((SELECT support_group_id FROM conversations WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id), (SELECT group_id FROM service_group_routes WHERE bot_id=NEW.bot_id),0),COALESCE(NEW.source_created_at,NEW.created_at),'user_to_support');
END;
CREATE TRIGGER statistics_reopen_delivered AFTER UPDATE ON reopen_business_messages WHEN NEW.delivered_at IS NOT NULL BEGIN
 UPDATE statistics_facts SET delivered_at=COALESCE(delivered_at,NEW.delivered_at)
 WHERE event_key='m:'||NEW.bot_id||':'||'user_to_support'||':'||NEW.user_id||':'||NEW.source_message_id AND delivered_at IS NULL;
END;
CREATE TRIGGER statistics_reopen_failed AFTER UPDATE ON reopen_business_messages WHEN NEW.failure_code IS NOT NULL BEGIN
 UPDATE statistics_facts SET failure_at=COALESCE(failure_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),failure_code=NEW.failure_code
 WHERE event_key='m:'||NEW.bot_id||':'||'user_to_support'||':'||NEW.user_id||':'||NEW.source_message_id AND delivered_at IS NULL AND failure_at IS NULL;
END;

CREATE TRIGGER statistics_album_received AFTER INSERT ON media_group_items BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,occurred_at,direction)
 VALUES('m:'||NEW.bot_id||':'||NEW.direction||':'||NEW.source_chat_id||':'||NEW.message_id,'message',NEW.bot_id,(SELECT user_id FROM media_groups WHERE bot_id=NEW.bot_id AND direction=NEW.direction AND media_group_id=NEW.media_group_id AND source_chat_id=NEW.source_chat_id),COALESCE((SELECT support_group_id FROM conversations WHERE bot_id=NEW.bot_id AND user_id=(SELECT user_id FROM media_groups WHERE bot_id=NEW.bot_id AND direction=NEW.direction AND media_group_id=NEW.media_group_id AND source_chat_id=NEW.source_chat_id)), (SELECT group_id FROM service_group_routes WHERE bot_id=NEW.bot_id),0),COALESCE(NEW.source_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',NEW.received_at/1000.0,'unixepoch')),NEW.direction);
END;
CREATE TRIGGER statistics_album_delivered AFTER UPDATE ON media_group_items WHEN NEW.delivered_at IS NOT NULL AND NEW.target_message_id IS NOT NULL BEGIN
 UPDATE statistics_facts SET delivered_at=COALESCE(delivered_at,NEW.delivered_at)
 WHERE event_key='m:'||NEW.bot_id||':'||NEW.direction||':'||NEW.source_chat_id||':'||NEW.message_id AND delivered_at IS NULL;
END;
CREATE TRIGGER statistics_album_failed AFTER UPDATE ON media_group_items WHEN NEW.delivery_uncertain_at IS NOT NULL BEGIN
 UPDATE statistics_facts SET failure_at=COALESCE(failure_at,NEW.delivery_uncertain_at),failure_code='telegram_delivery_outcome_unknown'
 WHERE event_key='m:'||NEW.bot_id||':'||NEW.direction||':'||NEW.source_chat_id||':'||NEW.message_id AND delivered_at IS NULL AND failure_at IS NULL;
END;

CREATE TRIGGER statistics_topic_state AFTER UPDATE OF status ON conversations WHEN NEW.status<>OLD.status BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,actor_id,occurred_at)
 VALUES('topic:'||NEW.bot_id||':'||NEW.user_id||':'||NEW.reply_epoch||':'||NEW.status,
 IIF(NEW.status='open','reopen','close'),NEW.bot_id,NEW.user_id,NEW.support_group_id,
 (SELECT assigned_to FROM conversation_work WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER statistics_answer AFTER UPDATE OF last_answer_at ON conversation_work
WHEN NEW.last_answer_at>COALESCE(OLD.last_answer_at,'') AND OLD.cycle_started_at IS NOT NULL AND OLD.notification_cycle>0
 AND NEW.last_answer_at>OLD.cycle_started_at BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,actor_id,occurred_at,seconds,first_reply,deadline_seconds)
 VALUES('answer:'||NEW.bot_id||':'||NEW.user_id||':'||OLD.notification_cycle,'answer',NEW.bot_id,NEW.user_id,
 COALESCE((SELECT support_group_id FROM conversations WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id),0),OLD.assigned_to,
 NEW.updated_at,MAX(0,(julianday(NEW.updated_at)-julianday(OLD.cycle_started_at))*86400),
 IIF(OLD.last_answer_at IS NULL OR EXISTS(SELECT 1 FROM statistics_facts WHERE kind='reopen' AND bot_id=NEW.bot_id AND user_id=NEW.user_id AND occurred_at>=OLD.last_answer_at AND occurred_at<=NEW.updated_at),1,0),
 60*COALESCE((SELECT reminder_minutes FROM service_responsibility WHERE bot_id=NEW.bot_id),30));
END;
CREATE TRIGGER statistics_verification_created AFTER INSERT ON verification_challenges BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,occurred_at)
 VALUES('check:'||NEW.id,'check',NEW.bot_id,NEW.user_id,COALESCE((SELECT support_group_id FROM conversations WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id),(SELECT group_id FROM service_group_routes WHERE bot_id=NEW.bot_id),0),NEW.created_at);
END;
CREATE TRIGGER statistics_verification_done AFTER UPDATE OF status ON verification_challenges
WHEN NEW.status IN('passed','failed','expired') AND OLD.status='pending' BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,occurred_at)
 VALUES('check-result:'||NEW.id,NEW.status,NEW.bot_id,NEW.user_id,COALESCE((SELECT support_group_id FROM conversations WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id),(SELECT group_id FROM service_group_routes WHERE bot_id=NEW.bot_id),0),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER statistics_ban AFTER INSERT ON banned_users BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,actor_id,occurred_at)
 VALUES('ban:'||NEW.bot_id||':'||NEW.user_id||':'||NEW.banned_at,'ban',NEW.bot_id,NEW.user_id,COALESCE((SELECT support_group_id FROM conversations WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id),(SELECT group_id FROM service_group_routes WHERE bot_id=NEW.bot_id),0),NEW.banned_by,NEW.banned_at);
END;
CREATE TRIGGER statistics_restriction AFTER UPDATE OF manual_restricted_until,muted_until ON user_abuse_state
WHEN COALESCE(NEW.manual_restricted_until,'')>COALESCE(OLD.manual_restricted_until,'') OR COALESCE(NEW.muted_until,'')>COALESCE(OLD.muted_until,'') BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,occurred_at)
 VALUES('restriction:'||NEW.bot_id||':'||NEW.user_id||':'||NEW.updated_at,'restriction',NEW.bot_id,NEW.user_id,COALESCE((SELECT support_group_id FROM conversations WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id),(SELECT group_id FROM service_group_routes WHERE bot_id=NEW.bot_id),0),NEW.updated_at);
END;
CREATE TRIGGER statistics_restriction_created AFTER INSERT ON user_abuse_state
WHEN NEW.manual_restricted_until IS NOT NULL OR NEW.muted_until IS NOT NULL BEGIN
 INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,user_id,group_id,occurred_at)
 VALUES('restriction:'||NEW.bot_id||':'||NEW.user_id||':'||NEW.updated_at,'restriction',NEW.bot_id,NEW.user_id,COALESCE((SELECT support_group_id FROM conversations WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id),(SELECT group_id FROM service_group_routes WHERE bot_id=NEW.bot_id),0),NEW.updated_at);
END;
