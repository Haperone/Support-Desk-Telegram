import { resolveInvocationDatabase } from './recovery-budget.js';
import { customerName } from './user-display.js';

const iso = value => value.toISOString();
const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();

// Private RPC only. Claims and external-request markers live beside the events,
// so a monitor restart cannot turn an unknown Telegram result into a duplicate.
export async function claimAccessEvents(env, now = new Date()) {
  const db = await resolveInvocationDatabase(env.SUPPORT_DB, env, 'recovery');
  if (db.storageMode === 'reset') return null;
  const token = crypto.randomUUID();
  const lease = iso(new Date(now.getTime() + 120_000));
  const gate = await first(db, `UPDATE user_access_dispatch SET owner_token=?,lease_until=?
    WHERE id=1 AND (owner_token IS NULL OR lease_until<=?) AND (next_send_at IS NULL OR next_send_at<=?) RETURNING id`, token, lease, iso(now), iso(now));
  if (!gate) return null;
  try {
    await run(db, `UPDATE user_access_events SET uncertain_at=? WHERE id IN
      (SELECT id FROM user_access_events WHERE sent_at IS NULL AND uncertain_at IS NULL AND request_started_at IS NOT NULL AND lease_until<=? LIMIT 50)`, iso(now), iso(now));
    await run(db, `DELETE FROM user_access_events WHERE id IN (SELECT id FROM user_access_events
      WHERE created_at<? AND (sent_at IS NOT NULL OR uncertain_at IS NOT NULL) LIMIT 100)`, iso(new Date(now.getTime()-30*86_400_000)));
    const rows = await db.prepare(`UPDATE user_access_events SET owner_token=?,lease_until=? WHERE id IN
      (SELECT id FROM user_access_events WHERE sent_at IS NULL AND uncertain_at IS NULL AND request_started_at IS NULL
        AND ready_at<=? AND (owner_token IS NULL OR lease_until<=?) ORDER BY ready_at,id LIMIT 3)
      RETURNING *`).bind(token,lease,iso(now),iso(now)).all();
    if (!rows.results?.length) {
      await run(db, 'UPDATE user_access_dispatch SET owner_token=NULL,lease_until=NULL WHERE id=1 AND owner_token=?',token);
      return null;
    }
    const profiles = await db.prepare(`SELECT e.id,
      COALESCE(c.username,(SELECT source_username FROM pending_messages p WHERE p.bot_id=e.bot_id AND p.user_id=e.user_id ORDER BY id DESC LIMIT 1)) AS username,
      COALESCE(c.first_name,(SELECT source_first_name FROM pending_messages p WHERE p.bot_id=e.bot_id AND p.user_id=e.user_id ORDER BY id DESC LIMIT 1)) AS first_name,
      c.last_name,c.thread_id,c.support_group_id,
      COALESCE(s.risk_score,0) AS risk_score,s.muted_until,s.manual_restricted_until,s.verification_required,
      EXISTS(SELECT 1 FROM banned_users b WHERE b.bot_id=e.bot_id AND b.user_id=e.user_id) AS banned,
      v.status AS challenge_status,
      (SELECT COUNT(*) FROM pending_messages p WHERE p.bot_id=e.bot_id AND p.user_id=e.user_id AND p.delivered_at IS NULL AND p.failed_at IS NULL) AS queued
      FROM user_access_events e LEFT JOIN conversations c ON c.bot_id=e.bot_id AND c.user_id=e.user_id
      LEFT JOIN user_abuse_state s ON s.bot_id=e.bot_id AND s.user_id=e.user_id
      LEFT JOIN verification_challenges v ON v.id=e.reference_id WHERE e.owner_token=? AND e.sent_at IS NULL`).bind(token).all();
    const configs = JSON.parse(env.BOT_REGISTRY || '[]');
    const events = rows.results.sort((a,b)=>a.ready_at.localeCompare(b.ready_at)||a.id-b.id).map(event => ({ ...event,...profiles.results.find(p => p.id===event.id),
      service: configs.find(c => c.id===event.bot_id)?.displayName || event.bot_id,
      support_group_id: Number(env.SUPPORT_GROUP_ID) }));
    return { token, generation:db.storageGeneration, events };
  } catch (error) {
    await run(db,'UPDATE user_access_dispatch SET owner_token=NULL,lease_until=NULL WHERE id=1 AND owner_token=?',token);
    throw error;
  }
}

