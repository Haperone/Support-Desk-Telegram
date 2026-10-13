import { managementBotFromKey, managementBotKey, managerUserAccess, parseBotRegistry } from './worker.js';
import { resolveActiveGroup } from './service-groups.js';
import { showManagerAudit } from './manager-audit.js';
import { customerName } from './user-display.js';
import { messageDeletionWarning } from './message-deletion-copy.js';
import { opaqueManagerText } from './manager-language.js';

const button = (text, data) => ({ text, callback_data: data });
const now = () => new Date().toISOString();
const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
const labels = { x: 'Все', b: '🚫 Заблокированные', r: '⏳ Ограниченные', v: '🧩 На проверке',
  s: '⚠️ Подозрительные', t: '✅ Доверенные', n: '🕘 Недавние' };
const operations = new Set(['ban', 'unban', 'restrict', 'unrestrict', 'trust', 'untrust', 'riskreset']);

function registry(env) { return parseBotRegistry(env.BOT_REGISTRY); }
function configFor(env, key, requireEnabled = false) {
  const config = managementBotFromKey(registry(env), key);
  return config && (!requireEnabled || config.enabled) ? config : null;
}
const name = customerName;
function active(value) { return value && new Date(value).getTime() > Date.now(); }
function status(profile) {
  if (profile.banned_at) return 'заблокирован';
  if (active(profile.manual_restricted_until)) return `ограничен до ${profile.manual_restricted_until}`;
  if (active(profile.muted_until)) return `автоограничение до ${profile.muted_until}`;
  if (profile.verification_required) return 'ожидает проверку';
  if (profile.manual_trust || active(profile.trusted_until)) return 'доверенный';
  if (profile.risk_score >= 4) return 'подозрительный';
  return 'обычный';
}
function profileButton(env, profile) {
  const config = registry(env).find(item => item.id === profile.bot_id);
  if (!config) return null;
  const key = managementBotKey(registry(env), config.id);
  return [button(`${config.enabled ? '' : '⏸ '}${opaqueManagerText(name(profile).slice(0, 22))} · ${opaqueManagerText(config.displayName.slice(0, 18))} · ${profile.user_id}`,
    `mu:card:${key}:${profile.user_id}`)];
}

export async function showManagerUserHome(env, db, actorId, show, key = 'a') {
  const config = key === 'a' ? null : configFor(env, key);
  if (key !== 'a' && !config) return show('Сервис больше не подключён.');
  const counts = await managerUserAccess({ ...env, SUPPORT_DB: db }, 'counts', { botId: config?.id });
  const rows = [
    [button('🔎 Поиск', 'mu:search')],
    ...Object.entries(labels).reduce((all, [filter, label], index) => {
      if (index % 2 === 0) all.push([]);
      all.at(-1).push(button(label, `mu:list:${key}:${filter}:0`));
      return all;
    }, []),
    ...registry(env).map(item =>
      [button(`${item.enabled ? '' : '⏸ '}${opaqueManagerText(item.displayName)}`, `mu:home:${managementBotKey(registry(env), item.id)}`)]),
    [button('Все сервисы', 'mu:home:a')], [button('Меню', 'mg:home')],
  ];
  return show(`Пользователи · ${config ? opaqueManagerText(config.displayName) : 'все сервисы'}\n\nЛюдей: ${counts?.people || 0} · профилей: ${counts?.profiles || 0}\n`
    + `Заблокированы: ${counts?.banned || 0} · ограничены: ${counts?.restricted || 0}\n`
    + `На проверке: ${counts?.verification || 0} · подозрительные: ${counts?.suspicious || 0}\n`
    + `Доверенные: ${counts?.trusted || 0} · недавние: ${counts?.recent || 0}`, rows);
}

