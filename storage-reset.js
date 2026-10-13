import { authorizeStorage, readStorageControl, storageOwner, storageStatement } from "./storage-retention.js";

// The list is deliberately explicit: settings, bans, operators, user trust,
// processed-update deduplication and monitor data are outside this reset.
export const RESET_TABLES = [
  'statistics_facts','statistics_users','statistics_report_cache',
  'service_checks', 'operator_note_drafts', 'operator_ui_sessions', 'manager_work_navigation', 'conversation_work', 'operator_work_inputs', 'bot_message_drafts',
  'service_notification_outbox', 'manager_work_flows', 'manager_search_flows', 'manager_home_screens', 'service_topic_history',
  "user_access_events",
  "reaction_checks", "reaction_sync_locks", "media_group_items", "media_groups", "pending_messages",
  "reopen_business_messages", "conversation_reopen_effects", "message_delivery_attempts",
  "conversation_provision_attempts", "message_mappings", "conversations", "conversation_auto_replies",
  "verification_attempts", "verification_challenges", "logical_message_guards",
  "pending_flush_locks", "abuse_decision_locks", "conversation_locks",
  "operator_pending_actions", "bot_message_flows",
  "storage_job_topics", "storage_jobs", "storage_topics", "storage_confirmations",
];

export async function resetPreview(env) {
  const counts = await storageStatement(env.SUPPORT_DB, `SELECT
    (SELECT COUNT(*) FROM conversations) AS conversations,
    (SELECT COUNT(*) FROM message_mappings) AS mappings,
    (SELECT COUNT(*) FROM pending_messages WHERE delivered_at IS NULL) +
    (SELECT COUNT(*) FROM reopen_business_messages WHERE delivered_at IS NULL) +
    (SELECT COUNT(*) FROM media_group_items WHERE delivered_at IS NULL) AS queued`).first();
  const control = await readStorageControl(env.SUPPORT_DB);
  return { ...counts, control };
}

export async function previewFullReset(env, actorId, now = new Date()) {
  authorizeStorage(env, actorId, env.SUPPORT_GROUP_ID);
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const result = await storageStatement(env.SUPPORT_DB, `UPDATE storage_control SET confirmation_actor = ?, confirmation_group = ?,
    confirmation_expires = ?, confirmation_nonce = ?, confirmation_stage = 'preview', emergency_reserve = NULL WHERE id = 1 AND mode = 'normal'`,
    actorId, Number(env.SUPPORT_GROUP_ID), new Date(now.getTime() + 5 * 60_000).toISOString(), nonce).run();
  return result.meta?.changes === 1 ? nonce : null;
}

export async function armFullReset(env, actorId, nonce, now = new Date()) {
  authorizeStorage(env, actorId, env.SUPPORT_GROUP_ID);
  const result = await storageStatement(env.SUPPORT_DB, `UPDATE storage_control SET confirmation_stage = 'phrase'
    WHERE id = 1 AND mode = 'normal' AND confirmation_stage = 'preview' AND confirmation_nonce = ?
      AND confirmation_actor = ? AND confirmation_group = ? AND confirmation_expires > ?`,
    nonce, actorId, Number(env.SUPPORT_GROUP_ID), now.toISOString()).run();
  return result.meta?.changes === 1;
}

export async function beginFullReset(env, actorId, phrase, now = new Date()) {
  authorizeStorage(env, actorId, env.SUPPORT_GROUP_ID);
  if (phrase !== "УДАЛИТЬ ВСЕ ОБРАЩЕНИЯ") return false;
  const result = await storageStatement(env.SUPPORT_DB, `UPDATE storage_control SET mode = 'reset', generation = generation + 1,
    reset_id = confirmation_nonce, reset_actor = ?, reset_group = ?, reset_started = ?, reset_cursor = 0,
    deleted_rows = 0, stopped = 0, last_error = NULL, confirmation_actor = NULL, confirmation_expires = NULL,
    reset_owner = NULL, reset_lease = NULL, reset_cancel_requested = 0
    WHERE id = 1 AND mode = 'normal' AND confirmation_stage = 'phrase' AND confirmation_actor = ? AND confirmation_group = ? AND confirmation_expires > ? RETURNING id`,
    actorId, Number(env.SUPPORT_GROUP_ID), now.toISOString(), actorId, Number(env.SUPPORT_GROUP_ID), now.toISOString()).first();
  return Boolean(result);
}

