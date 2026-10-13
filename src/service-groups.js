// D1-backed destinations. Telegram chat and topic identifiers are always used
// together; thread_id alone is never a routing key.
const now = () => new Date().toISOString();

function groupId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id >= 0) throw new Error('Invalid Telegram support group ID');
  return id;
}

function legacyId(env) {
  const value = typeof env === 'object' ? env?.SUPPORT_GROUP_ID : env;
  return value == null || value === '' ? null : groupId(value);
}

function changed(result) { return Number(result?.meta?.changes || 0) > 0; }

// A completed marker may remain after the conversation row was committed and
// before its best-effort cleanup. It is safe only while it identifies that
// exact active topic in its original group.
const unresolvedProvisionSql = `SELECT 1 FROM conversation_provision_attempts p WHERE p.bot_id=?
  AND (p.completed_at IS NULL OR p.thread_id IS NULL OR p.failure_code LIKE '%unknown%'
    OR NOT EXISTS(SELECT 1 FROM conversations c WHERE c.bot_id=p.bot_id AND c.user_id=p.user_id
      AND c.thread_id=p.thread_id AND (p.support_group_id IS NULL OR p.support_group_id=c.support_group_id)))`;

export async function registerSupportGroup(db, id, metadata = {}) {
  id = groupId(id);
  const timestamp = now();
  await db.prepare(`INSERT INTO support_groups(group_id,title,forum_verified_at,manager_verified_at,
      service_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(group_id) DO UPDATE SET
      title=COALESCE(excluded.title,support_groups.title),
      forum_verified_at=COALESCE(excluded.forum_verified_at,support_groups.forum_verified_at),
      manager_verified_at=COALESCE(excluded.manager_verified_at,support_groups.manager_verified_at),
      service_verified_at=COALESCE(excluded.service_verified_at,support_groups.service_verified_at),
      updated_at=excluded.updated_at`)
    .bind(id, metadata.title ?? null, metadata.forumVerifiedAt ?? null,
      metadata.managerVerifiedAt ?? null, metadata.serviceVerifiedAt ?? null,
      timestamp, timestamp).run();
  return db.prepare('SELECT * FROM support_groups WHERE group_id=?').bind(id).first();
}

export async function resolveActiveGroup(db, botId, env) {
  if (!botId) throw new Error('botId is required');
  const existing = await db.prepare('SELECT group_id FROM service_group_routes WHERE bot_id=?').bind(botId).first();
  if (existing) return Number(existing.group_id);
  const legacy = legacyId(env);
  if (legacy == null) return null;
  await registerSupportGroup(db, legacy);
  await db.prepare(`INSERT INTO service_group_routes(bot_id,group_id,source,updated_at)
    VALUES(?,?,'legacy',?) ON CONFLICT(bot_id) DO NOTHING`).bind(botId, legacy, now()).run();
  const route = await db.prepare('SELECT group_id FROM service_group_routes WHERE bot_id=?').bind(botId).first();
  return Number(route.group_id);
}

export async function listGroupServices(db, id) {
  return (await db.prepare('SELECT bot_id FROM service_group_routes WHERE group_id=? ORDER BY bot_id')
    .bind(groupId(id)).all()).results;
}

export async function findTopicByGroup(db, id, threadId) {
  id = groupId(id);
  const active = await db.prepare('SELECT *, 0 AS historical FROM conversations WHERE support_group_id=? AND thread_id=?')
    .bind(id, threadId).first();
  if (active) return active;
  return db.prepare(`SELECT h.*, 1 AS historical,
      COALESCE(h.replacement_thread_id, (SELECT c.thread_id FROM conversations c
        WHERE c.bot_id=h.bot_id AND c.user_id=h.user_id
          AND c.support_group_id=h.replacement_group_id)) AS current_thread_id
    FROM service_topic_history h WHERE h.support_group_id=? AND h.thread_id=?`)
    .bind(id, threadId).first();
}

