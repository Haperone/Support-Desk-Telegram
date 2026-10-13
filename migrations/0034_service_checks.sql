CREATE TABLE service_checks(
 nonce TEXT PRIMARY KEY, bot_id TEXT NOT NULL, owner_id INTEGER NOT NULL,
 stage TEXT NOT NULL, thread_id INTEGER, inbound_at TEXT, outbound_at TEXT, expires_at TEXT NOT NULL
);
