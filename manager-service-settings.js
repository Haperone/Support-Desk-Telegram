import { managementBotFromKey, managementBotKey, parseBotRegistry } from './worker.js';
import { createReactionChecks, reactionDirection, reactionSummary } from './reaction-checks.js';
import { reactionUpdates } from './telegram-updates.js';
import { webhookUrl } from './bot-registry.js';
import { requestTelegram } from './telegram-response.js';
import { resolveActiveGroup } from './service-groups.js';
import { readCloudflarePlan } from './cloudflare-plan.js';
import { LANGUAGES, languageOrDefault, supportedLanguage } from './language.js';
import { getManagerLanguage, opaqueManagerText, translateManager } from './manager-language.js';

const now = () => new Date().toISOString();
const first = (db, sql, ...values) => db.prepare(sql).bind(...values).first();
const run = (db, sql, ...values) => db.prepare(sql).bind(...values).run();
const button = (text, data) => ({ text, callback_data: data });
const fieldOf = value => value === 'w' ? 'welcome_text' : value === 'a' ? 'auto_reply_text' : null;
const fieldLabel = value => value === 'w' ? 'Приветствие' : 'Автоответ на обращение';
const colors = [[7322096, '🔵 Голубой'], [16766590, '🟡 Жёлтый'], [13338331, '🟣 Фиолетовый'],
  [9367192, '🟢 Зелёный'], [16749490, '🩷 Розовый'], [16478047, '🔴 Красный']];

function service(env, key, requireEnabled = true) {
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const config = managementBotFromKey(registry, key);
  return config && (!requireEnabled || config.enabled) && managementBotKey(registry, config.id) === key ? config : null;
}

async function audit(db, config, actorId, action) {
  await run(db, `INSERT INTO operator_audit(bot_id,actor_type,operator_id,operator_name,action,result,created_at)
    VALUES(?,'operator',?,?,?,'success',?)`, config.id, actorId, String(actorId), action, now());
}

export async function showManagerServiceSettings(env, db, config, key, show) {
  const [messages, reactions, style, attack] = await Promise.all([
    first(db, `SELECT s.welcome_text,s.auto_reply_text,p.welcome_enabled,p.auto_reply_enabled,
      p.welcome_reviewed,p.auto_reply_reviewed
      FROM (SELECT ? AS bot_id) b LEFT JOIN bot_message_settings s USING(bot_id)
      LEFT JOIN bot_message_preferences p USING(bot_id)`, config.id),
    first(db, 'SELECT * FROM reaction_settings WHERE bot_id=?', config.id),
    first(db, 'SELECT icon_color,icon_emoji FROM topic_style_settings WHERE bot_id=?', config.id),
    first(db, 'SELECT manual_override,override_until,manual_controlled FROM service_attack_state WHERE bot_id=?', config.id),
  ]);
  const status = (field, enabled, reviewed) => messages?.[field] && enabled !== 0 ? 'включено'
    : messages?.[field] || reviewed ? 'выключено' : 'не настроено';
  return show(`Настройки · ${opaqueManagerText(config.displayName)}${config.enabled ? '' : ' · только просмотр'}\n\nЯзык: ${LANGUAGES[languageOrDefault(config.locale)].name}\nПриветствие: ${status('welcome_text', messages?.welcome_enabled, messages?.welcome_reviewed)}\n`
    + `Автоответ: ${status('auto_reply_text', messages?.auto_reply_enabled, messages?.auto_reply_reviewed)}\n`
    + `Реакции: ${reactions ? ['support_to_user', 'user_to_support'].filter(d => reactionDirection(reactions, d).enabled).length + '/2 включено' : 'ещё не проверены'}\n`
    + `Оформление новых тем: ${style?.icon_emoji || colors.find(([id]) => id === style?.icon_color)?.[1] || 'по умолчанию'}\n`
    + `Защита сервиса: ${(attack?.manual_override || (attack?.manual_controlled ? null : config.attackModeManualOverride) || 'auto').toUpperCase()}`,
  [[button('🌐 Сменить язык', `mg:language:${key}`)], [button('Приветствие и автоответ', `mg:msgs:${key}`)], [button('Реакции', `mg:rx:${key}`)],
    [button('Оформление тем', `mg:style:${key}`)], [button('Защита сервиса', `mg:attack:${key}`)],
    [button('К сервису', `mg:service:${key}`)]]);
}

async function showMessages(db, actorId, config, key, show, selected = null) {
  const settings = await first(db, `SELECT s.*,p.welcome_enabled,p.auto_reply_enabled FROM (SELECT ? AS bot_id) b
    LEFT JOIN bot_message_settings s USING(bot_id) LEFT JOIN bot_message_preferences p USING(bot_id)`, config.id);
  if (selected) {
    const field = fieldOf(selected), text = settings?.[field];
    const draft = config.enabled ? await first(db, 'SELECT draft FROM bot_message_drafts WHERE owner_id=? AND bot_id=? AND field=?', actorId, config.id, field) : null;
    return show(`${opaqueManagerText(config.displayName)} · ${fieldLabel(selected)}\n\n${text ? opaqueManagerText(text) : 'Текст пока не задан.'}\n\n`
      + `Отправка: ${text && settings?.[selected === 'w' ? 'welcome_enabled' : 'auto_reply_enabled'] !== 0 ? 'включена' : 'выключена'}`,
    [...(config.enabled ? [[button('Изменить текст', `mg:msg:${key}:${selected}:edit`)]] : []),
      ...(draft ? [[button('Продолжить черновик', `mg:msg:${key}:${selected}:restore`)]] : []),
      ...(config.enabled ? [[button('Включить', `mg:msg:${key}:${selected}:on`), button('Выключить', `mg:msg:${key}:${selected}:off`)],
        [button('Очистить текст', `mg:msg:${key}:${selected}:clear`)]] : []), [button('Назад', `mg:msgs:${key}`)]]);
  }
  return show(`${opaqueManagerText(config.displayName)} · сообщения${config.enabled ? '' : ' · только просмотр'}\n\nТексты и переключатели сохранены отдельно для этого бота.`,
    [[button('Приветствие на /start', `mg:msg:${key}:w:view`)],
      [button('Автоответ на обращение', `mg:msg:${key}:a:view`)],
      ...(config.enabled ? [[button('Скопировать с другого бота', `mg:copymsg:${key}`)]] : []),
      [button('Настройки сервиса', `mg:settings:${key}`)]]);
}

