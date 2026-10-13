const DAY = 86_400_000;
export function storageStatement(db, sql, ...params) { return (db.prepareStorage || db.prepare).call(db, sql).bind(...params); }
export function storageOwner(env) {
  const values = String(env.ADMIN_IDS || "").split(",").map((value) => Number(value.trim())).filter((value) => Number.isSafeInteger(value) && value > 0);
  if (values.length !== 1) throw new Error("Exactly one primary administrator is required");
  return values[0];
}
export function authorizeStorage(env, actorId, groupId) {
  if (Number(actorId) !== storageOwner(env) || String(groupId) !== String(env.SUPPORT_GROUP_ID)) throw new Error("Storage action is available only to the primary administrator for the selected group");
}
export async function readStorageControl(db) { return storageStatement(db, "SELECT * FROM storage_control WHERE id = 1").first(); }

export function maintenanceStatement(db, sql) {
  const match = sql.trim().match(/^DELETE FROM (\w+) WHERE ([\s\S]+)$/);
  if (match) {
    const [, table, predicate] = match;
    // Child cleanup has its own batch limit. Keep the parent until every item
    // is gone, since uncertain/legacy item cleanup needs the parent's metadata.
    const childrenGone = table === 'media_groups' ? ` AND NOT EXISTS(SELECT 1 FROM media_group_items i
      WHERE i.bot_id = media_groups.bot_id AND i.direction = media_groups.direction
        AND i.media_group_id = media_groups.media_group_id AND i.source_chat_id = media_groups.source_chat_id)` : '';
    sql = `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE (${predicate})${childrenGone} LIMIT 100)`;
  }
  else if (sql.startsWith('UPDATE verification_challenges SET')) sql += ' AND id IN (SELECT id FROM verification_challenges WHERE status = \'pending\' ORDER BY expires_at LIMIT 100)';
  return db.prepare(sql);
}

export async function backfillStorageTopics(env) {
  const db = env.SUPPORT_DB;
  const control = await readStorageControl(db);
  await storageStatement(db, `UPDATE storage_topics SET generation = ?, revision = revision + 1
    WHERE id IN (SELECT id FROM storage_topics WHERE generation < ? ORDER BY id LIMIT 100)`, control.generation, control.generation).run();
  const rows = await storageStatement(db, "SELECT id, bot_id, user_id, thread_id, created_at FROM message_mappings WHERE id > ? ORDER BY id LIMIT 100", control.backfill_cursor).all();
  const mappings = rows.results || [];
  if (mappings.length) {
    await storageStatement(db, `INSERT INTO storage_topics(bot_id, support_group_id, thread_id, user_id, last_activity, generation)
      SELECT json_extract(m.value, '$.bot_id'), COALESCE(c.support_group_id, ?), json_extract(m.value, '$.thread_id'),
        json_extract(m.value, '$.user_id'), json_extract(m.value, '$.created_at'), ?
      FROM json_each(?) m LEFT JOIN conversations c ON c.bot_id = json_extract(m.value, '$.bot_id')
        AND c.thread_id = json_extract(m.value, '$.thread_id') WHERE true
      ON CONFLICT(bot_id, support_group_id, thread_id) DO UPDATE SET
        last_activity = MAX(COALESCE(last_activity, ''), COALESCE(excluded.last_activity, ''))`,
      Number(env.SUPPORT_GROUP_ID), control.generation, JSON.stringify(mappings)).run();
    await storageStatement(db, "UPDATE storage_control SET backfill_cursor = MAX(backfill_cursor, ?) WHERE id = 1", mappings.at(-1).id).run();
  }
  // Existing conversations with no mappings also need to appear in the review list.
  const conversations = await storageStatement(db, `INSERT OR IGNORE INTO storage_topics(bot_id, support_group_id, thread_id, user_id, last_activity, generation)
    SELECT c.bot_id, c.support_group_id, c.thread_id, c.user_id, COALESCE(c.last_message_at, c.created_at), ?
    FROM conversations c WHERE NOT EXISTS(SELECT 1 FROM storage_topics t WHERE t.bot_id = c.bot_id
      AND t.support_group_id = c.support_group_id AND t.thread_id = c.thread_id) ORDER BY c.id LIMIT 100`, control.generation).run();
  return mappings.length < 100 && Number(conversations.meta?.changes || 0) < 100;
}

