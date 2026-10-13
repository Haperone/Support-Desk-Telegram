-- One durable onboarding reminder per bot; preserved when chat history is cleared.
CREATE TABLE bot_setup_notices (
  bot_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('pending', 'started', 'sent', 'skipped')),
  claim_token TEXT,
  started_at TEXT,
  message_id INTEGER,
  completed_at TEXT
);
