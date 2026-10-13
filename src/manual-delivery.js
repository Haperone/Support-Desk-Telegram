import { resolveInvocationDatabase, RecoveryBudgetExhausted } from './recovery-budget.js';
import { TelegramCooldownError } from './telegram-cooldown.js';

const RUN_MS = 120_000;
const MAX_STEPS = 12;
const SAMPLE = 101;
export const MANAGER_DELIVERY_UI = '__manager__';

async function authorize(db, env, { actorId, groupId, threadId = 1, botId, uiBotId }) {
  const primary = Number(String(env.ADMIN_IDS || '').split(',')[0].trim());
  if (!Number.isSafeInteger(primary) || Number(actorId) !== primary) throw new Error('Manual delivery is restricted to the primary administrator');
  if (uiBotId === MANAGER_DELIVERY_UI) {
    if (threadId != null || !Number.isSafeInteger(Number(groupId))) throw new Error('Invalid manager delivery scope');
    if (!botId) {
      if (groupId !== 0) throw new Error('Invalid manager delivery scope');
      return;
    }
    if (Number(groupId) >= 0) throw new Error('Invalid manager delivery scope');
    const route = await db.prepare('SELECT group_id FROM service_group_routes WHERE bot_id=?').bind(botId).first();
    if (Number(route?.group_id) !== Number(groupId)) throw new Error('Service group changed; refresh the delivery screen');
    return;
  }
  if (String(groupId) !== String(env.SUPPORT_GROUP_ID) || (threadId != null && Number(threadId) !== 1))
    throw new Error('Manual delivery is restricted to General');
}
function configs(env, botId) {
  const registry = JSON.parse(env.BOT_REGISTRY);
  if (botId && !registry.some(bot => bot.id === botId)) throw new Error('Unknown support bot');
  return registry.filter(bot => !botId || bot.id === botId);
}
function parseReport(run) { return JSON.parse(run?.report_json || '{}'); }
function safeError(error) {
  return String(error?.message || error).replace(/\b\d+:[A-Za-z0-9_-]+\b/g, '[token]').slice(0, 220);
}

