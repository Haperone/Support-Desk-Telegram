-- NULL inherits the pre-upgrade setting. Existing verified installations retain
-- their behaviour; new installations remain off and unverified.
ALTER TABLE reaction_settings ADD COLUMN support_to_user_verified INTEGER CHECK(support_to_user_verified IN (0, 1));
ALTER TABLE reaction_settings ADD COLUMN user_to_support_verified INTEGER CHECK(user_to_support_verified IN (0, 1));
ALTER TABLE reaction_settings ADD COLUMN support_to_user_enabled INTEGER CHECK(support_to_user_enabled IN (0, 1));
ALTER TABLE reaction_settings ADD COLUMN user_to_support_enabled INTEGER CHECK(user_to_support_enabled IN (0, 1));

-- One bounded, replaceable check per bot; contains no customer messages.
CREATE TABLE reaction_checks (
  bot_id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  receiver_bot_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('waiting', 'preparing', 'ready', 'failed', 'closed')),
  private_message_id INTEGER,
  group_message_id INTEGER,
  support_step INTEGER NOT NULL DEFAULT 0 CHECK(support_step BETWEEN 0 AND 3),
  user_step INTEGER NOT NULL DEFAULT 0 CHECK(user_step BETWEEN 0 AND 3),
  support_date INTEGER,
  support_update INTEGER,
  user_date INTEGER,
  user_update INTEGER,
  support_error TEXT,
  user_error TEXT,
  lease_token TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
