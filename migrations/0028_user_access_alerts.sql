-- Durable, bounded-rate alerts about support access decisions. No customer text is copied.
CREATE TABLE user_access_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 event_key TEXT NOT NULL UNIQUE,
 bot_id TEXT NOT NULL,
 user_id INTEGER NOT NULL,
 kind TEXT NOT NULL,
 created_at TEXT NOT NULL,
 last_seen TEXT NOT NULL,
 occurrences INTEGER NOT NULL DEFAULT 1,
 deadline TEXT,
 reference_id INTEGER,
 detail TEXT,
 ready_at TEXT NOT NULL,
 owner_token TEXT,
 lease_until TEXT,
 request_started_at TEXT,
 sent_at TEXT,
 uncertain_at TEXT
);
CREATE INDEX user_access_ready ON user_access_events(ready_at,id) WHERE sent_at IS NULL AND uncertain_at IS NULL;
CREATE INDEX user_access_retention ON user_access_events(created_at);
CREATE TRIGGER access_failed_proof AFTER UPDATE OF status ON verification_attempts
WHEN NEW.status='failed' AND OLD.status<>'failed' AND (SELECT mode FROM storage_control WHERE id=1)='normal'
BEGIN
 INSERT INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,reference_id,ready_at)
 SELECT 'captcha-failed:'||c.id,c.bot_id,c.user_id,'verification_failed',NEW.completed_at,NEW.completed_at,c.id,NEW.completed_at
 FROM verification_challenges c WHERE c.id=NEW.challenge_id
 ON CONFLICT(event_key) DO UPDATE SET occurrences=occurrences+1,last_seen=excluded.last_seen;
END;
CREATE TABLE user_access_dispatch (
 id INTEGER PRIMARY KEY CHECK(id=1), owner_token TEXT, lease_until TEXT, next_send_at TEXT
);
INSERT INTO user_access_dispatch(id) VALUES(1);

CREATE TRIGGER access_challenge AFTER INSERT ON verification_challenges
WHEN (SELECT mode FROM storage_control WHERE id=1)='normal' AND (NEW.status='pending') BEGIN
 INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,reference_id,detail,ready_at)
 VALUES('captcha:'||NEW.id,NEW.bot_id,NEW.user_id,'verification_required',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.expires_at,NEW.id,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER access_passed AFTER UPDATE OF status ON verification_challenges
WHEN (SELECT mode FROM storage_control WHERE id=1)='normal' AND (NEW.status='passed' AND OLD.status<>'passed') BEGIN
 INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,reference_id,detail,ready_at)
 VALUES('passed:'||NEW.id,NEW.bot_id,NEW.user_id,'verification_passed',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NEW.id,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER access_challenge_ended AFTER UPDATE OF status ON verification_challenges
WHEN (SELECT mode FROM storage_control WHERE id=1)='normal' AND (OLD.status='pending' AND NEW.status IN ('expired','failed')) BEGIN
 INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,reference_id,detail,ready_at)
 VALUES('captcha-ended:'||NEW.id,NEW.bot_id,NEW.user_id,'verification_ended',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.expires_at,NEW.id,NEW.status,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER access_challenge_due AFTER INSERT ON verification_challenges
WHEN (SELECT mode FROM storage_control WHERE id=1)='normal' AND (NEW.status='pending') BEGIN
 INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,reference_id,detail,ready_at)
 VALUES('captcha-due:'||NEW.id,NEW.bot_id,NEW.user_id,'verification_due',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.expires_at,NEW.id,NULL,NEW.expires_at);
END;