export async function startAccessEvents(env, token, generation, now = new Date()) {
  const db = await resolveInvocationDatabase(env.SUPPORT_DB, env, 'recovery');
  if (db.storageMode === 'reset' || db.storageGeneration !== generation) return false;
  const marked = await first(db, `UPDATE user_access_events SET request_started_at=? WHERE owner_token=?
    AND sent_at IS NULL AND uncertain_at IS NULL AND request_started_at IS NULL AND lease_until>?
    AND EXISTS(SELECT 1 FROM user_access_dispatch WHERE id=1 AND owner_token=? AND lease_until>?) RETURNING id`,iso(now),token,iso(now),token,iso(now));
  return Boolean(marked);
}

export async function completeAccessEvents(env, token, outcome, now = new Date()) {
  const db = await resolveInvocationDatabase(env.SUPPORT_DB, env, 'recovery');
  if (db.storageMode === 'reset') return;
  const retryAt=iso(new Date(now.getTime()+Math.max(30,Math.min(86_400,Number(outcome.retryAfterSeconds)||60))*1000));
  await run(db, `UPDATE user_access_events SET sent_at=CASE WHEN ? THEN ? ELSE sent_at END,
    uncertain_at=CASE WHEN ? THEN ? ELSE uncertain_at END,
    request_started_at=CASE WHEN ? THEN request_started_at ELSE NULL END,
    ready_at=CASE WHEN ? THEN ready_at ELSE ? END,owner_token=NULL,lease_until=NULL WHERE owner_token=?`,
  outcome.ok===true?1:0,iso(now),outcome.uncertain===true?1:0,iso(now),outcome.uncertain===true?1:0,outcome.ok===true?1:0,retryAt,token);
  await run(db, `UPDATE user_access_dispatch SET owner_token=NULL,lease_until=NULL,next_send_at=? WHERE id=1 AND owner_token=?`,
    outcome.ok ? iso(new Date(now.getTime()+2_000)) : retryAt,token);
}

export function accessEventVisible(event) {
  if (event.kind==='verification_due') return event.challenge_status==='pending';
  if (event.kind==='auto_restricted_due') return event.muted_until===event.deadline;
  if (event.kind==='restricted_due') return event.manual_restricted_until===event.deadline;
  return true;
}

