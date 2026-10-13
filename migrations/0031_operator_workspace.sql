-- Operator navigation and durable classification of internal replies.
CREATE TABLE operator_ui_sessions (
  operator_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL DEFAULT 1,
  bot_id TEXT NOT NULL, message_id INTEGER, route TEXT NOT NULL DEFAULT 'um:n:home',
  history_json TEXT NOT NULL DEFAULT '[]', list_route TEXT, search_query TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(operator_id, chat_id, thread_id)
);
-- Keep these tombstones through history reset: an old internal reply must never become a customer reply.
CREATE TABLE operator_input_prompts (
  chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, operator_id INTEGER NOT NULL,
  kind TEXT NOT NULL, nonce TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(chat_id, message_id)
);
ALTER TABLE support_operator_flows ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE operator_pending_actions ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_message_flows ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
CREATE TABLE bot_message_drafts (
  owner_id INTEGER NOT NULL, bot_id TEXT NOT NULL, field TEXT NOT NULL,
  draft TEXT NOT NULL, expected_revision TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, bot_id, field)
);
CREATE TABLE bot_message_preferences (
  bot_id TEXT PRIMARY KEY, welcome_enabled INTEGER NOT NULL DEFAULT 1,
  auto_reply_enabled INTEGER NOT NULL DEFAULT 1,
  welcome_reviewed INTEGER NOT NULL DEFAULT 0, auto_reply_reviewed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE conversation_work (
  bot_id TEXT NOT NULL, user_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'needs_reply' CHECK(state IN ('needs_reply','waiting','snoozed','resolved')),
  assigned_to INTEGER, snoozed_until TEXT, note TEXT NOT NULL DEFAULT '',
  last_inbound_at TEXT, last_answer_at TEXT, resolved_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY(bot_id, user_id)
);
CREATE INDEX conversation_work_queue ON conversation_work(state, snoozed_until, last_inbound_at);
INSERT INTO conversation_work(bot_id,user_id,state,last_inbound_at,last_answer_at,updated_at)
SELECT c.bot_id,c.user_id,CASE WHEN COALESCE((SELECT MAX(started_at) FROM message_delivery_attempts WHERE bot_id=c.bot_id AND user_id=c.user_id AND direction='support_to_user' AND completed_at IS NOT NULL AND target_message_id IS NOT NULL),'') >= COALESCE(c.last_message_at,c.created_at) THEN 'waiting' ELSE 'needs_reply' END,
  COALESCE(c.last_message_at,c.created_at),
  (SELECT MAX(started_at) FROM message_delivery_attempts WHERE bot_id=c.bot_id AND user_id=c.user_id AND direction='support_to_user' AND completed_at IS NOT NULL AND target_message_id IS NOT NULL),
  strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM conversations c;
CREATE TABLE operator_work_inputs (
  operator_id INTEGER PRIMARY KEY, bot_id TEXT NOT NULL, user_id INTEGER NOT NULL,
  target_operator INTEGER, nonce TEXT NOT NULL, expected_revision INTEGER NOT NULL,
  chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL, expires_at TEXT NOT NULL,
  draft TEXT, suspended INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE service_attack_state ADD COLUMN override_until TEXT;
CREATE TABLE operator_input_guards (
  operator_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, thread_id INTEGER,
  nonce TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TRIGGER pending_internal_guard_insert AFTER INSERT ON operator_pending_actions BEGIN
  INSERT INTO operator_input_guards(operator_id,chat_id,thread_id,nonce,active)
  VALUES(NEW.operator_id,NEW.chat_id,NEW.thread_id,NEW.flow_nonce,1)
  ON CONFLICT(operator_id) DO UPDATE SET chat_id=excluded.chat_id,thread_id=excluded.thread_id,nonce=excluded.nonce,active=1;
END;
CREATE TRIGGER pending_internal_guard_update AFTER UPDATE OF stage,flow_nonce,suspended ON operator_pending_actions BEGIN
  INSERT INTO operator_input_guards(operator_id,chat_id,thread_id,nonce,active)
  VALUES(NEW.operator_id,NEW.chat_id,NEW.thread_id,NEW.flow_nonce,CASE WHEN NEW.stage='executing' OR NEW.suspended=1 THEN 0 ELSE 1 END)
  ON CONFLICT(operator_id) DO UPDATE SET chat_id=excluded.chat_id,thread_id=excluded.thread_id,nonce=excluded.nonce,active=excluded.active;
END;
CREATE TABLE operator_input_navigation(operator_id INTEGER PRIMARY KEY, keep_kind TEXT NOT NULL DEFAULT '');
CREATE TRIGGER operator_input_navigation_update AFTER UPDATE ON operator_input_navigation BEGIN
  UPDATE operator_pending_actions SET suspended=1 WHERE operator_id=NEW.operator_id AND suspended=0 AND NEW.keep_kind<>'pa';
  UPDATE support_operator_flows SET suspended=1 WHERE owner_id=NEW.operator_id AND suspended=0 AND NEW.keep_kind<>'o';
  UPDATE bot_message_flows SET suspended=1 WHERE owner_id=NEW.operator_id AND suspended=0 AND NEW.keep_kind<>'m';
  UPDATE operator_work_inputs SET suspended=1 WHERE operator_id=NEW.operator_id AND suspended=0 AND NEW.keep_kind<>'w';
END;
CREATE TRIGGER operator_input_navigation_insert AFTER INSERT ON operator_input_navigation BEGIN
  UPDATE operator_input_navigation SET keep_kind=NEW.keep_kind WHERE operator_id=NEW.operator_id;
END;
CREATE TRIGGER bot_message_keep_draft AFTER UPDATE OF draft ON bot_message_flows WHEN NEW.draft<>'' BEGIN
  INSERT INTO bot_message_drafts(owner_id,bot_id,field,draft,expected_revision,updated_at)
  VALUES(NEW.owner_id,NEW.bot_id,NEW.field,NEW.draft,NEW.expected_revision,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(owner_id,bot_id,field) DO UPDATE SET draft=excluded.draft,expected_revision=excluded.expected_revision,updated_at=excluded.updated_at;
END;