CREATE TRIGGER access_auto_restricted AFTER UPDATE OF muted_until ON user_abuse_state
WHEN (SELECT mode FROM storage_control WHERE id=1)='normal' AND (NEW.muted_until IS NOT OLD.muted_until AND NEW.muted_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN
 INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,reference_id,detail,ready_at)
 VALUES('auto_restricted:'||NEW.bot_id||':'||NEW.user_id||':'||NEW.muted_until,NEW.bot_id,NEW.user_id,'auto_restricted',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.muted_until,NULL,CAST(NEW.risk_score AS TEXT),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER access_auto_restricted_due AFTER UPDATE OF muted_until ON user_abuse_state
WHEN (SELECT mode FROM storage_control WHERE id=1)='normal' AND (NEW.muted_until IS NOT OLD.muted_until AND NEW.muted_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN
 INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,reference_id,detail,ready_at)
 VALUES('auto_restricted-due:'||NEW.bot_id||':'||NEW.user_id||':'||NEW.muted_until,NEW.bot_id,NEW.user_id,'auto_restricted_due',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.muted_until,NULL,NULL,NEW.muted_until);
END;

CREATE TRIGGER access_auto_restricted_removed AFTER UPDATE OF muted_until ON user_abuse_state
WHEN (SELECT mode FROM storage_control WHERE id=1)='normal' AND (OLD.muted_until IS NOT NULL AND NEW.muted_until IS NULL) BEGIN
 INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,reference_id,detail,ready_at)
 VALUES('auto_restricted-removed:'||NEW.bot_id||':'||NEW.user_id||':'||OLD.muted_until,NEW.bot_id,NEW.user_id,'auto_restricted_removed',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER access_restricted AFTER UPDATE OF manual_restricted_until ON user_abuse_state
WHEN (SELECT mode FROM storage_control WHERE id=1)='normal' AND (NEW.manual_restricted_until IS NOT OLD.manual_restricted_until AND NEW.manual_restricted_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN
 INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,reference_id,detail,ready_at)
 VALUES('restricted:'||NEW.bot_id||':'||NEW.user_id||':'||NEW.manual_restricted_until,NEW.bot_id,NEW.user_id,'restricted',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.manual_restricted_until,NULL,CAST(NEW.risk_score AS TEXT),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER access_restricted_due AFTER UPDATE OF manual_restricted_until ON user_abuse_state
WHEN (SELECT mode FROM storage_control WHERE id=1)='normal' AND (NEW.manual_restricted_until IS NOT OLD.manual_restricted_until AND NEW.manual_restricted_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN
 INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,reference_id,detail,ready_at)
 VALUES('restricted-due:'||NEW.bot_id||':'||NEW.user_id||':'||NEW.manual_restricted_until,NEW.bot_id,NEW.user_id,'restricted_due',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.manual_restricted_until,NULL,NULL,NEW.manual_restricted_until);
END;

CREATE TRIGGER access_restricted_removed AFTER UPDATE OF manual_restricted_until ON user_abuse_state
WHEN (SELECT mode FROM storage_control WHERE id=1)='normal' AND (OLD.manual_restricted_until IS NOT NULL AND NEW.manual_restricted_until IS NULL) BEGIN
 INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,reference_id,detail,ready_at)
 VALUES('restricted-removed:'||NEW.bot_id||':'||NEW.user_id||':'||OLD.manual_restricted_until,NEW.bot_id,NEW.user_id,'restricted_removed',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER access_ban AFTER INSERT ON banned_users
WHEN (SELECT mode FROM storage_control WHERE id=1)='normal' AND (1) BEGIN
 INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,reference_id,detail,ready_at)
 VALUES('ban:'||NEW.bot_id||':'||NEW.user_id||':'||NEW.banned_at,NEW.bot_id,NEW.user_id,'banned',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL,NEW.reason,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER access_unban AFTER DELETE ON banned_users
WHEN (SELECT mode FROM storage_control WHERE id=1)='normal' AND (1) BEGIN
 INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,reference_id,detail,ready_at)
 VALUES('unban:'||OLD.bot_id||':'||OLD.user_id||':'||OLD.banned_at,OLD.bot_id,OLD.user_id,'unbanned',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER access_rejection AFTER INSERT ON abuse_events
WHEN NEW.event_type IN ('access_rate_limited','access_queue_full','access_limiter_unavailable')
BEGIN
 INSERT INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,ready_at)
 VALUES(NEW.event_type||':'||NEW.bot_id||':'||NEW.user_id||':'||CAST(unixepoch(NEW.created_at)/300 AS INTEGER),
 NEW.bot_id,NEW.user_id,NEW.event_type,NEW.created_at,NEW.created_at,NEW.created_at)
 ON CONFLICT(event_key) DO UPDATE SET occurrences=occurrences+1,last_seen=excluded.last_seen;
END;

INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,ready_at) SELECT 'auto_restricted:'||bot_id||':'||user_id||':'||muted_until,bot_id,user_id,'auto_restricted',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),muted_until,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM user_abuse_state WHERE muted_until>strftime('%Y-%m-%dT%H:%M:%fZ','now');

INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,ready_at) SELECT 'auto_restricted-due:'||bot_id||':'||user_id||':'||muted_until,bot_id,user_id,'auto_restricted_due',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),muted_until,muted_until FROM user_abuse_state WHERE muted_until>strftime('%Y-%m-%dT%H:%M:%fZ','now');

INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,ready_at) SELECT 'restricted:'||bot_id||':'||user_id||':'||manual_restricted_until,bot_id,user_id,'restricted',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),manual_restricted_until,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM user_abuse_state WHERE manual_restricted_until>strftime('%Y-%m-%dT%H:%M:%fZ','now');

INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,ready_at) SELECT 'restricted-due:'||bot_id||':'||user_id||':'||manual_restricted_until,bot_id,user_id,'restricted_due',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),manual_restricted_until,manual_restricted_until FROM user_abuse_state WHERE manual_restricted_until>strftime('%Y-%m-%dT%H:%M:%fZ','now');

INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,detail,ready_at) SELECT 'ban:'||bot_id||':'||user_id||':'||banned_at,bot_id,user_id,'banned',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),reason,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM banned_users;

INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,reference_id,ready_at) SELECT 'captcha:'||id,bot_id,user_id,'verification_required',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),expires_at,id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM verification_challenges WHERE status='pending';

INSERT OR IGNORE INTO user_access_events(event_key,bot_id,user_id,kind,created_at,last_seen,deadline,reference_id,ready_at) SELECT 'captcha-due:'||id,bot_id,user_id,'verification_due',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),expires_at,id,expires_at FROM verification_challenges WHERE status='pending';