export async function inspectGroupCutover(db, botId, targetId) {
  targetId = groupId(targetId);
  const route = await db.prepare('SELECT group_id,revision FROM service_group_routes WHERE bot_id=?').bind(botId).first();
  const target = await db.prepare('SELECT * FROM support_groups WHERE group_id=?').bind(targetId).first();
  const blockers = [];
  if (!target) blockers.push('target_group_missing');
  if (!route || Number(route.group_id) !== targetId) {
    const checks = [
      ['topic_creation_unresolved', `${unresolvedProvisionSql} LIMIT 1`],
      ['delivery_unresolved', `SELECT 1 FROM message_delivery_attempts WHERE bot_id=? AND completed_at IS NULL
        AND (request_started_at IS NOT NULL OR failure_code LIKE '%unknown%') LIMIT 1`],
      ['pending_send_unresolved', `SELECT 1 FROM pending_messages WHERE bot_id=? AND delivered_at IS NULL
        AND (request_started_at IS NOT NULL OR failure_code LIKE '%unknown%') LIMIT 1`],
      ['reopen_effect_unresolved', `SELECT 1 FROM conversation_reopen_effects WHERE bot_id=? AND completed_at IS NULL LIMIT 1`],
      ['reopen_business_unresolved', `SELECT 1 FROM reopen_business_messages WHERE bot_id=? AND delivered_at IS NULL
        AND (failure_code IS NULL OR failure_code LIKE '%unknown%') LIMIT 1`],
      ['album_unresolved', `SELECT 1 FROM media_groups WHERE bot_id=? AND delivery_completed_at IS NULL LIMIT 1`],
      ['album_item_unresolved', `SELECT 1 FROM media_group_items WHERE bot_id=? AND delivered_at IS NULL LIMIT 1`],
      ['conversation_locked', `SELECT 1 FROM conversation_locks WHERE bot_id=? AND lease_expires_at>? LIMIT 1`],
    ];
    for (const [name, sql] of checks) {
      const result = await db.prepare(sql).bind(...(name === 'conversation_locked' ? [botId, now()] : [botId])).first();
      if (result) blockers.push(name);
    }
  }
  return { ready: blockers.length === 0, blockers, currentGroupId: route ? Number(route.group_id) : null,
    revision: route ? Number(route.revision) : null, targetGroupId: targetId };
}

export async function commitGroupCutover(db, botId, targetId, expectedGroupId, inspectedState = null) {
  targetId = groupId(targetId);
  expectedGroupId = expectedGroupId == null ? null : groupId(expectedGroupId);
  // A caller may reuse an inspection made just before updating group menus.
  // The conditional write below still checks the current route and blockers.
  const state = inspectedState || await inspectGroupCutover(db, botId, targetId);
  if (state.currentGroupId === targetId) return { changed: false, groupId: targetId, revision: state.revision };
  if (state.currentGroupId !== expectedGroupId) throw new Error('group_route_changed');
  if (!state.ready) throw new Error(`group_cutover_blocked:${state.blockers.join(',')}`);
  if (expectedGroupId === null) {
    const inserted = await db.prepare(`INSERT INTO service_group_routes(bot_id,group_id,source,updated_at)
      SELECT ?,?,'wizard',? WHERE EXISTS(SELECT 1 FROM support_groups WHERE group_id=?)
      AND NOT EXISTS(${unresolvedProvisionSql})
      AND NOT EXISTS(SELECT 1 FROM message_delivery_attempts WHERE bot_id=? AND completed_at IS NULL
        AND (request_started_at IS NOT NULL OR failure_code LIKE '%unknown%'))
      AND NOT EXISTS(SELECT 1 FROM pending_messages WHERE bot_id=? AND delivered_at IS NULL
        AND (request_started_at IS NOT NULL OR failure_code LIKE '%unknown%'))
      AND NOT EXISTS(SELECT 1 FROM conversation_reopen_effects WHERE bot_id=? AND completed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM reopen_business_messages WHERE bot_id=? AND delivered_at IS NULL
        AND (failure_code IS NULL OR failure_code LIKE '%unknown%'))
      AND NOT EXISTS(SELECT 1 FROM media_groups WHERE bot_id=? AND delivery_completed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM media_group_items WHERE bot_id=? AND delivered_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM conversation_locks WHERE bot_id=? AND lease_expires_at>?)
      ON CONFLICT(bot_id) DO NOTHING`)
      .bind(botId, targetId, now(), targetId, botId, botId, botId, botId, botId, botId, botId, botId, now()).run();
    if (changed(inserted)) return { changed: true, groupId: targetId, revision: 0 };
    const current = await db.prepare('SELECT group_id,revision FROM service_group_routes WHERE bot_id=?').bind(botId).first();
    if (Number(current?.group_id) === targetId) return { changed: false, groupId: targetId, revision: Number(current.revision) };
    throw new Error('group_cutover_raced_or_blocked');
  }
  // The predicates close the race between inspection and this CAS update.
  const [result] = await db.batch([db.prepare(`UPDATE service_group_routes SET group_id=?, revision=revision+1,
      source='wizard', updated_at=? WHERE bot_id=? AND group_id=? AND revision=?
      AND EXISTS(SELECT 1 FROM support_groups WHERE group_id=?)
      AND NOT EXISTS(${unresolvedProvisionSql})
      AND NOT EXISTS(SELECT 1 FROM message_delivery_attempts WHERE bot_id=? AND completed_at IS NULL
        AND (request_started_at IS NOT NULL OR failure_code LIKE '%unknown%'))
      AND NOT EXISTS(SELECT 1 FROM pending_messages WHERE bot_id=? AND delivered_at IS NULL
        AND (request_started_at IS NOT NULL OR failure_code LIKE '%unknown%'))
      AND NOT EXISTS(SELECT 1 FROM conversation_reopen_effects WHERE bot_id=? AND completed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM reopen_business_messages WHERE bot_id=? AND delivered_at IS NULL
        AND (failure_code IS NULL OR failure_code LIKE '%unknown%'))
      AND NOT EXISTS(SELECT 1 FROM media_groups WHERE bot_id=? AND delivery_completed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM media_group_items WHERE bot_id=? AND delivered_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM conversation_locks WHERE bot_id=? AND lease_expires_at>?)`)
    .bind(targetId, now(), botId, expectedGroupId, state.revision, targetId,
      botId, botId, botId, botId, botId, botId, botId, botId, now()),
  db.prepare(`UPDATE reaction_settings SET enabled=0,support_to_user_enabled=0,user_to_support_enabled=0,
      support_to_user_verified=0,user_to_support_verified=0,updated_at=?
      WHERE bot_id=? AND EXISTS(SELECT 1 FROM service_group_routes
        WHERE bot_id=? AND group_id=? AND revision=?)`)
    .bind(now(), botId, botId, targetId, state.revision + 1)]);
  if (!changed(result)) throw new Error('group_cutover_raced_or_blocked');
  return { changed: true, groupId: targetId, revision: state.revision + 1 };
}