export function formatAccessEvent(event, timezone='Europe/Budapest', now=new Date(), locale='en') {
  const language = ['ru','en','es','zh'].includes(locale) ? locale : 'en';
  const copy = {
    ru: {
    verification_required:'🧩 Пользователь ожидает проверки', verification_passed:'✅ Пользователь прошёл проверку',
    verification_ended:'ℹ️ Проверка завершена без прохождения',verification_due:'⚠️ Пользователь не прошёл проверку вовремя',
    verification_failed:'⚠️ Попытка проверки не прошла',
    auto_restricted:'⏳ Антиспам временно ограничил пользователя',restricted_event:'⏳ Оператор ограничил пользователя',
    auto_restricted_removed:'✅ Автоограничение снято',restricted_removed:'✅ Ограничение оператора снято',
    auto_restricted_due:'ℹ️ Срок автоограничения закончился',restricted_due:'ℹ️ Срок ограничения оператора закончился',
    banned:'🚫 Пользователь заблокирован',unbanned:'✅ Пользователь разблокирован',
    access_rate_limited:'⚠️ Сообщение остановлено лимитом частоты',access_queue_full:'⚠️ Очередь пользователя заполнена',
    access_limiter_unavailable:'⚠️ Сообщение остановлено: проверка антиспама недоступна',
    bot:'Бот',user:'Пользователь',id:'Telegram ID',event:'Событие',deadline:'Срок',reason:'Причина',
    auto_reason:d=>`антиспам; риск при ограничении — ${d||'неизвестен'}.`,risk:'Проверка антиспама; риск сейчас — ',
    occurrences:'Срабатываний в этой группе: ',now:'Сейчас',blocked:'заблокирован',restricted:'ограничен',pending:'ожидает проверки',clear:'действующих блокировок и капчи нет',
    queue:'В очереди капчи: ',delivery:'Это не подтверждение доставки.',stopped:'Остановленные сообщения могут не сохраняться; после снятия ограничения попросите пользователя повторить их.',
    topic:'Топик',missing:'Топик ещё не создан. Откройте General → Поиск пользователя или введите /user ',general:'General',unknown:'Имя пока неизвестно',changed:'Доступ пользователя изменился',
    date:'ru-RU'},
    en: {
    verification_required:'🧩 User needs verification',verification_passed:'✅ User passed verification',verification_ended:'ℹ️ Verification ended without passing',verification_due:'⚠️ User did not pass verification in time',verification_failed:'⚠️ Verification attempt failed',
    auto_restricted:'⏳ Anti-spam temporarily restricted the user',restricted_event:'⏳ Operator restricted the user',auto_restricted_removed:'✅ Automatic restriction removed',restricted_removed:'✅ Operator restriction removed',auto_restricted_due:'ℹ️ Automatic restriction expired',restricted_due:'ℹ️ Operator restriction expired',banned:'🚫 User blocked',unbanned:'✅ User unblocked',access_rate_limited:'⚠️ Message stopped by rate limit',access_queue_full:'⚠️ User queue is full',access_limiter_unavailable:'⚠️ Message stopped: anti-spam check unavailable',
    bot:'Bot',user:'User',id:'Telegram ID',event:'Event',deadline:'Deadline',reason:'Reason',auto_reason:d=>`anti-spam; risk when restricted: ${d||'unknown'}.`,risk:'Anti-spam check; current risk: ',occurrences:'Occurrences in this group: ',now:'Current status',blocked:'blocked',restricted:'restricted',pending:'awaiting verification',clear:'no active restrictions or CAPTCHA',queue:'CAPTCHA queue: ',delivery:'This does not confirm delivery.',stopped:'Stopped messages may not be stored. After the restriction is lifted, ask the user to send them again.',topic:'Topic',missing:'Topic not created yet. Open General → Search user or enter /user ',general:'General',unknown:'Name unavailable',changed:'User access changed',date:'en-GB'},
    es: {
    verification_required:'🧩 El usuario requiere verificación',verification_passed:'✅ El usuario superó la verificación',verification_ended:'ℹ️ La verificación terminó sin superarse',verification_due:'⚠️ El usuario no completó la verificación a tiempo',verification_failed:'⚠️ Falló el intento de verificación',auto_restricted:'⏳ La protección antispam restringió temporalmente al usuario',restricted_event:'⏳ Un operador restringió al usuario',auto_restricted_removed:'✅ Se retiró la restricción automática',restricted_removed:'✅ Se retiró la restricción del operador',auto_restricted_due:'ℹ️ Venció la restricción automática',restricted_due:'ℹ️ Venció la restricción del operador',banned:'🚫 Usuario bloqueado',unbanned:'✅ Usuario desbloqueado',access_rate_limited:'⚠️ Mensaje detenido por el límite de frecuencia',access_queue_full:'⚠️ La cola del usuario está llena',access_limiter_unavailable:'⚠️ Mensaje detenido: comprobación antispam no disponible',
    bot:'Bot',user:'Usuario',id:'ID de Telegram',event:'Evento',deadline:'Plazo',reason:'Motivo',auto_reason:d=>`antispam; riesgo al restringir: ${d||'desconocido'}.`,risk:'Comprobación antispam; riesgo actual: ',occurrences:'Incidencias en este grupo: ',now:'Estado actual',blocked:'bloqueado',restricted:'restringido',pending:'pendiente de verificación',clear:'sin restricciones activas ni CAPTCHA',queue:'En cola de CAPTCHA: ',delivery:'Esto no confirma la entrega.',stopped:'Es posible que los mensajes detenidos no se guarden. Cuando se retire la restricción, pide al usuario que los envíe de nuevo.',topic:'Tema',missing:'El tema aún no se ha creado. Abre General → Buscar usuario o escribe /user ',general:'General',unknown:'Nombre desconocido',changed:'Cambió el acceso del usuario',date:'es-ES'},
    zh: {
    verification_required:'🧩 用户需要验证',verification_passed:'✅ 用户已通过验证',verification_ended:'ℹ️ 验证结束，未通过',verification_due:'⚠️ 用户未能及时通过验证',verification_failed:'⚠️ 验证尝试失败',auto_restricted:'⏳ 反垃圾机制暂时限制了用户',restricted_event:'⏳ 管理员限制了用户',auto_restricted_removed:'✅ 已解除自动限制',restricted_removed:'✅ 已解除管理员限制',auto_restricted_due:'ℹ️ 自动限制已到期',restricted_due:'ℹ️ 管理员限制已到期',banned:'🚫 用户已封禁',unbanned:'✅ 用户已解除封禁',access_rate_limited:'⚠️ 消息因频率限制而停止',access_queue_full:'⚠️ 用户队列已满',access_limiter_unavailable:'⚠️ 消息已停止：反垃圾检查不可用',
    bot:'机器人',user:'用户',id:'Telegram ID',event:'事件',deadline:'期限',reason:'原因',auto_reason:d=>`反垃圾机制；限制时风险：${d||'未知'}。`,risk:'反垃圾检查；当前风险：',occurrences:'此组中的触发次数：',now:'当前状态',blocked:'已封禁',restricted:'受限',pending:'等待验证',clear:'没有生效的限制或验证码',queue:'验证码队列：',delivery:'这不代表消息已送达。',stopped:'被拦截的消息可能不会保存。限制解除后，请让用户重新发送。',topic:'话题',missing:'话题尚未创建。请打开 General → 搜索用户，或输入 /user ',general:'General',unknown:'未知姓名',changed:'用户访问状态已更改',date:'zh-CN'},
  }[language];
  const clean=(value,max=150)=>String(value||'').replace(/[\r\n\u0000-\u001f]/g,' ').slice(0,max);
  const date=value=>new Date(value).toLocaleString(copy.date,{timeZone:timezone});
  const name=customerName(event,copy.unknown);
  const eventKey = event.kind === 'restricted' ? 'restricted_event' : event.kind;
  const lines=[copy[eventKey]||`ℹ️ ${copy.changed}`,`${copy.bot}: ${clean(event.service)}`,
    `${copy.user}: ${clean(name)}${event.username && name !== '@'+event.username ? ' · @'+clean(event.username,32) : ''}`,`${copy.id}: ${event.user_id}`,
    `${copy.event}: ${date(event.created_at)}`];
  if (event.deadline) lines.push(`${copy.deadline}: ${date(event.deadline)}`);
  if (event.kind==='auto_restricted') lines.push(`${copy.reason}: ${copy.auto_reason(clean(event.detail,10)||null)}`);
  else if (event.kind==='verification_required') lines.push(`${copy.reason}: ${copy.risk}${event.risk_score||0}.`);
  if (event.kind==='banned' && event.detail) lines.push(`${copy.reason}: ${clean(event.detail,160)}`);
  if (event.occurrences>1) lines.push(`${copy.occurrences}${event.occurrences}`);
  const blocked=event.banned || Date.parse(event.muted_until)>now.getTime() || Date.parse(event.manual_restricted_until)>now.getTime();
  lines.push(`${copy.now}: ${event.banned?copy.blocked:blocked?copy.restricted:event.verification_required?copy.pending:copy.clear}.`);
  lines.push(`${copy.queue}${event.queued||0}. ${copy.delivery}`);
  if (['auto_restricted','restricted','banned','access_rate_limited','access_queue_full','access_limiter_unavailable'].includes(event.kind)) lines.push(copy.stopped);
  const group=String(event.support_group_id);
  if (/^-100\d+$/.test(group) && Number.isSafeInteger(event.thread_id) && event.thread_id>1) lines.push(`${copy.topic}: https://t.me/c/${group.slice(4)}/${event.thread_id}`);
  else {
    lines.push(copy.missing+event.user_id+'.');
    if (/^-100\d+$/.test(group)) lines.push(`${copy.general}: https://t.me/c/${group.slice(4)}/1`);
  }
  return lines.join('\n');
}
