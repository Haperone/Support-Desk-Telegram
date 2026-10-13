-- Service responsibility is separate from the assignee of an individual conversation.
CREATE TABLE service_responsibility (
  bot_id TEXT PRIMARY KEY,
  primary_id INTEGER,
  backup_id INTEGER,
  reminder_minutes INTEGER NOT NULL DEFAULT 30 CHECK(reminder_minutes BETWEEN 1 AND 10080),
  fallback_minutes INTEGER NOT NULL DEFAULT 60 CHECK(fallback_minutes BETWEEN 2 AND 20160),
  updated_at TEXT NOT NULL,
  CHECK(primary_id IS NULL OR backup_id IS NULL OR primary_id <> backup_id),
  CHECK(fallback_minutes > reminder_minutes)
);

-- A manager-bot /start records Telegram's prerequisite for a private DM.
-- Availability is an explicit operator choice. A failed send records reachability separately.
CREATE TABLE manager_dm_status (
  operator_id INTEGER PRIMARY KEY,
  started_at TEXT,
  available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)),
  unreachable_at TEXT,
  updated_at TEXT NOT NULL
);

ALTER TABLE conversation_work ADD COLUMN notification_cycle INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_work ADD COLUMN cycle_started_at TEXT;
-- Existing work stays visible in the queue. Its first post-migration inbound
-- starts a measured cycle; deployment must not send a burst of old reminders.

CREATE TRIGGER notification_cycle_insert AFTER INSERT ON conversation_work
WHEN NEW.last_inbound_message_id>0 AND NEW.last_inbound_at IS NOT NULL BEGIN
  UPDATE conversation_work SET notification_cycle=1,cycle_started_at=NEW.last_inbound_at
  WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id;
END;
CREATE TRIGGER notification_cycle_inbound AFTER UPDATE OF last_inbound_message_id ON conversation_work
WHEN NEW.last_inbound_message_id>OLD.last_inbound_message_id
  AND NEW.state='needs_reply' BEGIN
  UPDATE conversation_work SET
    notification_cycle=IIF(OLD.state IN ('waiting','resolved') OR OLD.notification_cycle=0,
      OLD.notification_cycle+1,OLD.notification_cycle),
    cycle_started_at=IIF(OLD.state IN ('waiting','resolved') OR OLD.cycle_started_at IS NULL,
      NEW.last_inbound_at,OLD.cycle_started_at)
  WHERE bot_id=NEW.bot_id AND user_id=NEW.user_id;
END;

-- One logical event per service/client/cycle/kind/recipient. Sending is claimed before
-- the external call; an expired claim is uncertain, never automatically retried.
CREATE TABLE service_notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  notification_cycle INTEGER NOT NULL CHECK(notification_cycle>0),
  kind TEXT NOT NULL CHECK(kind IN ('new','reply','transfer','reminder','fallback')),
  recipient_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','retryable','failed','uncertain','cancelled')),
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claim_token TEXT,
  claimed_at TEXT,
  telegram_message_id INTEGER,
  sent_at TEXT,
  error_code TEXT,
  UNIQUE(bot_id,user_id,notification_cycle,kind,recipient_id),
  CHECK(status <> 'sending' OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK(status <> 'sent' OR (telegram_message_id IS NOT NULL AND sent_at IS NOT NULL))
);
CREATE INDEX service_notification_due ON service_notification_outbox(status,available_at,id);
CREATE INDEX service_notification_conversation ON service_notification_outbox(bot_id,user_id,notification_cycle);