export async function touchStorageTopic(env, botId, threadId, userId, now = new Date()) {
  if (env.RETENTION_ENABLED !== "true" || !Number.isSafeInteger(Number(threadId))) return;
  await env.SUPPORT_DB.prepare(`INSERT INTO storage_topics(bot_id, support_group_id, thread_id, user_id, state, last_activity, activity_known, revision, generation)
    SELECT ?, ?, ?, ?, 'present', ?, 1, 1, generation FROM storage_control WHERE id = 1 AND mode = 'normal' AND generation = ?
    ON CONFLICT(bot_id, support_group_id, thread_id) DO UPDATE SET state = 'present', missing_at = NULL,
      last_activity = MAX(COALESCE(last_activity, ''), excluded.last_activity), revision = revision + 1, activity_known = 1, generation = excluded.generation`)
    .bind(botId, Number(env.SUPPORT_GROUP_ID), Number(threadId), Number(userId), now.toISOString(), env.SUPPORT_DB.storageGeneration).run();
}

export async function createStorageJob(env, { mode, actorId, topicId = null, botId = null }, now = new Date()) {
  authorizeStorage(env, actorId, env.SUPPORT_GROUP_ID);
  if (!["old", "deleted", "auto", 'technical'].includes(mode)) throw new Error("Unknown cleanup mode");
  const db = env.SUPPORT_DB;
  const control = await readStorageControl(db);
  if (control.mode !== 'normal') throw new Error("Full reset is already in progress");
  const id = crypto.randomUUID().replaceAll("-", "");
  const cutoff = new Date(now.getTime() - (mode === 'deleted' ? 0 : mode === 'technical' ? 7 * DAY : control.retention_days * DAY)).toISOString();
  await storageStatement(db, `INSERT INTO storage_jobs(id, mode, actor_id, support_group_id, generation, created_at, expires_at, cutoff, selected_bot, policy_revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, mode, actorId, Number(env.SUPPORT_GROUP_ID), control.generation,
    now.toISOString(), new Date(now.getTime() + (mode === 'auto' ? DAY : 15 * 60_000)).toISOString(), cutoff, botId, control.policy_revision).run();
  if (mode === 'technical') {
    await storageStatement(db, 'UPDATE storage_jobs SET scan_complete = 1 WHERE id = ?', id).run();
  } else if (topicId != null) {
    await addJobTopics(env, id, now, Number(topicId));
    await storageStatement(db, "UPDATE storage_jobs SET scan_complete = 1 WHERE id = ?", id).run();
  } else await addJobTopics(env, id, now);
  return id;
}

export async function addJobTopics(env, id, now = new Date(), topicId = null) {
  const db = env.SUPPORT_DB;
  const job = await storageStatement(db, "SELECT * FROM storage_jobs WHERE id = ? AND status = 'preview' AND expires_at > ?", id, now.toISOString()).first();
  if (!job || job.scan_complete) return;
  const control = await readStorageControl(db);
  const quarantine = new Date(now.getTime() - control.quarantine_days * DAY).toISOString();
  const rows = await storageStatement(db, `SELECT * FROM storage_topics WHERE id > ? AND (? IS NULL OR id = ?)
    AND support_group_id = ? AND generation = ? AND protected = 0 AND (? IS NULL OR bot_id = ?)
    AND COALESCE(remind_after, '') <= ? AND (
      (? = 'deleted' AND state = 'missing_confirmed') OR (? = 'old' AND (last_activity IS NULL OR last_activity <= ?))
      OR (? = 'auto' AND state = 'missing_confirmed' AND missing_at <= ? AND activity_known = 1 AND last_activity <= ?))
    ORDER BY id LIMIT 100`, job.scan_cursor, topicId, topicId, job.support_group_id, job.generation, job.selected_bot, job.selected_bot,
    now.toISOString(), job.mode, job.mode, job.cutoff, job.mode, quarantine, job.cutoff).all();
  const topics = rows.results || [];
  await storageStatement(db, `INSERT OR IGNORE INTO storage_job_topics(job_id, topic_id, revision, cutoff)
    SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.revision'), ? FROM json_each(?)`, id, job.cutoff, JSON.stringify(topics)).run();
  await storageStatement(db, "UPDATE storage_jobs SET scan_cursor = ?, scan_complete = ? WHERE id = ? AND status = 'preview'",
    topics.at(-1)?.id || job.scan_cursor, topics.length < 100 ? 1 : 0, id).run();
}

export async function confirmStorageJob(env, id, actorId, now = new Date()) {
  authorizeStorage(env, actorId, env.SUPPORT_GROUP_ID);
  const result = await storageStatement(env.SUPPORT_DB, `UPDATE storage_jobs SET status = 'running', expires_at = ?
    WHERE id = ? AND actor_id = ? AND support_group_id = ? AND status = 'preview' AND scan_complete = 1 AND expires_at > ?
      AND generation = (SELECT generation FROM storage_control WHERE id = 1 AND mode = 'normal')
      AND policy_revision = (SELECT policy_revision FROM storage_control WHERE id = 1)`,
    new Date(now.getTime() + DAY).toISOString(), id, actorId, Number(env.SUPPORT_GROUP_ID), now.toISOString()).run();
  return Number(result.meta?.changes || 0) === 1;
}

const NO_ACTIVE_WORK = `NOT EXISTS(SELECT 1 FROM storage_topics other WHERE other.bot_id = t.bot_id AND other.thread_id = t.thread_id AND other.support_group_id <> t.support_group_id)
  AND NOT EXISTS(SELECT 1 FROM message_delivery_attempts a WHERE a.bot_id = t.bot_id AND a.thread_id = t.thread_id AND a.completed_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM pending_messages p WHERE p.bot_id = t.bot_id AND p.user_id = t.user_id AND p.delivered_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM media_groups g WHERE g.bot_id = t.bot_id AND g.thread_id = t.thread_id)
  AND NOT EXISTS(SELECT 1 FROM conversation_reopen_effects e WHERE e.bot_id = t.bot_id AND e.user_id = t.user_id AND e.completed_at IS NULL AND e.cancelled_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM reopen_business_messages b WHERE b.bot_id = t.bot_id AND b.user_id = t.user_id AND b.delivered_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM conversation_locks l WHERE l.bot_id = t.bot_id AND l.user_id = t.user_id AND l.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  AND NOT EXISTS(SELECT 1 FROM abuse_decision_locks l WHERE l.bot_id = t.bot_id AND l.user_id = t.user_id AND l.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  AND NOT EXISTS(SELECT 1 FROM reaction_sync_locks l JOIN message_mappings m ON m.id = l.mapping_id
    WHERE m.bot_id = t.bot_id AND m.thread_id = t.thread_id AND l.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

const TECHNICAL_TABLES = [
  ['processed_updates', "state = 'completed' AND completed_at < ?"],
  ['message_delivery_attempts', 'completed_at < ? AND mapping_synced_at IS NOT NULL'],
  ['conversation_provision_attempts', 'completed_at < ?'],
  ['pending_messages', 'delivered_at < ? AND mapping_synced_at IS NOT NULL'],
  ['telegram_cleanup_jobs', 'completed_at < ?'],
  ['operational_signals', 'bucket < ?'],
];

export async function runStorageJob(env, now = new Date()) {
  const db = env.SUPPORT_DB;
  db.recoveryCheckpoint?.(22);
  const control = await readStorageControl(db);
  if (control.mode !== 'normal') return;
  const owner = crypto.randomUUID();
  const job = await storageStatement(db, `UPDATE storage_jobs SET owner_token = ?, lease_until = ?
    WHERE id = (SELECT id FROM storage_jobs WHERE status = 'running' AND (owner_token IS NULL OR lease_until <= ?)
      ORDER BY created_at LIMIT 1) AND NOT EXISTS(SELECT 1 FROM storage_jobs WHERE owner_token IS NOT NULL AND lease_until > ?)
      RETURNING *`, owner, new Date(now.getTime() + 120_000).toISOString(), now.toISOString(), now.toISOString()).first();
  if (!job) return;
  try {
    const registeredGroup = job.support_group_id === Number(env.SUPPORT_GROUP_ID)
      || Boolean(await storageStatement(db, 'SELECT 1 AS registered FROM support_groups WHERE group_id=?', job.support_group_id).first());
    if (job.actor_id !== storageOwner(env) || !registeredGroup || job.generation !== control.generation || job.policy_revision !== control.policy_revision || job.expires_at <= now.toISOString()) {
      await storageStatement(db, "UPDATE storage_jobs SET status = 'cancelled', last_error = 'Разрешение устарело' WHERE id = ? AND owner_token = ?", job.id, owner).run(); return;
    }
    if (job.mode === 'technical') {
      const table = TECHNICAL_TABLES[job.scan_cursor];
      if (!table) {
        await storageStatement(db, "UPDATE storage_jobs SET status = 'completed' WHERE id = ? AND owner_token = ?", job.id, owner).run();
        await storageStatement(db, `INSERT OR IGNORE INTO storage_audit(id, actor_id, action, created_at, completed_at, deleted_rows)
          SELECT id, actor_id, mode, created_at, ?, deleted_rows FROM storage_jobs WHERE id = ? AND owner_token = ?`, now.toISOString(), job.id, owner).run();
        return;
      }
      const [name, predicate] = table;
      await db.batch([
        storageStatement(db, `DELETE FROM ${name} WHERE rowid IN (SELECT rowid FROM ${name} WHERE ${predicate} LIMIT 100)
          AND EXISTS(SELECT 1 FROM storage_jobs j JOIN storage_control s ON s.id = 1 WHERE j.id = ? AND j.owner_token = ?
            AND j.status = 'running' AND s.mode = 'normal' AND s.generation = j.generation AND s.policy_revision = j.policy_revision)`, job.cutoff, job.id, owner),
        storageStatement(db, 'UPDATE storage_jobs SET deleted_rows = deleted_rows + changes() WHERE id = ? AND owner_token = ?', job.id, owner),
        storageStatement(db, `UPDATE storage_jobs SET scan_cursor = scan_cursor + 1 WHERE id = ? AND owner_token = ?
          AND NOT EXISTS(SELECT 1 FROM ${name} WHERE ${predicate})`, job.id, owner, job.cutoff),
      ]);
      return;
    }
    const selected = await storageStatement(db, `SELECT jt.*, t.* , jt.revision AS confirmed_revision,
      CASE WHEN ${NO_ACTIVE_WORK} THEN 0 ELSE 1 END AS busy
      FROM storage_job_topics jt JOIN storage_topics t ON t.id = jt.topic_id
      WHERE jt.job_id = ? AND jt.status = 'pending' ORDER BY jt.topic_id LIMIT 1`, job.id).first();
    if (!selected) {
      await storageStatement(db, `UPDATE storage_jobs SET status = CASE WHEN EXISTS(SELECT 1 FROM storage_job_topics
        WHERE job_id = ? AND status = 'needs_attention') THEN 'needs_attention' ELSE 'completed' END WHERE id = ? AND owner_token = ?`, job.id, job.id, owner).run();
      await storageStatement(db, `INSERT OR IGNORE INTO storage_audit(id, actor_id, action, created_at, completed_at, deleted_rows)
        SELECT id, actor_id, mode, created_at, ?, deleted_rows FROM storage_jobs WHERE id = ? AND owner_token = ?`, now.toISOString(), job.id, owner).run();
      return;
    }
    const eligible = selected.revision === selected.confirmed_revision && !selected.protected && selected.generation === job.generation
      && (job.mode === 'old' || selected.state === 'missing_confirmed');
    if (!eligible || selected.busy) {
      await storageStatement(db, "UPDATE storage_job_topics SET status = ? WHERE job_id = ? AND topic_id = ?", selected.busy ? 'needs_attention' : 'cancelled', job.id, selected.topic_id).run(); return;
    }
    const currentControl = await readStorageControl(db);
    const allowance = job.mode === 'auto' && db.plan !== 'paid'
      ? Math.max(0, currentControl.daily_limit - (currentControl.cleanup_day === now.toISOString().slice(0, 10) ? currentControl.cleanup_used : 0)) : 100;
    if (allowance === 0) return;
    const limit = Math.min(100, allowance);
    const gate = `EXISTS(SELECT 1 FROM storage_topics t JOIN storage_jobs j ON j.id = ? JOIN storage_job_topics jt ON jt.job_id = j.id AND jt.topic_id = t.id
      JOIN storage_control s ON s.id = 1 WHERE t.id = ? AND j.owner_token = ? AND j.status = 'running' AND j.expires_at > ?
        AND s.mode = 'normal' AND s.generation = j.generation AND s.policy_revision = j.policy_revision AND t.revision = jt.revision AND t.protected = 0
        AND (j.mode = 'old' OR t.state = 'missing_confirmed') AND ${NO_ACTIVE_WORK})`;
    const params = [job.id, selected.topic_id, owner, now.toISOString()];
    const prepare = (sql, ...args) => storageStatement(db, sql, ...args);
    await db.batch([
      prepare(`DELETE FROM message_mappings WHERE id IN (SELECT id FROM message_mappings WHERE bot_id = ? AND thread_id = ? AND created_at <= ? ORDER BY created_at, id LIMIT ?) AND ${gate}`,
        selected.bot_id, selected.thread_id, selected.cutoff, limit, ...params),
      prepare("UPDATE storage_job_topics SET deleted_rows = deleted_rows + changes() WHERE job_id = ? AND topic_id = ?", job.id, selected.topic_id),
      prepare(`UPDATE storage_topics SET purge_before = MAX(COALESCE(purge_before, ''), ?) WHERE id = ? AND ${gate}`,
        selected.cutoff, selected.topic_id, ...params),
      prepare("UPDATE storage_jobs SET deleted_rows = (SELECT COALESCE(SUM(deleted_rows), 0) FROM storage_job_topics WHERE job_id = ?) WHERE id = ?", job.id, job.id),
      prepare("UPDATE storage_control SET cleanup_used = CASE WHEN cleanup_day = ? THEN cleanup_used ELSE 0 END + ?, cleanup_day = ? WHERE id = 1",
        now.toISOString().slice(0, 10), job.mode === 'auto' ? limit : 0, now.toISOString().slice(0, 10)),
      prepare(`UPDATE storage_job_topics SET status = 'completed' WHERE job_id = ? AND topic_id = ? AND NOT EXISTS(
        SELECT 1 FROM message_mappings WHERE bot_id = ? AND thread_id = ? AND created_at <= ?) AND ${gate}`, job.id, selected.topic_id, selected.bot_id, selected.thread_id, selected.cutoff, ...params),
    ]);
    if (job.mode === 'deleted' || job.mode === 'auto') {
      await db.batch([
        ...['operator_note_drafts','operator_work_inputs','conversation_work','service_notification_outbox','manager_work_flows','service_topic_history'].map(table => storageStatement(db, `DELETE FROM ${table} WHERE bot_id = ? AND user_id IN
          (SELECT user_id FROM conversations WHERE bot_id = ? AND thread_id = ? AND ${gate}
           AND NOT EXISTS(SELECT 1 FROM message_mappings WHERE bot_id = ? AND thread_id = ?))`,
          selected.bot_id, selected.bot_id, selected.thread_id, ...params, selected.bot_id, selected.thread_id)),
        storageStatement(db, `DELETE FROM service_topic_history WHERE bot_id = ? AND support_group_id = ? AND thread_id = ?
          AND ${gate} AND NOT EXISTS(SELECT 1 FROM message_mappings WHERE bot_id = ? AND thread_id = ?)`,
          selected.bot_id, selected.support_group_id, selected.thread_id, ...params, selected.bot_id, selected.thread_id),
        storageStatement(db, `DELETE FROM conversation_auto_replies WHERE bot_id = ? AND user_id IN
          (SELECT user_id FROM conversations WHERE bot_id = ? AND thread_id = ? AND ${gate}
           AND NOT EXISTS(SELECT 1 FROM message_mappings WHERE bot_id = ? AND thread_id = ?))`,
          selected.bot_id, selected.bot_id, selected.thread_id, ...params, selected.bot_id, selected.thread_id),
        storageStatement(db, `DELETE FROM conversations WHERE bot_id = ? AND thread_id = ? AND ${gate}
          AND NOT EXISTS(SELECT 1 FROM message_mappings WHERE bot_id = ? AND thread_id = ?)`,
          selected.bot_id, selected.thread_id, ...params, selected.bot_id, selected.thread_id),
      ]);
    }
  } catch (error) {
    try { await storageStatement(db, "UPDATE storage_jobs SET last_error = ? WHERE id = ? AND owner_token = ?", String(error.message).slice(0, 200), job.id, owner).run(); } catch { /* Retry the durable job later. */ }
    throw error;
  } finally {
    await storageStatement(db, "UPDATE storage_jobs SET owner_token = NULL, lease_until = NULL WHERE id = ? AND owner_token = ?", job.id, owner).run();
  }
}

export async function storageMaintenance(env, notify, now = new Date(), locale = 'en') {
  const db = env.SUPPORT_DB;
  db.recoveryCheckpoint?.(26);
  const control = await readStorageControl(db);
  if (control.mode !== 'normal') return;
  const complete = await backfillStorageTopics(env);
  await storageStatement(db, 'DELETE FROM operational_signals WHERE rowid IN (SELECT rowid FROM operational_signals WHERE bucket < ? LIMIT 100)', new Date(now.getTime() - 7 * DAY).toISOString()).run();
  await storageStatement(db, 'DELETE FROM telegram_cooldowns WHERE rowid IN (SELECT rowid FROM telegram_cooldowns WHERE not_before < ? LIMIT 100)', new Date(now.getTime() - 7 * DAY).toISOString()).run();
  const cutoff = new Date(now.getTime() - 30 * DAY).toISOString();
  // Bound every maintenance mutation, including child rows of old jobs.
  await storageStatement(db, `DELETE FROM storage_job_topics WHERE rowid IN (SELECT jt.rowid FROM storage_job_topics jt
    JOIN storage_jobs j ON j.id = jt.job_id WHERE j.expires_at < ? ORDER BY jt.rowid LIMIT 100)`, cutoff).run();
  await storageStatement(db, `DELETE FROM storage_jobs WHERE id IN (SELECT j.id FROM storage_jobs j WHERE expires_at < ?
    AND NOT EXISTS(SELECT 1 FROM storage_job_topics WHERE job_id = j.id) LIMIT 100)`, cutoff).run();
  await storageStatement(db, 'DELETE FROM storage_audit WHERE rowid IN (SELECT rowid FROM storage_audit WHERE completed_at < ? LIMIT 100)', new Date(now.getTime() - 180 * DAY).toISOString()).run();
  await storageStatement(db, "UPDATE storage_jobs SET status = 'expired' WHERE id IN (SELECT id FROM storage_jobs WHERE status IN ('preview', 'running') AND expires_at <= ? LIMIT 100)", now.toISOString()).run();
  const pendingAuto = await storageStatement(db, "SELECT id,support_group_id FROM storage_jobs WHERE mode = 'auto' AND status = 'preview' AND expires_at > ? LIMIT 1", now.toISOString()).first();
  if (pendingAuto) {
    await addJobTopics(env, pendingAuto.id, now);
    await confirmStorageJob({ ...env, SUPPORT_GROUP_ID: String(pendingAuto.support_group_id) }, pendingAuto.id, storageOwner(env), now);
    return;
  }
  const recentAuto = await storageStatement(db, "SELECT 1 FROM storage_jobs WHERE mode = 'auto' AND (created_at >= ? OR status = 'running') LIMIT 1", new Date(now.getTime() - DAY).toISOString()).first();
  if (complete && !recentAuto) {
    const group = await storageStatement(db, `SELECT support_group_id FROM storage_topics
      WHERE generation=? AND protected=0 AND state='missing_confirmed' AND missing_at<=?
        AND activity_known=1 AND last_activity<=? AND COALESCE(remind_after,'')<=?
        AND (support_group_id=? OR EXISTS(SELECT 1 FROM support_groups g WHERE g.group_id=storage_topics.support_group_id))
      ORDER BY support_group_id = COALESCE((SELECT support_group_id FROM storage_jobs
        WHERE mode='auto' ORDER BY created_at DESC LIMIT 1), 0), missing_at, support_group_id LIMIT 1`, control.generation,
      new Date(now.getTime() - control.quarantine_days * DAY).toISOString(),
      new Date(now.getTime() - control.retention_days * DAY).toISOString(), now.toISOString(), Number(env.SUPPORT_GROUP_ID)).first();
    if (group) {
      const jobEnv = { ...env, SUPPORT_GROUP_ID: String(group.support_group_id) };
      const id = await createStorageJob(jobEnv, { mode: 'auto', actorId: storageOwner(env) }, now);
      await confirmStorageJob(jobEnv, id, storageOwner(env), now);
      return;
    }
  }
  if (!control.last_summary || Date.parse(control.last_summary) <= now.getTime() - 7 * DAY) {
    const candidates = await storageStatement(db, `SELECT COUNT(*) AS n FROM storage_topics WHERE generation = ?
      AND protected = 0 AND state <> 'missing_confirmed' AND COALESCE(remind_after, '') <= ?
      AND (last_activity IS NULL OR last_activity <= ?)`, control.generation,
      now.toISOString(), new Date(now.getTime() - control.retention_days * DAY).toISOString()).first();
    if (candidates.n) {
      const words = {
        en: `🗂 The database has ${candidates.n} topics with no known recent activity. The primary administrator can review them in Adminushka's private chat: Storage. These topics will not be cleared without your approval.`,
        ru: `🗂 В БД есть ${candidates.n} тем без недавней известной активности. Главный администратор может проверить их в личке Админушки: Хранилище. Без вашего согласия эти темы не очищаются.`,
        es: `🗂 Hay ${candidates.n} temas en la base de datos sin actividad reciente conocida. El administrador principal puede revisarlos en el chat privado de Adminushka: Almacenamiento. No se limpiarán sin su aprobación.`,
        zh: `🗂 数据库中有 ${candidates.n} 个话题近期无已知活动。主管理员可在管理机器人的私人聊天中通过“存储”查看。未经您的批准，这些话题不会被清理。`,
      };
      const result = await notify(words[locale] || words.en);
      if (!result.ok) return;
    }
    await storageStatement(db, 'UPDATE storage_control SET last_summary = ? WHERE id = 1 AND generation = ?', now.toISOString(), control.generation).run();
  }
}
