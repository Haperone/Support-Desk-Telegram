-- Explicit AUTO and expired timed overrides take precedence over deployment defaults.
ALTER TABLE service_attack_state ADD COLUMN manual_controlled INTEGER NOT NULL DEFAULT 0;
CREATE INDEX service_checks_bot ON service_checks(bot_id, expires_at);
CREATE TABLE operator_note_drafts (
 operator_id INTEGER NOT NULL, bot_id TEXT NOT NULL, user_id INTEGER NOT NULL,
 target_operator INTEGER NOT NULL, draft TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(operator_id,bot_id,user_id)
);
CREATE TRIGGER handoff_keep_draft AFTER UPDATE OF draft ON operator_work_inputs
WHEN NEW.user_id>0 AND NEW.target_operator IS NOT NULL AND NEW.draft IS NOT NULL BEGIN
 INSERT INTO operator_note_drafts(operator_id,bot_id,user_id,target_operator,draft,updated_at)
 VALUES(NEW.operator_id,NEW.bot_id,NEW.user_id,NEW.target_operator,NEW.draft,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 ON CONFLICT(operator_id,bot_id,user_id) DO UPDATE SET target_operator=excluded.target_operator,draft=excluded.draft,updated_at=excluded.updated_at;
END;
