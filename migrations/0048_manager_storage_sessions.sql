CREATE TABLE manager_storage_sessions (
  owner_id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES support_groups(group_id),
  screen_message_id INTEGER,
  updated_at TEXT NOT NULL
);

CREATE INDEX storage_topics_auto_groups ON storage_topics(state,generation,protected,missing_at,support_group_id);
CREATE INDEX storage_topics_group ON storage_topics(support_group_id,generation,id);
