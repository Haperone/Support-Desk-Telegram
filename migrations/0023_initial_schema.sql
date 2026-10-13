-- Current support schema for NEW databases. Apply using Wrangler migrations.
-- Existing databases: follow DATABASE_SETUP.md; do not replay this CREATE script.
-- Earlier migration filenames are preserved in database/legacy-migrations.json.

CREATE TABLE bots (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  topic_prefix TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  support_group_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL CHECK(thread_id <> 1),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
  created_at TEXT NOT NULL,
  last_message_at TEXT, panel_message_id INTEGER, topic_state_update_id INTEGER,
  UNIQUE(bot_id, user_id),
  UNIQUE(support_group_id, thread_id)
);

CREATE TABLE banned_users (
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  reason TEXT,
  banned_at TEXT NOT NULL, banned_by INTEGER, banned_by_name TEXT, notified_at TEXT,
  PRIMARY KEY(bot_id, user_id)
);

CREATE TABLE processed_updates (
  bot_id TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('processing', 'completed')),
  owner_token TEXT NOT NULL,
  lease_expires_at TEXT,
  processed_at TEXT NOT NULL,
  completed_at TEXT, dispatch_succeeded_at TEXT,
  PRIMARY KEY(bot_id, update_id)
);

CREATE TABLE message_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  user_message_id INTEGER,
  support_message_id INTEGER,
  created_at TEXT NOT NULL
, user_reaction_update_id INTEGER, support_reaction_update_id INTEGER, user_reaction_date INTEGER, support_reaction_date INTEGER);

CREATE TABLE conversation_locks (
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(bot_id, user_id)
);

CREATE TABLE media_groups (
  bot_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('user_to_support', 'support_to_user')),
  media_group_id TEXT NOT NULL,
  source_chat_id INTEGER NOT NULL,
  target_chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_received_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  claimed_at INTEGER,
  claimed_version INTEGER,
  created_at TEXT NOT NULL, delivery_started_at TEXT, delivery_completed_at TEXT, delivery_uncertain_at TEXT, delivery_alerted_at TEXT, request_started_at TEXT, operator_id INTEGER, operator_identity_unknown_at TEXT, operator_identity_alerted_at TEXT,
  PRIMARY KEY(bot_id, direction, media_group_id, source_chat_id)
);

CREATE TABLE media_group_items (
  bot_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('user_to_support', 'support_to_user')),
  media_group_id TEXT NOT NULL,
  source_chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('photo', 'video', 'audio', 'document')),
  file_id TEXT NOT NULL,
  caption TEXT,
  received_at INTEGER NOT NULL, delivered_at TEXT, caption_entities_json TEXT, has_spoiler INTEGER NOT NULL DEFAULT 0 CHECK(has_spoiler IN (0, 1)), target_message_id INTEGER, mapping_synced_at TEXT, delivery_attempt_started_at TEXT, delivery_uncertain_at TEXT,
  PRIMARY KEY(bot_id, direction, media_group_id, source_chat_id, message_id)
);

CREATE TABLE user_abuse_state (
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  risk_score INTEGER NOT NULL DEFAULT 0 CHECK(risk_score >= 0),
  last_risk_at TEXT,
  last_warning_at TEXT,
  trusted_until TEXT,
  manual_trust INTEGER NOT NULL DEFAULT 0 CHECK(manual_trust IN (0, 1)),
  muted_until TEXT,
  mute_level INTEGER NOT NULL DEFAULT 0 CHECK(mute_level >= 0),
  verification_required INTEGER NOT NULL DEFAULT 0 CHECK(verification_required IN (0, 1)),
  pending_release_required INTEGER NOT NULL DEFAULT 0 CHECK(pending_release_required IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, manual_restricted_until TEXT, manual_restriction_reason TEXT, manual_restriction_notice_at TEXT,
  PRIMARY KEY (bot_id, user_id)
);

CREATE TABLE verification_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending', 'passed', 'failed', 'expired')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  failed_at TEXT,
  notice_sent_at TEXT,
  flushed_at TEXT
);

