-- Current monitor schema for NEW databases. Apply using Wrangler migrations.
-- Existing databases: follow DATABASE_SETUP.md; do not replay this CREATE script.
-- Earlier migration filenames are preserved in database/legacy-migrations.json.

CREATE TABLE usage_snapshots (
    checked_at TEXT PRIMARY KEY,
    day_utc TEXT NOT NULL,
    worker_requests INTEGER NOT NULL CHECK (worker_requests >= 0),
    kv_reads INTEGER NOT NULL CHECK (kv_reads >= 0),
    kv_writes INTEGER NOT NULL CHECK (kv_writes >= 0),
    kv_deletes INTEGER NOT NULL CHECK (kv_deletes >= 0),
    kv_lists INTEGER NOT NULL CHECK (kv_lists >= 0)
, d1_rows_read INTEGER CHECK (d1_rows_read IS NULL OR d1_rows_read >= 0), d1_rows_written INTEGER CHECK (d1_rows_written IS NULL OR d1_rows_written >= 0));

CREATE TABLE usage_breakdowns (
    checked_at TEXT NOT NULL,
    resource_kind TEXT NOT NULL CHECK (resource_kind IN ('worker', 'kv_namespace')),
    resource_name TEXT NOT NULL,
    operation TEXT NOT NULL,
    usage_value INTEGER NOT NULL CHECK (usage_value >= 0),
    PRIMARY KEY (checked_at, resource_kind, resource_name, operation),
    FOREIGN KEY (checked_at) REFERENCES usage_snapshots(checked_at) ON DELETE CASCADE
);

CREATE TABLE sent_alerts (
    day_utc TEXT NOT NULL,
    metric TEXT NOT NULL,
    alert_level TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    usage_value INTEGER NOT NULL,
    PRIMARY KEY (day_utc, metric, alert_level)
);

CREATE TABLE monitor_state (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE alert_claims (day_utc TEXT NOT NULL, metric TEXT NOT NULL, owner_token TEXT NOT NULL, lease_expires_at TEXT NOT NULL, PRIMARY KEY(day_utc, metric));

CREATE TABLE monitor_incidents (
  incident_key TEXT PRIMARY KEY,
  severity INTEGER NOT NULL DEFAULT 0,
  sent_severity INTEGER NOT NULL DEFAULT 0,
  quality TEXT NOT NULL DEFAULT 'unavailable',
  message TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_sample TEXT,
  normal_samples INTEGER NOT NULL DEFAULT 0,
  candidate_severity INTEGER,
  last_sent TEXT,
  recovered_at TEXT,
  owner_token TEXT,
  lease_until TEXT
);

CREATE TABLE monitor_api_cooldowns (
  scope TEXT PRIMARY KEY,
  not_before TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE telegram_cooldowns (
  bot_key TEXT PRIMARY KEY,
  not_before TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 1,
  last_method TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE monitor_scheduler (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  next_job INTEGER NOT NULL DEFAULT 0,
  owner_token TEXT,
  lease_until TEXT
);

CREATE TABLE storage_inventory (
  database_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  inventory_id TEXT NOT NULL,
  bytes INTEGER,
  measured_at TEXT,
  quality TEXT NOT NULL DEFAULT 'unavailable'
);

CREATE TABLE storage_samples (
  resource_id TEXT NOT NULL,
  measured_at TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes >= 0),
  quality TEXT NOT NULL,
  PRIMARY KEY(resource_id, measured_at)
);

CREATE TABLE storage_daily_samples (
  resource_id TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  measured_at TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes >= 0),
  PRIMARY KEY(resource_id, day_utc)
);

CREATE TABLE runtime_samples (
  script_name TEXT NOT NULL,
  window_end TEXT NOT NULL,
  payload TEXT NOT NULL,
  quality TEXT NOT NULL,
  PRIMARY KEY(script_name, window_end)
);

CREATE INDEX idx_usage_snapshots_day_checked
    ON usage_snapshots(day_utc, checked_at DESC);

CREATE INDEX alert_claims_expiry_idx ON alert_claims(lease_expires_at);

CREATE INDEX idx_monitor_incidents_pending ON monitor_incidents(last_sent, incident_key);

CREATE INDEX idx_storage_inventory_generation ON storage_inventory(inventory_id, database_id);

CREATE INDEX storage_samples_expiry ON storage_samples(measured_at);

CREATE INDEX storage_daily_expiry ON storage_daily_samples(day_utc);

CREATE INDEX runtime_samples_expiry ON runtime_samples(window_end);

-- Initial singleton settings (including preallocated emergency storage).
INSERT INTO "monitor_scheduler" ("id", "next_job", "owner_token", "lease_until") VALUES (1, 0, NULL, NULL);