async function messageCopyState(db, botId) {
  return first(db, `SELECT s.welcome_text,s.auto_reply_text,s.revision,
    COALESCE(p.welcome_enabled,1) welcome_enabled,COALESCE(p.auto_reply_enabled,1) auto_reply_enabled,
    COALESCE(p.welcome_reviewed,0) welcome_reviewed,COALESCE(p.auto_reply_reviewed,0) auto_reply_reviewed
    FROM (SELECT ? bot_id) b LEFT JOIN bot_message_settings s USING(bot_id)
    LEFT JOIN bot_message_preferences p USING(bot_id)`, botId);
}

async function copyFingerprint(source, target) {
  const bytes = new TextEncoder().encode(JSON.stringify([source, target]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 8), value => value.toString(16).padStart(2, '0')).join('');
}

function copyPreview(text) {
  if (!text) return 'не задано';
  if (text.length <= 1200) return opaqueManagerText(text);
  return `${opaqueManagerText(text.slice(0, 1200))}… [показаны первые 1200 из ${text.length} символов]`;
}

async function chooseMessageSource(env, db, config, key, show) {
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const configured = (await db.prepare(`SELECT bot_id,welcome_text,auto_reply_text FROM bot_message_settings
    WHERE welcome_text<>'' OR auto_reply_text<>'' ORDER BY bot_id LIMIT 100`).all()).results || [];
  const candidates = configured.map(row => registry.find(item => item.id === row.bot_id))
    .filter(item => item && item.id !== config.id);
  return show(`Скопировать сообщения для ${opaqueManagerText(config.displayName)}\n\nВыберите бота-источник. Скопируются оба текста и состояние их отправки. Текущие настройки ${opaqueManagerText(config.displayName)} будут заменены после подтверждения.`,
    [...candidates.map(item => [button(`${item.enabled ? '' : '⏸ '}${opaqueManagerText(item.displayName)}`,
      `mg:copypreview:${key}:${managementBotKey(registry, item.id)}`)]),
      [button('Назад к сообщениям', `mg:msgs:${key}`)]]);
}

async function previewMessageCopy(env, db, config, key, sourceKey, show) {
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const sourceConfig = service(env, sourceKey, false);
  if (!sourceConfig || sourceConfig.id === config.id)
    return show('Бот-источник больше не доступен. Выберите другого.', [[button('Выбрать бота', `mg:copymsg:${key}`)]]);
  const [source, target] = await Promise.all([
    messageCopyState(db, sourceConfig.id), messageCopyState(db, config.id),
  ]);
  if (!source?.revision || !source.welcome_text && !source.auto_reply_text)
    return show('У выбранного бота сообщения больше не настроены.', [[button('Выбрать бота', `mg:copymsg:${key}`)]]);
  const fingerprint = await copyFingerprint(source, target);
  const state = (text, enabled) => text && enabled ? 'включена' : 'выключена';
  return show(`Копирование: ${opaqueManagerText(sourceConfig.displayName)} → ${opaqueManagerText(config.displayName)}\n\n`
    + `Приветствие (${state(source.welcome_text, source.welcome_enabled)}):\n${copyPreview(source.welcome_text)}\n\n`
    + `Подтверждение обращения (${state(source.auto_reply_text, source.auto_reply_enabled)}):\n${copyPreview(source.auto_reply_text)}\n\n`
    + `После подтверждения оба текста и переключателя у ${opaqueManagerText(config.displayName)} будут заменены. У ${opaqueManagerText(sourceConfig.displayName)} ничего не изменится.`,
  [[button('Применить оба сообщения', `mg:copyapply:${key}:${sourceKey}:${fingerprint}`)],
    [button('Выбрать другого бота', `mg:copymsg:${key}`)], [button('Отмена', `mg:msgs:${key}`)]]);
}

async function applyMessageCopy(env, db, actorId, config, key, sourceKey, expected, show) {
  const sourceConfig = service(env, sourceKey, false);
  if (!sourceConfig || sourceConfig.id === config.id || !/^[0-9a-f]{16}$/.test(expected))
    return show('Подтверждение устарело. Откройте копирование заново.', [[button('Сообщения', `mg:msgs:${key}`)]]);
  const [source, target] = await Promise.all([
    messageCopyState(db, sourceConfig.id), messageCopyState(db, config.id),
  ]);
  if (!source?.revision || !source.welcome_text && !source.auto_reply_text
    || await copyFingerprint(source, target) !== expected)
    return show('Настройки одного из ботов изменились. Проверьте тексты ещё раз перед копированием.',
      [[button('Проверить тексты', `mg:copypreview:${key}:${sourceKey}`)]]);
  const revision = crypto.randomUUID(), stamp = now();
  const result = await db.batch([
    db.prepare(`INSERT INTO bot_message_settings(bot_id,welcome_text,auto_reply_text,revision,updated_by,updated_at)
      SELECT ?,s.welcome_text,s.auto_reply_text,?,?,? FROM bot_message_settings s
      LEFT JOIN bot_message_preferences p ON p.bot_id=s.bot_id
      WHERE s.bot_id=? AND s.revision=?
        AND COALESCE(p.welcome_enabled,1)=? AND COALESCE(p.auto_reply_enabled,1)=?
        AND COALESCE(p.welcome_reviewed,0)=? AND COALESCE(p.auto_reply_reviewed,0)=?
        AND COALESCE((SELECT revision FROM bot_message_settings WHERE bot_id=?),'')=?
        AND COALESCE((SELECT welcome_enabled FROM bot_message_preferences WHERE bot_id=?),1)=?
        AND COALESCE((SELECT auto_reply_enabled FROM bot_message_preferences WHERE bot_id=?),1)=?
        AND COALESCE((SELECT welcome_reviewed FROM bot_message_preferences WHERE bot_id=?),0)=?
        AND COALESCE((SELECT auto_reply_reviewed FROM bot_message_preferences WHERE bot_id=?),0)=?
      ON CONFLICT(bot_id) DO UPDATE SET welcome_text=excluded.welcome_text,
        auto_reply_text=excluded.auto_reply_text,revision=excluded.revision,
        updated_by=excluded.updated_by,updated_at=excluded.updated_at
        WHERE bot_message_settings.revision=?`)
      .bind(config.id, revision, actorId, stamp, sourceConfig.id, source.revision,
        source.welcome_enabled, source.auto_reply_enabled, source.welcome_reviewed, source.auto_reply_reviewed,
        config.id, target?.revision || '', config.id, target?.welcome_enabled ?? 1,
        config.id, target?.auto_reply_enabled ?? 1, config.id, target?.welcome_reviewed ?? 0,
        config.id, target?.auto_reply_reviewed ?? 0, target?.revision || ''),
    db.prepare(`INSERT INTO bot_message_preferences(bot_id,welcome_enabled,auto_reply_enabled,welcome_reviewed,auto_reply_reviewed)
      SELECT ?,?,?,?,? WHERE (SELECT revision FROM bot_message_settings WHERE bot_id=?)=?
      ON CONFLICT(bot_id) DO UPDATE SET welcome_enabled=excluded.welcome_enabled,
        auto_reply_enabled=excluded.auto_reply_enabled,welcome_reviewed=excluded.welcome_reviewed,
        auto_reply_reviewed=excluded.auto_reply_reviewed`)
      .bind(config.id, source.welcome_enabled, source.auto_reply_enabled,
        source.welcome_reviewed, source.auto_reply_reviewed, config.id, revision),
    db.prepare(`INSERT INTO operator_audit(bot_id,actor_type,operator_id,operator_name,action,reason,result,created_at)
      SELECT ?,'operator',?,?,'bot_messages_copy',?,'success',?
      WHERE (SELECT revision FROM bot_message_settings WHERE bot_id=?)=?`)
      .bind(config.id, actorId, String(actorId), sourceConfig.id, stamp, config.id, revision),
  ]);
  if (result[0].meta?.changes !== 1)
    return show('Настройки изменились до сохранения. Проверьте тексты ещё раз.',
      [[button('Проверить тексты', `mg:copypreview:${key}:${sourceKey}`)]]);
  return show(`Сообщения ${opaqueManagerText(sourceConfig.displayName)} скопированы для ${opaqueManagerText(config.displayName)}. Приветствие и подтверждение теперь можно проверить в настройках сервиса.`,
    [[button('Открыть сообщения', `mg:msgs:${key}`)], [button('К сервису', `mg:service:${key}`)]]);
}