CREATE TABLE verification_attempts (
  challenge_id INTEGER NOT NULL,
  response_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing', 'failed', 'passed', 'denied')),
  owner_token TEXT,
  lease_expires_at TEXT,
  effects_applied INTEGER NOT NULL DEFAULT 0 CHECK(effects_applied IN (0, 1)),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(challenge_id, response_hash),
  FOREIGN KEY(challenge_id) REFERENCES verification_challenges(id) ON DELETE CASCADE,
  CHECK(status <> 'processing' OR (owner_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK(status = 'processing' OR (owner_token IS NULL AND lease_expires_at IS NULL))
);

CREATE TABLE abuse_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  value_hash TEXT,
  risk_delta INTEGER NOT NULL DEFAULT 0,
  risk_applied INTEGER NOT NULL DEFAULT 1 CHECK(risk_applied IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(bot_id, event_key, event_type)
);

CREATE TABLE logical_message_guards (
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  logical_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('claimed', 'limited', 'decided')),
  owner_token TEXT,
  lease_expires_at TEXT,
  burst_allowed INTEGER CHECK(burst_allowed IN (0, 1)),
  minute_allowed INTEGER CHECK(minute_allowed IN (0, 1)),
  risk_delta INTEGER,
  created_at TEXT NOT NULL,
  CHECK(state = 'claimed' OR (burst_allowed IS NOT NULL AND minute_allowed IS NOT NULL)),
  CHECK(state <> 'decided' OR risk_delta IS NOT NULL),
  PRIMARY KEY(bot_id, user_id, logical_key)
);

CREATE TABLE pending_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  challenge_id INTEGER,
  update_id INTEGER NOT NULL,
  source_chat_id INTEGER NOT NULL,
  source_message_id INTEGER NOT NULL,
  media_group_id TEXT,
  source_username TEXT,
  source_first_name TEXT,
  source_last_name TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  failed_at TEXT,
  failure_code TEXT, media_type TEXT, file_id TEXT, caption TEXT, delivery_started_at TEXT, delivery_completed_at TEXT, caption_entities_json TEXT, has_spoiler INTEGER NOT NULL DEFAULT 0 CHECK(has_spoiler IN (0, 1)), target_message_id INTEGER, target_thread_id INTEGER, mapping_synced_at TEXT, request_started_at TEXT, failure_alerted_at TEXT,
  UNIQUE(bot_id, update_id),
  FOREIGN KEY(challenge_id) REFERENCES verification_challenges(id) ON DELETE CASCADE
);

CREATE TABLE service_attack_state (
  bot_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'normal' CHECK(mode IN ('normal', 'attack')),
  manual_override TEXT CHECK(manual_override IN ('on', 'off')),
  anomaly_seen_at TEXT,
  entered_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE pending_flush_locks (
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(bot_id, user_id)
);

CREATE TABLE abuse_decision_locks (
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(bot_id, user_id)
);

CREATE TABLE operator_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  user_id INTEGER,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('operator', 'system')),
  operator_id INTEGER,
  operator_name TEXT,
  action TEXT NOT NULL,
  duration_seconds INTEGER,
  reason TEXT,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL, reopen_effect_id INTEGER,
  CHECK(actor_type <> 'operator' OR operator_id IS NOT NULL)
);

CREATE TABLE operator_pending_actions (
  operator_id INTEGER PRIMARY KEY,
  operator_name TEXT NOT NULL,
  management_bot_id TEXT NOT NULL,
  target_bot_id TEXT,
  user_id INTEGER,
  action TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('service', 'reason', 'duration', 'confirm', 'executing')),
  duration_seconds INTEGER,
  reason TEXT,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
, flow_nonce TEXT, expected_state_key TEXT);

CREATE TABLE reaction_settings (
  bot_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  capability_verified INTEGER NOT NULL DEFAULT 0 CHECK(capability_verified IN (0, 1)),
  unavailable_reason TEXT,
  updated_at TEXT NOT NULL,
  verified_at TEXT
);