// Bounded samples of durable inputs. Never interpret a disappeared row as delivery.
// Unconfirmed single sends are visible but cannot be rebuilt without the original
// Telegram update (in particular the operator identity and reply metadata).
export async function deliverySnapshot(db, env, botId = null) {
  const registry = configs(env, botId);
  if (db.storageMode === 'reset') return { maintenance: true, rows: [], targets: [], limited: false };
  const found = await db.prepare(`WITH inputs AS (
    SELECT * FROM (SELECT 'reopen' kind, id, bot_id, user_id, source_chat_id, source_message_id,
      'user_to_support' direction, NULL media_group_id, failure_code, NULL request_started_at, created_at
      FROM reopen_business_messages WHERE delivered_at IS NULL AND (?1 IS NULL OR bot_id = ?1) ORDER BY id LIMIT ${SAMPLE})
    UNION ALL SELECT * FROM (SELECT 'pending', id, bot_id, user_id, source_chat_id, source_message_id,
      'user_to_support', media_group_id, failure_code, request_started_at, created_at
      FROM pending_messages WHERE delivered_at IS NULL AND delivery_completed_at IS NULL AND (?1 IS NULL OR bot_id = ?1) ORDER BY id LIMIT ${SAMPLE})
    UNION ALL SELECT * FROM (SELECT 'album', 0, i.bot_id, g.user_id, i.source_chat_id, i.message_id,
      i.direction, i.media_group_id,
      CASE WHEN i.delivery_uncertain_at IS NOT NULL OR g.operator_identity_unknown_at IS NOT NULL THEN 'uncertain' END,
      CASE WHEN i.delivery_attempt_started_at IS NOT NULL THEN g.request_started_at END, g.created_at
      FROM media_group_items i JOIN media_groups g USING(bot_id, direction, media_group_id, source_chat_id)
      WHERE i.delivered_at IS NULL AND (?1 IS NULL OR i.bot_id = ?1) ORDER BY i.received_at LIMIT ${SAMPLE})
    UNION ALL SELECT * FROM (SELECT 'single', 0, bot_id, user_id, source_chat_id, source_message_id,
      direction, NULL, failure_code, request_started_at, started_at FROM message_delivery_attempts
      WHERE completed_at IS NULL AND (?1 IS NULL OR bot_id = ?1) ORDER BY started_at LIMIT ${SAMPLE})
  ) SELECT i.*, c.support_group_id,c.thread_id,c.first_name,c.username, b.enabled AS persisted_enabled,
    CASE WHEN banned.user_id IS NOT NULL THEN 'banned'
      WHEN s.manual_restricted_until > ?2 THEN 'restricted'
      WHEN s.muted_until > ?2 THEN 'muted'
      WHEN s.verification_required = 1 THEN 'captcha' END AS blocked,
    (SELECT id FROM verification_challenges c WHERE c.bot_id=i.bot_id AND c.user_id=i.user_id
      AND c.status='passed' AND c.flushed_at IS NULL ORDER BY c.verified_at LIMIT 1) AS challenge_id,
    COALESCE(s.pending_release_required, 0) AS release_required
    FROM inputs i LEFT JOIN bots b ON b.id=i.bot_id
    LEFT JOIN conversations c ON c.bot_id=i.bot_id AND c.user_id=i.user_id
    LEFT JOIN user_abuse_state s ON s.bot_id=i.bot_id AND s.user_id=i.user_id
    LEFT JOIN banned_users banned ON banned.bot_id=i.bot_id AND banned.user_id=i.user_id`)
    .bind(botId, new Date().toISOString()).all();
  const unique = new Map();
  const counts = {};
  for (const row of found.results || []) {
    counts[row.kind] = (counts[row.kind] || 0) + 1;
    const key = JSON.stringify([row.bot_id, row.direction, row.source_chat_id, row.source_message_id]);
    // Prefer a durable queue over the overlapping single-delivery attempt.
    if (!unique.has(key)) unique.set(key, { ...row, key });
    const selected = unique.get(key);
    if ((row.failure_code && row.failure_code !== 'support_group_unavailable') || row.request_started_at)
      selected.uncertain = true;
  }
  const rows = [...unique.values()];
  const targets = new Map();
  for (const row of rows) {
    const bot = registry.find(bot => bot.id === row.bot_id);
    row.reason = !bot?.enabled || row.persisted_enabled === 0 ? 'disabled'
      : row.blocked || (row.uncertain ? 'uncertain' : null);
    let kind = row.kind;
    if (kind === 'pending') kind = row.challenge_id ? 'challenge'
      : row.release_required || row.failure_code === 'support_group_unavailable' ? 'release' : null;
    if (kind === 'single') kind = null;
    if (!row.reason && !kind) row.reason = 'telegram';
    if (!row.reason) {
      const target = { kind, botId: row.bot_id, userId: row.user_id, id: row.challenge_id,
        direction: row.direction, groupId: row.media_group_id, sourceChatId: row.source_chat_id };
      target.key = JSON.stringify([target.botId, kind, kind === 'album' ? [target.direction, target.groupId, target.sourceChatId] : target.userId]);
      targets.set(target.key, target);
    }
  }
  return { rows, targets: [...targets.values()], limited: Object.values(counts).some(count => count >= SAMPLE) };
}