async function beginMessageEdit(db, actorId, config, key, fieldCode, clear, show, restore = false) {
  const current = await first(db, 'SELECT revision FROM bot_message_settings WHERE bot_id=?', config.id);
  const draft = restore ? await first(db, 'SELECT draft,expected_revision FROM bot_message_drafts WHERE owner_id=? AND bot_id=? AND field=?', actorId, config.id, fieldOf(fieldCode)) : null;
  if (restore && !draft) return show('Черновик больше не найден.');
  if (restore && draft.expected_revision !== (current?.revision || ''))
    return show('После создания черновика текст бота изменился. Откройте текущий текст и создайте новый черновик.');
  await cancelManagerMessageFlow(db, actorId);
  const nonce = crypto.randomUUID();
  await run(db, `INSERT INTO bot_message_flows(owner_id,bot_id,field,stage,draft,expected_revision,nonce,chat_id,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET bot_id=excluded.bot_id,field=excluded.field,
      stage=excluded.stage,draft=excluded.draft,expected_revision=excluded.expected_revision,nonce=excluded.nonce,
      chat_id=excluded.chat_id,expires_at=excluded.expires_at,suspended=0`,
  actorId, config.id, fieldOf(fieldCode), clear || restore ? 'confirm' : 'text', draft?.draft || '', current?.revision || '', nonce,
  actorId, new Date(Date.now() + 30 * 60_000).toISOString());
  return restore ? show(`Проверьте черновик «${fieldLabel(fieldCode)}» для ${opaqueManagerText(config.displayName)}:\n\n${opaqueManagerText(draft.draft)}`,
    [[button('Сохранить', `mg:msgsave:${nonce}`)], [button('Изменить', `mg:msgrevise:${nonce}`)],
      [button('Отмена', `mg:msgcancel:${nonce}`)]])
    : clear ? show(`Очистить текст «${fieldLabel(fieldCode)}» для ${opaqueManagerText(config.displayName)} и выключить отправку?`,
    [[button('Да, очистить', `mg:msgsave:${nonce}`)], [button('Отмена', `mg:msgcancel:${nonce}`)]])
    : show(`Отправьте новый текст «${fieldLabel(fieldCode)}» для ${opaqueManagerText(config.displayName)} одним сообщением (до 3500 символов).\n`
      + 'После этого проверьте текст перед сохранением.', [[button('Отмена', `mg:msgcancel:${nonce}`)]]);
}

export async function handleManagerMessageText(env, db, actorId, text, show) {
  const flow = await first(db, `SELECT * FROM bot_message_flows WHERE owner_id=? AND chat_id=?
    AND stage='text' AND suspended=0 AND expires_at>?`, actorId, actorId, now());
  if (!flow) return false;
  const value = String(text || '').trim();
  if (!value || value.length > 3500 || /\b\d{5,20}:[A-Za-z0-9_-]{20,150}\b/.test(value)) {
    await show('Нужен текст от 1 до 3500 символов без токенов ботов.'); return true;
  }
  await run(db, `UPDATE bot_message_flows SET draft=?,stage='confirm' WHERE owner_id=? AND nonce=?
    AND stage='text' AND expires_at>?`, value, actorId, flow.nonce, now());
  await show(`Проверьте текст для ${fieldLabel(flow.field === 'welcome_text' ? 'w' : 'a')}:\n\n${value}`,
    [[button('Сохранить', `mg:msgsave:${flow.nonce}`)], [button('Изменить', `mg:msgrevise:${flow.nonce}`)],
      [button('Отмена', `mg:msgcancel:${flow.nonce}`)]]);
  return true;
}

async function reviseMessageFlow(db, actorId, nonce, show) {
  const flow = await first(db, `SELECT field FROM bot_message_flows WHERE owner_id=? AND nonce=? AND chat_id=?
    AND stage='confirm' AND suspended=0 AND expires_at>?`, actorId, nonce, actorId, now());
  if (!flow) return show('Эта форма устарела. Откройте настройки сервиса заново.');
  await run(db, "UPDATE bot_message_flows SET stage='text',expires_at=? WHERE owner_id=? AND nonce=? AND stage='confirm' AND suspended=0",
    new Date(Date.now() + 30 * 60_000).toISOString(), actorId, nonce);
  return show(`Отправьте новый текст «${fieldLabel(flow.field === 'welcome_text' ? 'w' : 'a')}» одним сообщением (до 3500 символов).`,
    [[button('Отмена', `mg:msgcancel:${nonce}`)]]);
}