// Call under the existing per-user conversation lock, before provisioning a
// topic in the newly active group. The transaction preserves the old address.
export async function archiveConversationForNewGroup(db, botId, userId, activeGroupId) {
  activeGroupId = groupId(activeGroupId);
  const route = await db.prepare('SELECT group_id FROM service_group_routes WHERE bot_id=?').bind(botId).first();
  if (Number(route?.group_id) !== activeGroupId) throw new Error('group_route_changed');
  const old = await db.prepare('SELECT * FROM conversations WHERE bot_id=? AND user_id=?')
    .bind(botId, userId).first();
  if (!old || Number(old.support_group_id) === activeGroupId) return false;
  const results = await db.batch([
    db.prepare(`INSERT INTO service_topic_history(bot_id,user_id,support_group_id,thread_id,
      conversation_id,status,created_at,last_message_at,archived_at,replacement_group_id)
      SELECT bot_id,user_id,support_group_id,thread_id,id,status,created_at,last_message_at,?,?
      FROM conversations WHERE id=? AND support_group_id=?
        AND EXISTS(SELECT 1 FROM service_group_routes WHERE bot_id=? AND group_id=?)
      ON CONFLICT(support_group_id,thread_id) DO NOTHING`)
      .bind(now(), activeGroupId, old.id, old.support_group_id, botId, activeGroupId),
    db.prepare(`DELETE FROM conversation_provision_attempts WHERE bot_id=? AND user_id=?
      AND completed_at IS NOT NULL AND thread_id=?
      AND (support_group_id IS NULL OR support_group_id=?)
      AND EXISTS(SELECT 1 FROM service_topic_history WHERE conversation_id=?)`)
      .bind(botId, userId, old.thread_id, old.support_group_id, old.id),
    db.prepare(`DELETE FROM conversations WHERE id=? AND support_group_id=?
      AND EXISTS(SELECT 1 FROM service_topic_history WHERE conversation_id=?)
      AND NOT EXISTS(SELECT 1 FROM conversation_provision_attempts WHERE bot_id=? AND user_id=?)
      AND EXISTS(SELECT 1 FROM service_group_routes WHERE bot_id=? AND group_id=?)`)
      .bind(old.id, old.support_group_id, old.id, botId, userId, botId, activeGroupId),
  ]);
  return changed(results[2]);
}
