-- A service has one active destination; a group may contain several services.
CREATE TABLE support_groups (
  group_id INTEGER PRIMARY KEY,
  title TEXT,
  forum_verified_at TEXT,
  manager_verified_at TEXT,
  service_verified_at TEXT,
  menu_message_id INTEGER,
  menu_state TEXT NOT NULL DEFAULT 'pending' CHECK(menu_state IN ('pending','ready','uncertain')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE service_group_routes (
  bot_id TEXT PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES support_groups(group_id),
  revision INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK(source IN ('legacy','wizard')),
  updated_at TEXT NOT NULL
);
CREATE INDEX service_group_routes_group ON service_group_routes(group_id, bot_id);

-- The active conversation row retains its existing bot/user uniqueness. On a
-- cutover its old topic is archived here before a new topic is provisioned.
CREATE TABLE service_topic_history (
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  support_group_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_message_at TEXT,
  archived_at TEXT NOT NULL,
  replacement_group_id INTEGER NOT NULL,
  replacement_thread_id INTEGER,
  PRIMARY KEY (support_group_id, thread_id),
  UNIQUE (conversation_id)
);
CREATE INDEX service_topic_history_user ON service_topic_history(bot_id, user_id, archived_at);

-- Old mappings cannot be assigned a group after the active row is replaced.
ALTER TABLE message_mappings ADD COLUMN support_group_id INTEGER;
UPDATE message_mappings SET support_group_id = (
  SELECT c.support_group_id FROM conversations c
  WHERE c.bot_id = message_mappings.bot_id AND c.user_id = message_mappings.user_id
    AND c.thread_id = message_mappings.thread_id
);
UPDATE message_mappings SET support_group_id = (
  SELECT t.support_group_id FROM storage_topics t
  WHERE t.bot_id = message_mappings.bot_id AND t.user_id = message_mappings.user_id
    AND t.thread_id = message_mappings.thread_id
  LIMIT 1
) WHERE support_group_id IS NULL;
DROP INDEX message_mappings_support_message_idx;
CREATE UNIQUE INDEX message_mappings_support_message_idx
  ON message_mappings(bot_id, support_group_id, thread_id, support_message_id)
  WHERE support_message_id IS NOT NULL;
CREATE TRIGGER service_mapping_group AFTER INSERT ON message_mappings
WHEN NEW.support_group_id IS NULL BEGIN
  UPDATE message_mappings SET support_group_id = (
    SELECT c.support_group_id FROM conversations c
    WHERE c.bot_id = NEW.bot_id AND c.user_id = NEW.user_id AND c.thread_id = NEW.thread_id
  ) WHERE id = NEW.id;
END;

-- Provision markers and in-flight deliveries are checked before cutover.
-- A prepared topic in the old group must never be reused in the new one.
ALTER TABLE conversation_provision_attempts ADD COLUMN support_group_id INTEGER;
UPDATE conversation_provision_attempts SET support_group_id = (
  SELECT c.support_group_id FROM conversations c
  WHERE c.bot_id = conversation_provision_attempts.bot_id
    AND c.user_id = conversation_provision_attempts.user_id
);

-- Retention for an old topic must not suppress a new mapping when Telegram
-- reuses its thread number in another group.
DROP TRIGGER storage_mapping_retired;
CREATE TRIGGER storage_mapping_retired BEFORE INSERT ON message_mappings
WHEN EXISTS(SELECT 1 FROM storage_topics t
  WHERE t.bot_id=NEW.bot_id AND t.thread_id=NEW.thread_id
    AND t.support_group_id=COALESCE(NEW.support_group_id,
      (SELECT c.support_group_id FROM conversations c
       WHERE c.bot_id=NEW.bot_id AND c.user_id=NEW.user_id AND c.thread_id=NEW.thread_id))
    AND t.purge_before IS NOT NULL AND (
      EXISTS(SELECT 1 FROM message_delivery_attempts a
        WHERE a.bot_id=NEW.bot_id AND a.thread_id=NEW.thread_id
          AND ((a.direction='user_to_support' AND a.target_chat_id=t.support_group_id AND a.source_message_id=NEW.user_message_id)
            OR (a.direction='support_to_user' AND a.source_chat_id=t.support_group_id AND a.source_message_id=NEW.support_message_id))
          AND a.started_at<=t.purge_before)
      OR EXISTS(SELECT 1 FROM pending_messages p
        WHERE p.bot_id=NEW.bot_id AND p.target_thread_id=NEW.thread_id
          AND p.source_message_id=NEW.user_message_id AND p.created_at<=t.purge_before
          AND EXISTS(SELECT 1 FROM conversations c WHERE c.bot_id=p.bot_id AND c.user_id=p.user_id
            AND c.support_group_id=t.support_group_id))))
BEGIN SELECT RAISE(IGNORE); END;