async function completeMessageFlow(db, actorId, nonce, save, env, show) {
  const flow = await first(db, `SELECT * FROM bot_message_flows WHERE owner_id=? AND nonce=? AND chat_id=?
    AND expires_at>?`, actorId, nonce, actorId, now());
  if (!flow) return show('Эта форма устарела. Откройте настройки сервиса заново.');
  const config = parseBotRegistry(env.BOT_REGISTRY).find(item => item.id === flow.bot_id && item.enabled);
  if (!config) return show('Бот больше не подключён.');
  const key = managementBotKey(parseBotRegistry(env.BOT_REGISTRY), config.id);
  if (!save) {
    if (flow.draft) await run(db, `INSERT INTO bot_message_drafts(owner_id,bot_id,field,draft,expected_revision,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,bot_id,field) DO UPDATE SET draft=excluded.draft,
        expected_revision=excluded.expected_revision,updated_at=excluded.updated_at`, actorId, config.id,
    flow.field, flow.draft, flow.expected_revision, now());
    await run(db, 'DELETE FROM bot_message_flows WHERE owner_id=? AND nonce=?', actorId, nonce);
    return showMessages(db, actorId, config, key, show, flow.field === 'welcome_text' ? 'w' : 'a');
  }
  if (flow.suspended) return show('Эта форма приостановлена. Откройте её через «Черновики».');
  if (flow.stage !== 'confirm') return show('Сначала отправьте текст.');
  const current = await first(db, 'SELECT * FROM bot_message_settings WHERE bot_id=?', config.id);
  if ((current?.revision || '') !== flow.expected_revision) return show('Текст уже менялся. Откройте настройки заново.');
  const welcome = flow.field === 'welcome_text' ? flow.draft : current?.welcome_text || '';
  const auto = flow.field === 'auto_reply_text' ? flow.draft : current?.auto_reply_text || '';
  const saved = await run(db, `INSERT INTO bot_message_settings(bot_id,welcome_text,auto_reply_text,revision,updated_by,updated_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM bot_message_flows WHERE owner_id=? AND nonce=? AND stage='confirm' AND suspended=0 AND expires_at>?)
    ON CONFLICT(bot_id) DO UPDATE SET welcome_text=excluded.welcome_text,auto_reply_text=excluded.auto_reply_text,
      revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at
      WHERE bot_message_settings.revision=?`, config.id, welcome, auto, nonce, actorId, now(), actorId, nonce, now(), flow.expected_revision);
  if (saved.meta?.changes !== 1) return show('Текст уже менялся. Откройте настройки заново.');
  if (!flow.draft) {
    const column = flow.field === 'welcome_text' ? 'welcome_enabled' : 'auto_reply_enabled';
    const reviewed = flow.field === 'welcome_text' ? 'welcome_reviewed' : 'auto_reply_reviewed';
    await run(db, `INSERT INTO bot_message_preferences(bot_id,${column},${reviewed}) VALUES(?,0,1)
      ON CONFLICT(bot_id) DO UPDATE SET ${column}=0,${reviewed}=1`, config.id);
  }
  await run(db, 'DELETE FROM bot_message_flows WHERE owner_id=? AND nonce=?', actorId, nonce);
  await run(db, 'DELETE FROM bot_message_drafts WHERE owner_id=? AND bot_id=? AND field=?', actorId, config.id, flow.field);
  await audit(db, config, actorId, `bot_message_${flow.field}`);
  return showMessages(db, actorId, config, key, show, flow.field === 'welcome_text' ? 'w' : 'a');
}

export async function cancelManagerMessageFlow(db, actorId) {
  const flow = await first(db, 'SELECT * FROM bot_message_flows WHERE owner_id=?', actorId);
  if (!flow) return;
  if (flow.draft) await run(db, `INSERT INTO bot_message_drafts(owner_id,bot_id,field,draft,expected_revision,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,bot_id,field) DO UPDATE SET draft=excluded.draft,
      expected_revision=excluded.expected_revision,updated_at=excluded.updated_at`, actorId, flow.bot_id,
  flow.field, flow.draft, flow.expected_revision, now());
  await run(db, 'DELETE FROM bot_message_flows WHERE owner_id=?', actorId);
}

async function webhook(env, config, enabled, fetchImpl) {
  const result = await requestTelegram({ token: env[config.tokenBinding], method: 'setWebhook', body: {
    url: webhookUrl(env, config.id), secret_token: env[config.webhookSecretBinding],
    allowed_updates: reactionUpdates(enabled), drop_pending_updates: false,
  }, fetchImpl, timeoutMs: 10000 });
  if (result.ok) return;
  if (result.deliveryUncertain) {
    const info = await requestTelegram({ token: env[config.tokenBinding], method: 'getWebhookInfo', body: {}, fetchImpl, timeoutMs: 10000 });
    const allowed = info.result?.allowed_updates || [];
    if (info.ok && info.result?.url === webhookUrl(env, config.id)
      && allowed.includes('message_reaction') === Boolean(enabled)) return;
  }
  throw new Error(`Reaction webhook update failed: ${result.description || 'unknown result'}`);
}

async function withReactionSettingsLock(db, task) {
  const token = crypto.randomUUID(), expires = new Date(Date.now() + 5 * 60_000).toISOString();
  const lock = await run(db, `INSERT INTO reaction_settings_lock(id,owner_token,lease_expires_at,created_at)
    VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_token=excluded.owner_token,
      lease_expires_at=excluded.lease_expires_at,created_at=excluded.created_at
      WHERE reaction_settings_lock.lease_expires_at<=?`, token, expires, now(), now());
  if (lock.meta?.changes !== 1) throw new Error('Настройка реакций занята. Повторите позже.');
  try { return await task(); } finally {
    await run(db, 'DELETE FROM reaction_settings_lock WHERE id=1 AND owner_token=?', token);
  }
}

async function setReactions(env, db, actorId, config, changes, fetchImpl) {
  return withReactionSettingsLock(db, async () => {
    const persisted = await first(db, 'SELECT enabled FROM bots WHERE id=?', config.id);
    if (Object.values(changes).some(Boolean) && Number(persisted?.enabled) === 0)
      throw new Error('Сервис выключен аварийным выключателем D1.');
    const before = await first(db, 'SELECT * FROM reaction_settings WHERE bot_id=?', config.id);
    const check = await first(db, `SELECT state,expires_at FROM reaction_checks WHERE bot_id=?`, config.id);
    const checking = check && check.expires_at > now() && ['waiting', 'preparing', 'ready'].includes(check.state);
    for (const [direction, enabled] of Object.entries(changes)) {
      if (enabled && !reactionDirection(before, direction).verified)
        throw new Error('Сначала завершите проверку реакций в обоих направлениях.');
    }
    const oldSupport = reactionDirection(before, 'support_to_user').enabled;
    const oldUser = reactionDirection(before, 'user_to_support').enabled;
    const nextSupport = changes.support_to_user ?? oldSupport;
    const nextUser = changes.user_to_support ?? oldUser;
    await webhook(env, config, Boolean(nextSupport || nextUser || checking), fetchImpl);
    try {
      await run(db, `INSERT INTO reaction_settings(bot_id,enabled,support_to_user_enabled,user_to_support_enabled,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET enabled=excluded.enabled,
          support_to_user_enabled=excluded.support_to_user_enabled,user_to_support_enabled=excluded.user_to_support_enabled,
          updated_at=excluded.updated_at`, config.id, nextSupport || nextUser ? 1 : 0,
      nextSupport ? 1 : 0, nextUser ? 1 : 0, now());
      await audit(db, config, actorId, 'reactions_' + (nextSupport || nextUser ? 'enable' : 'disable'));
    } catch (error) {
      try { await webhook(env, config, Boolean(oldSupport || oldUser || checking), fetchImpl); } catch { /* Next retry reconciles. */ }
      throw error;
    }
  });
}