CREATE TABLE reaction_sync_locks (
  mapping_id INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('user_to_support', 'support_to_user')),
  owner_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(mapping_id, direction)
);

CREATE TABLE reaction_settings_lock (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  owner_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE operator_completed_flows (flow_nonce TEXT PRIMARY KEY, operator_id INTEGER NOT NULL, action TEXT NOT NULL, completed_at TEXT NOT NULL);

CREATE TABLE conversation_provision_attempts (
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  thread_id INTEGER,
  failure_code TEXT,
  failure_detail TEXT,
  alerted_at TEXT, request_started_at TEXT,
  PRIMARY KEY (bot_id, user_id)
);

CREATE TABLE message_delivery_attempts (
  bot_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('user_to_support', 'support_to_user')),
  source_chat_id INTEGER NOT NULL,
  source_message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  target_chat_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  target_message_id INTEGER,
  failure_code TEXT,
  failure_detail TEXT,
  alerted_at TEXT,
  mapping_synced_at TEXT, request_started_at TEXT,
  PRIMARY KEY (bot_id, direction, source_chat_id, source_message_id)
);

CREATE TABLE general_message_claims (
  support_group_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  handler_bot_id TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL, dispatch_succeeded_at TEXT,
  PRIMARY KEY (support_group_id, message_id)
);

CREATE TABLE conversation_reopen_effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  old_thread_id INTEGER NOT NULL,
  new_thread_id INTEGER,
  recreated INTEGER NOT NULL DEFAULT 0 CHECK(recreated IN (0, 1)),
  opened_at TEXT,
  marker_request_started_at TEXT,
  marker_delivered_at TEXT,
  marker_message_id INTEGER,
  marker_outcome_uncertain_at TEXT,
  marker_failure TEXT,
  marker_alerted_at TEXT,
  panel_refreshed_at TEXT,
  business_delivered_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
, recovery_owner_token TEXT, recovery_lease_expires_at TEXT, marker_prepared_at TEXT, last_business_queued_at TEXT, cancelled_at TEXT, cancellation_reason TEXT);

CREATE TABLE support_operators (
  user_id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT,
  username TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  added_by INTEGER NOT NULL,
  added_by_name TEXT NOT NULL,
  added_at TEXT NOT NULL,
  removed_by INTEGER,
  removed_by_name TEXT,
  removed_at TEXT
);