export async function runFullReset(env, now = new Date()) {
  const db = env.SUPPORT_DB;
  db.recoveryCheckpoint?.(12);
  const owner = crypto.randomUUID();
  const state = await storageStatement(db, `UPDATE storage_control SET reset_owner = ?, reset_lease = ?
    WHERE id = 1 AND mode = 'reset' AND stopped = 0 AND (reset_owner IS NULL OR reset_lease <= ?) RETURNING *`,
    owner, new Date(now.getTime() + 120_000).toISOString(), now.toISOString()).first();
  if (!state) return;
  try {
    if (state.reset_actor !== storageOwner(env) || state.reset_group !== Number(env.SUPPORT_GROUP_ID)) {
      await storageStatement(db, "UPDATE storage_control SET stopped = 1, last_error = 'Главный администратор или группа изменились' WHERE id = 1 AND reset_owner = ?", owner).run(); return;
    }
    // Allow outstanding external requests to settle before removing their state.
    // Generation guards already prevent them from writing into the new database state.
    if (now.getTime() - Date.parse(state.reset_started) < 120_000) return;
    // Keep minimal deduplication for in-flight updates from the old generation.
    // Otherwise their webhook retry could rebuild an erased conversation.
    const retired = await storageStatement(db, `UPDATE processed_updates SET state = 'completed', completed_at = ?, processed_at = ?,
      dispatch_succeeded_at = COALESCE(dispatch_succeeded_at, ?), lease_expires_at = NULL
      WHERE rowid IN (SELECT rowid FROM processed_updates WHERE state = 'processing' LIMIT 100)
      AND EXISTS(SELECT 1 FROM storage_control WHERE id = 1 AND reset_owner = ? AND mode = 'reset' AND stopped = 0)`, now.toISOString(), now.toISOString(), now.toISOString(), owner).run();
    if (retired.meta?.changes > 0) return { retiredUpdates: retired.meta.changes };
    if (state.reset_cancel_requested) {
      await db.batch([
        storageStatement(db, `INSERT OR IGNORE INTO storage_audit(id, actor_id, action, created_at, completed_at, deleted_rows)
          SELECT reset_id, reset_actor, 'full_reset_cancelled', reset_started, ?, deleted_rows FROM storage_control WHERE id = 1 AND reset_owner = ?`, now.toISOString(), owner),
        storageStatement(db, "UPDATE storage_control SET mode = 'normal', stopped = 0, backfill_cursor = 0 WHERE id = 1 AND reset_owner = ? AND reset_cancel_requested = 1", owner),
      ]);
      return { cancelled: true };
    }
    const table = RESET_TABLES[state.reset_cursor];
    if (table) {
      const result = await db.batch([
        storageStatement(db, `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY rowid LIMIT 1000)
          AND EXISTS(SELECT 1 FROM storage_control WHERE id = 1 AND reset_owner = ? AND mode = 'reset' AND generation = ? AND stopped = 0 AND reset_cancel_requested = 0)`, owner, state.generation),
        storageStatement(db, "UPDATE storage_control SET deleted_rows = deleted_rows + changes() WHERE id = 1 AND reset_owner = ?", owner),
        storageStatement(db, `UPDATE storage_control SET reset_cursor = reset_cursor + 1 WHERE id = 1 AND reset_owner = ?
          AND NOT EXISTS(SELECT 1 FROM ${table})`, owner),
      ]);
      return { table, deleted: result[0].meta?.changes || 0 };
    }
    // Preserve trust/restrictions while removing stale verification pointers.
    const changed = await storageStatement(db, `UPDATE user_abuse_state SET verification_required = 0, pending_release_required = 0
      WHERE rowid IN (SELECT rowid FROM user_abuse_state WHERE verification_required <> 0 OR pending_release_required <> 0 LIMIT 100)
        AND EXISTS(SELECT 1 FROM storage_control WHERE id = 1 AND reset_owner = ? AND mode = 'reset')`, owner).run();
    if (changed.meta?.changes > 0) return;
    await db.batch([
      storageStatement(db, `INSERT OR IGNORE INTO storage_audit(id, actor_id, action, created_at, completed_at, deleted_rows)
        SELECT reset_id, reset_actor, 'full_reset', reset_started, ?, deleted_rows FROM storage_control WHERE id = 1 AND reset_owner = ?`, now.toISOString(), owner),
      storageStatement(db, `UPDATE storage_control SET mode = 'normal', last_error = NULL, backfill_cursor = 0, emergency_reserve = zeroblob(16384)
        WHERE id = 1 AND reset_owner = ? AND mode = 'reset' AND stopped = 0`, owner),
    ]);
    return { completed: true };
  } catch (error) {
    try { await storageStatement(db, "UPDATE storage_control SET last_error = ? WHERE id = 1 AND reset_owner = ?", String(error.message).slice(0, 200), owner).run(); } catch { /* Resume from the last committed table and batch. */ }
    throw error;
  } finally {
    await storageStatement(db, "UPDATE storage_control SET reset_owner = NULL, reset_lease = NULL WHERE id = 1 AND reset_owner = ?", owner).run();
  }
}