async function showReactions(env, db, actorId, config, key, show, fetchImpl, readOnly = false) {
  const state = await first(db, 'SELECT * FROM reaction_settings WHERE bot_id=?', config.id);
  const rows = ['support_to_user', 'user_to_support'].map((direction, index) => {
    const enabled = reactionDirection(state, direction).enabled;
    return [button(`${enabled ? '🔴 Выключить' : '🟢 Включить'} ${index ? 'пользователь → поддержка' : 'поддержка → пользователь'}`,
      `mg:rxset:${key}:${index}:${enabled ? 'off' : 'on'}`)];
  });
  if (readOnly || !config.enabled) return show(`Реакции · ${opaqueManagerText(config.displayName)} · только просмотр\n\n${reactionSummary(state, true)}`,
    [[button('К сервису', `mg:service:${key}`)]]);
  return show(`Реакции · ${opaqueManagerText(config.displayName)}\n\n${reactionSummary(state, true)}\n\n`
    + 'При подключении проверьте оба направления в Telegram. После успешной проверки они включатся автоматически.',
  [[button('🧪 Проверить в Telegram', `mg:rxtest:${key}`)],
    [button('Обновить результат', `mg:rxcheck:${key}`)], ...rows,
    [button('Настройки сервиса', `mg:settings:${key}`)]]);
}

async function reactionCheck(env, db, actorId, config, key, show, fetchImpl, restart, stopNonce = null) {
  const persisted = await first(db, 'SELECT enabled FROM bots WHERE id=?', config.id);
  if (restart && Number(persisted?.enabled) === 0)
    return show('Сервис выключен аварийным выключателем D1. Сначала включите сервис.');
  const groupId = await resolveActiveGroup(db, config.id, env);
  if (!groupId) return show('Сначала подключите сервисного бота к группе поддержки.');
  const checkEnv = { ...env, SUPPORT_GROUP_ID: String(groupId) };
  const checks = createReactionChecks(checkEnv, {
    primaryId: actorId,
    resolveBot: id => {
      const target = parseBotRegistry(env.BOT_REGISTRY).find(item => item.id === id);
      if (!target) throw new Error('Сервисный бот больше не подключён.');
      return target;
    },
    botKey: id => managementBotKey(parseBotRegistry(env.BOT_REGISTRY), id),
    telegram: (target, method, body) => requestTelegram({ token: env[target.tokenBinding], method, body, fetchImpl, timeoutMs: 10000 }),
    subscribe: async (id, include) => {
      const target = parseBotRegistry(env.BOT_REGISTRY).find(item => item.id === id);
      if (!target) throw new Error('Сервисный бот больше не подключён.');
      await webhook(env, target, include, fetchImpl);
    },
    receiverId: async () => config.id,
  });
  if (stopNonce) await withReactionSettingsLock(db, async () => {
    await checks.stop(config.id, stopNonce);
    const current = await checks.read(config.id);
    const settings = await first(db, 'SELECT * FROM reaction_settings WHERE bot_id=?', config.id);
    const enabled = ['support_to_user', 'user_to_support'].some(direction => reactionDirection(settings, direction).enabled);
    await webhook(env, config, Boolean(checks.active(current) || enabled), fetchImpl);
  });
  const row = restart ? await withReactionSettingsLock(db, () => checks.start(config.id)) : await checks.read(config.id);
  if (!row) return show('Проверка ещё не запускалась.', [[button('Начать проверку', `mg:rxtest:${key}`)]]);
  const state = await first(db, 'SELECT * FROM reaction_settings WHERE bot_id=?', config.id);
  const link = config.username ? `https://t.me/${config.username}?start=rx_${row.nonce}` : null;
  const groupLink = row.group_message_id
    ? `https://t.me/c/${String(row.group_id).replace(/^-100/, '')}/${row.group_message_id}` : null;
  return show(`Проверка реакций · ${opaqueManagerText(config.displayName)}\n\n${checks.screen(row, 'manager', await getManagerLanguage(db, actorId)).text}\n\n${reactionSummary(state, true)}`,
    [...(link ? [[{ text: row.state === 'waiting' ? 'Открыть бота для проверки' : 'Тест в личном чате', url: link }]] : []),
      ...(groupLink ? [[{ text: 'Тест в General', url: groupLink }]] : []),
      [button('Обновить результат', `mg:rxcheck:${key}`)],
      ...(checks.active(row) ? [[button('Закрыть проверку', `mg:rxstop:${key}:${row.nonce}`)]] : []),
      ...(!checks.active(row) ? [[button('Начать новую проверку', `mg:rxtest:${key}`)]] : []),
      [button('Реакции', `mg:rx:${key}`)]]);
}

async function showStyle(db, config, key, show) {
  const row = await first(db, 'SELECT * FROM topic_style_settings WHERE bot_id=?', config.id);
  const selected = colors.find(([id]) => id === row?.icon_color);
  return show(`Оформление новых тем · ${opaqueManagerText(config.displayName)}${config.enabled ? '' : ' · только просмотр'}\n\nЦвет: ${selected?.[1] || 'по умолчанию'}\n`
    + `Иконка: ${row?.icon_emoji || 'стандартная'}\nПример: ${row?.icon_emoji || selected?.[1]?.split(' ')[0] || '💬'} ${opaqueManagerText(config.topicPrefix || config.displayName)} · Анна (42)\n\n`
    + 'Изменения действуют на новые темы. Эмодзи заменяет цветную стандартную иконку.',
  [...(config.enabled ? [[button('Цвет стандартной иконки', `mg:stylecolors:${key}`)],
    [button('Эмодзи-иконка', `mg:styleicons:${key}:0`)],
    [button('Сбросить оформление', `mg:stylereset:${key}`)]] : []),
    [button('Настройки сервиса', `mg:settings:${key}`)]]);
}