CREATE TABLE support_primary_operator_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  user_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE support_operator_flows (
  owner_id INTEGER PRIMARY KEY,
  owner_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('add', 'remove')),
  stage TEXT NOT NULL CHECK(stage IN ('candidate', 'confirm', 'executing')),
  candidate_id INTEGER,
  candidate_first_name TEXT,
  candidate_last_name TEXT,
  candidate_username TEXT,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER,
  flow_nonce TEXT NOT NULL UNIQUE,
  list_page INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE support_operator_completed_flows (
  flow_nonce TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE TABLE support_operator_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL,
  actor_name TEXT NOT NULL,
  target_operator_id INTEGER NOT NULL,
  target_name TEXT NOT NULL,
  target_username TEXT,
  action TEXT NOT NULL CHECK(action IN ('operator_added', 'operator_removed')),
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE support_operator_execution_locks (
  operator_id INTEGER PRIMARY KEY,
  owner_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE reopen_business_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  update_id INTEGER NOT NULL,
  source_chat_id INTEGER NOT NULL,
  source_message_id INTEGER NOT NULL,
  reply_to_source_message_id INTEGER,
  source_username TEXT,
  source_first_name TEXT,
  source_last_name TEXT,
  media_group_id TEXT,
  media_type TEXT,
  file_id TEXT,
  caption TEXT,
  caption_entities_json TEXT,
  has_spoiler INTEGER NOT NULL DEFAULT 0 CHECK(has_spoiler IN (0, 1)),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  target_message_id INTEGER,
  failure_code TEXT,
  failure_detail TEXT,
  failure_alerted_at TEXT,
  UNIQUE(bot_id, update_id)
);

CREATE TABLE recovery_scheduler (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_job INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE general_callback_recoveries (
  incoming_bot_id TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  delivery_started_at TEXT,
  delivery_uncertain_at TEXT,
  completed_at TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (incoming_bot_id, update_id)
);

CREATE TABLE topic_style_settings (
  bot_id TEXT PRIMARY KEY,
  icon_color INTEGER CHECK (icon_color IN (7322096, 16766590, 13338331, 9367192, 16749490, 16478047)),
  icon_custom_emoji_id TEXT,
  icon_emoji TEXT,
  updated_at TEXT NOT NULL,
  updated_by INTEGER NOT NULL
);

CREATE TABLE cloudflare_plan_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  plan TEXT CHECK (plan IN ('free', 'paid')),
  billing_day INTEGER CHECK (billing_day BETWEEN 1 AND 31),
  revision TEXT NOT NULL,
  updated_at TEXT,
  updated_by INTEGER
);

CREATE TABLE telegram_cooldowns (
  bot_key TEXT PRIMARY KEY,
  not_before TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 1,
  last_method TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE operational_signals (
  bot_id TEXT NOT NULL, bucket TEXT NOT NULL, kind TEXT NOT NULL,
  PRIMARY KEY(bot_id, bucket, kind)
);

CREATE TABLE operational_signal_budget (
  id INTEGER PRIMARY KEY CHECK(id = 1), day_utc TEXT NOT NULL DEFAULT '', used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE storage_control (
  id INTEGER PRIMARY KEY CHECK(id = 1), generation INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'normal' CHECK(mode IN ('normal', 'reset')),
  reset_id TEXT, reset_actor INTEGER, reset_group INTEGER, reset_started TEXT,
  reset_cursor INTEGER NOT NULL DEFAULT 0, deleted_rows INTEGER NOT NULL DEFAULT 0,
  stopped INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  retention_days INTEGER NOT NULL DEFAULT 180 CHECK(retention_days BETWEEN 1 AND 3650),
  quarantine_days INTEGER NOT NULL DEFAULT 7 CHECK(quarantine_days BETWEEN 1 AND 90),
  daily_limit INTEGER NOT NULL DEFAULT 500 CHECK(daily_limit BETWEEN 1 AND 100000),
  cleanup_day TEXT NOT NULL DEFAULT '', cleanup_used INTEGER NOT NULL DEFAULT 0,
  last_summary TEXT, backfill_cursor INTEGER NOT NULL DEFAULT 0,
  confirmation_actor INTEGER, confirmation_group INTEGER, confirmation_expires TEXT,
  confirmation_nonce TEXT NOT NULL DEFAULT '00000000000000000000000000000000',
  confirmation_stage TEXT,
  policy_revision INTEGER NOT NULL DEFAULT 0,
  emergency_reserve BLOB,
  reset_cancel_requested INTEGER NOT NULL DEFAULT 0,
  reset_owner TEXT, reset_lease TEXT
);

CREATE TABLE storage_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, support_group_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'unknown' CHECK(state IN ('present', 'closed', 'unknown', 'missing_confirmed')),
  last_activity TEXT, activity_known INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0, missing_at TEXT,
  protected INTEGER NOT NULL DEFAULT 0, remind_after TEXT,
  purge_before TEXT, generation INTEGER NOT NULL DEFAULT 0,
  UNIQUE(bot_id, support_group_id, thread_id)
);

CREATE TABLE storage_jobs (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('old', 'deleted', 'auto', 'technical')),
  actor_id INTEGER NOT NULL, support_group_id INTEGER NOT NULL, generation INTEGER NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preview', cutoff TEXT NOT NULL,
  selected_bot TEXT, scan_cursor INTEGER NOT NULL DEFAULT 0,
  scan_complete INTEGER NOT NULL DEFAULT 0, deleted_rows INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, owner_token TEXT, lease_until TEXT,
  policy_revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE storage_job_topics (
  job_id TEXT NOT NULL, topic_id INTEGER NOT NULL, revision INTEGER NOT NULL, cutoff TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', deleted_rows INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(job_id, topic_id)
);

CREATE TABLE storage_audit (
  id TEXT PRIMARY KEY, actor_id INTEGER NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL,
  completed_at TEXT, deleted_rows INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE storage_confirmations (
  actor_id INTEGER PRIMARY KEY, nonce TEXT NOT NULL, generation INTEGER NOT NULL,
  support_group_id INTEGER NOT NULL, expires_at TEXT NOT NULL
);

CREATE TABLE telegram_cleanup_jobs (
  bot_id TEXT NOT NULL, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
  created_at TEXT NOT NULL, completed_at TEXT, last_error TEXT,
  PRIMARY KEY(bot_id, chat_id, message_id)
);

CREATE INDEX conversations_last_message_at_idx ON conversations(last_message_at);

CREATE INDEX conversations_reverse_idx ON conversations(support_group_id, thread_id);

CREATE INDEX message_mappings_conversation_idx ON message_mappings(bot_id, user_id, thread_id);

CREATE UNIQUE INDEX message_mappings_user_message_idx
  ON message_mappings(bot_id, user_id, user_message_id)
  WHERE user_message_id IS NOT NULL;

CREATE UNIQUE INDEX message_mappings_support_message_idx
  ON message_mappings(bot_id, thread_id, support_message_id)
  WHERE support_message_id IS NOT NULL;

CREATE INDEX processed_updates_time_idx ON processed_updates(processed_at);

CREATE INDEX media_group_items_time_idx ON media_group_items(received_at);

CREATE UNIQUE INDEX verification_challenges_one_active_idx
  ON verification_challenges(bot_id, user_id) WHERE status = 'pending';

CREATE INDEX verification_challenges_lookup_idx
  ON verification_challenges(token_hash, status, expires_at);

CREATE INDEX abuse_events_service_time_idx ON abuse_events(bot_id, created_at);

CREATE INDEX abuse_events_user_value_idx ON abuse_events(bot_id, user_id, event_type, value_hash, created_at);

CREATE INDEX pending_messages_flush_idx ON pending_messages(bot_id, user_id, challenge_id, delivered_at, failed_at, id);

CREATE INDEX operator_audit_time_idx
  ON operator_audit(created_at DESC);

CREATE INDEX operator_audit_bot_user_idx
  ON operator_audit(bot_id, user_id, created_at DESC);

CREATE INDEX operator_audit_operator_idx
  ON operator_audit(operator_id, created_at DESC);

CREATE INDEX operator_pending_actions_expiry_idx
  ON operator_pending_actions(expires_at);

CREATE INDEX user_abuse_state_management_idx
  ON user_abuse_state(bot_id, manual_restricted_until, muted_until, verification_required, risk_score);

CREATE INDEX message_mappings_support_reaction_lookup_idx
  ON message_mappings(support_message_id)
  WHERE support_message_id IS NOT NULL;

CREATE INDEX reaction_sync_locks_expiry_idx ON reaction_sync_locks(lease_expires_at);

CREATE INDEX operator_pending_actions_nonce_idx
  ON operator_pending_actions(operator_id, flow_nonce, expires_at);

CREATE INDEX operator_completed_flows_operator_idx ON operator_completed_flows(operator_id, completed_at);

CREATE INDEX media_groups_delivery_idx
  ON media_groups(bot_id, delivery_started_at, delivery_completed_at, last_received_at);

CREATE INDEX pending_messages_delivery_idx
  ON pending_messages(bot_id, user_id, delivery_started_at, delivery_completed_at, delivered_at, failed_at, id);

CREATE INDEX message_delivery_repair_idx ON message_delivery_attempts(bot_id, completed_at, mapping_synced_at);

CREATE INDEX message_delivery_unknown_idx ON message_delivery_attempts(bot_id, failure_code, alerted_at, started_at);

CREATE INDEX media_groups_uncertain_idx ON media_groups(bot_id, delivery_completed_at, delivery_uncertain_at, delivery_alerted_at, last_received_at);

CREATE INDEX media_group_items_delivery_state_idx
  ON media_group_items(bot_id, direction, media_group_id, source_chat_id, delivered_at, delivery_uncertain_at, delivery_attempt_started_at);

CREATE INDEX pending_messages_uncertain_alert_idx
  ON pending_messages(bot_id, failure_code, failure_alerted_at, failed_at);

CREATE INDEX general_message_claims_cleanup_idx
  ON general_message_claims(completed_at, lease_expires_at, created_at);

CREATE UNIQUE INDEX conversation_reopen_effects_active_idx
  ON conversation_reopen_effects(bot_id, user_id)
  WHERE completed_at IS NULL;

CREATE INDEX conversation_reopen_effects_recovery_idx
  ON conversation_reopen_effects(bot_id, completed_at, created_at);

CREATE INDEX support_operators_active_idx
  ON support_operators(active, added_at, user_id);

CREATE INDEX support_operator_audit_time_idx
  ON support_operator_audit(created_at DESC);

CREATE INDEX support_operator_execution_locks_expiry_idx
  ON support_operator_execution_locks(lease_expires_at);

CREATE UNIQUE INDEX operator_audit_reopen_effect_action_idx
  ON operator_audit(reopen_effect_id, action)
  WHERE reopen_effect_id IS NOT NULL;

CREATE INDEX reopen_business_messages_recovery_idx
  ON reopen_business_messages(bot_id, user_id, delivered_at, source_message_id);

CREATE INDEX idx_general_callback_recoveries_expiry
  ON general_callback_recoveries (lease_expires_at);

CREATE INDEX idx_telegram_cooldowns_expiry ON telegram_cooldowns(not_before);

CREATE INDEX operational_signals_window ON operational_signals(bucket, bot_id);

CREATE INDEX health_delivery_pending ON message_delivery_attempts(bot_id, completed_at, started_at);

CREATE INDEX health_pending_ready ON pending_messages(bot_id, delivered_at, failed_at, created_at);

CREATE INDEX health_reopen_pending ON reopen_business_messages(bot_id, delivered_at, created_at);

CREATE INDEX storage_topics_candidates ON storage_topics(protected, last_activity, id);

CREATE INDEX storage_topics_user ON storage_topics(bot_id, user_id, thread_id);

CREATE INDEX storage_mappings_cutoff ON message_mappings(bot_id, thread_id, created_at, id);

CREATE INDEX storage_jobs_pending ON storage_jobs(status, created_at);

CREATE INDEX telegram_cleanup_pending ON telegram_cleanup_jobs(bot_id, completed_at, created_at);

CREATE TRIGGER operational_signal_cap BEFORE INSERT ON operational_signals
WHEN EXISTS(SELECT 1 FROM operational_signal_budget WHERE id = 1 AND day_utc = substr(NEW.bucket, 1, 10) AND used >= 1000)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER operational_signal_count AFTER INSERT ON operational_signals
BEGIN
  UPDATE operational_signal_budget SET used = CASE WHEN day_utc = substr(NEW.bucket, 1, 10) THEN used + 1 ELSE 1 END,
    day_utc = substr(NEW.bucket, 1, 10) WHERE id = 1;
END;

CREATE TRIGGER storage_conversation_created AFTER INSERT ON conversations BEGIN
  INSERT INTO storage_topics(bot_id, support_group_id, thread_id, user_id, state, last_activity, activity_known, generation)
    VALUES(NEW.bot_id, NEW.support_group_id, NEW.thread_id, NEW.user_id,
      CASE NEW.status WHEN 'closed' THEN 'closed' ELSE 'present' END,
      COALESCE(NEW.last_message_at, NEW.created_at), 1, (SELECT generation FROM storage_control WHERE id = 1))
    ON CONFLICT(bot_id, support_group_id, thread_id) DO UPDATE SET
      state = excluded.state, last_activity = MAX(COALESCE(last_activity, ''), excluded.last_activity),
      activity_known = 1, revision = revision + 1, missing_at = NULL, generation = excluded.generation;
END;

CREATE TRIGGER storage_conversation_changed AFTER UPDATE OF last_message_at, status ON conversations BEGIN
  INSERT INTO storage_topics(bot_id, support_group_id, thread_id, user_id, state, last_activity, activity_known, revision, generation)
    VALUES(NEW.bot_id, NEW.support_group_id, NEW.thread_id, NEW.user_id,
      CASE NEW.status WHEN 'closed' THEN 'closed' ELSE 'present' END,
      COALESCE(NEW.last_message_at, NEW.created_at), 1, 1, (SELECT generation FROM storage_control WHERE id = 1))
    ON CONFLICT(bot_id, support_group_id, thread_id) DO UPDATE SET state = excluded.state,
      last_activity = MAX(COALESCE(last_activity, ''), excluded.last_activity), activity_known = 1,
      revision = revision + 1, missing_at = NULL, generation = excluded.generation;
END;

CREATE TRIGGER storage_conversation_removed BEFORE DELETE ON conversations BEGIN
  INSERT OR IGNORE INTO storage_topics(bot_id, support_group_id, thread_id, user_id, last_activity, generation)
    VALUES(OLD.bot_id, OLD.support_group_id, OLD.thread_id, OLD.user_id, COALESCE(OLD.last_message_at, OLD.created_at),
      (SELECT generation FROM storage_control WHERE id = 1));
  UPDATE storage_topics SET state = CASE WHEN state = 'missing_confirmed' THEN state ELSE 'unknown' END,
    revision = revision + 1 WHERE bot_id = OLD.bot_id AND support_group_id = OLD.support_group_id AND thread_id = OLD.thread_id;
END;

CREATE TRIGGER storage_mapping_retired BEFORE INSERT ON message_mappings
WHEN EXISTS(SELECT 1 FROM storage_topics t WHERE t.bot_id = NEW.bot_id AND t.thread_id = NEW.thread_id
  AND t.purge_before IS NOT NULL AND (
    EXISTS(SELECT 1 FROM message_delivery_attempts a WHERE a.bot_id = NEW.bot_id AND a.thread_id = NEW.thread_id
      AND a.started_at <= t.purge_before AND ((a.direction = 'user_to_support' AND a.source_message_id = NEW.user_message_id)
        OR (a.direction = 'support_to_user' AND a.source_message_id = NEW.support_message_id)))
    OR EXISTS(SELECT 1 FROM pending_messages p WHERE p.bot_id = NEW.bot_id AND p.target_thread_id = NEW.thread_id
      AND p.source_message_id = NEW.user_message_id AND p.created_at <= t.purge_before)))
BEGIN SELECT RAISE(IGNORE); END;

-- Initial singleton settings (including preallocated emergency storage).
INSERT INTO "cloudflare_plan_settings" ("id", "plan", "billing_day", "revision", "updated_at", "updated_by") VALUES (1, NULL, NULL, 'initial', NULL, NULL);
INSERT INTO "operational_signal_budget" ("id", "day_utc", "used") VALUES (1, '', 0);
INSERT INTO "storage_control" ("id", "generation", "mode", "reset_id", "reset_actor", "reset_group", "reset_started", "reset_cursor", "deleted_rows", "stopped", "last_error", "retention_days", "quarantine_days", "daily_limit", "cleanup_day", "cleanup_used", "last_summary", "backfill_cursor", "confirmation_actor", "confirmation_group", "confirmation_expires", "confirmation_nonce", "confirmation_stage", "policy_revision", "emergency_reserve", "reset_cancel_requested", "reset_owner", "reset_lease") VALUES (1, 0, 'normal', NULL, NULL, NULL, NULL, 0, 0, 0, NULL, 180, 7, 500, '', 0, NULL, 0, NULL, NULL, NULL, '00000000000000000000000000000000', NULL, 0, zeroblob(16384), 0, NULL, NULL);