export async function manualDeliveryStatus(env, options) {
  const db = await resolveInvocationDatabase(env.SUPPORT_DB, env);
  await authorize(db, env, options);
  const run = await db.prepare(`SELECT * FROM manual_delivery_runs
    WHERE (? IS NULL OR bot_id=?) AND (?<>? OR group_id=?)
    ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .bind(options.botId || null, options.botId || null, options.uiBotId || '', MANAGER_DELIVERY_UI, options.groupId).first();
  const snapshot = await deliverySnapshot(db, env, options.botId || null);
  return { run, snapshot };
}

export async function beginManualDelivery(env, options, publish) {
  configs(env, options.botId);
  if (options.uiBotId !== MANAGER_DELIVERY_UI && !configs(env).some(bot => bot.id === options.uiBotId && bot.enabled)
      || !Number.isSafeInteger(options.messageId) || options.messageId <= 0 || !options.requestKey) throw new Error('Invalid manual delivery request');
  const db = await resolveInvocationDatabase(env.SUPPORT_DB, env);
  await authorize(db, env, options);
  if (db.storageMode === 'reset') return { maintenance: true };
  const now = new Date().toISOString();
  await db.prepare("UPDATE manual_delivery_runs SET status='interrupted', finished_at=? WHERE status IN ('queued','running') AND expires_at<=?").bind(now, now).run();
  const token = crypto.randomUUID();
  const inserted = await db.prepare(`INSERT OR IGNORE INTO manual_delivery_runs
    (token,request_key,actor_id,group_id,bot_id,ui_bot_id,message_id,generation,status,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,'queued',?,?)`)
    .bind(token, options.requestKey, options.actorId, options.groupId, options.botId || null, options.uiBotId,
      options.messageId, db.storageGeneration ?? null, now, new Date(Date.now() + RUN_MS).toISOString()).run();
  const run = await db.prepare(`SELECT * FROM manual_delivery_runs WHERE token=? OR request_key=? OR status IN ('queued','running')
    ORDER BY CASE WHEN request_key=? THEN 0 ELSE 1 END LIMIT 1`).bind(token, options.requestKey, options.requestKey).first();
  if (inserted.meta?.changes !== 1 && !(run?.request_key === options.requestKey && run.status === 'queued')) return { run, started: false };
  // Publish acceptance before starting work; a failed UI write leaves an explicit
  // queued run, never a falsely completed run. The same callback can resume it.
  await publish({ ...env, SUPPORT_DB: db }, run);
  return { run, started: true };
}

async function activeRun(db, env, token) {
  const run = await db.prepare('SELECT * FROM manual_delivery_runs WHERE token=?').bind(token).first();
  if (!run || run.status !== 'running' || run.expires_at <= new Date().toISOString()) return null;
  await authorize(db, env, { actorId: run.actor_id, groupId: run.group_id, threadId: run.ui_bot_id === MANAGER_DELIVERY_UI ? null : 1,
    botId: run.bot_id, uiBotId: run.ui_bot_id });
  if (db.storageMode === 'reset' || (run.generation != null && run.generation !== db.storageGeneration)) return null;
  return run;
}

export async function inspectManualDelivery(env, token, observed = []) {
  const db = await resolveInvocationDatabase(env.SUPPORT_DB, env);
  const run = await activeRun(db, env, token);
  if (!run) return null;
  const snapshot = await deliverySnapshot(db, env, run.bot_id);
  const keys = [...new Set([...observed, ...snapshot.rows.map(row => row.key)])].slice(0, 500);
  const confirmed = await db.prepare(`SELECT k.value AS key FROM json_each(?) k WHERE EXISTS (
    SELECT 1 FROM message_mappings m WHERE m.bot_id=json_extract(k.value,'$[0]') AND
    ((json_extract(k.value,'$[1]')='user_to_support' AND m.user_id=json_extract(k.value,'$[2]') AND m.user_message_id=json_extract(k.value,'$[3]') AND m.support_message_id IS NOT NULL)
    OR (json_extract(k.value,'$[1]')='support_to_user' AND m.support_message_id=json_extract(k.value,'$[3]') AND m.user_message_id IS NOT NULL)))
    OR EXISTS(SELECT 1 FROM message_delivery_attempts d WHERE d.bot_id=json_extract(k.value,'$[0]') AND d.direction=json_extract(k.value,'$[1]')
      AND d.source_chat_id=json_extract(k.value,'$[2]') AND d.source_message_id=json_extract(k.value,'$[3]') AND d.completed_at IS NOT NULL AND d.target_message_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM pending_messages p WHERE p.bot_id=json_extract(k.value,'$[0]') AND json_extract(k.value,'$[1]')='user_to_support'
      AND p.source_chat_id=json_extract(k.value,'$[2]') AND p.source_message_id=json_extract(k.value,'$[3]') AND p.delivery_completed_at IS NOT NULL AND p.target_message_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM media_group_items i WHERE i.bot_id=json_extract(k.value,'$[0]') AND i.direction=json_extract(k.value,'$[1]')
      AND i.source_chat_id=json_extract(k.value,'$[2]') AND i.message_id=json_extract(k.value,'$[3]') AND i.delivered_at IS NOT NULL AND i.target_message_id IS NOT NULL)`)
    .bind(JSON.stringify(keys)).all();
  return { ...snapshot, confirmed: (confirmed.results || []).map(row => row.key) };
}

export async function stepManualDelivery(env, token, target, perform) {
  const db = await resolveInvocationDatabase(env.SUPPORT_DB, env, 'recovery');
  const run = await activeRun(db, env, token);
  if (!run || (run.bot_id && target.botId !== run.bot_id)) return { state: 'stopped', attempts: 0 };
  const events = { attempts: 0, errors: [] };
  env = { ...env, SUPPORT_DB: db, MANUAL_DELIVERY_EVENTS: events };
  try {
    const result = await perform(env, target);
    return { state: result?.reason || 'checked', ...events };
  } catch (error) {
    if (error instanceof RecoveryBudgetExhausted) return { state: 'budget', ...events };
    if (error instanceof TelegramCooldownError) return { state: 'cooldown', until: error.notBefore, ...events };
    return { state: 'error', ...events, error: safeError(error) };
  }
}

// Called through a private loopback RPC, never through a public HTTP endpoint.
// Each step has its own real invocation budget. A bounded launch stops promptly;
// the admin may immediately start another batch, while Cron remains independent.
export async function executeManualDelivery(env, token, service, publish) {
  const db = await resolveInvocationDatabase(env.SUPPORT_DB, env);
  const claimed = await db.prepare("UPDATE manual_delivery_runs SET status='running' WHERE token=? AND status='queued' AND expires_at>? RETURNING *")
    .bind(token, new Date().toISOString()).first();
  if (!claimed) return;
  const report = { steps: 0, attempts: 0, confirmed: 0, errors: [], outcomes: [], remaining: null };
  const visits = new Map();
  const observed = new Map();
  const observe = snapshot => {
    const confirmed = new Set(snapshot.confirmed);
    for (const row of snapshot.rows) if (!observed.has(row.key) && observed.size < 500) observed.set(row.key, confirmed.has(row.key));
    report.confirmed = [...observed].filter(([key, before]) => !before && confirmed.has(key)).length;
    report.remaining = summarizeSnapshot(snapshot);
  };
  const deadline = Date.now() + 18_000;
  let status = 'finished';
  try {
    for (let i = 0; i < MAX_STEPS && Date.now() < deadline; i++) {
      const snapshot = await service.inspect(token, [...observed.keys()]);
      if (!snapshot) { status = 'interrupted'; break; }
      observe(snapshot);
      const target = snapshot.targets.filter(item => (visits.get(item.key) || 0) < 4)
        .sort((a, b) => (visits.get(a.key) || 0) - (visits.get(b.key) || 0))[0];
      if (!target) break;
      visits.set(target.key, (visits.get(target.key) || 0) + 1);
      const result = await service.step(token, target);
      report.steps++;
      report.attempts += result.attempts || 0;
      report.outcomes.push({ bot: target.botId, state: result.state, until: result.until });
      for (const error of [...(result.errors || []), ...(result.error ? [result.error] : [])]) {
        if (report.errors.length < 5) report.errors.push(`${target.botId}: ${safeError(error)}`);
      }
      if (['error', 'cooldown', 'stopped'].includes(result.state)) visits.set(target.key, 4);
      await db.prepare("UPDATE manual_delivery_runs SET report_json=? WHERE token=? AND status='running'")
        .bind(JSON.stringify(report), token).run();
    }
    const final = await service.inspect(token, [...observed.keys()]);
    if (final) observe(final);
    else status = 'interrupted';
  } catch (error) {
    status = 'interrupted';
    report.errors.push(safeError(error));
  }
  await db.prepare("UPDATE manual_delivery_runs SET status=?, finished_at=?, report_json=? WHERE token=? AND status='running'")
    .bind(status, new Date().toISOString(), JSON.stringify(report), token).run();
  const run = await db.prepare('SELECT * FROM manual_delivery_runs WHERE token=?').bind(token).first();
  // Retain a small diagnostic history without growing alongside chat history.
  await db.prepare("DELETE FROM manual_delivery_runs WHERE token IN (SELECT token FROM manual_delivery_runs WHERE status NOT IN ('queued','running') ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 20)").run();
  await publish({ ...env, SUPPORT_DB: db }, run);
}

function summarizeSnapshot(snapshot) {
  const counts = { total: snapshot.rows.length, ready: 0, limited: snapshot.limited };
  for (const row of snapshot.rows) counts[row.reason || 'ready'] = (counts[row.reason || 'ready'] || 0) + 1;
  return counts;
}

const deliveryCopy = {
  en: { maintenance: 'Database cleanup is running. Delivery retry is unavailable.', title: '🔄 Retry delivery', scope: 'Run scope: ', all: 'all bots', last: 'Last run: ', interrupted: '⚠️ Run interrupted; completion is not confirmed.', active: '⏳ Accepted. Recovery is running…', finished: '✅ Attempt finished. Some messages may remain.', steps: 'Recovery steps: ', attempts: 'Message send requests: ', confirmed: 'Deliveries confirmed during this run: ', queue: 'In the saved queue: ', review: 'Review the outcome in Telegram before a manual decision:', operator: 'Operator → customer', customer: 'Customer → topic', more: 'And {n} more', budget: 'A step reached its limit; progress was saved.', cooldown: 'Telegram cooldown until', errors: 'Errors during the run (some may have been resolved by recovery):', retry: 'Messages remain. You can retry another batch now without waiting for Cron.', footer: 'Retries durable queues in our database. Updates Telegram has not delivered to the bot are outside this queue. Uncertain sends are not replayed to avoid duplicates.', labels: { ready: 'Ready to retry', uncertain: 'Uncertain previous result / review required', captcha: 'Awaiting CAPTCHA', banned: 'User banned', restricted: 'User restricted', muted: 'User muted', disabled: 'Bot disabled', telegram: 'Requires Telegram to retry the incoming update' } },
  ru: { maintenance: 'Очистка базы ещё выполняется. Повторная доставка сейчас недоступна.', title: '🔄 Повторная доставка', scope: 'Область запуска: ', all: 'все боты', last: 'Последний запуск: ', interrupted: '⚠️ Запуск прерван. Завершение не подтверждено.', active: '⏳ Запуск принят. Выполняется восстановление…', finished: '✅ Попытка завершена. Это не означает, что доставлены все сообщения.', steps: 'Шагов восстановления: ', attempts: 'Запросов отправки сообщений: ', confirmed: 'Подтверждено доставок за время запуска: ', queue: 'В сохранённой очереди: ', review: 'Проверьте исход в Telegram перед ручным решением:', operator: 'Оператор → клиент', customer: 'Клиент → тема', more: 'И ещё: {n}', budget: 'Достигался лимит одного шага; прогресс сохранён.', cooldown: 'Telegram запрещает отправку до', errors: 'Ответы об ошибках во время запуска (часть могла быть исправлена восстановлением):', retry: 'В очереди ещё есть сообщения. Можно сразу нажать «Повторить сейчас» ещё раз; ждать Cron не нужно.', footer: 'Кнопка запускает доставку из нашей базы. Сообщения, которые Telegram ещё не передал боту, сюда не входят. Неясные отправки не повторяются, чтобы избежать дублей.', labels: { ready: 'Можно повторить', uncertain: 'Результат прежней отправки неясен / нужна проверка', captcha: 'Ожидают капчу', banned: 'Пользователь заблокирован', restricted: 'Пользователь ограничен', muted: 'Временное ограничение', disabled: 'Бот отключён', telegram: 'Нужен повтор входящего сообщения от Telegram' } },
  es: { maintenance: 'La limpieza de la base de datos sigue en curso. No se puede reintentar la entrega ahora.', title: '🔄 Reintentar entrega', scope: 'Ámbito de ejecución: ', all: 'todos los bots', last: 'Última ejecución: ', interrupted: '⚠️ Ejecución interrumpida; no se confirmó su finalización.', active: '⏳ Solicitud aceptada. La recuperación está en curso…', finished: '✅ Intento finalizado. Puede que aún queden mensajes.', steps: 'Pasos de recuperación: ', attempts: 'Solicitudes de envío: ', confirmed: 'Entregas confirmadas durante esta ejecución: ', queue: 'En la cola guardada: ', review: 'Compruebe el resultado en Telegram antes de decidir manualmente:', operator: 'Operador → cliente', customer: 'Cliente → tema', more: 'Y {n} más', budget: 'Se alcanzó el límite de un paso; se guardó el progreso.', cooldown: 'Telegram impide enviar hasta', errors: 'Errores durante la ejecución (algunos pueden haberse resuelto):', retry: 'Quedan mensajes. Puede reintentar otro lote ahora sin esperar a Cron.', footer: 'Reintenta las colas guardadas en nuestra base de datos. No incluye actualizaciones que Telegram aún no entregó al bot. Los envíos inciertos no se repiten para evitar duplicados.', labels: { ready: 'Listo para reintentar', uncertain: 'Resultado anterior incierto / requiere revisión', captcha: 'En espera de CAPTCHA', banned: 'Usuario bloqueado', restricted: 'Usuario restringido', muted: 'Usuario silenciado temporalmente', disabled: 'Bot desactivado', telegram: 'Requiere que Telegram reenvíe la actualización entrante' } },
  zh: { maintenance: '数据库清理仍在进行，暂时无法重试投递。', title: '🔄 重试投递', scope: '执行范围：', all: '所有机器人', last: '上次执行：', interrupted: '⚠️ 执行中断，尚未确认完成。', active: '⏳ 已接受请求，正在恢复…', finished: '✅ 本次尝试已结束，可能仍有消息待投递。', steps: '恢复步骤：', attempts: '消息发送请求：', confirmed: '本次确认投递：', queue: '已保存队列中：', review: '手动处理前请先在 Telegram 中核查结果：', operator: '操作员 → 客户', customer: '客户 → 话题', more: '另有 {n} 条', budget: '单步达到限制，进度已保存。', cooldown: 'Telegram 限制发送至', errors: '执行期间的错误（部分可能已恢复）：', retry: '仍有消息待处理。现在可以再次重试，无需等待定时任务。', footer: '此操作重试数据库中已保存的队列。不包括 Telegram 尚未交给机器人的更新。为避免重复，不会重发结果不确定的消息。', labels: { ready: '可重试', uncertain: '上次结果不确定／需要核查', captcha: '等待 CAPTCHA', banned: '用户已封禁', restricted: '用户受限', muted: '用户暂时禁言', disabled: '机器人已停用', telegram: '需要 Telegram 重发传入更新' } },
};

export function manualDeliveryText({ run, snapshot, maintenance }, locale = 'ru') {
  const c = deliveryCopy[locale] || deliveryCopy.en;
  if (maintenance || snapshot?.maintenance) return c.maintenance;
  const report = parseReport(run);
  const active = run && ['queued', 'running'].includes(run.status);
  const expired = active && run.expires_at <= new Date().toISOString();
  const lines = [c.title];
  if (run) {
    lines.push(c.scope + (run.bot_id || c.all));
    lines.push(c.last + run.created_at.replace('T', ' ').replace(/\.\d+Z$/, ' UTC'));
    lines.push(expired || run.status === 'interrupted' ? c.interrupted : active ? c.active : c.finished);
    lines.push(c.steps + (report.steps || 0));
    lines.push(c.attempts + (report.attempts || 0));
    lines.push(c.confirmed + (report.confirmed || 0));
  }
  const counts = snapshot ? summarizeSnapshot(snapshot) : report.remaining;
  if (counts) {
    lines.push('', c.queue + counts.total + (counts.limited ? '+' : ''));
    for (const [key, label] of Object.entries(c.labels)) if (counts[key]) lines.push(`${label}: ${counts[key]}`);
    const review = (snapshot?.rows || []).filter(row => row.reason === 'uncertain').slice(0, 5);
    if (review.length) {
      lines.push('', c.review);
      for (const row of review) lines.push(`${row.direction === 'support_to_user' ? c.operator : c.customer} · ${row.bot_id} · ${row.source_chat_id}/${row.source_message_id}`);
      if (counts.uncertain > review.length) lines.push(c.more.replace('{n}', counts.uncertain - review.length));
    }
  }
  if (report.outcomes?.some(item => item.state === 'budget')) lines.push(c.budget);
  for (const item of report.outcomes?.filter(item => item.state === 'cooldown').slice(0, 3) || []) lines.push(`${item.bot}: ${c.cooldown} ${item.until}`);
  if (report.errors?.length) lines.push('', c.errors, ...report.errors);
  if (!active && counts?.ready) lines.push('', c.retry);
  lines.push('', c.footer);
  return lines.join('\n');
}