async function showStyleColors(config, key, show) {
  return show(`Цвет новых тем · ${opaqueManagerText(config.displayName)}\n\nTelegram разрешает ботам шесть цветов. Эмодзи-иконка отображается вместо цветной стандартной.`,
    [...colors.map(([id, label]) => [button(label, `mg:stylecolor:${key}:${id}`)]),
      [button('По умолчанию', `mg:stylecolor:${key}:default`)], [button('Назад', `mg:style:${key}`)]]);
}

async function showStyleIcons(env, config, key, show, fetchImpl, rawPage) {
  const result = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'getForumTopicIconStickers',
    body: {}, fetchImpl, timeoutMs: 10000 });
  if (!result.ok || !Array.isArray(result.result)) return show('Не удалось загрузить иконки Telegram. Повторите позже.',
    [[button('Повторить загрузку', `mg:styleicons:${key}:${Math.max(Number(rawPage) || 0, 0)}`)],
      [button('Назад', `mg:style:${key}`)]]);
  const icons = result.result.filter(item => /^[0-9]{1,20}$/.test(String(item.custom_emoji_id || '')));
  const page = Math.min(Math.max(Number(rawPage) || 0, 0), Math.max(Math.ceil(icons.length / 24) - 1, 0));
  const rows = icons.slice(page * 24, (page + 1) * 24).map(item =>
    [button(`${item.emoji || '◻️'} · ${item.custom_emoji_id}`, `mg:styleicon:${key}:${item.custom_emoji_id}`)]);
  const navigation = [];
  if (page) navigation.push(button('←', `mg:styleicons:${key}:${page - 1}`));
  if ((page + 1) * 24 < icons.length) navigation.push(button('→', `mg:styleicons:${key}:${page + 1}`));
  return show(`Иконка новых тем · ${opaqueManagerText(config.displayName)}\n\nВыберите эмодзи из каталога Telegram.`,
    [...rows, ...(navigation.length ? [navigation] : []), [button('Стандартная иконка', `mg:styleicon:${key}:default`)],
      [button('Назад', `mg:style:${key}`)]]);
}

async function showAttack(db, config, key, show, readOnly = false) {
  const [row, recent] = await Promise.all([
    first(db, 'SELECT mode,manual_override,override_until,manual_controlled FROM service_attack_state WHERE bot_id=?', config.id),
    db.prepare('SELECT event_type,COUNT(*) AS count FROM abuse_events WHERE bot_id=? AND created_at>=? GROUP BY event_type')
      .bind(config.id, new Date(Date.now() - 60_000).toISOString()).all(),
  ]);
  const counts = Object.fromEntries((recent.results || []).map(item => [item.event_type, Number(item.count)]));
  const limited = (counts.burst_limit || 0) + (counts.minute_limit || 0) + (counts.absolute_limit || 0);
  const current = row?.manual_override || (row?.manual_controlled ? null : config.attackModeManualOverride) || 'auto';
  return show(`Защита сервиса · ${opaqueManagerText(config.displayName)}${readOnly || !config.enabled ? ' · только просмотр' : ''}\n\nРежим: ${current.toUpperCase()}`
    + (row?.override_until ? `\nВозврат в AUTO: ${row.override_until}` : '')
    + `\nАнтиспам: ${config.antispamEnabled ? 'включён' : 'выключен'} · CAPTCHA: ${config.verificationMode}`
    + `\nПороги сообщений: ${config.burstLimit}/10 с · ${config.minuteLimit}/мин · ${config.absoluteLimit}/мин`
    + `\nПорог CAPTCHA: ${config.riskTurnstileThreshold} · автомьюта: ${config.riskMuteThreshold}`
    + `\nЗа последнюю минуту: новых пользователей ${counts.new_user || 0}, ограничений частоты ${limited}, CAPTCHA ${counts.verification_requested || 0}, автомьютов ${counts.temporary_mute || 0}`
    + '\n\nON и OFF действуют один час, затем возвращается AUTO.',
  [...(readOnly || !config.enabled ? [] : [[button('AUTO', `mg:attackset:${key}:auto`), button('ON', `mg:attackset:${key}:on`)],
    [button('OFF', `mg:attackconfirm:${key}`)]]),
    [button(readOnly ? 'К сервису' : 'Настройки сервиса', readOnly ? `mg:service:${key}` : `mg:settings:${key}`)]]);
}