export async function showManagerUserList(env, db, actorId, key, filter, page, show) {
  const config = key === 'a' ? null : configFor(env, key);
  if (key !== 'a' && !config) return show('Сервис больше не подключён.');
  if (!Object.hasOwn(labels, filter) || !Number.isSafeInteger(Number(page)) || Number(page) < 0) return;
  const result = await managerUserAccess({ ...env, SUPPORT_DB: db }, 'list',
    { botId: config?.id, filter, page: Number(page) });
  const rows = result.rows.map(profile => profileButton(env, profile)).filter(Boolean);
  const nav = [];
  if (result.page) nav.push(button('←', `mu:list:${key}:${filter}:${result.page - 1}`));
  if (result.page + 1 < result.pages) nav.push(button('→', `mu:list:${key}:${filter}:${result.page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button('Фильтры', `mu:home:${key}`)]);
  return show(`${labels[filter]} · ${config ? opaqueManagerText(config.displayName) : 'все сервисы'}\nНайдено профилей: ${result.count} · страница ${result.page + 1}/${result.pages}`
    + (key === 'a' ? '\nОдин пользователь может иметь профиль в нескольких сервисах.' : '') + '\n\n'
    + (result.rows.length ? result.rows.map(profile => {
      const service = registry(env).find(item => item.id === profile.bot_id)?.displayName || profile.bot_id;
      const conversation = profile.conversation_status === 'closed' ? 'закрыто'
        : profile.conversation_status === 'open' ? 'открыто' : 'нет темы';
      const displayName = name(profile);
      const username = !profile.username ? 'без username · '
        : displayName !== `@${profile.username}` ? `@${profile.username} · ` : '';
      return `${opaqueManagerText(displayName)} · ${opaqueManagerText(service)} · ${profile.user_id}`
        + `\n  ${username}${status(profile)} · обращение: ${conversation}`;
    }).join('\n')
      : 'Пользователей нет.'), rows);
}

export async function showManagerUserSearch(env, db, actorId, query, show) {
  const value = String(query || '').trim();
  if (value.length < 2) {
    await run(db, `INSERT INTO manager_search_flows(operator_id,expires_at) VALUES(?,?)
      ON CONFLICT(operator_id) DO UPDATE SET expires_at=excluded.expires_at`,
    actorId, new Date(Date.now() + 10 * 60_000).toISOString());
    return show('Поиск профиля\n\nОтправьте следующим обычным сообщением Telegram ID, @username или часть имени (от 2 символов). Команду перед запросом писать не нужно. Для отмены нажмите кнопку или отправьте /cancel.',
      [[button('Отмена', 'mu:searchcancel')]]);
  }
  await run(db, 'DELETE FROM manager_search_flows WHERE operator_id=?', actorId);
  const profiles = await managerUserAccess({ ...env, SUPPORT_DB: db }, 'search', { query: value });
  const rows = profiles.map(profile => profileButton(env, profile)).filter(Boolean);
  rows.push([button('🔎 Новый поиск', 'mu:search'), button('Пользователи', 'mu:home:a')]);
  return show(profiles.length
    ? `Поиск: ${opaqueManagerText(value.slice(0, 100))}\nНайдено профилей: ${profiles.length}${profiles.length === 20 ? '+' : ''}. Выберите пользователя и сервис.`
      + (profiles.length === 20 ? '\nПоказаны первые 20. Уточните поиск по ID или username.' : '')
    : `Поиск: ${opaqueManagerText(value.slice(0, 100))}\nПрофиль не найден.`, rows);
}

export async function handleManagerUserSearchText(env, db, actorId, text, show) {
  const pending = await first(db, 'SELECT 1 AS active FROM manager_search_flows WHERE operator_id=? AND expires_at>?',
    actorId, now());
  if (!pending) return false;
  const query = String(text || '').trim();
  if (query.length < 2 || query.length > 100) {
    await show('Введите от 2 до 100 символов: Telegram ID, @username или часть имени.',
      [[button('Отмена', 'mu:searchcancel')]]);
    return true;
  }
  await showManagerUserSearch(env, db, actorId, query, show);
  return true;
}

export async function showManagerUserCard(env, db, actorId, key, userId, show, prefix = '') {
  const config = configFor(env, key), id = Number(userId);
  if (!config || !Number.isSafeInteger(id) || id <= 0) return show('Карточка устарела. Откройте список заново.');
  const profile = await managerUserAccess({ ...env, SUPPORT_DB: db }, 'profile', { botId: config.id, userId: id });
  if (!profile) return show('Профиль больше не найден.');
  const stateKey = await managerUserAccess(env, 'stateKey', { profile });
  const action = code => `mu:act:${code}:${key}:${id}:${stateKey}`;
  const rows = [];
  if (Number(profile.thread_id) > 1) {
    const groupId = Number(profile.support_group_id) || await resolveActiveGroup(db, config.id, env);
    if (groupId) rows.push([{ text: 'Перейти в тему', url: `https://t.me/c/${String(groupId).replace(/^-100/, '')}/${profile.thread_id}` }]);
    if (config.enabled) rows.push([button('Работа с обращением', `mg:work:${key}:${id}`)]);
  }
  if (config.enabled) {
    rows.push([button(profile.manual_trust ? 'Снять доверие' : 'Доверять', action(profile.manual_trust ? 'untrust' : 'trust')),
    button(active(profile.manual_restricted_until) ? 'Снять ограничение' : 'Ограничить',
      active(profile.manual_restricted_until) ? action('unrestrict') : `mu:restrict:${key}:${id}:${stateKey}`)]);
    rows.push([button(profile.banned_at ? 'Разблокировать' : 'Заблокировать', action(profile.banned_at ? 'unban' : 'ban')),
    button('Сбросить риск и CAPTCHA', action('riskreset'))]);
  }
  rows.push([button('История', `mu:audit:${key}:${id}:0`), button('Обновить', `mu:card:${key}:${id}`)]);
  rows.push([button('Пользователи', `mu:home:${key}`)]);
  const text = `${prefix}${opaqueManagerText(name(profile))} · ${opaqueManagerText(config.displayName)}${config.enabled ? '' : ' · сервис приостановлен (только просмотр)'}\nTelegram ID: ${id}\n`
    + `Username: ${profile.username ? opaqueManagerText('@' + profile.username) : '—'}\nСостояние: ${status(profile)}\n`
    + `Последняя активность: ${profile.activity_at || 'нет данных'}\n`
    + `Обращение: ${profile.conversation_status === 'closed' ? 'закрыто' : profile.conversation_status === 'open' ? 'открыто' : 'тема ещё не создана'}\n`
    + `Риск сейчас: ${profile.risk_score} · CAPTCHA: ${profile.verification_required ? 'ожидает' : 'нет'}\n`
    + `Доступ к переписке:\n${[
      ...(profile.banned_at ? ['• Блокировка оператором'] : []),
      ...(active(profile.manual_restricted_until) ? [`• Ручное ограничение до ${profile.manual_restricted_until}`] : []),
      ...(active(profile.muted_until) ? [`• Автоограничение до ${profile.muted_until}`] : []),
      ...(profile.verification_required ? ['• Требуется CAPTCHA'] : []),
    ].join('\n') || 'Действующих блокировок и CAPTCHA нет.'}\n`
    + `Доверие: ${profile.manual_trust ? 'ручное' : active(profile.trusted_until) ? `до ${profile.trusted_until}` : 'нет'}\n`
    + `Ожидающих сообщений: ${profile.pending_count || 0} · ожидающих возобновления: ${profile.reopen_count || 0}`;
  return show(text + (Number(profile.thread_id) > 1 ? '\n\n' + messageDeletionWarning('ru') : ''), rows);
}

function validReason(text) {
  const value = String(text || '').trim();
  return value.length >= 3 && value.length <= 500 && !/\b\d{5,20}:[A-Za-z0-9_-]{20,150}\b/.test(value) ? value : null;
}
function duration(text) {
  const match = /^(\d{1,5})([mhd])$/.exec(String(text || '').trim().toLowerCase());
  if (!match) return null;
  const value = Number(match[1]) * { m: 60, h: 3600, d: 86400 }[match[2]];
  return value >= 300 && value <= 30 * 86400 ? value : null;
}
async function flow(db, actorId) {
  return first(db, "SELECT * FROM operator_pending_actions WHERE operator_id=? AND management_bot_id='__manager__' AND chat_id=? AND expires_at>?",
    actorId, actorId, now());
}
async function saveFlow(db, actor, config, userId, action, stateKey, stage, extra = {}) {
  const nonce = crypto.randomUUID();
  await run(db, `INSERT INTO operator_pending_actions
    (operator_id,operator_name,management_bot_id,target_bot_id,user_id,action,stage,duration_seconds,reason,chat_id,thread_id,flow_nonce,expected_state_key,created_at,expires_at)
    VALUES(?,?,'__manager__',?,?,?,?,?,?,?,NULL,?,?,?,?)
    ON CONFLICT(operator_id) DO UPDATE SET operator_name=excluded.operator_name,management_bot_id=excluded.management_bot_id,
      target_bot_id=excluded.target_bot_id,user_id=excluded.user_id,action=excluded.action,stage=excluded.stage,
      duration_seconds=excluded.duration_seconds,reason=excluded.reason,chat_id=excluded.chat_id,thread_id=NULL,
      flow_nonce=excluded.flow_nonce,expected_state_key=excluded.expected_state_key,created_at=excluded.created_at,
      expires_at=excluded.expires_at,suspended=0`, actor.id, actor.first_name || String(actor.id), config.id,
  userId, action, stage, extra.durationSeconds || null, extra.reason || null, actor.id, nonce, stateKey,
  now(), new Date(Date.now() + 30 * 60_000).toISOString());
  return nonce;
}
async function confirmFlow(db, actorId, pending, show) {
  const warning = pending.action === 'ban' || pending.action === 'restrict'
    ? '\n\nНедоставленные сообщения будут удалены из очереди и их потребуется отправить заново.'
    : pending.action === 'trust'
      ? '\n\nРучное доверие снимет автомьют и CAPTCHA; ожидающие сообщения могут быть доставлены.'
      : pending.action === 'riskreset'
        ? '\n\nРиск станет 0, автомьют и CAPTCHA будут сняты; ожидающие сообщения могут быть доставлены.' : '';
  const label = { ban: 'Заблокировать', unban: 'Разблокировать', restrict: 'Ограничить',
    unrestrict: 'Снять ограничение', trust: 'Доверять', untrust: 'Снять доверие',
    riskreset: 'Сбросить риск и CAPTCHA' }[pending.action] || pending.action;
  return show(`Подтвердите действие: ${label}\nСервис: ${pending.target_bot_id}\nTelegram ID: ${pending.user_id}`
    + (pending.duration_seconds ? `\nСрок: ${pending.duration_seconds / 60} мин` : '')
    + (pending.reason ? `\nПричина: ${opaqueManagerText(pending.reason)}` : '') + warning,
  [[button('Подтвердить', `mu:confirm:${pending.flow_nonce}`)],
    ...(['ban', 'restrict'].includes(pending.action) ? [[button('Изменить', `mu:revise:${pending.flow_nonce}`)]] : []),
    [button('Отмена', `mu:cancel:${pending.flow_nonce}`)]]);
}

export async function handleManagerUserText(env, db, actor, text, show) {
  const pending = await flow(db, actor.id);
  if (!pending || pending.suspended || !['reason', 'duration'].includes(pending.stage)) return false;
  const value = pending.stage === 'reason' ? validReason(text) : duration(text);
  if (!value) {
    await show(pending.stage === 'reason' ? 'Укажите внутреннюю причину от 3 до 500 символов без токенов.'
      : 'Укажите срок от 5 минут до 30 дней: например 45m, 6h, 7d.',
    [[button('Отмена', `mu:cancel:${pending.flow_nonce}`)]]);
    return true;
  }
  if (pending.stage === 'duration') {
    await run(db, "UPDATE operator_pending_actions SET duration_seconds=?,stage='reason' WHERE operator_id=? AND flow_nonce=? AND stage='duration'",
      value, actor.id, pending.flow_nonce);
    await show('Укажите внутреннюю причину ограничения (3–500 символов).',
      [[button('Отмена', `mu:cancel:${pending.flow_nonce}`)]]);
  } else {
    await run(db, "UPDATE operator_pending_actions SET reason=?,stage='confirm' WHERE operator_id=? AND flow_nonce=? AND stage='reason'",
      value, actor.id, pending.flow_nonce);
    await confirmFlow(db, actor.id, await flow(db, actor.id), show);
  }
  return true;
}

export async function handleManagerUserAction(env, db, actor, data, show) {
  const parts = String(data || '').split(':'), action = parts[1];
  if (parts[0] !== 'mu') return false;
  if (action === 'home') {
    await run(db, 'DELETE FROM manager_search_flows WHERE operator_id=?', actor.id);
    return showManagerUserHome(env, db, actor.id, show, parts[2] || 'a');
  }
  if (action === 'list') return showManagerUserList(env, db, actor.id, parts[2], parts[3], parts[4], show);
  if (action === 'search') return showManagerUserSearch(env, db, actor.id, '', show);
  if (action === 'searchcancel') {
    await run(db, 'DELETE FROM manager_search_flows WHERE operator_id=?', actor.id);
    return showManagerUserHome(env, db, actor.id, show);
  }
  if (action === 'card') return showManagerUserCard(env, db, actor.id, parts[2], parts[3], show);
  if (action === 'audit') return showManagerAudit(env, db,
    { key: parts[2], userId: parts[3], page: parts[4], details: parts[5] === 'd' }, show);
  if (action === 'resume') {
    const pending = await flow(db, actor.id);
    if (!pending) return show('Незавершённого действия нет.', [[button('Пользователи', 'mu:home:a')]]);
    await run(db, "UPDATE operator_pending_actions SET suspended=0 WHERE operator_id=? AND management_bot_id='__manager__' AND flow_nonce=?", actor.id, pending.flow_nonce);
    if (pending.stage === 'duration') return show('Продолжите ограничение: укажите срок от 5 минут до 30 дней, например 45m, 6h, 7d.',
      [[button('Отмена', `mu:cancel:${pending.flow_nonce}`)]]);
    if (pending.stage === 'reason') return show('Продолжите действие: укажите внутреннюю причину от 3 до 500 символов.',
      [[button('Отмена', `mu:cancel:${pending.flow_nonce}`)]]);
    if (pending.stage === 'confirm') return confirmFlow(db, actor.id, pending, show);
    return show('Действие выполняется. Проверьте карточку пользователя.',
      [[button('Пользователи', 'mu:home:a')]]);
  }
  if (action === 'cancel') {
    const pending = await flow(db, actor.id);
    if (pending?.flow_nonce === parts[2]) await run(db,
      "DELETE FROM operator_pending_actions WHERE operator_id=? AND management_bot_id='__manager__' AND flow_nonce=?", actor.id, parts[2]);
    return show('Действие отменено.', [[button('Пользователи', 'mu:home:a')]]);
  }
  if (action === 'revise') {
    const pending = await flow(db, actor.id);
    if (!pending || pending.suspended || pending.flow_nonce !== parts[2] || pending.stage !== 'confirm'
      || !['ban', 'restrict'].includes(pending.action)) return show('Форма устарела. Откройте карточку заново.');
    const stage = pending.action === 'ban' ? 'reason' : 'duration';
    await run(db, "UPDATE operator_pending_actions SET stage=?,expires_at=? WHERE operator_id=? AND management_bot_id='__manager__' AND flow_nonce=? AND stage='confirm' AND suspended=0",
      stage, new Date(Date.now() + 30 * 60_000).toISOString(), actor.id, pending.flow_nonce);
    return show(stage === 'reason' ? 'Укажите новую внутреннюю причину от 3 до 500 символов.'
      : 'Укажите новый срок от 5 минут до 30 дней: 45m, 6h или 7d.',
    [[button('Отмена', `mu:cancel:${pending.flow_nonce}`)]]);
  }
  if (action === 'confirm') {
    const pending = await flow(db, actor.id);
    if (!pending || pending.suspended || pending.flow_nonce !== parts[2] || pending.stage !== 'confirm')
      return show('Подтверждение устарело. Откройте карточку заново.');
    const config = registry(env).find(item => item.id === pending.target_bot_id && item.enabled);
    if (!config) return show('Сервис больше не подключён.');
    const claimed = await run(db, "UPDATE operator_pending_actions SET stage='executing' WHERE operator_id=? AND flow_nonce=? AND stage='confirm' AND suspended=0 AND management_bot_id='__manager__'",
      actor.id, pending.flow_nonce);
    if (!(claimed.meta?.changes > 0)) return show('Действие уже выполняется. Обновите карточку.');
    try {
      const groupId = await resolveActiveGroup(db, config.id, env);
      const result = await managerUserAccess({ ...env, SUPPORT_DB: db,
        ...(groupId ? { SUPPORT_GROUP_ID: String(groupId) } : {}) }, 'apply', {
        botId: config.id, actor, action: pending.action, userId: Number(pending.user_id),
        options: { reason: pending.reason, durationMs: Number(pending.duration_seconds) * 1000,
          expectedStateKey: pending.expected_state_key },
      });
      await run(db, "DELETE FROM operator_pending_actions WHERE operator_id=? AND management_bot_id='__manager__' AND flow_nonce=?",
        actor.id, pending.flow_nonce);
      const key = managementBotKey(registry(env), config.id);
      return showManagerUserCard(env, db, actor.id, key, pending.user_id, show, `${result.text}\n\n`);
    } catch (error) {
      await run(db, "UPDATE operator_pending_actions SET stage='confirm' WHERE operator_id=? AND management_bot_id='__manager__' AND flow_nonce=? AND stage='executing'",
        actor.id, pending.flow_nonce);
      throw error;
    }
  }
  if (action === 'restrict' || action === 'period') {
    const period = action === 'period' ? parts[2] : null;
    const key = parts[action === 'period' ? 3 : 2];
    const userId = Number(parts[action === 'period' ? 4 : 3]);
    const stateKey = parts[action === 'period' ? 5 : 4];
    const config = configFor(env, key, true);
    if (!config || !Number.isSafeInteger(userId) || userId <= 0) return show('Карточка устарела.');
    const profile = await managerUserAccess({ ...env, SUPPORT_DB: db }, 'profile', { botId: config.id, userId });
    if (!profile || await managerUserAccess(env, 'stateKey', { profile }) !== stateKey)
      return showManagerUserCard(env, db, actor.id, key, userId, show, 'Карточка изменилась.\n\n');
    if (action === 'restrict') return show('На какой срок ограничить доступ к переписке?',
      [[button('15 минут', `mu:period:15m:${key}:${userId}:${stateKey}`),
        button('1 час', `mu:period:1h:${key}:${userId}:${stateKey}`)],
      [button('24 часа', `mu:period:24h:${key}:${userId}:${stateKey}`),
        button('Другой срок', `mu:period:custom:${key}:${userId}:${stateKey}`)],
      [button('К карточке', `mu:card:${key}:${userId}`)]]);
    const seconds = { '15m': 900, '1h': 3600, '24h': 86400 }[period];
    if (!seconds && period !== 'custom') return show('Срок устарел. Откройте карточку заново.');
    const nonce = await saveFlow(db, actor, config, userId, 'restrict', stateKey,
      seconds ? 'reason' : 'duration', { durationSeconds: seconds });
    return show(seconds ? `Срок: ${period}. Укажите внутреннюю причину ограничения (3–500 символов).`
      : 'Укажите срок ограничения от 5 минут до 30 дней: 45m, 6h, 7d.',
    [[button('Отмена', `mu:cancel:${nonce}`)]]);
  }
  if (action !== 'act' || !operations.has(parts[2])) return false;
  const code = parts[2], config = configFor(env, parts[3], true), userId = Number(parts[4]);
  if (!config || !Number.isSafeInteger(userId) || userId <= 0) return show('Карточка устарела.');
  const profile = await managerUserAccess({ ...env, SUPPORT_DB: db }, 'profile', { botId: config.id, userId });
  if (!profile || await managerUserAccess(env, 'stateKey', { profile }) !== parts[5])
    return showManagerUserCard(env, db, actor.id, parts[3], userId, show, 'Карточка изменилась.\n\n');
  const nonce = await saveFlow(db, actor, config, userId, code, parts[5],
    code === 'ban' ? 'reason' : code === 'restrict' ? 'duration' : 'confirm');
  if (code === 'ban') return show('Укажите внутреннюю причину блокировки (3–500 символов). Клиент её не получит.',
    [[button('Отмена', `mu:cancel:${nonce}`)]]);
  if (code === 'restrict') return show('Укажите срок ограничения от 5 минут до 30 дней: 45m, 6h, 7d.',
    [[button('Отмена', `mu:cancel:${nonce}`)]]);
  return confirmFlow(db, actor.id, await flow(db, actor.id), show);
}