export async function showManagerServiceInspection(env, db, key, kind, show, page = 0) {
  if (key === 'a' && kind === 'rx') {
    const registry = parseBotRegistry(env.BOT_REGISTRY);
    const size = 12;
    const pages = Math.max(1, Math.ceil(registry.length / size));
    const current = Number.isSafeInteger(Number(page)) ? Math.min(Math.max(0, Number(page)), pages - 1) : 0;
    const items = registry.slice(current * size, (current + 1) * size);
    const stored = (await db.prepare(`SELECT * FROM reaction_settings
      WHERE bot_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(items.map(item => item.id))).all()).results || [];
    const states = new Map(stored.map(row => [row.bot_id, row]));
    const rows = items.map(item => {
      const state = states.get(item.id);
      const enabled = ['support_to_user', 'user_to_support'].filter(direction =>
        reactionDirection(state, direction).enabled && reactionDirection(state, direction).verified).length;
      const verified = ['support_to_user', 'user_to_support'].filter(direction =>
        reactionDirection(state, direction).verified).length;
      return [button(`${item.enabled ? '' : '⏸ '}${item.displayName} · ${enabled}/2 включено · ${verified}/2 проверено`,
        `mg:rxview:${managementBotKey(registry, item.id)}`)];
    });
    const navigation = [
      ...(current ? [button('←', `mg:rxview:a:${current - 1}`)] : []),
      ...(current + 1 < pages ? [button('→', `mg:rxview:a:${current + 1}`)] : []),
    ];
    if (navigation.length) rows.push(navigation);
    rows.push([button('Меню', 'mg:home')]);
    return show(`Реакции всех сервисов · страница ${current + 1}/${pages}\n\nВыберите сервис, чтобы увидеть оба направления проверки.`, rows);
  }
  const config = service(env, key, false);
  if (!config) return show('Сервис больше не подключён.');
  if (kind === 'rx') return showReactions(env, db, null, config, key, show, null, true);
  if (kind === 'attack') return showAttack(db, config, key, show, true);
}

async function setAttack(db, actorId, config, mode) {
  const override = mode === 'auto' ? null : mode;
  const timestamp = now();
  await db.batch([
    db.prepare(`INSERT INTO service_attack_state(bot_id,mode,manual_override,updated_at,override_until,manual_controlled)
      VALUES(?,?,?,?,?,1) ON CONFLICT(bot_id) DO UPDATE SET mode=excluded.mode,
      manual_override=excluded.manual_override,override_until=excluded.override_until,manual_controlled=1,
      anomaly_seen_at=CASE WHEN excluded.manual_override IS NULL THEN service_attack_state.anomaly_seen_at ELSE NULL END,
      updated_at=excluded.updated_at`).bind(config.id, override === 'on' ? 'attack' : 'normal', override,
      timestamp, override ? new Date(Date.now() + 3600000).toISOString() : null),
    db.prepare(`INSERT INTO operator_audit(bot_id,actor_type,operator_id,operator_name,action,result,created_at)
      VALUES(?,'operator',?,?,?,'success',?)`).bind(config.id, actorId, String(actorId), `attack_control_${mode}`, timestamp),
  ]);
}

export async function handleManagerPlan(env, db, actorId, parts, show) {
  const state = await readCloudflarePlan(db, env);
  const [action, target, revision, dayText] = parts;
  if (!action || action === 'home') return show(`☁️ Cloudflare · ${state.plan.toUpperCase()}\n\n`
    + `Источник: ${state.source === 'config' ? 'RECOVERY_D1_PLAN' : 'настройка приложения'}\n`
    + (state.plan === 'paid' ? `D1: до 1000 запросов за запуск. Монитор: месяц от дня продления (${state.billingDay || 'не задан'}).`
      : 'D1: до 50 запросов за запуск. Монитор: суточные квоты Free.')
    + '\n\nНастройка относится ко всем ботам и монитору. Тариф в Cloudflare меняется отдельно.',
  [[button('Free · 50', `mg:plan:choose:free:${state.revision}`), button('Paid · 1000', `mg:plan:choose:paid:${state.revision}`)],
    ...(state.plan === 'paid' ? [[button('Изменить день продления', `mg:plan:day:${state.source === 'config' ? 'auto' : 'paid'}:${state.revision}`)]] : []),
    ...(state.source === 'config' ? [] : [[button('Использовать конфиг', `mg:plan:choose:auto:${state.revision}`)]]),
    [button('Меню', 'mg:home')]]);
  if (!['choose', 'set', 'day'].includes(action) || !['free', 'paid', 'auto'].includes(target) || revision !== state.revision)
    return show('Этот экран устарел. Откройте план заново.', [[button('План', 'mg:plan')]]);
  const effective = target === 'auto' ? state.configuredPlan : target;
  const day = dayText ? Number(dayText) : state.billingDay;
  if (effective === 'paid' && (action === 'day' || !Number.isInteger(day) || day < 1 || day > 31))
    return show('Укажите день ежемесячного продления Workers Paid из Cloudflare Billing (UTC).',
      [...Array.from({ length: 5 }, (_, row) => Array.from({ length: Math.min(7, 31 - row * 7) }, (_, col) => {
        const value = row * 7 + col + 1;
        return button(String(value), `mg:plan:choose:${target}:${revision}:${value}`);
      })), [button('Назад', 'mg:plan')]]);
  if (action === 'choose') return show(`Применить ${effective.toUpperCase()} ко всем ботам и монитору?`
    + (effective === 'paid' ? `\n\nD1: до 1000 запросов за запуск. День продления: ${day}. Сначала подключите Workers Paid в Cloudflare.`
      : '\n\nD1: до 50 запросов за запуск. Монитор: суточные квоты Free.')
    + '\n\nЭта кнопка меняет настройки приложения, а не подписку Cloudflare.',
  [[button('Применить', `mg:plan:set:${target}:${revision}${day ? ':' + day : ''}`)], [button('Назад', 'mg:plan')]]);
  const nextRevision = crypto.randomUUID(), timestamp = now();
  const updated = await db.batch([
    db.prepare(`UPDATE cloudflare_plan_settings SET plan=?,billing_day=?,revision=?,updated_at=?,updated_by=?
      WHERE id=1 AND revision=?`).bind(target === 'auto' ? null : target, day || null, nextRevision, timestamp, actorId, revision),
    db.prepare(`INSERT INTO operator_audit(bot_id,actor_type,operator_id,operator_name,action,reason,result,created_at)
      SELECT '__manager__','operator',?,?,'cloudflare_plan',?,'success',?
      FROM cloudflare_plan_settings WHERE id=1 AND revision=?`).bind(actorId, String(actorId),
      JSON.stringify({ plan: target, billing_day: day || null }), timestamp, nextRevision),
  ]);
  if (!updated[0].meta?.changes) return show('План уже изменился. Откройте экран заново.', [[button('План', 'mg:plan')]]);
  return handleManagerPlan(env, db, actorId, ['home'], show);
}

export async function handleManagerServiceSettings(env, db, actorId, parts, show, fetchImpl, source = null) {
  const [action, key, fieldCode, operation] = parts;
  if (action === 'msgsave' || action === 'msgcancel') return completeMessageFlow(db, actorId, key, action === 'msgsave', env, show);
  if (action === 'msgrevise') return reviseMessageFlow(db, actorId, key, show);
  const config = service(env, key, false);
  if (!config) return show('Настройки устарели. Откройте карточку сервиса заново.');
  if (!config.enabled && !(action === 'settings' || action === 'language' || action === 'msgs' || action === 'msg' && operation === 'view'
    || action === 'rx' || action === 'style' || action === 'attack'))
    return show('Сервис приостановлен. Настройки доступны только для просмотра.',
      [[button('К настройкам', `mg:settings:${key}`)]]);
  if (action === 'settings') return showManagerServiceSettings(env, db, config, key, show);
  if (action === 'language') return show(`Язык сервиса · ${opaqueManagerText(config.displayName)}\n\nСейчас: ${LANGUAGES[languageOrDefault(config.locale)].name}\nЯзык применяется к новым сообщениям, кнопкам и карточкам этого бота.`,
    [...(config.enabled ? Object.entries(LANGUAGES).map(([code, language]) =>
      [button(`${code === languageOrDefault(config.locale) ? '✓ ' : ''}${language.button}`, `mg:langset:${key}:${code}`)]) : []),
    [button('Назад', `mg:settings:${key}`)]]);
  if (action === 'langset') {
    if (!supportedLanguage(fieldCode)) return;
    const row = await first(db, "SELECT config_json FROM registered_bots WHERE bot_id=? AND status='active'", config.id);
    if (!row) return show('Язык этого бота нельзя изменить через меню. Проверьте подключение сервиса.',
      [[button('К настройкам', `mg:settings:${key}`)]]);
    const saved = JSON.parse(row.config_json);
    if (saved.locale !== fieldCode) {
      saved.locale = fieldCode;
      const changed = await run(db, `UPDATE registered_bots SET config_json=?,updated_at=?
        WHERE bot_id=? AND config_json=? AND status='active'`, JSON.stringify(saved), now(), config.id, row.config_json);
      if (changed.meta?.changes !== 1) return show('Настройки уже изменились. Откройте экран заново.',
        [[button('К настройкам', `mg:settings:${key}`)]]);
      await audit(db, config, actorId, `language_${fieldCode}`);
    }
    return showManagerServiceSettings(env, db, { ...config, locale: fieldCode }, key, show);
  }
  if (action === 'msgs') return showMessages(db, actorId, config, key, show);
  if (action === 'copymsg') return chooseMessageSource(env, db, config, key, show);
  if (action === 'copypreview') return previewMessageCopy(env, db, config, key, fieldCode, show);
  if (action === 'copyapply') return applyMessageCopy(env, db, actorId, config, key, fieldCode, operation, show);
  if (action === 'msg') {
    if (!fieldOf(fieldCode)) return;
    if (operation === 'view') return showMessages(db, actorId, config, key, show, fieldCode);
    if (['edit', 'clear', 'restore'].includes(operation)) return beginMessageEdit(db, actorId, config, key, fieldCode,
      operation === 'clear', show, operation === 'restore');
    if (operation === 'on' || operation === 'off') {
      const field = fieldOf(fieldCode), column = fieldCode === 'w' ? 'welcome_enabled' : 'auto_reply_enabled';
      const reviewed = fieldCode === 'w' ? 'welcome_reviewed' : 'auto_reply_reviewed';
      const text = await first(db, `SELECT ${field} AS value FROM bot_message_settings WHERE bot_id=?`, config.id);
      if (operation === 'on' && !text?.value) return show('Сначала сохраните текст.', [[button('Изменить', `mg:msg:${key}:${fieldCode}:edit`)]]);
      await run(db, `INSERT INTO bot_message_preferences(bot_id,${column},${reviewed}) VALUES(?,?,1)
        ON CONFLICT(bot_id) DO UPDATE SET ${column}=excluded.${column},${reviewed}=1`, config.id, operation === 'on' ? 1 : 0);
      await audit(db, config, actorId, `message_${fieldCode}_${operation}`);
      return showMessages(db, actorId, config, key, show, fieldCode);
    }
  }
  if (action === 'rx') return showReactions(env, db, actorId, config, key, show, fetchImpl);
  if (action === 'rxtest' || action === 'rxcheck' || action === 'rxstop') return reactionCheck(env, db, actorId, config, key,
    show, fetchImpl, action === 'rxtest', action === 'rxstop' ? fieldCode : null);
  if (action === 'rxset') {
    if (!['0', '1'].includes(fieldCode) || !['on', 'off'].includes(operation)) return;
    const direction = fieldCode === '0' ? 'support_to_user' : 'user_to_support';
    const state = await first(db, 'SELECT * FROM reaction_settings WHERE bot_id=?', config.id);
    if (operation === 'on' && !reactionDirection(state, direction).verified)
      return show('Сначала завершите проверку этого направления в Telegram.',
        [[button('Проверить реакции', `mg:rxtest:${key}`)], [button('Назад', `mg:rx:${key}`)]]);
    await setReactions(env, db, actorId, config, { [direction]: operation === 'on' }, fetchImpl);
    return showReactions(env, db, actorId, config, key, show, fetchImpl);
  }
  if (action === 'style') return showStyle(db, config, key, show);
  if (action === 'stylecolors') return showStyleColors(config, key, show);
  if (action === 'styleicons') return showStyleIcons(env, config, key, show, fetchImpl, fieldCode);
  if (action === 'styleicon') {
    if (fieldCode !== 'default' && !/^[0-9]{1,20}$/.test(String(fieldCode))) return;
    const id = fieldCode === 'default' ? null : fieldCode;
    let emoji = null;
    if (id) {
      const result = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'getForumTopicIconStickers',
        body: {}, fetchImpl, timeoutMs: 10000 });
      emoji = result.result?.find(item => item.custom_emoji_id === id)?.emoji;
      if (!emoji) return show('Иконка уже недоступна. Откройте список заново.');
    }
    await run(db, `INSERT INTO topic_style_settings(bot_id,icon_custom_emoji_id,icon_emoji,updated_at,updated_by)
      VALUES(?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET icon_custom_emoji_id=excluded.icon_custom_emoji_id,
        icon_emoji=excluded.icon_emoji,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
    config.id, id, emoji, now(), actorId);
    await audit(db, config, actorId, 'topic_style_icon');
    return showStyle(db, config, key, show);
  }
  if (action === 'attack') return showAttack(db, config, key, show);
  if (action === 'attackconfirm') return show(`Выключить автоматическую защиту ${opaqueManagerText(config.displayName)} на один час?`,
    [[button('Да, выключить', `mg:attackset:${key}:off`)], [button('Назад', `mg:attack:${key}`)]]);
  if (action === 'attackset' && ['auto', 'on', 'off'].includes(fieldCode)) {
    const confirmText = `Выключить автоматическую защиту ${opaqueManagerText(config.displayName)} на один час?`;
    if (fieldCode === 'off' && !['ru', 'en', 'es', 'zh'].some(locale =>
      String(source?.text || '') === translateManager(locale, confirmText)))
      return show('Сначала подтвердите отключение защиты.', [[button('Защита сервиса', `mg:attack:${key}`)]]);
    await setAttack(db, actorId, config, fieldCode);
    return showAttack(db, config, key, show);
  }
  if (action === 'stylecolor') {
    const color = fieldCode === 'default' ? null : Number(fieldCode);
    if (color !== null && !colors.some(([id]) => id === color)) return;
    await run(db, `INSERT INTO topic_style_settings(bot_id,icon_color,updated_at,updated_by)
      VALUES(?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET icon_color=excluded.icon_color,
        updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
    config.id, color, now(), actorId);
    await audit(db, config, actorId, 'topic_style_color');
    return showStyle(db, config, key, show);
  }
  if (action === 'stylereset') {
    await run(db, `INSERT INTO topic_style_settings(bot_id,updated_at,updated_by)
      VALUES(?,?,?) ON CONFLICT(bot_id) DO UPDATE SET icon_color=NULL,icon_custom_emoji_id=NULL,
        icon_emoji=NULL,updated_at=excluded.updated_at,updated_by=excluded.updated_by`, config.id, now(), actorId);
    await audit(db, config, actorId, 'topic_style_reset');
    return showStyle(db, config, key, show);
  }
}
