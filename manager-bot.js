import { BOT_UPDATES, withBotRegistry, webhookUrl } from './bot-registry.js';
import { resolveInvocationDatabase } from './recovery-budget.js';
import { isAlreadyTopicState, managementBotFromKey, managementBotKey, managerCommandList, parseAdminIds, parseBotRegistry, timingSafeEqual } from './worker.js';
import { requestTelegram } from './telegram-response.js';
import { commitGroupCutover, inspectGroupCutover, listGroupServices, registerSupportGroup, resolveActiveGroup } from './service-groups.js';
import { getServiceOwners, markManagerDmStarted, queueTransferNotice, setOperatorAvailability, setServiceOwners } from './service-notifications.js';
import { getOperatorMessageDeliveryStatus, formatOperatorMessageDeliveryStatus } from './delivery-status.js';
import { handleBotRegistrationUpdate } from './bot-onboarding.js';
import { changeWork, readWork, tomorrowMorning, workAge, workStateLabel, workCounts, workQueue, WORK_FILTERS, assigneeLabel } from './conversation-work.js';
import { serviceChecks } from './service-checks.js';
import { MANAGER_DELIVERY_UI, manualDeliveryText } from './manual-delivery.js';
import { handleStorageUpdate, storageCandidate, isStorageResetPhrase } from './storage-ui.js';
import { showManagerServiceSettings, showManagerServiceInspection, handleManagerServiceSettings, handleManagerMessageText, handleManagerPlan, cancelManagerMessageFlow } from './manager-service-settings.js';
import { showManagerDeliveryDiagnostics, showManagerDeliveryProblems, showManagerHelp, showManagerSystemHealth, showManagerReadiness } from './manager-diagnostics.js';
import { showManagerAudit as showAuditScreen } from './manager-audit.js';
import { showManagerUserHome, showManagerUserList, showManagerUserSearch, showManagerUserCard,
  handleManagerUserAction, handleManagerUserText, handleManagerUserSearchText } from './manager-user-management.js';
import { customerName } from './user-display.js';
import { messageDeletionWarning } from './message-deletion-copy.js';
import { managerScreenKeyboard } from './manager-navigation.js';
import { getManagerLanguage, setManagerLanguage, opaqueManagerText, translateManager, translateManagerScreen } from './manager-language.js';
import { LANGUAGES, languageOrDefault } from './language.js';
import { localizedAlertConfigError } from './monitor/alert-config.js';
import { claimManagerHome, completeManagerHome, releaseManagerHome } from './manager-home.js';
import { handleStatisticsCallback, handleStatisticsText } from './manager-statistics.js';
import { recordStatisticsTelegramFailure } from './support-statistics.js';

const FLOW_TTL_MS = 60 * 60 * 1000;
const managerPath = '/tg/manager';
const now = () => new Date().toISOString();
const later = () => new Date(Date.now() + FLOW_TTL_MS).toISOString();
const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
const reply = (status, text) => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
const button = (text, data) => ({ text, callback_data: data });
const workScopes = ['mine', 'all', 'urgent', 'urgentall'];
const workDate = (value, locale = 'en') => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(LANGUAGES[languageOrDefault(locale)].dateLocale, {
    timeZone: 'Europe/Budapest', dateStyle: 'short', timeStyle: 'short',
  }).format(date);
};
const managerLocales = ['ru', 'en', 'es', 'zh'];
function managerHeaderMatches(text, source) {
  const value = String(text || '');
  return managerLocales.some(locale => value.startsWith(translateManager(locale, source)));
}

class ManagerError extends Error {
  constructor(message, retryable = false, telegram = null) {
    super(message);
    this.retryable = retryable;
    if (telegram) this.telegramFailure = { telegram_error_code: telegram.errorCode || telegram.httpStatus || null,
      retry_after_seconds: telegram.retryAfterSeconds || null, outcome_uncertain: telegram.deliveryUncertain === true };
  }
}

function managerConfigured(env) {
  return Boolean(env.MANAGER_BOT_TOKEN && env.MANAGER_WEBHOOK_SECRET);
}

function primaryId(env) {
  return Number([...parseAdminIds(env.ADMIN_IDS)][0]);
}

async function call(env, method, body, fetchImpl) {
  if (Number(body?.chat_id) < 0 && ['sendMessage', 'editMessageText'].includes(method)) {
    const locale = await getManagerLanguage(env.SUPPORT_DB, env.MANAGER_REQUEST_ACTOR_ID);
    const localized = translateManagerScreen(locale, body.text, body.reply_markup);
    body = { ...body, text: localized.text, ...(body.reply_markup ? { reply_markup: localized.markup } : {}) };
  }
  const result = ['sendMessage','sendRichMessage'].includes(method) ? await sendManagerMessage(env, body, fetchImpl, method)
    : await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method, body, fetchImpl, timeoutMs: 10000 });
  if (!result.ok) await recordStatisticsTelegramFailure(env.SUPPORT_DB,'__manager__',result);
  if (!result.ok) throw new ManagerError(
    result.rateLimited ? `Telegram временно ограничил запросы. Повторите через ${result.retryAfterSeconds || 60} сек.`
      : 'Telegram не подтвердил действие. Повторите проверку позже.',
    result.retryable || result.deliveryUncertain,
    result,
  );
  return result.result;
}

async function sendManagerMessage(env, body, fetchImpl, method = 'sendMessage') {
  const updateId = env.MANAGER_UPDATE_ID;
  const db = env.SUPPORT_DB;
  const chatId = Number(body.chat_id), threadId = Number(body.message_thread_id || 0);
  const claimToken = crypto.randomUUID();
  const claimedAt = now();
  if (Number.isSafeInteger(updateId)) {
    const claim = await run(db, `INSERT OR IGNORE INTO manager_message_sends
      (update_id,chat_id,thread_id,status,claim_token,claimed_at,updated_at)
      VALUES(?,?,?,'sending',?,?,?)`, updateId, chatId, threadId, claimToken, claimedAt, claimedAt);
    if (claim.meta?.changes !== 1) return { ok: true, result: null, skipped: true };
  }
  const result = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method,
    body, fetchImpl, timeoutMs: 10000 });
  const confirmed = result.ok && Number.isSafeInteger(Number(result.result?.message_id))
    && Number(result.result.message_id) > 0;
  if (Number.isSafeInteger(updateId)) {
    if (confirmed) {
      await run(db, `UPDATE manager_message_sends SET status='sent',telegram_message_id=?,updated_at=?
        WHERE update_id=? AND chat_id=? AND thread_id=? AND claim_token=? AND status='sending'`,
      Number(result.result.message_id), now(), updateId, chatId, threadId, claimToken);
    } else if (result.deliveryUncertain || result.ok || Number(result.errorCode || result.httpStatus) >= 500) {
      await run(db, `UPDATE manager_message_sends SET status='uncertain',updated_at=?
        WHERE update_id=? AND chat_id=? AND thread_id=? AND claim_token=? AND status='sending'`,
      now(), updateId, chatId, threadId, claimToken);
    } else {
      await run(db, "DELETE FROM manager_message_sends WHERE update_id=? AND chat_id=? AND thread_id=? AND claim_token=? AND status='sending'",
        updateId, chatId, threadId, claimToken);
    }
  }
  return result.ok && !confirmed ? { ...result, ok: false, retryable: true, deliveryUncertain: true,
    description: 'Telegram did not return the message ID' } : result;
}

async function sendStatistics(env,actorId,markdown,rows,fetchImpl) {
  const body={chat_id:actorId,rich_message:{markdown},reply_markup:{inline_keyboard:rows}};
  const id=Number(env.MANAGER_SCREEN_MESSAGE_ID);
  if(Number(env.MANAGER_SCREEN_CHAT_ID)===actorId&&Number.isSafeInteger(id)&&id>0){
    const result=await requestTelegram({token:env.MANAGER_BOT_TOKEN,method:'editMessageText',body:{...body,message_id:id},fetchImpl,timeoutMs:10000});
    if(result.ok||/message is not modified/i.test(result.description||''))return result.result;
    if(!result.deliveryUncertain&&Number(result.errorCode||result.httpStatus)===400&&/(?:message.*not found|message_id_invalid)/i.test(result.description||''))
      return call(env,'sendRichMessage',body,fetchImpl);
    throw new ManagerError('Telegram не подтвердил обновление меню. Повторите действие позже.',result.retryable||result.deliveryUncertain,result);
  }
  return call(env,'sendRichMessage',body,fetchImpl);
}

async function send(env, chatId, text, markup, fetchImpl, navigation = true) {
  const locale = await getManagerLanguage(env.SUPPORT_DB, Number(chatId) > 0 ? Number(chatId) : env.MANAGER_REQUEST_ACTOR_ID);
  const screenId = Number(env.MANAGER_SCREEN_MESSAGE_ID);
  const interactive = Array.isArray(markup) || Number(chatId) === Number(env.MANAGER_SCREEN_CHAT_ID)
    && Number.isSafeInteger(screenId) && screenId > 0 && markup !== null;
  if (navigation && Number(chatId) > 0 && interactive) markup = managerScreenKeyboard(markup, {
    route: env.MANAGER_SCREEN_ROUTE,
    primary: Number(chatId) === primaryId(env),
    root: String(text).startsWith('Управление поддержкой\n\n'),
    screenText: text,
  });
  ({ text, markup } = translateManagerScreen(locale, text, markup));
  if (Number(chatId) === Number(env.MANAGER_SCREEN_CHAT_ID)
    && Number.isSafeInteger(screenId) && screenId > 0) {
    const result = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'editMessageText',
      body: { chat_id: chatId, message_id: screenId, text,
        reply_markup: { inline_keyboard: markup || [] } }, fetchImpl, timeoutMs: 10000 });
    if (result.ok || /message is not modified/i.test(result.description || '')) return result.result;
    // A missing source message is a definitive failure; a timeout or 5xx may
    // mean the edit succeeded, so never create a second screen for those.
    if (!result.deliveryUncertain && Number(result.errorCode || result.httpStatus) === 400
      && /(?:message.*not found|message_id_invalid)/i.test(result.description || '')) {
      return call(env, 'sendMessage',
        { chat_id: chatId, text, ...(markup ? { reply_markup: { inline_keyboard: markup } } : {}) }, fetchImpl);
    }
    throw new ManagerError(result.rateLimited
      ? `Telegram временно ограничил запросы. Повторите через ${result.retryAfterSeconds || 60} сек.`
      : 'Telegram не подтвердил обновление меню. Повторите действие позже.',
    result.retryable || result.deliveryUncertain, result);
  }
  return call(env, 'sendMessage',
    { chat_id: chatId, text, ...(markup ? { reply_markup: { inline_keyboard: markup } } : {}) }, fetchImpl);
}

function managerScreenContext(env, query, actorId) {
  const source = query?.message;
  const messageId = Number(source?.message_id);
  if (source?.chat?.type !== 'private' || Number(source.chat.id) !== actorId
    || !Number.isSafeInteger(messageId) || messageId <= 0) return env;
  return { ...env, MANAGER_SCREEN_CHAT_ID: actorId, MANAGER_SCREEN_MESSAGE_ID: messageId,
    MANAGER_SCREEN_ROUTE: String(query.data || '') };
}

function deliveryStatusCard(result, sourceMessageId, locale = 'en') {
  return `Статус доставки сообщения #${sourceMessageId}\n${formatOperatorMessageDeliveryStatus(result, locale)}`;
}

function deliveryStatusMarkup(sourceMessageId) {
  return [[button('Обновить статус', `ds:${Number(sourceMessageId)}`)]];
}

function recoveryMarkup(key) {
  return [[button('▶️ Повторить безопасные отправки', `mg:recover:${key}`)],
    [button('Обновить проверку', `mg:delivery:${key}`)],
    [button(key === 'a' ? 'Меню' : 'К сервису', key === 'a' ? 'mg:home' : `mg:service:${key}`)]];
}

async function editRecoveryPanel(env, actorId, messageId, text, key, fetchImpl, locale = 'en') {
  const result = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'editMessageText',
    body: { chat_id: actorId, message_id: messageId, text: translateManager(locale, text),
      reply_markup: { inline_keyboard: managerScreenKeyboard(recoveryMarkup(key), {
        route: `mg:delivery:${key}`, primary: true,
      }).map(row => row.map(item => ({ ...item, text: translateManager(locale, item.text) }))) } }, fetchImpl, timeoutMs: 10000 });
  if (!result.ok && !/message is not modified/i.test(result.description || ''))
    throw new ManagerError('Telegram не подтвердил обновление проверки доставки. Обновите экран позже.', result.retryable || result.deliveryUncertain);
}

async function managerRecoveryScreen(env, db, actorId, config, registry, fetchImpl, service, query = null) {
  if (actorId !== primaryId(env)) return;
  const locale = await getManagerLanguage(db, actorId);
  if (!service) throw new ManagerError('Сервис восстановления недоступен. Проверьте публикацию обновления.');
  const groupId = config ? await resolveActiveGroup(db, config.id, env) : 0;
  if (config && !groupId) throw new ManagerError('Сначала подключите группу сервиса.');
  const key = config ? managementBotKey(registry, config.id) : 'a';
  const label = config?.displayName || 'Все сервисы';
  const options = { actorId, groupId, threadId: null, botId: config?.id || null, uiBotId: MANAGER_DELIVERY_UI,
    messageId: Number(query?.message?.message_id) || 1, requestKey: `manager:${query?.id || ''}` };
  if (query && String(query.data || '').startsWith('mg:recover:')) {
    const panel = query.message;
    if (!Number.isSafeInteger(Number(panel?.message_id)) || Number(panel.message_id) <= 0) return;
    await editRecoveryPanel(env, actorId, Number(panel.message_id),
      `🔄 Повторная доставка · ${label}\n⏳ Запуск принимается. Обновите проверку, если результат задерживается.`,
      key, fetchImpl, locale);
    options.messageId = Number(panel.message_id);
    options.requestKey = `manager:${query.id}`;
    const result = await service.start(options);
    if (result.started) return;
    if (result.run && result.run.bot_id !== options.botId && ['queued', 'running'].includes(result.run.status)) {
      return editRecoveryPanel(env, actorId, options.messageId,
        `🔄 Повторная доставка · ${label}\nДругой запуск уже выполняется (${result.run.bot_id || 'все сервисы'}). Обновите проверку после его завершения.`,
        key, fetchImpl, locale);
    }
  }
  const status = await service.status(options);
  const text = `${label}${config ? ` · группа ${groupId}` : ''}\n${manualDeliveryText(status, locale)}`;
  if (query) return editRecoveryPanel(env, actorId, Number(query.message.message_id), text, key, fetchImpl, locale);
  return send(env, actorId, text, recoveryMarkup(key), fetchImpl);
}

export async function publishManagerManualDelivery(env, run, fetchImpl = fetch) {
  if (run.ui_bot_id !== MANAGER_DELIVERY_UI || Number(run.actor_id) !== primaryId(env)) return;
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const config = run.bot_id && registry.find(item => item.id === run.bot_id && item.enabled);
  if (run.bot_id) {
    const group = await first(env.SUPPORT_DB, 'SELECT group_id FROM service_group_routes WHERE bot_id=?', run.bot_id);
    if (!config || Number(group?.group_id) !== Number(run.group_id)) return;
  } else if (Number(run.group_id) !== 0) return;
  const key = config ? managementBotKey(registry, config.id) : 'a';
  const locale = await getManagerLanguage(env.SUPPORT_DB, Number(run.actor_id));
  const result = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'editMessageText',
    body: { chat_id: Number(run.actor_id), message_id: Number(run.message_id),
      text: translateManager(locale, `${config ? `${opaqueManagerText(config.displayName)} · группа ${run.group_id}` : 'Все сервисы'}\n${manualDeliveryText({ run }, locale)}`),
      reply_markup: { inline_keyboard: managerScreenKeyboard(recoveryMarkup(key), {
        route: `mg:delivery:${key}`, primary: true,
      }).map(row => row.map(item => ({ ...item, text: translateManager(locale, item.text) }))) } }, fetchImpl, timeoutMs: 10000 });
  if (!result.ok && !/message is not modified/i.test(result.description || ''))
    throw new Error('Manager delivery report could not be displayed');
}

async function authorizedOperator(db, env, actorId) {
  if (Number(actorId) === primaryId(env)) return true;
  const row = await first(db, 'SELECT 1 AS allowed FROM support_operators WHERE user_id=? AND active=1', Number(actorId));
  return Boolean(row);
}

function safeTitle(value) {
  return String(value || 'Группа поддержки').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 80);
}

async function currentFlow(db, actorId) {
  return first(db, "SELECT * FROM manager_group_flows WHERE owner_id=? AND (expires_at>? OR stage='connecting')", actorId, now());
}

function groupCommand(message) {
  return /^\/connect(?:@[a-z0-9_]+)?\s+([A-F0-9]{12})\s*$/i.exec(String(message?.text || ''))?.[1]?.toUpperCase() || null;
}

function addressedToManager(message, env) {
  const mentioned = /^\/[a-z0-9_]+@([a-z0-9_]+)/i.exec(String(message?.text || ''))?.[1];
  const managerName = String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, '');
  return !mentioned || Boolean(managerName && mentioned.toLowerCase() === managerName.toLowerCase());
}

async function changeTopicState(env, db, actorId, conversation, action, fetchImpl) {
  if (!['close', 'open'].includes(action)) return;
  const { bot_id: botId, user_id: userId, support_group_id: groupId, thread_id: threadId } = conversation;
  const nextStatus = action === 'close' ? 'closed' : 'open';
  const result = await requestTelegram({ token: env.MANAGER_BOT_TOKEN,
    method: action === 'close' ? 'closeForumTopic' : 'reopenForumTopic',
    body: { chat_id: Number(groupId), message_thread_id: Number(threadId) }, fetchImpl, timeoutMs: 10000 });
  if (!result.ok && !isAlreadyTopicState(result.description, nextStatus)) {
    throw new ManagerError(action === 'close'
      ? 'Не удалось закрыть тему. Проверьте право Админушки управлять темами и повторите /close.'
      : 'Не удалось открыть тему. Проверьте право Админушки управлять темами и повторите действие.',
    result.retryable || result.deliveryUncertain);
  }
  const floor = await first(db, 'SELECT MAX(update_id) AS value FROM processed_updates WHERE bot_id=?', botId);
  const updateFloor = Number.isSafeInteger(Number(floor?.value)) ? Number(floor.value) : null;
  await db.batch([
    db.prepare(`INSERT INTO operator_audit(bot_id,user_id,actor_type,operator_id,operator_name,action,result,created_at)
      SELECT ?,?,'operator',?,?,?,'success',? FROM conversations
      WHERE bot_id=? AND user_id=? AND support_group_id=? AND thread_id=? AND status<>?`)
      .bind(botId, userId, actorId, String(actorId), `conversation_${action}`, now(), botId, userId, groupId, threadId, nextStatus),
    db.prepare(`UPDATE conversations SET status=?,reply_epoch=reply_epoch+CASE WHEN ?='closed' AND status<>'closed' THEN 1 ELSE 0 END,
      topic_state_update_id=CASE WHEN ? IS NULL THEN topic_state_update_id
        WHEN topic_state_update_id IS NULL OR topic_state_update_id<? THEN ? ELSE topic_state_update_id END
      WHERE bot_id=? AND user_id=? AND support_group_id=? AND thread_id=?`)
      .bind(nextStatus, nextStatus, updateFloor, updateFloor, updateFloor, botId, userId, groupId, threadId),
  ]);
}

async function showHome(env, db, actorId, fetchImpl) {
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  if (Number(actorId) === primaryId(env)) {
    const flow = await currentFlow(db, actorId);
    const rows = [
      ...(flow && flow.stage !== 'done' ? [[button('Продолжить подключение группы', `mg:flow:${flow.nonce}`)]] : []),
      [button('📥 Мои обращения', 'mg:mine'), button('📋 Все обращения', 'mg:all')],
      [button('🔥 Просроченные', 'mg:section:overdue')],
      [button('📂 Очереди, доставка, черновики', 'mg:section:work')],
      [button('👥 Пользователи', 'mu:home:a'), button('🔎 Поиск', 'mu:search')],
      [button('👥 Операторы', 'mg:operators')],
      [button('🤖 Управление ботами поддержки', 'mg:section:bots')],
      [button('🚨 Алерты', 'mg:alert:home')],
      [button('📊 Статистика', 'mg:stats:home')],
      [button('📊 Контроль и восстановление', 'mg:section:control')],
      [button('☁️ План и хранилище', 'mg:section:platform')],
      [button('📜 Журнал действий', 'mg:audit:0'), button('❓ Помощь', 'mg:help')],
      [button('🌐 Язык интерфейса', 'mg:uilanguage')],
    ];
    return send(env, actorId, 'Управление поддержкой\n\nВыберите действие или раздел.', rows, fetchImpl);
  }
  const owned = new Set(((await db.prepare(`
    SELECT bot_id FROM service_responsibility WHERE primary_id=? OR backup_id=?
    UNION SELECT bot_id FROM conversation_work WHERE assigned_to=? AND state<>'resolved'
    LIMIT 50`).bind(actorId, actorId, actorId).all()).results || []).map(row => row.bot_id));
  const rows = registry.filter(config => !owned || owned.has(config.id))
    .map(config => [button(`${config.enabled ? '🔧' : '⏸'} ${opaqueManagerText(config.displayName)}`,
      `mg:service:${managementBotKey(registry, config.id)}`)]);
  rows.unshift([button('🔥 Мои просроченные', 'mg:urgent'), button('📥 Мои обращения', 'mg:mine')]);
  rows.push([button('👥 Пользователи', 'mu:home:a'), button('🔎 Поиск', 'mu:search')]);
  rows.push([button('🧪 Реакции всех сервисов', 'mg:rxview:a')]);
  rows.push([button('👥 Операторы', 'mg:operators')]);
  rows.push([button('📥 Очереди', 'mg:queue:a:needs:0')]);
  rows.push([button('📨 Проблемы доставки', 'mg:problems:a:0')]);
  rows.push([button('📝 Черновики', 'mg:drafts')]);
  rows.push([button('📊 Статистика', 'mg:stats:home')]);
  rows.push([button('📜 Журнал действий', 'mg:audit:0'), button('❓ Помощь', 'mg:help')]);
  rows.push([button('🌐 Язык интерфейса', 'mg:uilanguage')]);
  return send(env, actorId, 'Управление поддержкой\n\nВыберите сервис. Обращения клиентов остаются в темах его группы.', rows, fetchImpl);
}

async function showManagerUiLanguage(db, actorId, sendFn) {
  const current = await getManagerLanguage(db, actorId);
  return sendFn('🌐 Язык интерфейса\n\nВыберите язык интерфейса.', [
    [{ text: `${current === 'en' ? '✓ ' : ''}English`, callback_data: 'mg:uilangset:en' }],
    [{ text: `${current === 'ru' ? '✓ ' : ''}Русский`, callback_data: 'mg:uilangset:ru' }],
    [{ text: `${current === 'es' ? '✓ ' : ''}Español`, callback_data: 'mg:uilangset:es' }],
    [{ text: `${current === 'zh' ? '✓ ' : ''}简体中文`, callback_data: 'mg:uilangset:zh' }],
    [{ text: '← Назад', callback_data: 'mg:home' }],
  ]);
}

async function showHomeSection(env, db, actorId, section, fetchImpl) {
  if (Number(actorId) !== primaryId(env)) return showHome(env, db, actorId, fetchImpl);
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const sections = {
    overdue: ['Просроченные обращения', [
      [button('🔥 Мои просроченные', 'mg:urgent')],
      [button('🔥 Все просроченные', 'mg:urgentall')],
    ]],
    work: ['Очереди, доставка и черновики', [
      [button('📥 Очереди', 'mg:queue:a:needs:0')],
      [button('📨 Проблемы доставки', 'mg:problems:a:0')],
      [button('📝 Черновики', 'mg:drafts')],
    ]],
    bots: ['Управление ботами поддержки', [
      ...registry.map(config => [button(`${config.enabled ? '🔧' : '⏸'} ${opaqueManagerText(config.displayName)}`,
        `mg:service:${managementBotKey(registry, config.id)}`)]),
      [button('Добавить сервисного бота', 'mg:addbot')],
      [button('🧪 Реакции всех сервисов', 'mg:rxview:a')],
    ]],
    control: ['Контроль и восстановление', [
      [button('📊 Контроль ожидания', 'mg:metrics')],
      [button('🔄 Восстановление доставки · все сервисы', 'mg:delivery:a')],
      [button('🩺 Здоровье системы', 'mg:health')],
    ]],
    platform: ['План и хранилище', [
      [button('☁️ План Cloudflare', 'mg:plan')],
      [button('🗄️ Хранилище', 'mg:storage')],
    ]],
  };
  const selected = sections[section];
  if (!selected) return showHome(env, db, actorId, fetchImpl);
  return send(env, actorId, `${selected[0]}\n\nВыберите действие.`,
    [...selected[1], [button('← Главное меню', 'mg:home')]], fetchImpl);
}

async function showMetrics(env, db, actorId, fetchImpl) {
  if (Number(actorId) !== primaryId(env)) return;
  const overdue = await first(db, `SELECT COUNT(*) AS total FROM conversation_work w
    LEFT JOIN service_responsibility r ON r.bot_id=w.bot_id
    WHERE w.state='needs_reply' AND w.cycle_started_at IS NOT NULL
    AND datetime(w.cycle_started_at)<=datetime('now','-' || COALESCE(r.reminder_minutes,30) || ' minutes')`);
  const unknownDelivery = await first(db, `SELECT COUNT(*) AS total FROM message_delivery_attempts
    WHERE completed_at IS NULL AND request_started_at IS NOT NULL`);
  const unknownNotices = await first(db, "SELECT COUNT(*) AS total FROM service_notification_outbox WHERE status='uncertain'");
  const failedNotices = await first(db, `SELECT COUNT(*) AS total FROM service_notification_outbox n
    JOIN conversation_work w ON w.bot_id=n.bot_id AND w.user_id=n.user_id
      AND w.notification_cycle=n.notification_cycle
    WHERE n.status='failed' AND w.state<>'resolved'`);
  const unreachableOperators = await first(db, `SELECT COUNT(*) AS total FROM manager_dm_status d
    LEFT JOIN support_operators o ON o.user_id=d.operator_id
    WHERE d.unreachable_at IS NOT NULL AND (o.active=1 OR d.operator_id=?)`, primaryId(env));
  const staleNoticeLinks = await first(db, "SELECT COUNT(*) AS total FROM service_notification_outbox WHERE status='sent' AND error_code IN ('link_refresh_pending','link_refresh_failed')");
  return send(env, actorId,
    `Контроль поддержки\n\nОбращений старше первого порога без ответа: ${overdue?.total || 0}\nНеясных исходов доставки сообщений: ${unknownDelivery?.total || 0}\nНеясных исходов личных уведомлений: ${unknownNotices?.total || 0}\nЛичных уведомлений с ошибкой в открытых обращениях: ${failedNotices?.total || 0}\nНедоступных операторов: ${unreachableOperators?.total || 0}\nКарточек, где новая ссылка ещё не подтверждена: ${staleNoticeLinks?.total || 0}\n\nTelegram не подтверждает прочтение клиентом.`,
    [[button('Просроченные обращения', 'mg:urgentall')], [button('Все обращения', 'mg:all')],
      [button('Операторы', 'mg:operators')], [button('Меню', 'mg:home')]], fetchImpl);
}

async function showManagerAudit(env, db, actorId, key, page, details, fetchImpl) {
  return showAuditScreen(env, db, { key, page, details }, (body, rows) => send(env, actorId, body, rows, fetchImpl));
}

async function showStorageGroups(env, db, actorId, fetchImpl, page = 0) {
  if (actorId !== primaryId(env)) return;
  const safePage = Number.isSafeInteger(Number(page)) ? Math.max(0, Math.min(1000, Number(page))) : 0;
  const pageSize = 20;
  const groups = (await db.prepare(`SELECT g.group_id,g.title,COUNT(r.bot_id) AS services
    FROM support_groups g LEFT JOIN service_group_routes r ON r.group_id=g.group_id
    GROUP BY g.group_id ORDER BY services DESC,g.updated_at DESC LIMIT ? OFFSET ?`)
    .bind(pageSize + 1, safePage * pageSize).all()).results || [];
  if (!groups.length && safePage === 0) throw new ManagerError('Сначала подключите группу поддержки.');
  const navigation = [
    ...(safePage ? [button('←', `mg:storage:page:${safePage - 1}`)] : []),
    ...(groups.length > pageSize ? [button('→', `mg:storage:page:${safePage + 1}`)] : []),
  ];
  return send(env, actorId,
    `Хранилище · страница ${safePage + 1}\n\nВыберите группу для просмотра тем и ручных заданий очистки. Размер баз, правила хранения и полная очистка относятся ко всей системе.`,
    [...groups.slice(0, pageSize).map(group => [button(`${safeTitle(group.title || group.group_id)} · ${group.services} сервисов`,
      `mg:storage:group:${group.group_id}`)]), ...(navigation.length ? [navigation] : []), [button('Меню', 'mg:home')]], fetchImpl);
}

async function openStorageGroup(env, db, actorId, groupId, fetchImpl) {
  if (actorId !== primaryId(env) || !Number.isSafeInteger(groupId) || groupId >= 0) return;
  const group = await first(db, 'SELECT group_id,title FROM support_groups WHERE group_id=?', groupId);
  if (!group) throw new ManagerError('Группа больше не подключена. Откройте Хранилище заново.');
  await run(db, `INSERT INTO manager_storage_sessions(owner_id,group_id,screen_message_id,updated_at)
    VALUES(?,?,NULL,?) ON CONFLICT(owner_id) DO UPDATE SET group_id=excluded.group_id,
      screen_message_id=NULL,updated_at=excluded.updated_at`, actorId, groupId, now());
  await run(db, `UPDATE storage_control SET confirmation_actor=NULL,confirmation_group=NULL,
    confirmation_nonce='00000000000000000000000000000000',confirmation_stage=NULL,confirmation_expires=NULL
    WHERE id=1 AND mode='normal' AND confirmation_actor=?`, actorId);
  return handlePrivateStorage(env, db, actorId, group, { message: {
    from: { id: actorId }, chat: { id: actorId, type: 'private' }, text: '/storage' } }, fetchImpl);
}

async function handlePrivateStorage(env, db, actorId, group, update, fetchImpl) {
  const storageEnv = { ...env, SUPPORT_GROUP_ID: String(group.group_id),
    STORAGE_RESET_GROUP_ID: String(env.SUPPORT_GROUP_ID) };
  const sendStorage = async (method, body) => {
    let result = method === 'sendMessage' ? await sendManagerMessage(env, body, fetchImpl)
      : await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method, body, fetchImpl, timeoutMs: 10000 });
    if (method === 'sendMessage' && result.skipped) {
      const previous = await first(db, `SELECT status,telegram_message_id FROM manager_message_sends
        WHERE update_id=? AND chat_id=? AND thread_id=0`, env.MANAGER_UPDATE_ID, actorId);
      result = previous?.status === 'sent' && previous.telegram_message_id
        ? { ok: true, result: { message_id: Number(previous.telegram_message_id) } }
        : { ok: false, deliveryUncertain: true };
    }
    if (method === 'sendMessage' && result.ok && result.result?.message_id)
      await run(db, 'UPDATE manager_storage_sessions SET screen_message_id=?,updated_at=? WHERE owner_id=? AND group_id=?',
        Number(result.result.message_id), now(), actorId, Number(group.group_id));
    return result;
  };
  return handleStorageUpdate({ locale: await getManagerLanguage(db, actorId), groupCommandOwner: true, privateStorage: true,
    storageGroupTitle: safeTitle(group.title || group.group_id) }, storageEnv, update, sendStorage);
}

const EMERGENCY_STORAGE_MARKER = '🚨 Аварийное хранилище\n';
const emergencyStorageActions = new Set(['home', 'space', 'details', 'rules', 'days', 'policypreview', 'policy',
  'danger', 'reset', 'arm', 'pause', 'resume', 'stop', 'stopconfirm']);

async function handleEmergencyStorage(env, actorId, update, fetchImpl) {
  const emergencyEnv = { ...env, STORAGE_RESET_GROUP_ID: String(env.SUPPORT_GROUP_ID) };
  const locale = await getManagerLanguage(env.SUPPORT_DB, actorId);
  const sendEmergency = (method, body) => {
    if (method === 'sendMessage' || method === 'editMessageText') {
      const rows = body.reply_markup?.inline_keyboard?.map(row => row.filter(item => !item.callback_data?.startsWith('um:st:')
        || emergencyStorageActions.has(item.callback_data.slice('um:st:'.length).split(':')[0]))).filter(row => row.length);
      body = { ...body, text: translateManager(locale, EMERGENCY_STORAGE_MARKER) + body.text,
        ...(rows ? { reply_markup: { inline_keyboard: rows } } : {}) };
    }
    return requestTelegram({ token: env.MANAGER_BOT_TOKEN, method, body, fetchImpl, timeoutMs: 10000 });
  };
  return handleStorageUpdate({ locale, groupCommandOwner: true, privateStorage: true,
    storageGroupTitle: translateManager(locale, 'Все обращения') }, emergencyEnv, update, sendEmergency);
}

async function alertRpc(env, method, options) {
  if (!env.ALERT_SETTINGS) throw new ManagerError('Управление алертами ещё не опубликовано в мониторе.');
  try { return await env.ALERT_SETTINGS[method](options); }
  catch (error) {
    const message = String(error?.message || '');
    const locale = await getManagerLanguage(env.SUPPORT_DB, env.MANAGER_REQUEST_ACTOR_ID);
    throw new ManagerError(localizedAlertConfigError(message, locale)
      || 'Монитор не подтвердил изменение алертов. Откройте настройки заново.');
  }
}

async function showAlerts(env, db, actorId, fetchImpl, prefix = '') {
  if (actorId !== primaryId(env)) return;
  const status = await alertRpc(env, 'status');
  const location = status.mode === 'group' ? `топик ${status.threadId || 'General'} группы ${status.chatId}`
    : status.mode === 'private' ? `личные чаты: ${(status.recipients || []).join(', ')}`
      : 'отключены — предупреждения не доставляются';
  const rows = [[button(status.mode === 'disabled' ? 'Подключить алерт-бота' : 'Заменить алерт-бота', 'mg:alert:connect')]];
  if (status.mode !== 'disabled') rows.push([button('Переключить в личку администратору и операторам', 'mg:alert:private')],
    [button('Переключить в топик группы', 'mg:alert:group')], [button('Отключить алерт-бота', 'mg:alert:remove')]);
  rows.push([button('Меню', 'mg:home')]);
  return send(env, actorId, `${prefix}Алерты\n\nБот: ${status.username ? '@' + status.username : status.mode === 'disabled' ? 'не подключён' : 'подключён ранее'}\nДоставка: ${location}\n\nАктивен только один режим доставки. При переключении прежний чат получит сообщение об отключении.`, rows, fetchImpl);
}

async function startAlertFlow(env, db, actorId, stage, fetchImpl) {
  const status = await alertRpc(env, 'status');
  if (stage !== 'token' && status.mode === 'disabled') return showAlerts(env, db, actorId, fetchImpl);
  if (stage === 'token') {
    const registering = await first(db, "SELECT 1 AS active FROM bot_registration_flow WHERE owner_id=? AND stage<>'done' AND expires_at>?", actorId, now());
    if (registering) throw new ManagerError('Сначала завершите или отмените подключение сервисного бота.');
  }
  const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  await run(db, `INSERT INTO manager_alert_flows(owner_id,nonce,stage,generation,recipients_json,expires_at,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET nonce=excluded.nonce,stage=excluded.stage,
      generation=excluded.generation,recipients_json=excluded.recipients_json,expires_at=excluded.expires_at,
      updated_at=excluded.updated_at`, actorId, nonce, stage, status.generation,
  JSON.stringify([actorId]), later(), now());
  if (stage === 'token') return send(env, actorId,
    'Отправьте токен алерт-бота из BotFather одним сообщением сюда. Я удалю сообщение по возможности. Если бот ещё не писал вам в личку, сначала откройте его и нажмите Start. При замене добавьте нового бота в текущий топик до отправки токена.',
    [[button('Отмена', 'mg:alert:cancel')]], fetchImpl);
  if (stage === 'group') return send(env, actorId,
    `Откройте нужный топик подключённой группы поддержки и отправьте от своего имени /alerts${env.MANAGER_BOT_USERNAME ? '@' + String(env.MANAGER_BOT_USERNAME).replace(/^@/, '') : ''}. Алерт-бот должен иметь право писать в этот топик. После проверки бот сообщит о переключении в прежний чат.`,
    [[button('Отмена', 'mg:alert:cancel')]], fetchImpl);
  return renderAlertRecipients(env, db, actorId, nonce, fetchImpl);
}

async function activeOperatorPage(db, page) {
  const safePage = Number.isSafeInteger(Number(page)) ? Math.max(0, Math.min(1000, Number(page))) : 0;
  const size = 20;
  const operators = (await db.prepare('SELECT user_id,first_name,username FROM support_operators WHERE active=1 ORDER BY first_name,user_id LIMIT ? OFFSET ?')
    .bind(size + 1, safePage * size).all()).results || [];
  return { page: safePage, rows: operators.slice(0, size), hasNext: operators.length > size };
}

async function renderAlertRecipients(env, db, actorId, nonce, fetchImpl, page = 0) {
  const flow = await first(db, "SELECT * FROM manager_alert_flows WHERE owner_id=? AND nonce=? AND stage='private' AND expires_at>?", actorId, nonce, now());
  if (!flow) return showAlerts(env, db, actorId, fetchImpl, 'Этот выбор устарел.\n\n');
  const selected = new Set(JSON.parse(flow.recipients_json).map(Number));
  const operators = await activeOperatorPage(db, page);
  const rows = operators.rows.map(person => [button(`${selected.has(Number(person.user_id)) ? '✅' : '☐'} ${opaqueManagerText(safeTitle(person.first_name || person.username || person.user_id).slice(0, 35))}`,
    `mg:alert:toggle:${nonce}:${person.user_id}:${operators.page}`)]);
  const navigation = [
    ...(operators.page ? [button('←', `mg:alert:page:${nonce}:${operators.page - 1}`)] : []),
    ...(operators.hasNext ? [button('→', `mg:alert:page:${nonce}:${operators.page + 1}`)] : []),
  ];
  if (navigation.length) rows.push(navigation);
  rows.push([button(`Подтвердить · ${selected.size} получателей`, `mg:alert:privateok:${nonce}`)],
    [button('Отмена', 'mg:alert:cancel')]);
  return send(env, actorId,
    `Алерты будут приходить в личку вам и отмеченным операторам. Каждый должен сначала нажать Start у алерт-бота. Перед переключением бот проверит доставку всем выбранным.\nСтраница операторов ${operators.page + 1}.`, rows, fetchImpl);
}

async function handleAlertCallback(env, db, actorId, action, nonce, selected, page, fetchImpl) {
  if (actorId !== primaryId(env)) return;
  if (action === 'home') return showAlerts(env, db, actorId, fetchImpl);
  if (action === 'connect') return startAlertFlow(env, db, actorId, 'token', fetchImpl);
  if (action === 'group') return startAlertFlow(env, db, actorId, 'group', fetchImpl);
  if (action === 'private') return startAlertFlow(env, db, actorId, 'private', fetchImpl);
  if (action === 'page') return renderAlertRecipients(env, db, actorId, nonce, fetchImpl, selected);
  if (action === 'cancel') {
    await run(db, 'DELETE FROM manager_alert_flows WHERE owner_id=?', actorId);
    return showAlerts(env, db, actorId, fetchImpl);
  }
  if (action === 'toggle') {
    const flow = await first(db, "SELECT * FROM manager_alert_flows WHERE owner_id=? AND nonce=? AND stage='private' AND expires_at>?", actorId, nonce, now());
    const operatorId = Number(selected);
    if (!flow || !Number.isSafeInteger(operatorId) || operatorId <= 0 || operatorId === actorId
      || !await first(db, 'SELECT 1 AS active FROM support_operators WHERE user_id=? AND active=1', operatorId))
      return showAlerts(env, db, actorId, fetchImpl, 'Этот выбор устарел.\n\n');
    const recipients = new Set(JSON.parse(flow.recipients_json).map(Number));
    if (recipients.has(operatorId)) recipients.delete(operatorId); else recipients.add(operatorId);
    await run(db, "UPDATE manager_alert_flows SET recipients_json=?,updated_at=? WHERE owner_id=? AND nonce=? AND stage='private'",
      JSON.stringify([actorId, ...recipients].filter((id, index, ids) => ids.indexOf(id) === index)), now(), actorId, nonce);
    return renderAlertRecipients(env, db, actorId, nonce, fetchImpl, page);
  }
  if (action === 'privateok') {
    const flow = await first(db, "SELECT * FROM manager_alert_flows WHERE owner_id=? AND nonce=? AND stage='private' AND expires_at>?", actorId, nonce, now());
    if (!flow) return showAlerts(env, db, actorId, fetchImpl, 'Этот выбор устарел.\n\n');
    const recipientIds = JSON.parse(flow.recipients_json).map(Number);
    if (recipientIds[0] !== actorId || new Set(recipientIds).size !== recipientIds.length) throw new ManagerError('Список получателей изменился. Откройте настройку заново.');
    const active = (await db.prepare(`SELECT COUNT(*) AS total FROM support_operators WHERE active=1
      AND user_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(recipientIds.slice(1))).first())?.total || 0;
    if (active !== recipientIds.length - 1) throw new ManagerError('Один из операторов больше не активен. Откройте настройку заново.');
    const result = await alertRpc(env, 'switch', { expectedGeneration: Number(flow.generation), mode: 'private',
      recipientIds });
    await run(db, 'DELETE FROM manager_alert_flows WHERE owner_id=? AND nonce=?', actorId, nonce);
    return showAlerts(env, db, actorId, fetchImpl,
      `✅ Алерты переключены в личку.${result.oldNotified ? '' : '\nПрежний чат недоступен: сообщить там об отключении не удалось.'}\n\n`);
  }
  if (action === 'remove') {
    const status = await alertRpc(env, 'status');
    return send(env, actorId, 'Отключить алерт-бота? Пока не подключите его снова, технические предупреждения и события доступа не будут доставляться.',
      [[button('Да, отключить', `mg:alert:removeok:${status.generation}`)], [button('Отмена', 'mg:alert:home')]], fetchImpl);
  }
  if (action === 'removeok') {
    const generation = Number(nonce);
    if (!Number.isSafeInteger(generation) || generation < 0) return;
    const result = await alertRpc(env, 'remove', { expectedGeneration: generation });
    return showAlerts(env, db, actorId, fetchImpl,
      `Алерт-бот отключён.${result.oldNotified ? '' : '\nПрежний чат недоступен: сообщить там об отключении не удалось.'}\n\n`);
  }
}

async function operatorLoad(db, adminId) {
  const rows = (await db.prepare(`SELECT assigned_to,COUNT(*) AS active_count,
    SUM(CASE WHEN state='needs_reply' OR state='snoozed' AND snoozed_until<=? THEN 1 ELSE 0 END) AS reply_count
    FROM conversation_work WHERE state IN ('needs_reply','waiting','snoozed') AND assigned_to IN
      (SELECT user_id FROM support_operators WHERE active=1 UNION SELECT ?)
    GROUP BY assigned_to`).bind(now(), adminId).all()).results || [];
  return new Map(rows.map(row => [Number(row.assigned_to), row]));
}

function loadLabel(load, operatorId) {
  const row = load.get(Number(operatorId));
  return `${row?.reply_count || 0} ждут · ${row?.active_count || 0} всего`;
}

async function showOperators(env, db, actorId, fetchImpl, page = 0, candidatePage = 0) {
  const primary = Number(actorId) === primaryId(env);
  const total = Number((await first(db, 'SELECT COUNT(*) AS total FROM support_operators WHERE active=1'))?.total || 0);
  const pages = Math.max(1, Math.ceil(total / 20));
  const safePage = Number.isSafeInteger(page) ? Math.max(0, Math.min(page, pages - 1)) : 0;
  const active = (await db.prepare(`SELECT o.user_id,o.first_name,o.username,o.added_at,d.available,d.unreachable_at
    FROM support_operators o LEFT JOIN manager_dm_status d ON d.operator_id=o.user_id
    WHERE o.active=1 ORDER BY o.first_name,o.user_id LIMIT 20 OFFSET ?`).bind(safePage * 20).all()).results || [];
  const load = await operatorLoad(db, primaryId(env));
  const primaryPerson = await first(db, 'SELECT first_name,username,available,unreachable_at FROM manager_dm_status WHERE operator_id=?', primaryId(env));
  const candidateCount = primary ? Number((await first(db, `SELECT COUNT(*) AS total FROM manager_dm_status d
    LEFT JOIN support_operators o ON o.user_id=d.operator_id
    WHERE d.started_at IS NOT NULL AND d.operator_id<>? AND COALESCE(o.active,0)=0`, actorId))?.total || 0) : 0;
  const candidatePages = Math.max(1, Math.ceil(candidateCount / 20));
  const safeCandidatePage = Number.isSafeInteger(candidatePage)
    ? Math.max(0, Math.min(candidatePage, candidatePages - 1)) : 0;
  const candidates = primary ? (await db.prepare(`SELECT d.operator_id,d.first_name,d.username FROM manager_dm_status d
    LEFT JOIN support_operators o ON o.user_id=d.operator_id
    WHERE d.started_at IS NOT NULL AND d.operator_id<>? AND COALESCE(o.active,0)=0
    ORDER BY d.updated_at DESC,d.operator_id DESC LIMIT 20 OFFSET ?`).bind(actorId, safeCandidatePage * 20).all()).results || [] : [];
  const navigation = [];
  if (safePage) navigation.push(button('←', `mg:operators:${safePage - 1}:${safeCandidatePage}`));
  navigation.push(button(`Команда ${safePage + 1} / ${pages}`, `mg:operators:${safePage}:${safeCandidatePage}`));
  if (safePage + 1 < pages) navigation.push(button('→', `mg:operators:${safePage + 1}:${safeCandidatePage}`));
  const candidateNavigation = [];
  if (candidatePages > 1) {
    if (safeCandidatePage) candidateNavigation.push(button('←', `mg:operators:${safePage}:${safeCandidatePage - 1}`));
    candidateNavigation.push(button(`Новые ${safeCandidatePage + 1} / ${candidatePages}`, `mg:operators:${safePage}:${safeCandidatePage}`));
    if (safeCandidatePage + 1 < candidatePages)
      candidateNavigation.push(button('→', `mg:operators:${safePage}:${safeCandidatePage + 1}`));
  }
  const rows = [
    [button(`👑 ${primaryPerson?.first_name ? opaqueManagerText(safeTitle(primaryPerson.first_name).slice(0, 24)) : 'Главный администратор'} · ${loadLabel(load, primaryId(env))}`, `mg:opprimary${safePage ? ':' + safePage : ''}`)],
    ...active.map(person => [button(`${person.unreachable_at ? '⚠️ ' : person.available === 0 ? '⏸ ' : ''}${opaqueManagerText(safeTitle(person.first_name || person.user_id).slice(0, 24))} · ${loadLabel(load, person.user_id)}`, `mg:opcard:${person.user_id}${safePage ? ':' + safePage : ''}`)]),
    ...candidates.map(person => [button(`Добавить ${opaqueManagerText(person.first_name || person.username || person.operator_id)} (${person.operator_id})`,
      `mg:opadd:${person.operator_id}${safePage || safeCandidatePage ? ':' + safePage + ':' + safeCandidatePage : ''}`)]),
    navigation, ...(candidateNavigation.length ? [candidateNavigation] : []), [button('Меню', 'mg:home')],
  ];
  return send(env, actorId,
    `Операторы поддержки · ${total + 1} · страница ${safePage + 1}/${pages}\n\n👑 ${primaryPerson?.first_name ? opaqueManagerText(safeTitle(primaryPerson.first_name)) : 'Главный администратор'} · ${loadLabel(load, primaryId(env))}`
      + (primary ? `\n\nОжидают добавления: ${candidateCount} · страница ${safeCandidatePage + 1}/${candidatePages}. Новый человек сначала отправляет /start управляющему боту.` : ''),
    rows, fetchImpl);
}

async function showPrimaryOperatorCard(env, db, actorId, fetchImpl, page = 0) {
  const id = primaryId(env);
  const person = await first(db, 'SELECT first_name,username,started_at,available,unreachable_at FROM manager_dm_status WHERE operator_id=?', id);
  const load = await operatorLoad(db, id);
  return send(env, actorId, `👑 ${person?.first_name ? opaqueManagerText(safeTitle(person.first_name)) : 'Главный администратор'}\n`
    + `Username: ${person?.username ? opaqueManagerText('@' + safeTitle(person.username)) : '—'}\nTelegram ID: ${id}\n`
    + `Роль: главный администратор\nЛичный чат: ${person?.started_at ? 'открыт' : 'не открыт'}\n`
    + `Доступность: ${person?.unreachable_at ? 'недоступен' : person?.available === 0 ? 'приостановлена' : 'доступен'}\n`
    + `Нагрузка: ${loadLabel(load, id)}`, [[button('К списку', page ? `mg:operators:${page}:0` : 'mg:operators')]], fetchImpl);
}

async function showOperatorCard(env, db, actorId, targetId, fetchImpl, confirmRemoval = false, page = 0) {
  if (!Number.isSafeInteger(targetId) || targetId <= 0) return;
  const person = await first(db, `SELECT o.user_id,o.first_name,o.last_name,o.username,o.added_at,o.added_by_name,
    d.available,d.unreachable_at FROM support_operators o
    LEFT JOIN manager_dm_status d ON d.operator_id=o.user_id WHERE o.user_id=? AND o.active=1`, targetId);
  if (!person) return showOperators(env, db, actorId, fetchImpl, page);
  const primary = Number(actorId) === primaryId(env);
  const load = await operatorLoad(db, primaryId(env));
  const name = safeTitle([person.first_name, person.last_name].filter(Boolean).join(' ') || targetId);
  const text = `${confirmRemoval ? 'Удалить оператора?\n\n' : ''}👤 ${opaqueManagerText(name)}\nUsername: ${person.username ? opaqueManagerText('@' + safeTitle(person.username)) : '—'}`
    + `\nTelegram ID: ${targetId}\nРоль: оператор\nДобавлен: ${person.added_at || '—'}`
    + `\nДобавил: ${opaqueManagerText(safeTitle(person.added_by_name || '—'))}\nНагрузка: ${loadLabel(load, targetId)}`;
  const rows = primary ? [[button(confirmRemoval ? 'Да, удалить' : 'Удалить из операторов',
    `mg:${confirmRemoval ? 'opconfirm' : 'opremove'}:${targetId}${confirmRemoval ? ':' + Date.parse(person.added_at).toString(36) : ''}${page ? ':' + page : ''}`)]] : [];
  rows.push([button(confirmRemoval ? 'К карточке' : 'К списку', confirmRemoval
    ? `mg:opcard:${targetId}${page ? ':' + page : ''}` : page ? `mg:operators:${page}:0` : 'mg:operators')]);
  return send(env, actorId, text, rows, fetchImpl);
}

async function showOperatorAddConfirmation(env, db, actorId, targetId, fetchImpl, page = 0, candidatePage = 0) {
  if (actorId !== primaryId(env) || !Number.isSafeInteger(targetId) || targetId <= 0) return;
  const candidate = await first(db, `SELECT d.first_name,d.username,d.started_at,d.updated_at FROM manager_dm_status d
    LEFT JOIN support_operators o ON o.user_id=d.operator_id
    WHERE d.operator_id=? AND d.started_at IS NOT NULL AND COALESCE(o.active,0)=0`, targetId);
  if (!candidate) return showOperators(env, db, actorId, fetchImpl, page, candidatePage);
  return send(env, actorId,
    `Добавить оператора?\n\n${opaqueManagerText(safeTitle(candidate.first_name || candidate.username || targetId))}\nTelegram ID: ${targetId}`
      + '\nПосле добавления он получит доступ к управлению обращениями.',
    [[button('Да, добавить', `mg:opaddconfirm:${targetId}:${Date.parse(candidate.updated_at).toString(36)}`
      + (page || candidatePage ? `:${page}:${candidatePage}` : ''))],
      [button('К списку', page || candidatePage ? `mg:operators:${page}:${candidatePage}` : 'mg:operators')]], fetchImpl);
}

async function changeOperator(env, db, actorId, targetId, action, fetchImpl, expectedAddedAt = null, page = 0,
  candidatePage = 0) {
  if (Number(actorId) !== primaryId(env) || !Number.isSafeInteger(targetId) || targetId <= 0 || targetId === actorId) return;
  if (action === 'opadd') {
    const dm = await first(db, 'SELECT started_at,updated_at,first_name,username FROM manager_dm_status WHERE operator_id=?', targetId);
    if (!dm?.started_at || Date.parse(dm.updated_at) !== expectedAddedAt)
      return showOperatorAddConfirmation(env, db, actorId, targetId, fetchImpl, page, candidatePage);
    if (await first(db, 'SELECT 1 AS active FROM support_operators WHERE user_id=? AND active=1', targetId))
      return showOperators(env, db, actorId, fetchImpl, page, candidatePage);
    const added = await run(db, `INSERT INTO support_operators(user_id,first_name,username,active,added_by,added_by_name,added_at)
      VALUES(?,?,?,1,?,'Главный администратор',?) ON CONFLICT(user_id) DO UPDATE SET
      active=1,first_name=excluded.first_name,username=excluded.username,added_by=excluded.added_by,
      added_by_name=excluded.added_by_name,added_at=excluded.added_at,removed_by=NULL,removed_by_name=NULL,removed_at=NULL
      WHERE support_operators.active=0`,
    targetId, safeTitle(dm.first_name || `Оператор ${targetId}`), dm.username || null, actorId, now());
    if (added.meta?.changes) await setOperatorAvailability(db, { operatorId: targetId, available: true });
  } else if (action === 'opremove') {
    const current = await first(db, 'SELECT added_at FROM support_operators WHERE user_id=? AND active=1', targetId);
    if (!current || Date.parse(current.added_at) !== expectedAddedAt)
      return showOperatorCard(env, db, actorId, targetId, fetchImpl, false, page);
    if (env.ALERT_SETTINGS) {
      const alerts = await alertRpc(env, 'status');
      if (alerts.mode === 'private' && alerts.recipients?.includes(targetId)) {
        await alertRpc(env, 'switch', { expectedGeneration: alerts.generation, mode: 'private',
          recipientIds: alerts.recipients.filter(id => id !== targetId) });
      }
    }
    const removed = await run(db, `UPDATE support_operators SET active=0,removed_by=?,removed_by_name='Главный администратор',removed_at=?
      WHERE user_id=? AND active=1 AND added_at=?`, actorId, now(), targetId, current.added_at);
    if (removed.meta?.changes) await setOperatorAvailability(db, { operatorId: targetId, available: false, adminId: actorId });
  }
  return showOperators(env, db, actorId, fetchImpl, page, candidatePage);
}

async function rememberWorkList(db, actorId, route) {
  await run(db, `INSERT INTO manager_work_navigation(operator_id,list_route,card_route,updated_at)
    VALUES(?,?,'',?) ON CONFLICT(operator_id) DO UPDATE SET
    list_route=excluded.list_route,card_route='',updated_at=excluded.updated_at`, actorId, route, now());
}

async function rememberWorkCard(db, actorId, key, userId) {
  await run(db, 'UPDATE manager_work_navigation SET card_route=?,updated_at=? WHERE operator_id=?',
    `mg:work:${key}:${userId}`, now(), actorId);
}

async function forgetWorkCard(db, actorId) {
  await run(db, "UPDATE manager_work_navigation SET card_route='',updated_at=? WHERE operator_id=?", now(), actorId);
}

async function workListContext(db, actorId, key, userId) {
  const context = await first(db, `SELECT list_route FROM manager_work_navigation
    WHERE operator_id=? AND card_route=? AND updated_at>?`, actorId, `mg:work:${key}:${userId}`,
  new Date(Date.now() - 30 * 60_000).toISOString());
  return context?.list_route || null;
}

async function showMyWork(env, db, actorId, fetchImpl, scope = 'mine', page = 0) {
  const locale = await getManagerLanguage(db, actorId);
  if (!['mine', 'all', 'urgent', 'urgentall'].includes(scope)) return;
  const all = scope === 'all' || scope === 'urgentall';
  const urgent = scope === 'urgent' || scope === 'urgentall';
  if (all && Number(actorId) !== primaryId(env)) return;
  if (!Number.isSafeInteger(page) || page < 0 || page > 10000) return;
  const pageSize = 20;
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const activeBotIds = JSON.stringify(registry.filter(config => config.enabled).map(config => config.id));
  const rows = (await db.prepare(`SELECT w.bot_id,w.user_id,w.state,w.last_inbound_at,w.cycle_started_at,
      c.support_group_id,c.thread_id,c.first_name,c.last_name,c.username,
      CASE WHEN w.state='needs_reply' AND w.cycle_started_at IS NOT NULL
        AND datetime(w.cycle_started_at)<=datetime('now','-' || COALESCE(r.reminder_minutes,30) || ' minutes')
        THEN 1 ELSE 0 END AS overdue
      FROM conversation_work w JOIN conversations c
      ON c.bot_id=w.bot_id AND c.user_id=w.user_id
      LEFT JOIN service_responsibility r ON r.bot_id=w.bot_id
      WHERE w.bot_id IN (SELECT value FROM json_each(?))
      AND (? IS NULL OR w.assigned_to=?) AND w.state IN ('needs_reply','snoozed','waiting')
      AND (?=0 OR (w.state='needs_reply' AND w.cycle_started_at IS NOT NULL
        AND datetime(w.cycle_started_at)<=datetime('now','-' || COALESCE(r.reminder_minutes,30) || ' minutes')))
      ORDER BY CASE w.state WHEN 'needs_reply' THEN 0 WHEN 'snoozed' THEN 1 ELSE 2 END,
        COALESCE(w.cycle_started_at,w.last_inbound_at,w.updated_at),w.bot_id,w.user_id LIMIT ? OFFSET ?`)
    .bind(activeBotIds, all ? null : actorId, actorId, urgent ? 1 : 0, pageSize + 1, page * pageSize).all()).results || [];
  const names = new Map(registry.map(config => [config.id, config.displayName]));
  const buttons = rows.slice(0, pageSize).filter(row => Number.isSafeInteger(Number(row.support_group_id)) && Number(row.thread_id) > 1)
    .map(row => {
      const client = safeTitle(customerName(row)).slice(0, 20);
      const service = safeTitle(names.get(row.bot_id) || row.bot_id).slice(0, 16);
      const age = row.state === 'needs_reply' ? ` · ${workAge(row.cycle_started_at || row.last_inbound_at, locale)}` : '';
      return [button(`${row.overdue ? '🔥' : { needs_reply: '📥', snoozed: '⏰', waiting: '💬' }[row.state]} ${opaqueManagerText(service)} · ${opaqueManagerText(client)}${age}`,
        `mg:pw:${managementBotKey(registry, row.bot_id)}:${row.user_id}:${workScopes.indexOf(scope)}:${page.toString(36)}`),
      { text: 'Тема', url: `https://t.me/c/${String(row.support_group_id).replace(/^-100/, '')}/${row.thread_id}` }];
    });
  if (page > 0 || rows.length > pageSize) buttons.push([
    ...(page > 0 ? [button('← Назад', `mg:page:${scope}:${page - 1}`)] : []),
    ...(rows.length > pageSize ? [button('Далее →', `mg:page:${scope}:${page + 1}`)] : []),
  ]);
  buttons.push([button('Назад к сервисам', 'mg:home')]);
  await rememberWorkList(db, actorId, `mg:page:${scope}:${page}`);
  return send(env, actorId, (rows.length ? `${urgent ? all ? 'Просроченные обращения команды' : 'Ваши просроченные обращения' : all ? 'Текущие обращения команды' : 'Ваши текущие обращения'} · страница ${page + 1}:`
    : page > 0 ? 'На этой странице обращений больше нет.'
      : urgent ? all ? 'Сейчас нет просроченных обращений во всей команде.'
        : 'Сейчас за вами нет просроченных обращений.'
        : all ? 'Сейчас нет открытых обращений.' : 'Сейчас за вами нет открытых обращений.')
    + (rows.length ? '\n\n' + opaqueManagerText(messageDeletionWarning(locale)) : ''), buttons, fetchImpl);
}

async function showQueues(env, db, actorId, registry, key, filter, page, fetchImpl) {
  const locale = await getManagerLanguage(db, actorId);
  const config = key === 'a' ? null : managementBotFromKey(registry, key);
  if (key !== 'a' && !config?.enabled || !WORK_FILTERS.includes(filter)) return;
  const safePage = Number.isSafeInteger(Number(page)) ? Math.max(0, Math.min(1000, Number(page))) : 0;
  const options = { botId: config?.id || null, botIds: registry.filter(item => item.enabled).map(item => item.id), actor: actorId };
  const [counts, result] = await Promise.all([workCounts(db, options), workQueue(db, { ...options, filter, page: safePage })]);
  const labels = { needs: 'Нужен ответ', mine: 'Мои', waiting: 'Ждём клиента',
    today: 'Вернуться сегодня', resolved: 'Решено', all: 'Все' };
  const rows = result.rows.map(item => {
    const service = registry.find(entry => entry.id === item.bot_id);
    if (!service) return null;
    const name = customerName(item);
    return [button(`${opaqueManagerText(safeTitle(service.displayName).slice(0, 12))} · ${opaqueManagerText(safeTitle(name).slice(0, 22))} · ${workStateLabel(item, locale)}`,
      `mg:qw:${managementBotKey(registry, item.bot_id)}:${item.user_id}:${key}:${WORK_FILTERS.indexOf(filter)}:${safePage.toString(36)}`)];
  }).filter(Boolean);
  const nav = [];
  if (safePage) nav.push(button('←', `mg:queue:${key}:${filter}:${safePage - 1}`));
  if (result.hasNext) nav.push(button('→', `mg:queue:${key}:${filter}:${safePage + 1}`));
  if (nav.length) rows.push(nav);
  for (let i = 0; i < WORK_FILTERS.length; i += 2) rows.push(WORK_FILTERS.slice(i, i + 2).map(next =>
    button(`${next === filter ? '✓ ' : ''}${labels[next]} · ${counts?.[next] || 0}`, `mg:queue:${key}:${next}:0`)));
  rows.push([button('Выбрать сервис', `mg:queuebots:${filter}`), button('Меню', 'mg:home')]);
  const summaries = result.rows.map(item => {
    const name = customerName(item);
    return `${opaqueManagerText(safeTitle(name))} · ${workStateLabel(item, locale)} · ${workAge(item.last_inbound_at || item.updated_at, locale)} · ${opaqueManagerText(assigneeLabel(item, actorId, primaryId(env), locale))}`;
  });
  await rememberWorkList(db, actorId, `mg:queue:${key}:${filter}:${safePage}`);
  return send(env, actorId, `${labels[filter]} · ${config ? opaqueManagerText(config.displayName) : translateManager(locale, 'все сервисы')}\nНайдено: ${result.total} · страница ${safePage + 1}\n\n`
    + (summaries.join('\n') || 'В этой очереди обращений нет.'), rows, fetchImpl);
}

async function showWorkCard(env, db, actorId, config, userId, fetchImpl, prefix = '') {
  const locale = await getManagerLanguage(db, actorId);
  const work = await readWork(db, config.id, userId);
  const conversation = await first(db, 'SELECT support_group_id,thread_id,status,first_name,last_name,username FROM conversations WHERE bot_id=? AND user_id=?',
    config.id, userId);
  if (!conversation) return send(env, actorId, 'Обращение больше не найдено. Обновите список.', [[button('Мои обращения', 'mg:mine')]], fetchImpl);
  const key = managementBotKey(parseBotRegistry(env.BOT_REGISTRY), config.id);
  const listRoute = await workListContext(db, actorId, key, userId);
  const name = customerName(conversation, userId);
  const link = `https://t.me/c/${String(conversation.support_group_id).replace(/^-100/, '')}/${conversation.thread_id}`;
  const text = `${prefix}${opaqueManagerText(config.displayName)} · ${opaqueManagerText(name)}\nСостояние темы: ${conversation.status === 'closed' ? 'закрыта' : 'открыта'}`
    + (work ? `\nСостояние очереди: ${workStateLabel(work, locale)}\nОжидание: ${workAge(work.cycle_started_at || work.last_inbound_at, locale)}\nОтветственный: ${assigneeLabel(work, actorId, primaryId(env), locale)}`
      + `${work.snoozed_until ? `\nВернуться: ${workDate(work.snoozed_until, locale)}` : ''}`
      + `${work.last_inbound_at ? `\nПоследнее входящее: ${workDate(work.last_inbound_at, locale)}` : ''}`
      + `${work.last_answer_at ? `\nПодтверждённый ответ: ${workDate(work.last_answer_at, locale)}` : ''}`
      + `${work.note ? `\nЗаметка: ${opaqueManagerText(work.note)}` : ''}` : '\nЗаписи в очереди операторов нет.');
  const action = name => `mg:act:${name}:${key}:${userId}:${work.revision}`;
  const rows = [[{ text: 'Перейти в тему', url: link }]];
  if (work) {
    if (!work.assigned_to) rows.push([button('Взять', action('take'))]);
    else rows.push([button('Снять назначение', action('release'))]);
    rows.push([button(work.state === 'needs_reply' ? 'Ждём клиента' : 'Вернуть в работу',
      action(work.state === 'needs_reply' ? 'waiting' : 'needs')),
    ...(work.state === 'resolved' ? [] : [button('Решено', action('resolve'))])]);
    rows.push([button('Отложить на час', action('snooze')), button('Завтра в 09:00', action('tomorrow'))]);
    rows.push([button('Передать с заметкой', `mg:transfer:${key}:${userId}:${work.revision}`)]);
  }
  rows.push([button(conversation.status === 'closed' ? 'Открыть тему' : 'Закрыть тему',
    `mg:topic:${conversation.status === 'closed' ? 'open' : 'close'}:${key}:${userId.toString(36)}:${Number(conversation.support_group_id).toString(36)}:${Number(conversation.thread_id).toString(36)}`)]);
  rows.push([button('Доставка', `mg:diag:${key}:${userId}:0`)]);
  rows.push([button('Доступ и модерация', `mu:card:${key}:${userId}`)]);
  if (listRoute) rows.push([button('К результатам', `mg:workreturn:${key}:${userId}`),
    ...(listRoute.startsWith('mg:queue:') ? [button('Следующее →', `mg:worknext:${key}:${userId}`)] : [])]);
  rows.push([button('Мои обращения', 'mg:mine')]);
  return send(env, actorId, text + '\n\n' + opaqueManagerText(messageDeletionWarning(locale, config.username)), rows, fetchImpl);
}

async function returnToWorkList(env, db, actorId, registry, key, userId, fetchImpl) {
  const route = await workListContext(db, actorId, key, userId);
  if (!route) return showMyWork(env, db, actorId, fetchImpl);
  const queue = /^mg:queue:(a|b[0-9a-z]{13}):(needs|mine|waiting|today|resolved|all):(\d+)$/.exec(route);
  if (queue) return showQueues(env, db, actorId, registry, queue[1], queue[2], Number(queue[3]), fetchImpl);
  const personal = /^mg:page:(mine|all|urgent|urgentall):(\d+)$/.exec(route);
  if (personal) return showMyWork(env, db, actorId, fetchImpl, personal[1], Number(personal[2]));
  return showMyWork(env, db, actorId, fetchImpl);
}

async function showNextWorkCard(env, db, actorId, registry, key, userId, fetchImpl) {
  const currentConfig = managementBotFromKey(registry, key);
  if (!currentConfig?.enabled || !Number.isSafeInteger(userId) || userId <= 0) return;
  const route = await workListContext(db, actorId, key, userId);
  const queue = /^mg:queue:(a|b[0-9a-z]{13}):(needs|mine|waiting|today|resolved|all):(\d+)$/.exec(route || '');
  if (!queue) return showWorkCard(env, db, actorId, currentConfig, userId, fetchImpl);
  const config = queue[1] === 'a' ? null : managementBotFromKey(registry, queue[1]);
  if (queue[1] !== 'a' && !config?.enabled) return showMyWork(env, db, actorId, fetchImpl);
  const options = { botId: config?.id || null, botIds: registry.filter(item => item.enabled).map(item => item.id),
    filter: queue[2], actor: actorId };
  const page = Number(queue[3]);
  const current = await workQueue(db, { ...options, page });
  const index = current.rows.findIndex(row => row.bot_id === currentConfig.id
    && Number(row.user_id) === userId);
  let next = current.rows[index + 1], nextPage = page;
  if (!next && current.hasNext) {
    nextPage++;
    next = (await workQueue(db, { ...options, page: nextPage })).rows[0];
  }
  if (!next) return send(env, actorId, 'В этой части очереди больше нет обращений.',
    [[button('К очереди', `mg:queue:${queue[1]}:${queue[2]}:${page}`)]], fetchImpl);
  const nextConfig = registry.find(item => item.id === next.bot_id && item.enabled);
  if (!nextConfig) return showQueues(env, db, actorId, registry, queue[1], queue[2], nextPage, fetchImpl);
  const nextKey = managementBotKey(registry, next.bot_id);
  if (nextPage !== page) await rememberWorkList(db, actorId, `mg:queue:${queue[1]}:${queue[2]}:${nextPage}`);
  await rememberWorkCard(db, actorId, nextKey, Number(next.user_id));
  return showWorkCard(env, db, actorId, nextConfig, Number(next.user_id), fetchImpl);
}

async function showTopicWorkCard(env, db, config, userId, chatId, threadId, fetchImpl, messageId = null, prefix = '', actorId = null) {
  const locale = languageOrDefault(config.locale);
  const work = await readWork(db, config.id, userId);
  const conversation = await first(db, `SELECT support_group_id,thread_id,status,first_name,last_name,username
    FROM conversations WHERE bot_id=? AND user_id=?`, config.id, userId);
  if (Number(conversation?.support_group_id) !== chatId || Number(conversation.thread_id) !== threadId) return;
  const key = managementBotKey(parseBotRegistry(env.BOT_REGISTRY), config.id);
  const name = customerName(conversation, userId);
  const action = name => `mt:act:${name}:${key}:${userId}:${work.revision}`;
  const rows = [];
  if (work) {
    if (!work.assigned_to) rows.push([button('Взять', action('take'))]);
    else rows.push([button('Снять назначение', action('release'))]);
    rows.push([button(work.state === 'needs_reply' ? 'Ждём клиента' : 'Вернуть в работу',
      action(work.state === 'needs_reply' ? 'waiting' : 'needs')),
    ...(work.state === 'resolved' ? [] : [button('Решено', action('resolve'))])]);
    rows.push([button('Отложить на час', action('snooze')), button('Завтра в 09:00', action('tomorrow'))]);
  }
  rows.push([button(conversation.status === 'closed' ? 'Открыть тему' : 'Закрыть тему',
    `mt:topic:${conversation.status === 'closed' ? 'open' : 'close'}:${key}:${userId}`)]);
  const managerName = String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, '');
  if (managerName) rows.push(
    [{ text: 'Сведения и модерация', url: `https://t.me/${managerName}?start=user_${key}_${userId}` },
      { text: 'История', url: `https://t.me/${managerName}?start=history_${key}_${userId}` }],
    [{ text: 'Передать с заметкой в личке',
      url: `https://t.me/${managerName}?start=case_${key}_${userId}` }]);
  const rawText = `Обращение · ${opaqueManagerText(config.displayName)} · ${opaqueManagerText(name)}\n${prefix}Состояние: ${work ? workStateLabel(work, locale) : 'нет записи очереди'}`
    + (work ? `\nОжидание: ${workAge(work.cycle_started_at || work.last_inbound_at, locale)}`
      + `\nОтветственный: ${assigneeLabel(work, actorId, primaryId(env), locale)}`
      + `${work.snoozed_until ? `\nВернуться: ${workDate(work.snoozed_until, locale)}` : ''}`
      + `${work.last_inbound_at ? `\nПоследнее входящее: ${workDate(work.last_inbound_at, locale)}` : ''}`
      + `${work.last_answer_at ? `\nПодтверждённый ответ: ${workDate(work.last_answer_at, locale)}` : ''}`
      + `${work.note ? `\nЗаметка: ${opaqueManagerText(work.note)}` : ''}` : '');
  const screen = translateManagerScreen(locale, rawText, rows);
  const method = messageId ? 'editMessageText' : 'sendMessage';
  const body = {
    chat_id: chatId, ...(messageId ? { message_id: messageId } : { message_thread_id: threadId }),
    text: screen.text + '\n\n' + messageDeletionWarning(locale, config.username), reply_markup: { inline_keyboard: screen.markup },
  };
  const edited = method === 'sendMessage' ? await sendManagerMessage(env, body, fetchImpl)
    : await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method, body, fetchImpl, timeoutMs: 10000 });
  if (!messageId && !edited.ok) {
    if (edited.deliveryUncertain) throw new ManagerError(
      'Неизвестно, появилась ли карточка обращения. Проверьте тему перед повтором /case.');
    throw new ManagerError(edited.rateLimited
      ? `Telegram временно ограничил запросы. Повторите через ${edited.retryAfterSeconds || 60} сек.`
      : 'Не удалось показать карточку обращения. Повторите /case позже.', edited.retryable);
  }
  if (!messageId) return edited.result;
  if (!edited.ok && !/message is not modified/i.test(edited.description || ''))
    throw new ManagerError('Не удалось обновить карточку обращения. Откройте её командой /case.',
      edited.retryable || edited.deliveryUncertain);
  return edited.result;
}

async function runWorkAction(env, db, actorId, config, userId, revision, action, fetchImpl) {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(revision) || revision < 0) return;
  if (!['take', 'release', 'snooze', 'tomorrow', 'waiting', 'needs', 'resolve'].includes(action)) return;
  const result = await changeWork(db, { botId: config.id, userId, actor: actorId, revision,
    action: action === 'tomorrow' ? 'snooze' : action,
    until: action === 'snooze' ? new Date(Date.now() + 3600000).toISOString()
      : action === 'tomorrow' ? tomorrowMorning() : null,
    audit: { actorName: String(actorId), action: `manager_work_${action}` } });
  return showWorkCard(env, db, actorId, config, userId, fetchImpl,
    result ? '✅ Изменение сохранено.\n\n' : 'Состояние уже изменилось. Показаны свежие данные.\n\n');
}

async function showDrafts(env, db, actorId, registry, fetchImpl, page = 0) {
  const currentPage = Number.isSafeInteger(Number(page)) ? Math.max(0, Math.min(1000, Number(page))) : 0;
  const pageSize = 8;
  const [messages, activeMessage, work, notes, moderation, legacyWork] = await Promise.all([
    db.prepare('SELECT bot_id,field FROM bot_message_drafts WHERE owner_id=? ORDER BY updated_at DESC,bot_id,field LIMIT ? OFFSET ?')
      .bind(actorId, pageSize + 1, currentPage * pageSize).all(),
    first(db, 'SELECT bot_id,field,nonce FROM bot_message_flows WHERE owner_id=? AND chat_id=? AND expires_at>?', actorId, actorId, now()),
    first(db, 'SELECT bot_id,user_id,stage,nonce FROM manager_work_flows WHERE operator_id=? AND expires_at>?', actorId, now()),
    db.prepare('SELECT bot_id,user_id FROM operator_note_drafts WHERE operator_id=? ORDER BY updated_at DESC,bot_id,user_id LIMIT ? OFFSET ?')
      .bind(actorId, pageSize + 1, currentPage * pageSize).all(),
    first(db, 'SELECT management_bot_id,target_bot_id,user_id,stage,flow_nonce,expected_state_key FROM operator_pending_actions WHERE operator_id=? AND expires_at>?', actorId, now()),
    first(db, 'SELECT bot_id,user_id FROM operator_work_inputs WHERE operator_id=? AND user_id>0 AND expires_at>?', actorId, now()),
  ]);
  const available = new Map(registry.filter(config => config.enabled).map(config => [config.id, config]));
  const rows = [];
  if (actorId === primaryId(env) && activeMessage?.nonce && available.has(activeMessage.bot_id)) rows.push([button(
    `Продолжить редактирование · ${opaqueManagerText(available.get(activeMessage.bot_id).displayName)}`,
    `mg:draftmsg:${activeMessage.nonce}`)]);
  for (const draft of (messages.results || []).slice(0, pageSize)) {
    const config = available.get(draft.bot_id), field = draft.field === 'welcome_text' ? 'w' : draft.field === 'auto_reply_text' ? 'a' : null;
    if (actorId === primaryId(env) && config && field) rows.push([button(`${field === 'w' ? 'Приветствие' : 'Автоответ'} · ${opaqueManagerText(config.displayName)}`,
      `mg:msg:${managementBotKey(registry, config.id)}:${field}:restore`)]);
  }
  if (work && available.has(work.bot_id)) rows.push([button(
    `Передача обращения · ${opaqueManagerText(available.get(work.bot_id).displayName)} · ${work.user_id}`, `mg:draftwork:${work.nonce}`)]);
  for (const draft of (notes.results || []).slice(0, pageSize)) {
    const config = available.get(draft.bot_id);
    if (config) rows.push([button(`Сохранённая заметка · ${opaqueManagerText(config.displayName)} · ${draft.user_id}`,
      `mg:draftnote:${managementBotKey(registry, config.id)}:${draft.user_id}`)]);
  }
  if (legacyWork && available.has(legacyWork.bot_id)) rows.push([button(
    `Начать передачу заново · ${opaqueManagerText(available.get(legacyWork.bot_id).displayName)} · ${legacyWork.user_id}`,
    `mg:work:${managementBotKey(registry, legacyWork.bot_id)}:${legacyWork.user_id}`)]);
  if (moderation?.management_bot_id === '__manager__') rows.push([button('Незавершённая модерация', 'mu:resume')]);
  else if (moderation?.expected_state_key && available.has(moderation.target_bot_id) && Number(moderation.user_id) > 0
    && ['reason', 'duration', 'confirm'].includes(moderation.stage))
    rows.push([button('Продолжить действие из старого меню', `mg:importpending:${moderation.flow_nonce}`)]);
  else if (moderation) rows.push([button('Старое действие: начните заново через Пользователи', 'mu:home:a')]);
  const navigation = [
    ...(currentPage ? [button('←', `mg:drafts:${currentPage - 1}`)] : []),
    ...((messages.results || []).length > pageSize || (notes.results || []).length > pageSize
      ? [button('→', `mg:drafts:${currentPage + 1}`)] : []),
  ];
  if (navigation.length) rows.push(navigation);
  rows.push([button('Меню', 'mg:home')]);
  return send(env, actorId, rows.length === 1 ? 'Черновиков нет.'
    : `Черновики и незавершённые действия · страница ${currentPage + 1}. Выберите запись для продолжения.`, rows, fetchImpl);
}

async function resumeTransferDraft(env, db, actorId, nonce, fetchImpl) {
  const flow = await first(db, 'SELECT * FROM manager_work_flows WHERE operator_id=? AND nonce=? AND expires_at>?', actorId, nonce, now());
  if (!flow) return send(env, actorId, 'Черновик передачи устарел.', [[button('Черновики', 'mg:drafts')]], fetchImpl);
  const config = parseBotRegistry(env.BOT_REGISTRY).find(item => item.id === flow.bot_id && item.enabled);
  if (!config) return send(env, actorId, 'Сервис больше не подключён.', [[button('Черновики', 'mg:drafts')]], fetchImpl);
  if (flow.stage === 'choose') return beginTransfer(env, db, actorId, config, Number(flow.user_id), Number(flow.expected_revision), fetchImpl);
  await run(db, 'UPDATE manager_work_flows SET suspended=0 WHERE operator_id=? AND nonce=?', actorId, nonce);
  if (flow.stage === 'note') return send(env, actorId, 'Продолжите передачу: отправьте внутреннюю заметку одним сообщением.',
    [[button('Отмена', `mg:abort:${nonce}`)]], fetchImpl);
  if (flow.stage === 'confirm') return send(env, actorId,
    `Подтвердите передачу обращения ${flow.user_id} оператору ${flow.target_id}. Заметка:\n\n${opaqueManagerText(flow.note)}`,
    [[button('Подтвердить передачу', `mg:commit:${nonce}`)], [button('Отмена', `mg:abort:${nonce}`)]], fetchImpl);
  return send(env, actorId, 'Этот черновик уже обрабатывается. Откройте карточку обращения.',
    [[button('Мои обращения', 'mg:mine')]], fetchImpl);
}

// Switching screens pauses text forms. Explicit "Черновики" actions resume them.
async function suspendPrivateInputs(db, actorId, route) {
  const target = String(route || '');
  const statements = [];
  if (!/^mg:stats:(?:periodset:custom|config:)/.test(target))
    statements.push(db.prepare('UPDATE manager_statistics_preferences SET input_kind=NULL WHERE operator_id=? AND input_kind IS NOT NULL').bind(actorId));
  if (!['/start', '/menu', '/groups'].includes(target))
    statements.push(db.prepare("UPDATE manager_home_screens SET requested_at='1970-01-01T00:00:00.000Z',message_id=NULL WHERE operator_id=? AND claim_token IS NULL").bind(actorId));
  if (!['mu:search', 'mu:searchcancel', 'mg:search', '/user'].includes(target))
    statements.push(db.prepare('DELETE FROM manager_search_flows WHERE operator_id=?').bind(actorId));
  if (!/^mu:(resume|cancel|confirm|revise|act|restrict|period):/.test(target))
    statements.push(db.prepare("UPDATE operator_pending_actions SET suspended=1 WHERE operator_id=? AND management_bot_id='__manager__' AND suspended=0").bind(actorId));
  if (!/^mg:(to|commit|abort|draftwork|transfer|transferpage):/.test(target))
    statements.push(db.prepare('UPDATE manager_work_flows SET suspended=1 WHERE operator_id=? AND suspended=0').bind(actorId));
  if (!/^mg:(msgsave|msgcancel|msgrevise|draftmsg):/.test(target))
    statements.push(db.prepare('UPDATE bot_message_flows SET suspended=1 WHERE owner_id=? AND chat_id=? AND suspended=0').bind(actorId, actorId));
  if (statements.length) await db.batch(statements);
}

async function restoreLegacyNote(env, db, actorId, config, userId, fetchImpl) {
  const draft = await first(db, 'SELECT target_operator,draft FROM operator_note_drafts WHERE operator_id=? AND bot_id=? AND user_id=?',
    actorId, config.id, userId);
  if (!draft) return send(env, actorId, 'Черновик заметки больше не найден.', [[button('Черновики', 'mg:drafts')]], fetchImpl);
  const work = await readWork(db, config.id, userId);
  if (!work || work.state === 'resolved') return send(env, actorId,
    'Обращение уже завершено. Черновик сохранён; откройте карточку и проверьте состояние.',
    [[button('Работа с обращением', `mg:work:${managementBotKey(parseBotRegistry(env.BOT_REGISTRY), config.id)}:${userId}`)]], fetchImpl);
  const allowed = Number(draft.target_operator) === primaryId(env) || Boolean(await first(db,
    'SELECT 1 AS allowed FROM support_operators WHERE user_id=? AND active=1', draft.target_operator));
  const contact = await first(db, 'SELECT started_at,available,unreachable_at FROM manager_dm_status WHERE operator_id=?', draft.target_operator);
  if (!allowed || !contact?.started_at || Number(contact.available) !== 1 || contact.unreachable_at) return send(env, actorId,
    'Прежний получатель недоступен. Заметка сохранена; откройте обращение и выберите нового ответственного.',
    [[button('Работа с обращением', `mg:work:${managementBotKey(parseBotRegistry(env.BOT_REGISTRY), config.id)}:${userId}`)]], fetchImpl);
  const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  await run(db, `INSERT INTO manager_work_flows(operator_id,bot_id,user_id,expected_revision,target_id,note,stage,nonce,expires_at,updated_at)
    VALUES(?,?,?,?,?,?,'confirm',?,?,?) ON CONFLICT(operator_id) DO UPDATE SET bot_id=excluded.bot_id,
      user_id=excluded.user_id,expected_revision=excluded.expected_revision,target_id=excluded.target_id,note=excluded.note,
      stage='confirm',nonce=excluded.nonce,expires_at=excluded.expires_at,updated_at=excluded.updated_at,suspended=0`,
  actorId, config.id, userId, work.revision, draft.target_operator, draft.draft, nonce, later(), now());
  return resumeTransferDraft(env, db, actorId, nonce, fetchImpl);
}

async function beginTransfer(env, db, actorId, config, userId, revision, fetchImpl) {
  const work = await readWork(db, config.id, userId);
  if (!work || work.revision !== revision || work.state === 'resolved') return showWorkCard(env, db, actorId, config, userId, fetchImpl, 'Состояние уже изменилось.\n\n');
  const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  await run(db, `INSERT INTO manager_work_flows(operator_id,bot_id,user_id,expected_revision,stage,nonce,expires_at,updated_at)
    VALUES(?,?,?,?,'choose',?,?,?) ON CONFLICT(operator_id) DO UPDATE SET
    bot_id=excluded.bot_id,user_id=excluded.user_id,expected_revision=excluded.expected_revision,
    target_id=NULL,note=NULL,stage='choose',nonce=excluded.nonce,expires_at=excluded.expires_at,updated_at=excluded.updated_at,suspended=0`,
  actorId, config.id, userId, revision, nonce, later(), now());
  return showTransferTargets(env, db, actorId, nonce, fetchImpl);
}

async function showTransferTargets(env, db, actorId, nonce, fetchImpl, page = 0) {
  const flow = await first(db, "SELECT bot_id FROM manager_work_flows WHERE operator_id=? AND nonce=? AND stage='choose' AND suspended=0 AND expires_at>?", actorId, nonce, now());
  if (!flow || !parseBotRegistry(env.BOT_REGISTRY).some(item => item.id === flow.bot_id && item.enabled)) return send(env, actorId, 'Выбор оператора устарел. Откройте обращение заново.',
    [[button('Мои обращения', 'mg:mine')]], fetchImpl);
  const operators = await activeOperatorPage(db, page);
  const choices = [...(operators.page === 0 ? [{ user_id: primaryId(env), first_name: 'Главный администратор', synthetic: true }] : []), ...operators.rows];
  const load = await operatorLoad(db, primaryId(env));
  const contacts = (await db.prepare(`SELECT operator_id,available,unreachable_at,started_at FROM manager_dm_status
    WHERE operator_id IN (SELECT user_id FROM support_operators WHERE active=1 UNION SELECT ?)`)
    .bind(primaryId(env)).all()).results || [];
  const contactById = new Map(contacts.map(contact => [Number(contact.operator_id), contact]));
  const rows = choices.map(person => {
    const contact = contactById.get(Number(person.user_id));
    const unavailable = !contact?.started_at || Number(contact.available) !== 1 || contact.unreachable_at;
    const name = safeTitle(person.first_name || person.username || String(person.user_id)).slice(0, 24);
    return [button(`${unavailable ? '⏸ ' : ''}${person.synthetic ? name : opaqueManagerText(name)} · ${loadLabel(load, person.user_id)}`,
      `mg:to:${nonce}:${person.user_id}`)];
  });
  const navigation = [
    ...(operators.page ? [button('←', `mg:transferpage:${nonce}:${operators.page - 1}`)] : []),
    ...(operators.hasNext ? [button('→', `mg:transferpage:${nonce}:${operators.page + 1}`)] : []),
  ];
  if (navigation.length) rows.push(navigation);
  return send(env, actorId, `Выберите нового ответственного. Затем напишите внутреннюю заметку: клиент её не получит.\nСтраница ${operators.page + 1}.`, rows, fetchImpl);
}

async function chooseTransferTarget(env, db, actorId, nonce, targetId, fetchImpl) {
  const flow = await first(db, "SELECT * FROM manager_work_flows WHERE operator_id=? AND nonce=? AND stage='choose' AND suspended=0 AND expires_at>?", actorId, nonce, now());
  if (!flow || !Number.isSafeInteger(targetId) || targetId <= 0) return;
  const authorized = targetId === primaryId(env) || Boolean(await first(db, 'SELECT 1 AS allowed FROM support_operators WHERE user_id=? AND active=1', targetId));
  const contact = await first(db, 'SELECT started_at,available,unreachable_at FROM manager_dm_status WHERE operator_id=?', targetId);
  if (!authorized || !contact?.started_at || Number(contact.available) !== 1 || contact.unreachable_at) {
    throw new ManagerError('Оператор должен сначала открыть /start в личке управляющего бота и быть доступным.');
  }
  await run(db, "UPDATE manager_work_flows SET target_id=?,stage='note',updated_at=? WHERE operator_id=? AND nonce=? AND stage='choose'",
    targetId, now(), actorId, nonce);
  return send(env, actorId, 'Отправьте внутреннюю заметку для нового ответственного одним сообщением (до 500 символов).',
    [[button('Отмена', `mg:abort:${nonce}`)]], fetchImpl);
}

async function finishTransfer(env, db, actorId, nonce, fetchImpl) {
  const flow = await first(db, "SELECT * FROM manager_work_flows WHERE operator_id=? AND nonce=? AND stage='confirm' AND suspended=0 AND expires_at>?", actorId, nonce, now());
  if (!flow) return send(env, actorId, 'Этот шаг устарел. Откройте обращение заново.', [[button('Мои обращения', 'mg:mine')]], fetchImpl);
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const config = registry.find(item => item.id === flow.bot_id && item.enabled);
  if (!config) throw new ManagerError('Сервис недоступен. Заметка сохранена в мастере; повторите позже.', true);
  const changed = await changeWork(db, { botId: flow.bot_id, userId: flow.user_id, actor: actorId,
    revision: flow.expected_revision, action: 'transfer', target: flow.target_id, note: flow.note,
    primaryId: primaryId(env), audit: { actorName: String(actorId), action: 'manager_work_transfer' } });
  const current = await readWork(db, flow.bot_id, flow.user_id);
  const committed = Boolean(changed || current?.revision === flow.expected_revision + 1
    && Number(current.assigned_to) === Number(flow.target_id) && current.note === flow.note);
  if (committed) {
    const route = await first(db, 'SELECT support_group_id,thread_id FROM conversations WHERE bot_id=? AND user_id=?', flow.bot_id, flow.user_id);
    if (route) await queueTransferNotice(db, { botId: flow.bot_id, userId: flow.user_id,
      groupId: route.support_group_id, threadId: route.thread_id, note: flow.note });
    await run(db, 'DELETE FROM operator_note_drafts WHERE operator_id=? AND bot_id=? AND user_id=? AND draft=?',
      actorId, flow.bot_id, flow.user_id, flow.note);
    await run(db, 'DELETE FROM manager_work_flows WHERE operator_id=? AND nonce=?', actorId, nonce);
  }
  return showWorkCard(env, db, actorId, config, flow.user_id, fetchImpl,
    committed ? '✅ Передача сохранена. Уведомление новому оператору поставлено в очередь.\n\n'
      : 'Назначение уже изменилось. Заметка не отправлена.\n\n');
}

async function showRegistrationGroups(env, db, actorId, fetchImpl, page = 0) {
  const safePage = Number.isSafeInteger(Number(page)) ? Math.max(0, Math.min(1000, Number(page))) : 0;
  const pageSize = 20;
  const groups = (await db.prepare('SELECT group_id,title FROM support_groups ORDER BY updated_at DESC LIMIT ? OFFSET ?')
    .bind(pageSize + 1, safePage * pageSize).all()).results || [];
  const legacyId = Number(env.SUPPORT_GROUP_ID);
  const legacyExists = safePage === 0 && Number.isSafeInteger(legacyId) && legacyId < 0
    && await first(db, 'SELECT 1 AS present FROM support_groups WHERE group_id=?', legacyId);
  const rows = groups.slice(0, pageSize).map(row => [button(`${opaqueManagerText(safeTitle(row.title))} (${row.group_id})`, `mg:reggrp:${row.group_id}`)]);
  if (safePage === 0 && Number.isSafeInteger(legacyId) && legacyId < 0 && !legacyExists)
    rows.push([button(`Текущая группа поддержки (${legacyId})`, `mg:reggrp:${legacyId}`)]);
  const navigation = [
    ...(safePage ? [button('←', `mg:addbotpage:${safePage - 1}`)] : []),
    ...(groups.length > pageSize ? [button('→', `mg:addbotpage:${safePage + 1}`)] : []),
  ];
  if (navigation.length) rows.push(navigation);
  rows.push([button('Создать новую группу', 'mg:newgrp')]);
  return send(env, actorId, `Выберите группу для нового сервисного бота или подготовьте новую группу с темами.\nСтраница ${safePage + 1}.`, rows, fetchImpl);
}

async function resumeBotRegistration(env, db, update, actorId, fetchImpl, targetGroupId = null) {
  const flow = await first(db, 'SELECT manager_bot_id,data_json FROM bot_registration_flow WHERE owner_id=?', actorId);
  const savedGroupId = flow?.manager_bot_id === 'manager' ? Number(JSON.parse(flow.data_json || '{}').groupId) : null;
  const groupId = Number(targetGroupId ?? savedGroupId ?? env.SUPPORT_GROUP_ID);
  if (!Number.isSafeInteger(groupId) || groupId >= 0) throw new ManagerError('Группа для сервиса не выбрана.');
  const manager = { id: 'manager', token: env.MANAGER_BOT_TOKEN, webhookSecret: env.MANAGER_WEBHOOK_SECRET };
  const handled = await handleBotRegistrationUpdate(manager, { ...env, SUPPORT_GROUP_ID: String(groupId) }, update, fetchImpl,
    { targetGroupId: groupId, renderScreen: (value, markup) => send(env, actorId, value, markup.inline_keyboard, fetchImpl) });
  if (handled) {
    const completed = await first(db, "SELECT stage,data_json FROM bot_registration_flow WHERE owner_id=? AND manager_bot_id='manager'", actorId);
    if (completed?.stage === 'done') {
      const registered = JSON.parse(completed.data_json || '{}');
      const botId = `bot-${registered.me?.id}`;
      const row = await first(db, "SELECT config_json FROM registered_bots WHERE bot_id=? AND status='active'", botId);
      if (row) {
        const registry = [...parseBotRegistry(env.BOT_REGISTRY), JSON.parse(row.config_json)];
        const menuId = await ensureGroupMenu(env, db, groupId, registry, fetchImpl);
        await run(db, "UPDATE manager_group_flows SET stage='done',menu_message_id=?,confirmed_at=COALESCE(confirmed_at,?),updated_at=? WHERE owner_id=? AND stage='registration_group' AND target_group_id=?",
          menuId, now(), now(), actorId, groupId);
      }
    }
  }
  return handled;
}

async function showService(env, db, actorId, config, registry, fetchImpl) {
  const locale = await getManagerLanguage(db, actorId);
  const key = managementBotKey(registry, config.id);
  const registered = await first(db, 'SELECT status FROM registered_bots WHERE bot_id=?', config.id);
  const credentialsUnavailable = env.DYNAMIC_BOT_STATES?.[config.id] === 'credentials_unavailable';
  if (registered?.status === 'connecting') return send(env, actorId,
    `${opaqueManagerText(config.displayName)}: подключение ещё завершается. Продолжите мастер добавления бота.`,
    [[button('Меню', 'mg:home')]], fetchImpl);
  if (!config.enabled) return send(env, actorId,
    `${opaqueManagerText(config.displayName)} · ${config.username ? '@' + opaqueManagerText(config.username) : translateManager(locale, 'не указан')}\n\n${credentialsUnavailable
      ? 'Учётные данные бота недоступны. Повторно подключите этого же бота через мастер с его токеном; сохранённые настройки и история останутся.'
      : registered ? 'Подключение приостановлено. Возобновите его здесь после проверки.'
        : 'Сервис выключен в конфигурации Worker. Возобновление требует изменения конфигурации.'}\n\nНовые сообщения не обрабатываются. История обращений и настройки сохранены.`,
    Number(actorId) === primaryId(env)
      ? [...(credentialsUnavailable ? [[button('Переподключить бот', 'mg:addbot')]] : registered ? [[button('Возобновить подключение', `mg:lifecycle:${key}:resume`)],
        [button('Удалить подключение', `mg:lifecycle:${key}:remove`)]] : []),
        [button('Настройки · просмотр', `mg:settings:${key}`)],
        [button('Пользователи', `mu:home:${key}`), button('Журнал', `mg:audit:${key}:0`)],
        [button('Проблемы доставки', `mg:problems:${key}:0`), button('Здоровье', `mg:health:${key}`)],
        [button('Меню', 'mg:home')]]
      : [[button('Реакции · просмотр', `mg:rxview:${key}`), button('Защита · просмотр', `mg:attackview:${key}`)],
        [button('Пользователи', `mu:home:${key}`), button('Проблемы доставки', `mg:problems:${key}:0`)],
        [button('Меню', 'mg:home')]], fetchImpl);
  const owners = await getServiceOwners(db, config.id);
  const groupId = await resolveActiveGroup(db, config.id, env);
  const latestCheck = groupId ? await first(db, 'SELECT stage FROM service_checks WHERE bot_id=? AND group_id=? ORDER BY rowid DESC LIMIT 1', config.id, groupId) : null;
  const reactions = await first(db, `SELECT s.support_to_user_verified,s.user_to_support_verified,
    s.support_to_user_enabled,s.user_to_support_enabled,c.group_id,c.support_step,c.user_step
    FROM reaction_settings s LEFT JOIN reaction_checks c ON c.bot_id=s.bot_id WHERE s.bot_id=?`, config.id);
  const reactionReady = Number(reactions?.support_to_user_verified) === 1 && Number(reactions?.user_to_support_verified) === 1
    && Number(reactions?.support_to_user_enabled) === 1 && Number(reactions?.user_to_support_enabled) === 1
    && Number(reactions?.group_id) === groupId && Number(reactions?.support_step) === 3 && Number(reactions?.user_step) === 3;
  const checkLabel = { done: 'завершён', waiting: 'ожидает входящего', creating: 'создаётся тема', reply: 'ожидает ответа', sending: 'отправляется ответ', unconfirmed: 'исход не подтверждён' }[latestCheck?.stage] || 'не проводился';
  const text = `Сервис: ${opaqueManagerText(config.displayName)}\nБот: ${config.username ? '@' + opaqueManagerText(config.username) : translateManager(locale, 'не указан')}\nГруппа: ${groupId || 'не подключена'}\nРеакции: ${reactionReady ? '✅ проверены и включены' : '🧪 требуется проверка'}\nКонтрольный обмен: ${checkLabel}\nОтветственный: ${owners.primary_id || 'главный администратор'}\nРезервный: ${owners.backup_id || 'главный администратор'}\nНапоминание: ${owners.reminder_minutes} мин\nЭскалация: ${owners.fallback_minutes} мин`;
  const rows = Number(actorId) === primaryId(env)
    ? [[button('Подключить группу', `mg:begin:${key}`)],
      [button('Контрольный обмен', `mg:test:${key}`)],
      [button('⚙️ Настройки сервиса', `mg:settings:${key}`)],
      ...(!reactionReady ? [[button('🧪 Проверить реакции', `mg:rxtest:${key}`)]] : []),
      [button('🛡 Защита сервиса', `mg:attack:${key}`)],
      [button('🔄 Проверка и восстановление доставки', `mg:delivery:${key}`)],
      [button('🩺 Здоровье сервиса', `mg:health:${key}`)],
      [button('Ответственный', `mg:choose:${key}:p`), button('Резервный', `mg:choose:${key}:b`)],
      [button('Интервалы уведомлений', `mg:timers:${key}`)]] : [];
  if (registered && Number(actorId) === primaryId(env))
    rows.push([button('Приостановить бота', `mg:lifecycle:${key}:pause`)]);
  rows.push([button('Проверить готовность', `mg:ready:${key}:brief`)]);
  if (Number(actorId) !== primaryId(env)) rows.push([button('Реакции · просмотр', `mg:rxview:${key}`),
    button('Защита · просмотр', `mg:attackview:${key}`)]);
  rows.push([button('Очередь сервиса', `mg:queue:${key}:needs:0`),
    button('Проблемы доставки', `mg:problems:${key}:0`)]);
  rows.push([button('Мои обращения', 'mg:mine')], [button('Меню', 'mg:home')]);
  return send(env, actorId, text, rows, fetchImpl);
}

const removalChecks = {
  open: "SELECT 1 FROM conversations WHERE bot_id=?1 AND status<>'closed' LIMIT 1",
  work: "SELECT 1 FROM conversation_work WHERE bot_id=?1 AND state<>'resolved' LIMIT 1",
  delivery: 'SELECT 1 FROM message_delivery_attempts WHERE bot_id=?1 AND completed_at IS NULL LIMIT 1',
  pending: 'SELECT 1 FROM pending_messages WHERE bot_id=?1 AND delivered_at IS NULL LIMIT 1',
  reopen: 'SELECT 1 FROM reopen_business_messages WHERE bot_id=?1 AND delivered_at IS NULL LIMIT 1',
  albums: 'SELECT 1 FROM media_group_items WHERE bot_id=?1 AND delivered_at IS NULL LIMIT 1',
  provisioning: 'SELECT 1 FROM conversation_provision_attempts WHERE bot_id=?1 AND completed_at IS NULL LIMIT 1',
  locks: 'SELECT 1 FROM conversation_locks WHERE bot_id=?1 AND lease_expires_at>?2 LIMIT 1',
};
const removalLabels = {
  open: 'открытые темы', work: 'незавершённые обращения', delivery: 'неподтверждённые доставки',
  pending: 'сообщения в очереди', reopen: 'сообщения после возобновления',
  albums: 'незавершённые альбомы', provisioning: 'создание тем', locks: 'активные операции',
};

async function removalBlockers(db, botId) {
  const columns = Object.entries(removalChecks).map(([name, sql]) => `EXISTS(${sql}) AS ${name}`).join(',');
  const row = await first(db, `SELECT ${columns}`, botId, now());
  return Object.keys(removalChecks).filter(name => Number(row?.[name]) === 1);
}

async function webhookInfo(env, config, fetchImpl) {
  const token = env[config.tokenBinding];
  if (!token) throw new ManagerError('Токен бота недоступен. Повторно подключите его через мастер.');
  const response = await requestTelegram({ token, method: 'getWebhookInfo', body: {}, fetchImpl, timeoutMs: 10000 });
  if (!response.ok) throw new ManagerError('Не удалось проверить webhook бота. Повторите позже.', response.retryable);
  return response.result;
}

async function clearOwnedWebhook(env, config, fetchImpl) {
  const info = await webhookInfo(env, config, fetchImpl);
  if (!info.url || info.url !== webhookUrl(env, config.id)) return true;
  const response = await requestTelegram({ token: env[config.tokenBinding], method: 'deleteWebhook',
    body: { drop_pending_updates: false }, fetchImpl, timeoutMs: 10000 });
  if (response.ok) return true;
  const checked = await webhookInfo(env, config, fetchImpl);
  return !checked.url || checked.url !== webhookUrl(env, config.id);
}

async function showServiceLifecycle(env, db, actorId, config, registry, operation, fetchImpl) {
  const key = managementBotKey(registry, config.id);
  const registered = await first(db, 'SELECT status FROM registered_bots WHERE bot_id=?', config.id);
  if (!registered) return send(env, actorId,
    `${opaqueManagerText(config.displayName)} задан в конфигурации Worker. Управление отключением и удалением появится после переноса этого бота в Админушку.`,
    [[button('К сервису', `mg:service:${key}`)]], fetchImpl);
  if (registered.status === 'connecting') return send(env, actorId,
    'Подключение ещё завершается. Сначала завершите мастер.', [[button('Меню', 'mg:home')]], fetchImpl);
  if (operation === 'pause' && registered.status !== 'active' ||
      ['resume', 'remove'].includes(operation) && registered.status !== 'paused')
    return showService(env, db, actorId, config, registry, fetchImpl);
  if (operation === 'remove') {
    const blockers = await removalBlockers(db, config.id);
    const locale = blockers.length ? await getManagerLanguage(db, actorId) : 'en';
    if (blockers.length) return send(env, actorId,
      `Удаление подключения ${opaqueManagerText(config.displayName)} пока невозможно. Остались: ${blockers.map(name => translateManager(locale, removalLabels[name])).join(', ')}.\n\nВозобновите бота, закройте обращения и разберите незавершённые доставки. История при этом не удаляется.`,
      [[button('К сервису', `mg:service:${key}`)]], fetchImpl);
  }
  const explanations = {
    pause: `Приостановить ${opaqueManagerText(config.displayName)}? Бот перестанет обрабатывать новые сообщения до возобновления. Сообщения, уже отправленные клиентами, не будут удалены намеренно.`,
    resume: `Возобновить ${opaqueManagerText(config.displayName)}? Админушка проверит webhook и снова включит приём сообщений.`,
    remove: `Удалить подключение ${opaqueManagerText(config.displayName)}? Сохранённый токен будет удалён из реестра. История, темы и настройки останутся в D1, но исчезнут из экранов Админушки до повторного подключения. Для него потребуются токен бота и прежняя группа.`,
  };
  if (!Object.hasOwn(explanations, operation)) return;
  return send(env, actorId, explanations[operation],
    [[button(operation === 'pause' ? 'Да, приостановить' : operation === 'resume' ? 'Да, возобновить' : 'Да, удалить подключение',
      `mg:lifedo:${key}:${operation}`)], [button('Отмена', `mg:service:${key}`)]], fetchImpl);
}

async function applyServiceLifecycle(env, db, actorId, config, registry, operation, fetchImpl) {
  const key = managementBotKey(registry, config.id);
  const registered = await first(db, 'SELECT status FROM registered_bots WHERE bot_id=?', config.id);
  if (!registered) return showServiceLifecycle(env, db, actorId, config, registry, operation, fetchImpl);
  const groupId = await resolveActiveGroup(db, config.id, env);
  if (operation === 'pause' && registered.status === 'active') {
    const changed = await run(db, "UPDATE registered_bots SET status='paused',updated_at=? WHERE bot_id=? AND status='active'",
      now(), config.id);
    if (changed.meta?.changes !== 1) return showService(env, db, actorId, config, registry, fetchImpl);
    let webhookRemoved = false;
    try { webhookRemoved = await clearOwnedWebhook(env, config, fetchImpl); } catch {}
    if (groupId) await ensureGroupMenu(env, db, groupId,
      registry.map(item => item.id === config.id ? { ...item, enabled: false } : item), fetchImpl);
    return send(env, actorId, `${opaqueManagerText(config.displayName)} приостановлен.${webhookRemoved ? '' : '\n\nWebhook не удалось подтвердить отключённым. Приходящие обновления не обрабатываются; проверьте подключение перед возобновлением.'}`,
      [[button('К сервису', `mg:service:${key}`)]], fetchImpl);
  }
  if (operation === 'resume' && registered.status === 'paused') {
    const info = await webhookInfo(env, config, fetchImpl);
    const expected = webhookUrl(env, config.id);
    if (info.url && info.url !== expected) throw new ManagerError('Webhook этого бота указывает на другую систему. Возобновите его через мастер подключения.');
    const connected = await requestTelegram({ token: env[config.tokenBinding], method: 'setWebhook',
      body: { url: expected, secret_token: env[config.webhookSecretBinding], allowed_updates: BOT_UPDATES,
        drop_pending_updates: false }, fetchImpl, timeoutMs: 10000 });
    if (!connected.ok && (await webhookInfo(env, config, fetchImpl)).url !== expected)
      throw new ManagerError('Telegram не подтвердил восстановление webhook. Бот остался приостановлен.', connected.retryable);
    if ((await webhookInfo(env, config, fetchImpl)).url !== expected)
      throw new ManagerError('Webhook не совпадает с адресом сервиса. Бот остался приостановлен.');
    const changed = await run(db, "UPDATE registered_bots SET status='active',updated_at=? WHERE bot_id=? AND status='paused'",
      now(), config.id);
    if (changed.meta?.changes !== 1) throw new ManagerError('Состояние бота изменилось. Откройте карточку заново.');
    if (groupId) await ensureGroupMenu(env, db, groupId,
      registry.map(item => item.id === config.id ? { ...item, enabled: true } : item), fetchImpl);
    return send(env, actorId, `${opaqueManagerText(config.displayName)} возобновлён.`, [[button('К сервису', `mg:service:${key}`)]], fetchImpl);
  }
  if (operation === 'remove' && registered.status === 'paused') {
    const blockers = await removalBlockers(db, config.id);
    if (blockers.length) return showServiceLifecycle(env, db, actorId, config, registry, operation, fetchImpl);
    const pendingUpdates = Number((await webhookInfo(env, config, fetchImpl)).pending_update_count || 0);
    if (pendingUpdates > 0) throw new ManagerError(
      `Telegram ещё хранит ${pendingUpdates} обновлений для этого бота. Возобновите его и дождитесь доставки перед удалением.`);
    if (!await clearOwnedWebhook(env, config, fetchImpl))
      throw new ManagerError('Сначала нужно подтвердить отключение webhook. Подключение сохранено.');
    const guards = Object.values(removalChecks).map(sql => `NOT EXISTS(${sql})`).join(' AND ');
    const deleted = await first(db, `DELETE FROM registered_bots WHERE bot_id=?1 AND status='paused'
      AND ${guards} RETURNING bot_id`, config.id, now());
    if (!deleted) return showServiceLifecycle(env, db, actorId, config, registry, operation, fetchImpl);
    if (groupId) await ensureGroupMenu(env, db, groupId,
      registry.map(item => item.id === config.id ? { ...item, enabled: false } : item), fetchImpl);
    return send(env, actorId,
      `Подключение ${opaqueManagerText(config.displayName)} удалено. Токен больше не хранится в реестре; история обращений и маршрут прежней группы сохранены.`,
      [[button('Меню', 'mg:home')]], fetchImpl);
  }
  return showService(env, db, actorId, config, registry, fetchImpl);
}

async function showServiceCheck(env, db, actorId, config, registry, fetchImpl, restart = false) {
  if (!config.username) throw new ManagerError('Для контрольного обмена нужен username сервисного бота.');
  const groupId = await resolveActiveGroup(db, config.id, env);
  if (!groupId) throw new ManagerError('Сначала подключите группу сервиса.');
  const latest = await first(db, 'SELECT * FROM service_checks WHERE bot_id=? AND group_id=? ORDER BY rowid DESC LIMIT 1', config.id, groupId);
  if (!restart && latest?.stage === 'done') return send(env, actorId,
    `✅ Контрольный обмен ${opaqueManagerText(config.displayName)} в этой группе завершён: входящее сообщение создало тестовую тему, ответ дошёл в личку.`,
    [[button('Запустить ещё раз', `mg:testnew:${managementBotKey(registry, config.id)}`)]], fetchImpl);
  if (!restart && latest?.stage === 'unconfirmed') return send(env, actorId,
    'Результат прежней проверки не подтверждён. Сначала проверьте тестовую тему и личный чат; автоматический повтор не выполняется.',
    [[button('Начать новую проверку после осмотра', `mg:testnew:${managementBotKey(registry, config.id)}`)]], fetchImpl);
  const active = latest && ['waiting', 'creating', 'reply', 'sending'].includes(latest.stage) && latest.expires_at > now();
  const nonce = active && !restart ? latest.nonce : await serviceChecks(db, {
    primaryId: primaryId(env), groupId, send: async () => { throw new Error('Only the service bot runs the exchange'); },
  }).start(config.id, actorId);
  const check = await first(db, 'SELECT stage,thread_id FROM service_checks WHERE nonce=?', nonce);
  const url = `https://t.me/${config.username}?start=qc_${nonce}`;
  const topic = check?.thread_id ? `https://t.me/c/${String(groupId).replace(/^-100/, '')}/${check.thread_id}` : null;
  const text = check?.stage === 'reply'
    ? 'Входящее дошло до тестовой темы. Откройте её и нажмите «Проверить ответ», затем обновите состояние здесь.'
    : 'Откройте сервисного бота кнопкой ниже и нажмите Start. Он создаст отдельную тестовую тему. Затем завершите ответ из темы. Клиентские обращения не затрагиваются.';
  return send(env, actorId, text, [[{ text: 'Начать в сервисном боте', url }],
    ...(topic ? [[{ text: 'Тестовая тема', url: topic }]] : []),
    [button('Обновить результат', `mg:test:${managementBotKey(registry, config.id)}`)]], fetchImpl);
}

async function chooseOwner(env, db, actorId, config, registry, role, fetchImpl, page = 0) {
  const key = managementBotKey(registry, config.id);
  const operators = await activeOperatorPage(db, page);
  const choices = [...(operators.page === 0 ? [{ user_id: primaryId(env), first_name: 'Главный администратор', synthetic: true }] : []), ...operators.rows];
  const load = await operatorLoad(db, primaryId(env));
  const rows = choices.map(person => [button(`${person.synthetic ? safeTitle(person.first_name) : opaqueManagerText(safeTitle(person.first_name || person.username || person.user_id).slice(0, 24))} · ${loadLabel(load, person.user_id)}`,
    `mg:set:${key}:${role}:${person.user_id}`)]);
  if (role === 'b') rows.unshift([button('Без резервного', `mg:set:${key}:${role}:0`)]);
  const navigation = [
    ...(operators.page ? [button('←', `mg:choose:${key}:${role}:${operators.page - 1}`)] : []),
    ...(operators.hasNext ? [button('→', `mg:choose:${key}:${role}:${operators.page + 1}`)] : []),
  ];
  if (navigation.length) rows.push(navigation);
  return send(env, actorId, `${opaqueManagerText(config.displayName)}: выберите ${role === 'p' ? 'ответственного' : 'резервного'} оператора. Человек должен сначала открыть /start в личке управляющего бота.\nСтраница ${operators.page + 1}.`, rows, fetchImpl);
}

async function selectOwner(env, db, actorId, config, registry, role, selectedId, fetchImpl) {
  if (!['p', 'b'].includes(role) || !Number.isSafeInteger(selectedId) || selectedId < 0) return;
  const previous = await getServiceOwners(db, config.id);
  const primary = role === 'p' ? selectedId || null : previous.primary_id;
  const backup = role === 'b' ? selectedId || null : previous.backup_id;
  if (primary && backup && Number(primary) === Number(backup))
    throw new ManagerError('Основным и резервным не может быть один оператор. Выберите другого человека или снимите резервное назначение.');
  if (selectedId > 0) {
    const allowed = selectedId === primaryId(env)
      || Boolean(await first(db, 'SELECT 1 AS allowed FROM support_operators WHERE user_id=? AND active=1', selectedId));
    const contact = await first(db, 'SELECT started_at,available,unreachable_at FROM manager_dm_status WHERE operator_id=?', selectedId);
    if (!allowed || !contact?.started_at || contact.unreachable_at) {
      throw new ManagerError('Оператор ещё не открыл /start в личке управляющего бота или связь с ним недоступна.');
    }
    if (Number(contact.available) !== 1)
      throw new ManagerError('Оператор отключил доступность. Попросите его отправить /available управляющему боту перед назначением.');
    const probe = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'sendChatAction',
      body: { chat_id: selectedId, action: 'typing' }, fetchImpl, timeoutMs: 10000 });
    if (!probe.ok || probe.result !== true) {
      const unreachable = Number(probe.errorCode || probe.httpStatus) === 403
        || /(?:chat not found|user is deactivated|bot was blocked)/i.test(String(probe.description || ''));
      if (unreachable && selectedId !== primaryId(env)) {
        await run(db, 'UPDATE manager_dm_status SET unreachable_at=?,updated_at=? WHERE operator_id=?', now(), now(), selectedId);
        await setOperatorAvailability(db, { operatorId: selectedId, available: false, adminId: primaryId(env) });
        throw new ManagerError('Управляющий бот не может связаться с оператором. Назначение не изменено; его открытые обращения переданы резервному оператору или администратору. Попросите оператора снова открыть бота и включить доступность.');
      }
      throw new ManagerError(probe.rateLimited
        ? `Telegram временно ограничил проверку личного чата. Повторите через ${probe.retryAfterSeconds || 60} сек.`
        : 'Не удалось подтвердить доступность личного чата. Назначение не изменено; повторите проверку позже.',
      probe.retryable || probe.deliveryUncertain);
    }
  }
  await setServiceOwners(db, { botId: config.id, primaryId: primary, backupId: backup,
    reminderMinutes: previous.reminder_minutes, fallbackMinutes: previous.fallback_minutes });
  return showService(env, db, actorId, config, registry, fetchImpl);
}

async function showTimers(env, actorId, config, registry, fetchImpl) {
  const key = managementBotKey(registry, config.id);
  const presets = [[15, 30], [30, 60], [60, 120], [120, 240]];
  return send(env, actorId, `${opaqueManagerText(config.displayName)}: выберите минуты от первого сообщения клиента без ответа человека.`,
    presets.map(([reminder, fallback]) => [button(`${reminder} мин → ${fallback} мин`, `mg:settimers:${key}:${reminder}:${fallback}`)]), fetchImpl);
}

async function beginGroupFlow(env, db, actorId, config, fetchImpl) {
  const locale = await getManagerLanguage(db, actorId);
  const existing = await currentFlow(db, actorId);
  if (existing && existing.stage !== 'done' && existing.bot_id !== config.id) {
    throw new ManagerError('Сначала завершите текущее подключение группы или отправьте /cancel.');
  }
  if (!existing || existing.stage === 'done') {
    const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 20);
    const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    await run(db, `INSERT INTO manager_group_flows(owner_id,bot_id,nonce,code,stage,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,'awaiting_group',?,?,?) ON CONFLICT(owner_id) DO UPDATE SET
      bot_id=excluded.bot_id,nonce=excluded.nonce,code=excluded.code,stage='awaiting_group',
      target_group_id=NULL,target_group_title=NULL,expires_at=excluded.expires_at,updated_at=excluded.updated_at,
      confirmed_at=NULL,menu_message_id=NULL,source_group_id=NULL`, actorId, config.id, nonce, code, later(), now(), now());
  }
  const flow = await currentFlow(db, actorId);
  const managerName = String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, '');
  const command = `/connect${managerName ? '@' + managerName : ''} ${flow.code}`;
  const newService = config.id === '__new__';
  return send(env, actorId,
    `Подключение группы для ${newService ? translateManager(locale, 'нового сервиса') : opaqueManagerText(config.displayName)}\n\n1. Создайте группу с темами.\n2. Добавьте ${managerName ? '@' + opaqueManagerText(managerName) : translateManager(locale, 'управляющего бота')} администратором с правами закреплять сообщения и управлять темами.${newService ? ' Сервисного бота добавим после создания.' : ` Добавьте ${config.username ? '@' + opaqueManagerText(config.username) : translateManager(locale, 'бота сервиса')} с правом управлять темами.`}\n3. В General отправьте:\n${command}\n\nКод действует один час. Токен бота в группу не отправляйте.`,
    [[button('Проверить состояние', `mg:flow:${flow.nonce}`)]], fetchImpl);
}

async function verifyManagerGroup(env, groupId, fetchImpl) {
  const manager = await call(env, 'getMe', {}, fetchImpl);
  const chat = await call(env, 'getChat', { chat_id: groupId }, fetchImpl);
  if (String(chat?.id) !== String(groupId) || chat?.type !== 'supergroup' || !chat?.is_forum) {
    throw new ManagerError('Нужна супергруппа с включёнными темами.');
  }
  const own = await call(env, 'getChatMember', { chat_id: groupId, user_id: manager.id }, fetchImpl);
  if (own?.status !== 'administrator' || !own.can_pin_messages) {
    throw new ManagerError('Управляющему боту нужно право закреплять сообщения в этой группе.');
  }
  if (!own.can_manage_topics) throw new ManagerError('Управляющему боту нужно право управлять темами в этой группе.');
  return safeTitle(chat.title);
}

async function verifyGroup(env, config, groupId, fetchImpl) {
  const title = await verifyManagerGroup(env, groupId, fetchImpl);
  const serviceToken = env[config.tokenBinding];
  if (!serviceToken) throw new ManagerError('Токен сервисного бота недоступен; проверьте его подключение.');
  const serviceMe = await requestTelegram({ token: serviceToken, method: 'getMe', body: {}, fetchImpl, timeoutMs: 10000 });
  if (!serviceMe.ok || !serviceMe.result?.id) throw new ManagerError('Не удалось проверить сервисного бота.', true);
  const membership = await call(env, 'getChatMember', { chat_id: groupId, user_id: serviceMe.result.id }, fetchImpl);
  if (membership?.status !== 'administrator' || !membership.can_manage_topics) {
    throw new ManagerError('Сервисному боту нужно право управлять темами в этой группе.');
  }
  const hook = await requestTelegram({ token: serviceToken, method: 'getWebhookInfo', body: {}, fetchImpl, timeoutMs: 10000 });
  if (!hook.ok || hook.result?.url !== webhookUrl(env, config.id)) {
    throw new ManagerError('Webhook сервисного бота не подключён к этой поддержке.');
  }
  return title;
}

async function groupConfirmationText(env, db, config, title) {
  const locale = await getManagerLanguage(db, env.MANAGER_REQUEST_ACTOR_ID || primaryId(env));
  const owners = await getServiceOwners(db, config.id);
  const managerName = String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, '');
  return `Подключение группы\n\nСервис: ${opaqueManagerText(config.displayName)}\nГруппа: ${opaqueManagerText(safeTitle(title))}\nУправляющий бот: ${managerName ? '@' + opaqueManagerText(managerName) : translateManager(locale, 'не указан')}\nСервисный бот: ${config.username ? '@' + opaqueManagerText(config.username) : translateManager(locale, 'не указан')}\nОтветственный: ${owners.primary_id || 'главный администратор'}\nРезервный: ${owners.backup_id || 'главный администратор'}\n\nПрава ботов и webhook проверены. Подтвердите подключение.`;
}

async function observeGroup(env, db, message, registry, fetchImpl) {
  const code = groupCommand(message);
  if (!code || !addressedToManager(message, env) || Number(message.from?.id) !== primaryId(env)
    || Number(message.message_thread_id || 1) !== 1) return;
  const flow = await first(db, `SELECT * FROM manager_group_flows WHERE code=? AND owner_id=? AND expires_at>?`, code, Number(message.from.id), now());
  if (!flow || flow.stage === 'done') return;
  if (['confirm', 'registration_group'].includes(flow.stage) && String(flow.target_group_id) === String(message.chat.id)) return;
  if (flow.stage !== 'awaiting_group' || !String(message.chat?.id).startsWith('-100')) return;
  if (flow.bot_id === '__new__') {
    const groupId = Number(message.chat.id);
    const title = await verifyManagerGroup(env, groupId, fetchImpl);
    await registerSupportGroup(db, groupId, { title, forumVerifiedAt: now(), managerVerifiedAt: now() });
    await ensureGroupMenu(env, db, groupId, registry, fetchImpl);
    const changed = await run(db, `UPDATE manager_group_flows SET stage='registration_group',target_group_id=?,target_group_title=?,updated_at=?
      WHERE owner_id=? AND nonce=? AND stage='awaiting_group' AND expires_at>?`, groupId, title, now(), flow.owner_id, flow.nonce, now());
    if (changed.meta?.changes !== 1) return;
    return send(env, flow.owner_id, `Группа «${opaqueManagerText(title)}» подготовлена. Теперь добавьте в неё сервисного бота и завершите мастер.`,
      [[button('Добавить сервисного бота', `mg:reggrp:${groupId}`)]], fetchImpl);
  }
  const config = registry.find(item => item.id === flow.bot_id && item.enabled);
  if (!config) throw new ManagerError('Сервис больше не доступен. Начните подключение заново.');
  const title = await verifyGroup(env, config, Number(message.chat.id), fetchImpl);
  const sourceGroupId = await resolveActiveGroup(db, config.id, env);
  const changed = await run(db, `UPDATE manager_group_flows SET stage='confirm',target_group_id=?,target_group_title=?,
    source_group_id=?,updated_at=? WHERE owner_id=? AND nonce=? AND stage='awaiting_group' AND expires_at>?`,
  Number(message.chat.id), title, sourceGroupId, now(), flow.owner_id, flow.nonce, now());
  if (changed.meta?.changes !== 1) return;
  await send(env, flow.owner_id, await groupConfirmationText(env, db, config, title),
    [[button('Подключить группу', `mg:confirm:${flow.nonce}`)]], fetchImpl);
}

async function ensureGroupMenu(env, db, groupId, registry, fetchImpl) {
  const group = await first(db, 'SELECT menu_message_id,menu_state,menu_services_json,menu_claim_token,menu_claim_expires_at FROM support_groups WHERE group_id=?', groupId);
  if (group?.menu_state === 'uncertain') throw new ManagerError('Публикация меню не подтверждена. Проверьте General перед повтором.');
  const services = await listGroupServices(db, groupId);
  const botIds = [...new Set(services.map(item => item.bot_id))]
    .filter(id => registry.some(bot => bot.id === id && bot.enabled)).sort();
  const names = botIds.map(id => registry.find(bot => bot.id === id)?.displayName || id);
  const contentKey = JSON.stringify(names);
  const managerName = String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, '');
  const url = managerName ? `https://t.me/${managerName}?start=menu` : null;
  const body = { chat_id: groupId,
    text: `Support management\n\nServices: ${names.join(', ') || 'none'}\nConversations are in this group’s topics.`,
    ...(url ? { reply_markup: { inline_keyboard: [[{ text: 'Open menu', url }]] } } : {}) };
  const missingMessage = result => !result.deliveryUncertain
    && Number(result.errorCode || result.httpStatus) === 400
    && /(?:message.*not found|message_id_invalid)/i.test(String(result.description || ''));
  const retireMissingMenu = async menuId => {
    const retired = await run(db, `UPDATE support_groups SET menu_message_id=NULL,menu_state='pending',
      menu_services_json=NULL,menu_claim_token=NULL,menu_claim_expires_at=NULL,updated_at=?
      WHERE group_id=? AND menu_message_id=?`, now(), groupId, menuId);
    if (retired.meta?.changes !== 1) throw new ManagerError('Меню уже изменилось. Откройте экран ещё раз.');
  };
  let menuId = Number(group?.menu_message_id) || null;
  let pinned = false;
  if (menuId && group.menu_state === 'ready') {
    const chat = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'getChat',
      body: { chat_id: groupId }, fetchImpl, timeoutMs: 10000 });
    if (!chat.ok) throw new ManagerError('Не удалось проверить закреплённое меню. Повторите позже.', chat.retryable);
    pinned = Number(chat.result?.pinned_message?.message_id) === menuId;
    if (pinned && group.menu_services_json === contentKey) return menuId;
  }
  if (menuId && group.menu_state === 'ready' && group.menu_services_json !== contentKey) {
    const edited = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'editMessageText',
      body: { ...body, message_id: menuId }, fetchImpl, timeoutMs: 10000 });
    if (!edited.ok && !String(edited.description || '').toLowerCase().includes('message is not modified')) {
      if (missingMessage(edited)) { await retireMissingMenu(menuId); menuId = null; }
      else throw new ManagerError('Не удалось обновить список сервисов в закреплённом меню.', edited.retryable);
    }
    if (menuId && pinned) {
      await run(db, 'UPDATE support_groups SET menu_services_json=?,updated_at=? WHERE group_id=? AND menu_message_id=?',
        contentKey, now(), groupId, menuId);
      return menuId;
    }
  }
  if (menuId) {
    const pin = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'pinChatMessage',
      body: { chat_id: groupId, message_id: menuId, disable_notification: true }, fetchImpl, timeoutMs: 10000 });
    if (!pin.ok && !/message is already pinned/i.test(String(pin.description || ''))) {
      if (missingMessage(pin)) { await retireMissingMenu(menuId); menuId = null; }
      else throw new ManagerError('Меню есть, но закрепление не подтверждено. Проверьте права и повторите.', pin.retryable);
    }
    if (menuId) {
      await run(db, "UPDATE support_groups SET menu_state='ready',menu_services_json=?,updated_at=? WHERE group_id=? AND menu_message_id=?",
        contentKey, now(), groupId, menuId);
      return menuId;
    }
  }
  const claimToken = crypto.randomUUID();
  const claim = await first(db, `UPDATE support_groups SET menu_claim_token=?,menu_claim_expires_at=?,updated_at=?
    WHERE group_id=? AND menu_message_id IS NULL AND menu_state='pending' AND menu_claim_token IS NULL
    RETURNING group_id`, claimToken, new Date(Date.now() + 120000).toISOString(), now(), groupId);
  if (!claim) {
    const current = await first(db, 'SELECT menu_claim_token,menu_claim_expires_at FROM support_groups WHERE group_id=?', groupId);
    if (current?.menu_claim_token && current.menu_claim_expires_at <= now()) {
      await run(db, `UPDATE support_groups SET menu_state='uncertain',menu_claim_token=NULL,
        menu_claim_expires_at=NULL,updated_at=? WHERE group_id=? AND menu_claim_token=?
        AND menu_message_id IS NULL AND menu_claim_expires_at<=?`, now(), groupId, current.menu_claim_token, now());
      throw new ManagerError('Исход прежней отправки меню неизвестен. Проверьте General перед повтором.');
    }
    throw new ManagerError('Меню уже создаётся. Обновите экран через несколько секунд.');
  }
  const sent = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'sendMessage', body, fetchImpl, timeoutMs: 10000 });
  if (!sent.ok) {
    if (sent.deliveryUncertain) {
      await run(db, "UPDATE support_groups SET menu_state='uncertain',menu_claim_token=NULL,menu_claim_expires_at=NULL,updated_at=? WHERE group_id=? AND menu_claim_token=?", now(), groupId, claimToken);
      throw new ManagerError('Неизвестно, появилось ли меню в General. Проверьте группу вручную.');
    }
    await run(db, "UPDATE support_groups SET menu_claim_token=NULL,menu_claim_expires_at=NULL,updated_at=? WHERE group_id=? AND menu_claim_token=?", now(), groupId, claimToken);
    throw new ManagerError('Не удалось создать меню. Повторите проверку.', sent.retryable);
  }
  const messageId = Number(sent.result?.message_id);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    await run(db, "UPDATE support_groups SET menu_state='uncertain',menu_claim_token=NULL,menu_claim_expires_at=NULL,updated_at=? WHERE group_id=? AND menu_claim_token=?", now(), groupId, claimToken);
    throw new ManagerError('Telegram не вернул ID меню. Проверьте General вручную.');
  }
  const saved = await run(db, `UPDATE support_groups SET menu_message_id=?,menu_state='pending',
    menu_claim_token=NULL,menu_claim_expires_at=NULL,updated_at=?
    WHERE group_id=? AND menu_claim_token=? AND menu_message_id IS NULL`, messageId, now(), groupId, claimToken);
  if (saved.meta?.changes !== 1) throw new ManagerError('Telegram создал меню, но сохранить его ID не удалось. Проверьте General перед повтором.');
  const pin = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'pinChatMessage',
    body: { chat_id: groupId, message_id: messageId, disable_notification: true }, fetchImpl, timeoutMs: 10000 });
  if (!pin.ok) throw new ManagerError('Меню создано, но закрепление не подтверждено. Повторите проверку.', pin.retryable);
  await run(db, "UPDATE support_groups SET menu_state='ready',menu_services_json=?,updated_at=? WHERE group_id=?", contentKey, now(), groupId);
  return messageId;
}

function groupCutoverBlockers(blockers, locale = 'ru') {
  const labels = {
    target_group_missing: 'целевая группа не подготовлена',
    topic_creation_unresolved: 'создание темы ещё не завершено',
    delivery_unresolved: 'исход отправки сообщения ещё не подтверждён',
    pending_send_unresolved: 'отложенное сообщение ещё доставляется',
    reopen_effect_unresolved: 'повторное открытие обращения ещё не завершено',
    reopen_business_unresolved: 'сообщение клиента при повторном открытии ещё не доставлено',
    album_unresolved: 'отправка альбома ещё не завершена',
    album_item_unresolved: 'не все элементы альбома доставлены',
    conversation_locked: 'обращение сейчас обрабатывается',
  };
  return blockers.map(code => translateManager(locale, labels[code] || 'есть незавершённая операция')).join('; ');
}

async function confirmGroup(env, db, actorId, nonce, registry, fetchImpl) {
  const flow = await currentFlow(db, actorId);
  if (!flow || flow.nonce !== nonce || !['confirm', 'connecting', 'done'].includes(flow.stage)) return;
  const locale = await getManagerLanguage(db, actorId);
  const config = registry.find(item => item.id === flow.bot_id && item.enabled);
  if (!config) throw new ManagerError('Сервис больше не доступен. Откройте мастер заново.');
  const groupId = Number(flow.target_group_id);
  const title = await verifyGroup(env, config, groupId, fetchImpl);
  await registerSupportGroup(db, groupId, { title, forumVerifiedAt: now(), managerVerifiedAt: now(), serviceVerifiedAt: now() });
  const previous = await resolveActiveGroup(db, config.id, env);
  const original = flow.source_group_id == null ? null : Number(flow.source_group_id);
  if (flow.stage === 'done' && previous !== groupId) throw new ManagerError(
    'Эта кнопка устарела: сервис уже подключён к другой группе. Откройте актуальную карточку сервиса.');
  if (flow.stage !== 'done' && previous !== groupId && previous !== original) {
    if (flow.stage === 'connecting') await run(db,
      "DELETE FROM manager_group_flows WHERE owner_id=? AND nonce=? AND stage='connecting'", actorId, nonce);
    throw new ManagerError('Маршрут сервиса изменился после начала мастера. Это подключение не выполнено; откройте актуальную карточку и начните заново.');
  }
  const state = await inspectGroupCutover(db, config.id, groupId);
  if (!state.ready) throw new ManagerError(`Перенос пока невозможен: ${groupCutoverBlockers(state.blockers, locale)}. Устраните причину и повторите подтверждение.`);
  if (flow.stage === 'confirm') {
    await run(db, "UPDATE manager_group_flows SET stage='connecting',updated_at=? WHERE owner_id=? AND nonce=? AND stage='confirm'",
      now(), actorId, nonce);
  }
  await ensureGroupMenu(env, db, groupId, registry, fetchImpl);
  try { await commitGroupCutover(db, config.id, groupId, previous, state); }
  catch (error) {
    const latest = await inspectGroupCutover(db, config.id, groupId);
    if (latest.currentGroupId !== groupId) {
      if (latest.currentGroupId !== previous) {
        await run(db, "DELETE FROM manager_group_flows WHERE owner_id=? AND nonce=? AND stage='connecting'", actorId, nonce);
        throw new ManagerError('Маршрут сервиса изменился в другом действии. Это подключение не выполнено; откройте актуальную карточку и начните заново.');
      }
      if (!latest.ready) throw new ManagerError(
        `Перенос не выполнен: появились незавершённые операции (${groupCutoverBlockers(latest.blockers, locale)}). Разберите их и повторите подтверждение.`);
      throw error;
    }
  }
  let menuId;
  try { menuId = await ensureGroupMenu(env, db, groupId, registry, fetchImpl); }
  catch (error) {
    if (error instanceof ManagerError) throw new ManagerError(
      `Сервис уже перенесён. Меню новой группы ${groupId} пока не обновлено: ${translateManager(locale, error.message)} Повторите подтверждение после исправления.`,
      error.retryable);
    throw error;
  }
  const oldGroupId = Number(flow.source_group_id ?? previous);
  if (Number.isSafeInteger(oldGroupId) && oldGroupId < 0 && oldGroupId !== groupId) {
    const oldMenu = await first(db, 'SELECT menu_message_id FROM support_groups WHERE group_id=?', oldGroupId);
    if (oldMenu?.menu_message_id) {
      try { await ensureGroupMenu(env, db, oldGroupId, registry, fetchImpl); }
      catch (error) {
        if (error instanceof ManagerError) throw new ManagerError(
          `Сервис уже перенесён. Меню прежней группы ${oldGroupId} пока не обновлено: ${translateManager(locale, error.message)} Повторите подтверждение после исправления.`,
          error.retryable);
        throw error;
      }
    }
  }
  const finished = await run(db, `UPDATE manager_group_flows SET stage='done',
    confirmed_at=COALESCE(confirmed_at,?),menu_message_id=?,updated_at=?
    WHERE owner_id=? AND nonce=? AND stage IN ('connecting','done')
      AND EXISTS(SELECT 1 FROM service_group_routes WHERE bot_id=? AND group_id=?)`,
  now(), menuId, now(), actorId, nonce, config.id, groupId);
  if (finished.meta?.changes !== 1) {
    const activeGroupId = await resolveActiveGroup(db, config.id, env);
    if (activeGroupId !== groupId) {
      let menuWarning = '';
      try {
        await ensureGroupMenu(env, db, groupId, registry, fetchImpl);
        if (Number.isSafeInteger(oldGroupId) && oldGroupId < 0 && oldGroupId !== groupId) {
          const oldMenu = await first(db, 'SELECT menu_message_id FROM support_groups WHERE group_id=?', oldGroupId);
          if (oldMenu?.menu_message_id) await ensureGroupMenu(env, db, oldGroupId, registry, fetchImpl);
        }
      } catch { menuWarning = ' ' + translateManager(locale, 'Проверьте закреплённые меню командой /menu в затронутых группах.'); }
      await run(db, "DELETE FROM manager_group_flows WHERE owner_id=? AND nonce=? AND stage='connecting'", actorId, nonce);
      throw new ManagerError(`Маршрут сервиса изменился во время завершения мастера. Подключение к выбранной группе не подтверждено.${menuWarning} Откройте актуальную карточку сервиса.`);
    }
    throw new ManagerError('Состояние мастера изменилось. Откройте его снова и проверьте результат.');
  }
  if (env.MANAGER_BOT_USERNAME) {
    await run(db, "UPDATE operator_pending_actions SET suspended=1 WHERE chat_id=? AND (thread_id IS NULL OR thread_id=1) AND suspended=0", groupId);
    await run(db, "UPDATE support_operator_flows SET suspended=1 WHERE chat_id=? AND (thread_id IS NULL OR thread_id=1) AND suspended=0", groupId);
    await run(db, "UPDATE bot_message_flows SET suspended=1 WHERE chat_id=? AND suspended=0", groupId);
    await run(db, "UPDATE operator_work_inputs SET suspended=1 WHERE chat_id=? AND thread_id=1 AND suspended=0", groupId);
    await run(db, 'DELETE FROM operator_input_prompts WHERE chat_id=?', groupId);
  }
  return send(env, actorId, `${opaqueManagerText(config.displayName)} подключён к группе «${opaqueManagerText(title)}». Меню закреплено. До отметки «готово» проведите контрольный обмен в тестовой теме.`,
    [[button('Начать контрольный обмен', `mg:test:${managementBotKey(registry, config.id)}`)], [button('К сервисам', 'mg:home')]], fetchImpl);
}

async function dispatchManagerUpdate(env, update, fetchImpl, ctx) {
  const db = env.SUPPORT_DB;
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const query = update.callback_query;
  const message = update.message;
  const actorId = Number(query?.from?.id || message?.from?.id || update.managed_bot?.user?.id);
  if (!Number.isSafeInteger(actorId)) return;
  env = { ...managerScreenContext(env, query, actorId), MANAGER_REQUEST_ACTOR_ID: actorId };
  if (actorId === primaryId(env)) {
    const registerFlow = await first(db, 'SELECT manager_bot_id,stage FROM bot_registration_flow WHERE owner_id=?', actorId);
    const registrationInput = String(query?.data || '').startsWith('br:')
      || Boolean(update.managed_bot)
      || (message?.chat?.type === 'private' && (registerFlow?.manager_bot_id === 'manager' && registerFlow.stage !== 'done'
        || /^\/(?:addbot(?:@\w+)?|start(?:@\w+)?\s+addbot)$/.test(String(message.text || '').trim())));
    if (registrationInput) {
      if (!registerFlow && message?.chat?.type === 'private' && /^\/addbot(?:@\w+)?$/.test(String(message.text || '').trim())) {
        return showRegistrationGroups(env, db, actorId, fetchImpl);
      }
      if (await resumeBotRegistration(env, db, update, actorId, fetchImpl)) return;
    }
  }
  if (query) {
    // A callback acknowledgement is UI-only. An expired acknowledgement must
    // not prevent a retried update from finishing its durable action.
    await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'answerCallbackQuery',
      body: { callback_query_id: query.id }, fetchImpl, timeoutMs: 5000 });
    const callbackData = String(query.data || '');
    const deliveryRefresh = /^ds:(\d+)$/.exec(callbackData);
    if (deliveryRefresh) {
      const statusMessage = query.message;
      const chatId = Number(statusMessage?.chat?.id);
      const threadId = Number(statusMessage?.message_thread_id);
      const sourceMessageId = Number(deliveryRefresh[1]);
      const expectedManagerName = String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, '').toLowerCase();
      if (statusMessage?.chat?.type !== 'supergroup' || !Number.isSafeInteger(chatId)
        || !Number.isSafeInteger(threadId) || !Number.isSafeInteger(sourceMessageId)
        || statusMessage.from?.is_bot !== true
        || (expectedManagerName && String(statusMessage.from?.username || '').toLowerCase() !== expectedManagerName)
        || !managerHeaderMatches(statusMessage.text, `Статус доставки сообщения #${sourceMessageId}\n`)
        || !await authorizedOperator(db, env, actorId)) return;
      const conversation = await first(db, 'SELECT bot_id FROM conversations WHERE support_group_id=? AND thread_id=?', chatId, threadId);
      if (!conversation) return;
      const result = await getOperatorMessageDeliveryStatus(db, { botId: conversation.bot_id,
        sourceChatId: chatId, sourceMessageId });
      return call(env, 'editMessageText', { chat_id: chatId, message_id: Number(statusMessage.message_id),
        text: deliveryStatusCard(result, sourceMessageId, await getManagerLanguage(db, actorId)), reply_markup: { inline_keyboard: deliveryStatusMarkup(sourceMessageId) } }, fetchImpl);
    }
    const topicChange = /^mt:topic:(close|open):(b[0-9a-z]{13}):(\d+)$/.exec(callbackData);
    if (topicChange) {
      const [, action, key, rawUserId] = topicChange;
      const config = managementBotFromKey(registry, key);
      const card = query.message;
      const chatId = Number(card?.chat?.id), threadId = Number(card?.message_thread_id);
      const userId = Number(rawUserId);
      const expectedManagerName = String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, '').toLowerCase();
      if (!config?.enabled || card?.chat?.type !== 'supergroup' || !Number.isSafeInteger(chatId)
        || !Number.isSafeInteger(threadId) || threadId <= 1 || !Number.isSafeInteger(userId)
        || card.from?.is_bot !== true
        || (expectedManagerName && String(card.from?.username || '').toLowerCase() !== expectedManagerName)
        || !managerHeaderMatches(card.text, `Обращение · ${opaqueManagerText(config.displayName)} · `)
        || !await authorizedOperator(db, env, actorId)) return;
      const conversation = await first(db, 'SELECT * FROM conversations WHERE bot_id=? AND user_id=? AND support_group_id=? AND thread_id=?',
        config.id, userId, chatId, threadId);
      if (!conversation) return;
      await changeTopicState(env, db, actorId, conversation, action, fetchImpl);
      return showTopicWorkCard(env, db, config, userId, chatId, threadId, fetchImpl, Number(card.message_id),
        action === 'close' ? 'Тема закрыта.\n\n' : 'Тема открыта.\n\n', actorId);
    }
    const topicAction = /^mt:act:(take|release|snooze|tomorrow|waiting|needs|resolve):(b[0-9a-z]{13}):(\d+):(\d+)$/.exec(callbackData);
    if (topicAction) {
      const [, action, key, rawUserId, rawRevision] = topicAction;
      const config = managementBotFromKey(registry, key);
      const card = query.message;
      const chatId = Number(card?.chat?.id), threadId = Number(card?.message_thread_id);
      const userId = Number(rawUserId), revision = Number(rawRevision);
      const expectedManagerName = String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, '').toLowerCase();
      if (!config?.enabled || card?.chat?.type !== 'supergroup' || !Number.isSafeInteger(chatId)
        || !Number.isSafeInteger(threadId) || threadId <= 1 || !Number.isSafeInteger(userId)
        || userId <= 0 || !Number.isSafeInteger(revision) || !Number.isSafeInteger(Number(card.message_id))
        || card.from?.is_bot !== true
        || (expectedManagerName && String(card.from?.username || '').toLowerCase() !== expectedManagerName)
        || !managerHeaderMatches(card.text, `Обращение · ${opaqueManagerText(config.displayName)} · `)
        || !await authorizedOperator(db, env, actorId)) return;
      const conversation = await first(db, `SELECT 1 AS active FROM conversations
        WHERE bot_id=? AND user_id=? AND support_group_id=? AND thread_id=?`,
      config.id, userId, chatId, threadId);
      if (!conversation) return;
      const changed = await changeWork(db, { botId: config.id, userId, actor: actorId, revision,
        action: action === 'tomorrow' ? 'snooze' : action,
        until: action === 'snooze' ? new Date(Date.now() + 3600000).toISOString()
          : action === 'tomorrow' ? tomorrowMorning() : null,
        audit: { actorName: String(actorId), action: `manager_work_${action}` } });
      return showTopicWorkCard(env, db, config, userId, chatId, threadId, fetchImpl, Number(card.message_id),
        changed ? '✅ Изменение сохранено.\n\n' : 'Состояние уже изменилось. Показаны свежие данные.\n\n', actorId);
    }
    if (query.message?.chat?.type !== 'private' || Number(query.message.chat.id) !== actorId) return;
    if (!await authorizedOperator(db, env, actorId)) return;
    await suspendPrivateInputs(db, actorId, callbackData);
    if (callbackData.startsWith('mu:')) return handleManagerUserAction(env, db, query.from, callbackData,
      (body, rows) => send(env, actorId, body, rows, fetchImpl));
    const privateTopicAction = /^mg:topic:(close|open):(b[0-9a-z]{13}):([0-9a-z]+):(-?[0-9a-z]+):([0-9a-z]+)$/.exec(String(query.data || ''));
    if (privateTopicAction) {
      const [, action, key, rawUserId, rawGroupId, rawThreadId] = privateTopicAction;
      const config = managementBotFromKey(registry, key);
      const userId = parseInt(rawUserId, 36), groupId = parseInt(rawGroupId, 36), threadId = parseInt(rawThreadId, 36);
      if (!config?.enabled || !Number.isSafeInteger(userId) || userId <= 0
        || !Number.isSafeInteger(groupId) || !Number.isSafeInteger(threadId) || threadId <= 1) return;
      const conversation = await first(db, 'SELECT * FROM conversations WHERE bot_id=? AND user_id=?', config.id, userId);
      if (!conversation || Number(conversation.support_group_id) !== groupId || Number(conversation.thread_id) !== threadId)
        return showWorkCard(env, db, actorId, config, userId, fetchImpl, 'Карточка устарела: тема была перенесена.\n\n');
      await changeTopicState(env, db, actorId, conversation, action, fetchImpl);
      return showWorkCard(env, db, actorId, config, userId, fetchImpl,
        action === 'close' ? 'Тема закрыта.\n\n' : 'Тема открыта.\n\n');
    }
    const [prefix, action, key, role, selected, revision, extra] = String(query.data || '').split(':');
    if (prefix !== 'mg') return;
    if (action === 'stats') return handleStatisticsCallback(env,db,actorId,String(query.data),
      (markdown,rows,recipient=actorId)=>sendStatistics(env,recipient,markdown,rows,fetchImpl));
    if (action === 'uilanguage') return showManagerUiLanguage(db, actorId,
      (body, rows) => send(env, actorId, body, rows, fetchImpl));
    if (action === 'uilangset') {
      if (!await setManagerLanguage(db, actorId, key)) return;
      await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'setMyCommands',
        body: { scope: { type: 'chat', chat_id: actorId }, commands: managerCommandList(key, actorId === primaryId(env)) },
        fetchImpl, timeoutMs: 10000 });
      return showHome(env, db, actorId, fetchImpl);
    }
    if (action === 'home') {
      if (query.message?.reply_markup?.inline_keyboard?.flat().some(item =>
        String(item.callback_data || '').startsWith('um:st:')))
        await run(db, 'DELETE FROM manager_storage_sessions WHERE owner_id=? AND screen_message_id=?',
          actorId, Number(query.message.message_id));
      await run(db, 'DELETE FROM manager_search_flows WHERE operator_id=?', actorId);
      return showHome(env, db, actorId, fetchImpl);
    }
    if (action === 'section') return showHomeSection(env, db, actorId, key, fetchImpl);
    if (action === 'queue') return showQueues(env, db, actorId, registry, key, role, selected, fetchImpl);
    if (action === 'queuebots') return send(env, actorId, 'Выберите сервис для очереди.',
      [[button('Все сервисы', `mg:queue:a:${WORK_FILTERS.includes(key) ? key : 'needs'}:0`)],
        ...registry.filter(config => config.enabled).map(config => [button(opaqueManagerText(config.displayName),
          `mg:queue:${managementBotKey(registry, config.id)}:${WORK_FILTERS.includes(key) ? key : 'needs'}:0`)])], fetchImpl);
    if (action === 'alert') return handleAlertCallback(env, db, actorId, key, role, selected, revision, fetchImpl);
    if (['mine', 'all', 'urgent', 'urgentall'].includes(action)) return showMyWork(env, db, actorId, fetchImpl, action);
    if (action === 'page' && ['all', 'mine', 'urgent', 'urgentall'].includes(key)) return showMyWork(env, db, actorId, fetchImpl,
      key, Number(role));
    if (action === 'workreturn') return returnToWorkList(env, db, actorId, registry, key, Number(role), fetchImpl);
    if (action === 'worknext') return showNextWorkCard(env, db, actorId, registry, key, Number(role), fetchImpl);
    if (action === 'work' || action === 'pw' || action === 'qw') {
      const config = managementBotFromKey(registry, key);
      const userId = Number(role);
      if (config?.enabled && Number.isSafeInteger(userId) && userId > 0) {
        if (action === 'pw' || action === 'qw') {
          const index = Number(action === 'pw' ? selected : revision);
          const page = parseInt(action === 'pw' ? revision : extra, 36);
          const source = action === 'pw' ? workScopes[index] : WORK_FILTERS[index];
          const sourceKey = action === 'qw' ? selected : null;
          if (!source || !Number.isSafeInteger(page) || page < 0 || page > 10000
            || (action === 'pw' && (index === 1 || index === 3) && actorId !== primaryId(env))
            || (action === 'qw' && sourceKey !== 'a' && !managementBotFromKey(registry, sourceKey)?.enabled)) return;
          await rememberWorkList(db, actorId, action === 'pw' ? `mg:page:${source}:${page}`
            : `mg:queue:${sourceKey}:${source}:${page}`);
          await rememberWorkCard(db, actorId, key, userId);
        } else await forgetWorkCard(db, actorId);
        return showWorkCard(env, db, actorId, config, userId, fetchImpl);
      }
    }
    if (action === 'act') {
      const config = managementBotFromKey(registry, role);
      if (config?.enabled) return runWorkAction(env, db, actorId, config, Number(selected), Number(revision), key, fetchImpl);
    }
    if (action === 'transfer') {
      const config = managementBotFromKey(registry, key);
      if (config?.enabled) return beginTransfer(env, db, actorId, config, Number(role), Number(selected), fetchImpl);
    }
    if (action === 'transferpage') return showTransferTargets(env, db, actorId, key, fetchImpl, role);
    if (action === 'to') return chooseTransferTarget(env, db, actorId, key, Number(role), fetchImpl);
    if (action === 'commit') return finishTransfer(env, db, actorId, key, fetchImpl);
    if (action === 'abort') {
      await run(db, 'DELETE FROM manager_work_flows WHERE operator_id=? AND nonce=?', actorId, key);
      return showMyWork(env, db, actorId, fetchImpl);
    }
    if (action === 'service') {
      const config = managementBotFromKey(registry, key);
      if (config) return showService(env, db, actorId, config, registry, fetchImpl);
    }
    if (action === 'help') return showManagerHelp(env, db, actorId,
      (body, rows) => send(env, actorId, body, rows, fetchImpl), key);
    if (action === 'drafts') return showDrafts(env, db, actorId, registry, fetchImpl, key || 0);
    if (action === 'importpending') {
      const pending = await first(db, `SELECT target_bot_id,user_id,stage,expected_state_key FROM operator_pending_actions
        WHERE operator_id=? AND flow_nonce=? AND management_bot_id<>'__manager__' AND expires_at>?`, actorId, key, now());
      if (pending?.expected_state_key && registry.some(item => item.id === pending.target_bot_id && item.enabled)
        && Number(pending.user_id) > 0 && ['reason', 'duration', 'confirm'].includes(pending.stage)) {
        await run(db, `UPDATE operator_pending_actions SET management_bot_id='__manager__',chat_id=?,thread_id=NULL,suspended=0
          WHERE operator_id=? AND flow_nonce=? AND management_bot_id<>'__manager__' AND expires_at>?`,
        actorId, actorId, key, now());
        return handleManagerUserAction(env, db, query.from, 'mu:resume',
          (body, rows) => send(env, actorId, body, rows, fetchImpl));
      }
      return showDrafts(env, db, actorId, registry, fetchImpl);
    }
    if (action === 'draftwork') return resumeTransferDraft(env, db, actorId, key, fetchImpl);
    if (action === 'draftnote') {
      const config = managementBotFromKey(registry, key), userId = Number(role);
      if (config?.enabled && Number.isSafeInteger(userId) && userId > 0)
        return restoreLegacyNote(env, db, actorId, config, userId, fetchImpl);
    }
    if (action === 'draftmsg') {
      if (actorId !== primaryId(env)) return;
      const flow = await first(db, 'SELECT bot_id,field,draft FROM bot_message_flows WHERE owner_id=? AND nonce=? AND chat_id=? AND expires_at>?',
        actorId, key, actorId, now());
      const config = flow && registry.find(item => item.id === flow.bot_id && item.enabled);
      if (!config) return showDrafts(env, db, actorId, registry, fetchImpl);
      await cancelManagerMessageFlow(db, actorId);
      return handleManagerServiceSettings(env, db, actorId,
        ['msg', managementBotKey(registry, config.id), flow.field === 'welcome_text' ? 'w' : 'a', flow.draft ? 'restore' : 'view'],
        (body, rows) => send(env, actorId, body, rows, fetchImpl), fetchImpl, query.message);
    }
    if (action === 'diag') {
      const config = managementBotFromKey(registry, key);
      if (config) return showManagerDeliveryDiagnostics(env, db, actorId, config, Number(role), Number(selected),
        (body, rows) => send(env, actorId, body, rows, fetchImpl));
    }
    if (action === 'problems') return showManagerDeliveryProblems(env, db, actorId, key, role,
      (body, rows) => send(env, actorId, body, rows, fetchImpl));
    if (action === 'ready') {
      const config = managementBotFromKey(registry, key);
      if (config?.enabled) return showManagerReadiness(env, db, actorId, config, role === 'details',
        (body, rows) => send(env, actorId, body, rows, fetchImpl), fetchImpl);
    }
    if (action === 'search') return showManagerUserSearch(env, db, actorId, '',
      (body, rows) => send(env, actorId, body, rows, fetchImpl));
    if (action === 'operators') return showOperators(env, db, actorId, fetchImpl,
      key ? Number(key) : 0, role ? Number(role) : 0);
    if (action === 'opprimary') return showPrimaryOperatorCard(env, db, actorId, fetchImpl, Number(key) || 0);
    if (action === 'opcard') return showOperatorCard(env, db, actorId, Number(key), fetchImpl, false, Number(role) || 0);
    if (action === 'rxview' || action === 'attackview') return showManagerServiceInspection(env, db, key,
      action === 'rxview' ? 'rx' : 'attack', (body, rows) => send(env, actorId, body, rows, fetchImpl), role);
    if (action === 'users') return showManagerUserHome(env, db, actorId,
      (body, rows) => send(env, actorId, body, rows, fetchImpl));
    if (action === 'audit') return showManagerAudit(env, db, actorId,
      /^\d+$/.test(key) ? 'a' : key, /^\d+$/.test(key) ? Number(key) : Number(role),
      selected === 'd', fetchImpl);
    if (actorId !== primaryId(env)) return;
    if (action === 'lifecycle' || action === 'lifedo') {
      const config = managementBotFromKey(registry, key);
      if (config && ['pause', 'resume', 'remove'].includes(role)) return action === 'lifecycle'
        ? showServiceLifecycle(env, db, actorId, config, registry, role, fetchImpl)
        : applyServiceLifecycle(env, db, actorId, config, registry, role, fetchImpl);
    }
    if (action === 'health') return showManagerSystemHealth(env, db, actorId,
      key ? managementBotFromKey(registry, key) : null,
      (body, rows) => send(env, actorId, body, rows, fetchImpl));
    if (action === 'healthpage') return showManagerSystemHealth(env, db, actorId, null,
      (body, rows) => send(env, actorId, body, rows, fetchImpl), Number(key));
    if (action === 'plan') return handleManagerPlan(env, db, actorId, [key, role, selected, revision],
      (body, rows) => send(env, actorId, body, rows, fetchImpl));
    if (['settings', 'language', 'langset', 'msgs', 'msg', 'msgsave', 'msgcancel', 'msgrevise', 'copymsg', 'copypreview', 'copyapply',
      'rx', 'rxtest', 'rxcheck', 'rxstop', 'rxset', 'style',
      'stylecolors', 'styleicons', 'styleicon', 'stylecolor', 'stylereset', 'attack', 'attackconfirm', 'attackset'].includes(action))
      return handleManagerServiceSettings(env, db, actorId, [action, key, role, selected],
        (body, rows) => send(env, actorId, body, rows, fetchImpl), fetchImpl, query.message);
    if (action === 'delivery' || action === 'recover') {
      const config = key === 'a' ? null : managementBotFromKey(registry, key);
      if (key === 'a' || config?.enabled) return managerRecoveryScreen(env, db, actorId, config, registry, fetchImpl,
        ctx?.exports?.DeliveryRecovery || env.MANUAL_DELIVERY_SERVICE, query);
    }
    if (action === 'metrics') return showMetrics(env, db, actorId, fetchImpl);
    if (action === 'opremove') return showOperatorCard(env, db, actorId, Number(key), fetchImpl, true, Number(role) || 0);
    if (action === 'opadd') return showOperatorAddConfirmation(env, db, actorId, Number(key), fetchImpl,
      Number(role) || 0, Number(selected) || 0);
    if (action === 'opaddconfirm' || action === 'opconfirm') return changeOperator(env, db, actorId, Number(key),
      action === 'opconfirm' ? 'opremove' : 'opadd', fetchImpl,
      /^[0-9a-z]+$/.test(role || '') ? parseInt(role, 36) : null, Number(selected) || 0,
      Number(revision) || 0);
    if (action === 'addbot' || action === 'addbotpage') return showRegistrationGroups(env, db, actorId, fetchImpl,
      action === 'addbotpage' ? key : 0);
    if (action === 'newgrp') return beginGroupFlow(env, db, actorId,
      { id: '__new__', displayName: 'нового сервиса' }, fetchImpl);
    if (action === 'reggrp') {
      const groupId = Number(key);
      const available = await first(db, 'SELECT 1 AS allowed FROM support_groups WHERE group_id=?', groupId);
      if (!available && groupId !== Number(env.SUPPORT_GROUP_ID)) return;
      const title = await verifyManagerGroup(env, groupId, fetchImpl);
      await registerSupportGroup(db, groupId, { title, forumVerifiedAt: now(), managerVerifiedAt: now() });
      await ensureGroupMenu(env, db, groupId, registry, fetchImpl);
      const synthetic = { update_id: update.update_id, message: { message_id: query.message.message_id,
        chat: { id: actorId, type: 'private' }, from: query.from, text: '/addbot' } };
      return resumeBotRegistration(env, db, synthetic, actorId, fetchImpl, groupId);
    }
    if (action === 'begin') {
      const config = managementBotFromKey(registry, key);
      if (config?.enabled) return beginGroupFlow(env, db, actorId, config, fetchImpl);
    }
    if (action === 'test' || action === 'testnew') {
      const config = managementBotFromKey(registry, key);
      if (config?.enabled) return showServiceCheck(env, db, actorId, config, registry, fetchImpl, action === 'testnew');
    }
    if (action === 'choose') {
      const config = managementBotFromKey(registry, key);
      if (config?.enabled && ['p', 'b'].includes(role)) return chooseOwner(env, db, actorId, config, registry, role, fetchImpl, selected);
    }
    if (action === 'set') {
      const config = managementBotFromKey(registry, key);
      if (config?.enabled) return selectOwner(env, db, actorId, config, registry, role, Number(selected), fetchImpl);
    }
    if (action === 'timers') {
      const config = managementBotFromKey(registry, key);
      if (config?.enabled) return showTimers(env, actorId, config, registry, fetchImpl);
    }
    if (action === 'settimers') {
      const config = managementBotFromKey(registry, key);
      const reminderMinutes = Number(role), fallbackMinutes = Number(selected);
      if (config?.enabled && [[15, 30], [30, 60], [60, 120], [120, 240]]
        .some(([a, b]) => a === reminderMinutes && b === fallbackMinutes)) {
        const owners = await getServiceOwners(db, config.id);
        await setServiceOwners(db, { botId: config.id, primaryId: owners.primary_id, backupId: owners.backup_id,
          reminderMinutes, fallbackMinutes });
        return showService(env, db, actorId, config, registry, fetchImpl);
      }
    }
    if (action === 'flow') {
      const flow = await currentFlow(db, actorId);
      if (flow?.nonce === key) {
        if (flow.bot_id === '__new__') {
          if (flow.stage === 'awaiting_group') return beginGroupFlow(env, db, actorId,
            { id: '__new__', displayName: 'нового сервиса' }, fetchImpl);
          if (flow.stage === 'registration_group') return send(env, actorId,
            `Группа «${safeTitle(flow.target_group_title)}» подготовлена. Добавьте сервисного бота.`,
            [[button('Добавить сервисного бота', `mg:reggrp:${flow.target_group_id}`)]], fetchImpl);
        }
        const config = registry.find(item => item.id === flow.bot_id);
        if (config?.enabled && flow.stage === 'awaiting_group') return beginGroupFlow(env, db, actorId, config, fetchImpl);
        if (config?.enabled && flow.stage === 'confirm') return send(env, actorId,
          await groupConfirmationText(env, db, config, flow.target_group_title),
          [[button('Подключить группу', `mg:confirm:${flow.nonce}`)]], fetchImpl);
        if (config?.enabled && flow.stage === 'connecting') return send(env, actorId,
          `${opaqueManagerText(config.displayName)} → ${opaqueManagerText(safeTitle(flow.target_group_title))}\n\nПодключение ещё завершается. Проверьте права ботов и повторите подтверждение.`,
          [[button('Завершить подключение', `mg:confirm:${flow.nonce}`)]], fetchImpl);
      }
    }
    if (action === 'storage') return key === 'group'
      ? openStorageGroup(env, db, actorId, Number(role), fetchImpl)
      : showStorageGroups(env, db, actorId, fetchImpl, key === 'page' ? role : 0);
    if (action === 'confirm') return confirmGroup(env, db, actorId, key, registry, fetchImpl);
    return;
  }
  if (!message) return;
  if (message.chat?.type !== 'private') {
    if (message.chat?.type !== 'supergroup') return;
    if (!message.from?.is_bot && /\b\d{5,20}:[A-Za-z0-9_-]{20,150}\b/.test(String(message.text || message.caption || ''))) {
      await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'deleteMessage',
        body: { chat_id: message.chat.id, message_id: message.message_id }, fetchImpl, timeoutMs: 10000 });
      if (actorId === primaryId(env)) await send(env, actorId,
        'В группе обнаружен токен бота. Сообщение удалено по возможности; если его могли увидеть другие, перевыпустите токен в BotFather. Для подключения используйте личный чат управляющего бота.', null, fetchImpl);
      return;
    }
    if (!addressedToManager(message, env)) return;
    const groupCommand = String(message.text || '').trim().split(/\s+/, 1)[0].split('@')[0].toLowerCase();
    if (groupCommand === '/alerts' && actorId === primaryId(env)) {
      const flow = await first(db, "SELECT * FROM manager_alert_flows WHERE owner_id=? AND stage='group' AND expires_at>?", actorId, now());
      if (!flow) return send(env, actorId, 'Сначала выберите «Переключить в топик группы» в разделе «Алерты» Админушки.', null, fetchImpl);
      const groupId = Number(message.chat.id), threadId = Number(message.message_thread_id);
      const group = await first(db, 'SELECT 1 AS connected FROM support_groups WHERE group_id=?', groupId);
      if (!group || !Number.isSafeInteger(threadId) || threadId <= 1)
        return send(env, actorId, 'Отправьте /alerts внутри нужного топика подключённой группы.', null, fetchImpl);
      const result = await alertRpc(env, 'switch', { expectedGeneration: Number(flow.generation),
        mode: 'group', chatId: groupId, threadId });
      await run(db, 'DELETE FROM manager_alert_flows WHERE owner_id=? AND nonce=?', actorId, flow.nonce);
      return showAlerts(env, db, actorId, fetchImpl,
        `✅ Алерты переключены в выбранный топик.${result.oldNotified ? '' : '\nПрежний чат недоступен: сообщить там об отключении не удалось.'}\n\n`);
    }
    if (['/adoptmenu', '/retrymenu'].includes(groupCommand) && actorId === primaryId(env)
      && Number(message.message_thread_id || 1) === 1) {
      const groupId = Number(message.chat.id);
      const group = await first(db, 'SELECT menu_state,menu_message_id FROM support_groups WHERE group_id=?', groupId);
      if (!group || !['uncertain', 'pending'].includes(group.menu_state)) return send(env, actorId,
        'Для этой группы нет неподтверждённого меню. Откройте мастер подключения.', null, fetchImpl);
      if (groupCommand === '/retrymenu') {
        if (group.menu_state === 'uncertain' && !group.menu_message_id) {
          await run(db, "UPDATE support_groups SET menu_state='pending',updated_at=? WHERE group_id=? AND menu_state='uncertain' AND menu_message_id IS NULL",
            now(), groupId);
        }
        return send(env, actorId,
          'Проверка General отмечена. Повторите исходное действие в личке управляющего бота; меню будет создано или закреплено.', null, fetchImpl);
      }
      const replied = message.reply_to_message;
      const own = await call(env, 'getMe', {}, fetchImpl);
      if (!Number.isSafeInteger(Number(replied?.message_id)) || Number(replied.from?.id) !== Number(own.id)
        || !managerHeaderMatches(replied.text, 'Управление поддержкой')) {
        return send(env, actorId,
          'Ответьте командой /adoptmenu в General на сообщение меню, которое отправил управляющий бот.', null, fetchImpl);
      }
      await run(db, `UPDATE support_groups SET menu_message_id=?,menu_state='pending',updated_at=?
        WHERE group_id=? AND menu_state IN ('uncertain','pending')
          AND (menu_message_id IS NULL OR menu_message_id=?)`,
        Number(replied.message_id), now(), groupId, Number(replied.message_id));
      await ensureGroupMenu(env, db, groupId, registry, fetchImpl);
      return send(env, actorId,
        'Найденное меню закреплено. Повторите подключение группы в личке; маршрут сервиса пока не менялся.', null, fetchImpl);
    }
    if (['/menu', '/panel', '/help'].includes(groupCommand) && await authorizedOperator(db, env, actorId)) {
      const threadId = Number(message.message_thread_id);
      if (threadId > 1 && ['/menu', '/panel'].includes(groupCommand)) {
        const conversation = await first(db, 'SELECT bot_id,user_id FROM conversations WHERE support_group_id=? AND thread_id=?',
          Number(message.chat.id), threadId);
        const config = conversation && registry.find(item => item.id === conversation.bot_id && item.enabled);
        if (config) return showTopicWorkCard(env, db, config, conversation.user_id, Number(message.chat.id),
          threadId, fetchImpl, null, '', actorId);
      }
      const services = await listGroupServices(db, Number(message.chat.id));
      if (!services.length) return;
      await ensureGroupMenu(env, db, Number(message.chat.id), registry, fetchImpl);
      const managerName = String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, '');
      return call(env, 'sendMessage', { chat_id: message.chat.id,
        text: managerName ? `Меню закреплено в General. Личное управление: https://t.me/${managerName}?start=menu` : 'Меню закреплено в General.' }, fetchImpl);
    }
    if (['/close', '/open'].includes(groupCommand) && await authorizedOperator(db, env, actorId)) {
      const chatId = Number(message.chat.id), threadId = Number(message.message_thread_id);
      if (!Number.isSafeInteger(threadId) || threadId <= 1) return send(env, chatId,
        `Команда ${groupCommand} работает внутри темы обращения.`, null, fetchImpl);
      const conversation = await first(db, 'SELECT * FROM conversations WHERE support_group_id=? AND thread_id=?', chatId, threadId);
      if (conversation) return changeTopicState(env, db, actorId, conversation, groupCommand === '/open' ? 'open' : 'close', fetchImpl);
      if (groupCommand === '/open') return call(env, 'sendMessage', { chat_id: chatId, message_thread_id: threadId,
        text: 'Для этой темы не найдено обращение. Проверьте, что команда отправлена в клиентской теме.' }, fetchImpl);
      const check = await first(db, `SELECT owner_id FROM service_checks
        WHERE group_id=? AND thread_id=? AND stage='done' LIMIT 1`, chatId, threadId);
      if (check && actorId === primaryId(env) && Number(check.owner_id) === actorId) {
        const closed = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'closeForumTopic',
          body: { chat_id: chatId, message_thread_id: threadId }, fetchImpl, timeoutMs: 10000 });
        if (!closed.ok && !isAlreadyTopicState(closed.description, 'closed')) throw new ManagerError(
          'Не удалось закрыть тестовую тему. Проверьте право Админушки управлять темами и повторите /close.',
          closed.retryable || closed.deliveryUncertain);
        return send(env, actorId, 'Тестовая тема закрыта.', null, fetchImpl);
      }
      return call(env, 'sendMessage', { chat_id: chatId, message_thread_id: threadId,
        text: 'Для этой темы не найдено обращение. Проверьте, что команда отправлена в клиентской теме.' }, fetchImpl);
    }
    if (groupCommand === '/case' && await authorizedOperator(db, env, actorId)) {
      const chatId = Number(message.chat.id), threadId = Number(message.message_thread_id);
      if (!Number.isSafeInteger(threadId) || threadId <= 1) return;
      const conversation = await first(db, `SELECT bot_id,user_id FROM conversations
        WHERE support_group_id=? AND thread_id=?`, chatId, threadId);
      const config = registry.find(item => item.id === conversation?.bot_id && item.enabled);
      if (config) return showTopicWorkCard(env, db, config, Number(conversation.user_id), chatId, threadId, fetchImpl,
        null, '', actorId);
      return;
    }
    if (/^\/status(?:@[a-z0-9_]+)?(?:\s|$)/i.test(String(message.text || ''))
      && await authorizedOperator(db, env, actorId)) {
      const threadId = Number(message.message_thread_id);
      if (!message.reply_to_message?.message_id) {
        return call(env, 'sendMessage', { chat_id: message.chat.id, message_thread_id: threadId,
          text: 'Чтобы проверить доставку, ответьте командой /status на конкретное сообщение оператора в этой теме.' }, fetchImpl);
      }
      const conversation = await first(db, 'SELECT bot_id FROM conversations WHERE support_group_id=? AND thread_id=?',
        Number(message.chat.id), threadId);
      if (!conversation) return;
      const result = await getOperatorMessageDeliveryStatus(db, { botId: conversation.bot_id,
        sourceChatId: Number(message.chat.id), sourceMessageId: Number(message.reply_to_message.message_id) });
      return call(env, 'sendMessage', { chat_id: message.chat.id, message_thread_id: threadId,
        text: deliveryStatusCard(result, Number(message.reply_to_message.message_id), await getManagerLanguage(db, actorId)),
        reply_markup: { inline_keyboard: deliveryStatusMarkup(Number(message.reply_to_message.message_id)) } }, fetchImpl);
    }
    return observeGroup(env, db, message, registry, fetchImpl);
  }
  if (Number(message.chat.id) !== actorId) return;
  if (!addressedToManager(message, env)) return;
  const commandParts = String(message.text || '').trim().split(/\s+/);
  const command = commandParts[0].split('@')[0].toLowerCase();
  if (command === '/start' && !message.from?.is_bot) {
    await markManagerDmStarted(db, { operatorId: actorId, firstName: message.from?.first_name ? safeTitle(message.from.first_name) : null,
      username: message.from?.username || null });
  }
  if (!await authorizedOperator(db, env, actorId)) {
    if (command === '/start') return send(env, actorId,
      'Личный чат подключён. Главный администратор может добавить вас в операторы поддержки.', null, fetchImpl);
    return;
  }
  if (['/start', '/menu', '/groups'].includes(command)
    && (commandParts.length === 1 || command === '/start' && commandParts.length === 2 && commandParts[1] === 'menu')) {
    const claim = await claimManagerHome(db, actorId, update.update_id);
    if (!claim) return;
    try {
      await suspendPrivateInputs(db, actorId, command);
      const result = await showHome({ ...env, ...(claim.messageId ? {
        MANAGER_SCREEN_CHAT_ID: actorId, MANAGER_SCREEN_MESSAGE_ID: claim.messageId, MANAGER_SCREEN_ROUTE: 'mg:home',
      } : {}) }, db, actorId, fetchImpl);
      let messageId = Number(result?.message_id) || claim.messageId || null;
      if (!messageId) {
        // Telegram may have accepted the menu before its home-pointer write
        // failed. Recover the durable send receipt without sending again.
        const receipt = await first(db, `SELECT telegram_message_id FROM manager_message_sends
          WHERE update_id=? AND chat_id=? AND thread_id=0 AND status='sent'`, update.update_id, actorId);
        messageId = Number(receipt?.telegram_message_id) || null;
      }
      await completeManagerHome(db, actorId, claim.token, messageId);
    } catch (error) {
      await releaseManagerHome(db, actorId, claim.token);
      throw error;
    }
    return;
  }
  if (command.startsWith('/') && command !== '/cancel') await suspendPrivateInputs(db, actorId, command);
  const caseStart = /^\/start(?:@\w+)?\s+case_(b[0-9a-z]{13})_(\d+)$/.exec(String(message.text || '').trim());
  if (caseStart) {
    const config = managementBotFromKey(registry, caseStart[1]);
    if (config?.enabled) {
      await forgetWorkCard(db, actorId);
      return showWorkCard(env, db, actorId, config, Number(caseStart[2]), fetchImpl);
    }
    return;
  }
  const profileStart = /^\/start(?:@\w+)?\s+(user|history)_(b[0-9a-z]{13})_(\d+)$/.exec(String(message.text || '').trim());
  if (profileStart) {
    const config = managementBotFromKey(registry, profileStart[2]);
    const userId = Number(profileStart[3]);
    if (!config || !Number.isSafeInteger(userId) || userId <= 0) return;
    return profileStart[1] === 'user'
      ? showManagerUserCard(env, db, actorId, profileStart[2], userId,
        (body, rows) => send(env, actorId, body, rows, fetchImpl))
      : showAuditScreen(env, db, { key: profileStart[2], userId },
        (body, rows) => send(env, actorId, body, rows, fetchImpl));
  }
  if (command === '/status') return send(env, actorId,
    'Статус проверяется в теме обращения: ответьте командой /status на сообщение оператора, которое нужно проверить.', null, fetchImpl);
  if (command === '/available' || command === '/unavailable') {
    await setOperatorAvailability(db, { operatorId: actorId, available: command === '/available', adminId: primaryId(env) });
    return send(env, actorId, command === '/available' ? 'Вы доступны для новых обращений.' : 'Новые обращения перейдут резервному оператору или администратору.',
      [[button('Меню', 'mg:home')]], fetchImpl, false);
  }
  if (command === '/cancel') {
    await run(db, 'UPDATE manager_statistics_preferences SET input_kind=NULL,expires_at=NULL WHERE operator_id=? AND input_kind IS NOT NULL', actorId);
    await run(db, 'DELETE FROM manager_search_flows WHERE operator_id=?', actorId);
    await run(db, 'DELETE FROM manager_work_flows WHERE operator_id=?', actorId);
    await run(db, "DELETE FROM operator_pending_actions WHERE operator_id=? AND management_bot_id='__manager__'", actorId);
    if (actorId === primaryId(env)) await run(db, 'DELETE FROM manager_alert_flows WHERE owner_id=?', actorId);
    if (actorId === primaryId(env)) await cancelManagerMessageFlow(db, actorId);
    const groupFlow = actorId === primaryId(env) ? await currentFlow(db, actorId) : null;
    if (actorId === primaryId(env)) await run(db, 'DELETE FROM manager_group_flows WHERE owner_id=? AND stage<>\'connecting\'', actorId);
    return send(env, actorId, groupFlow?.stage === 'connecting'
      ? 'Рабочая форма закрыта. Подключение группы ещё завершается; откройте меню и завершите его, чтобы обновить закреплённые меню.'
      : 'Текущий мастер закрыт. Сохранённые обращения и подключения не изменены.', [[button('Меню', 'mg:home')]], fetchImpl, false);
  }
  if (!command.startsWith('/') && typeof message.text === 'string') {
    if (actorId === primaryId(env) && /^\d{5,20}:[A-Za-z0-9_-]{20,150}$/.test(message.text.trim())) {
      const flow = await first(db, "SELECT * FROM manager_alert_flows WHERE owner_id=? AND stage='token' AND expires_at>?", actorId, now());
      await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'deleteMessage',
        body: { chat_id: actorId, message_id: message.message_id }, fetchImpl, timeoutMs: 10000 });
      if (!flow) return send(env, actorId, 'Токен удалён по возможности. Откройте «Алерты» → «Подключить алерт-бота».', null, fetchImpl);
      const otherTokens = new Set([env.MANAGER_BOT_TOKEN, ...registry.map(config => env[config.tokenBinding])]);
      if (otherTokens.has(message.text.trim())) throw new ManagerError('Для алертов нужен отдельный бот, не Админушка и не сервисный бот.');
      const result = await alertRpc(env, 'connect', { token: message.text.trim(), adminId: actorId,
        expectedGeneration: Number(flow.generation) });
      await run(db, 'DELETE FROM manager_alert_flows WHERE owner_id=? AND nonce=?', actorId, flow.nonce);
      return showAlerts(env, db, actorId, fetchImpl,
        `✅ @${result.username} подключён.${result.oldNotified ? '' : '\nПрежний чат недоступен: сообщить там об отключении не удалось.'}\n\n`);
    }
    if (await handleStatisticsText(env,db,actorId,message.text,
      (markdown,rows)=>sendStatistics(env,actorId,markdown,rows,fetchImpl))) return;
    if (await handleManagerUserText(env, db, message.from, message.text,
      (body, rows) => send(env, actorId, body, rows, fetchImpl))) return;
    const flow = await first(db, "SELECT * FROM manager_work_flows WHERE operator_id=? AND stage='note' AND suspended=0 AND expires_at>?", actorId, now());
    if (flow) {
      const note = message.text.trim();
      if (!note || note.length > 500 || /\b\d{5,20}:[A-Za-z0-9_-]{20,150}\b/.test(note)) {
        return send(env, actorId, 'Нужна заметка одной строкой до 500 символов. Токены ботов здесь использовать нельзя.',
          [[button('Отмена', `mg:abort:${flow.nonce}`)]], fetchImpl);
      }
      await run(db, "UPDATE manager_work_flows SET note=?,stage='confirm',updated_at=? WHERE operator_id=? AND nonce=? AND stage='note'",
        note, now(), actorId, flow.nonce);
      return send(env, actorId, `Передать обращение оператору ${flow.target_id}?\n\nВнутренняя заметка: ${opaqueManagerText(note)}`,
        [[button('Подтвердить передачу', `mg:commit:${flow.nonce}`)], [button('Отмена', `mg:abort:${flow.nonce}`)]], fetchImpl);
    }
    if (actorId === primaryId(env) && await handleManagerMessageText(env, db, actorId, message.text,
      (body, rows) => send(env, actorId, body, rows, fetchImpl))) return;
    if (await handleManagerUserSearchText(env, db, actorId, message.text,
      (body, rows) => send(env, actorId, body, rows, fetchImpl))) return;
  }
  if (command === '/mine') return showMyWork(env, db, actorId, fetchImpl);
  if (command === '/all') return showMyWork(env, db, actorId, fetchImpl, 'all');
  if (command === '/urgent') return showMyWork(env, db, actorId, fetchImpl, 'urgent');
  if (command === '/urgentall') return showMyWork(env, db, actorId, fetchImpl, 'urgentall');
  if (command === '/metrics') return showMetrics(env, db, actorId, fetchImpl);
  if (command === '/help') return showManagerHelp(env, db, actorId,
    (body, rows) => send(env, actorId, body, rows, fetchImpl));
  if (command === '/health' && actorId === primaryId(env)) return showManagerSystemHealth(env, db, actorId, null,
    (body, rows) => send(env, actorId, body, rows, fetchImpl));
  if (command === '/user') return showManagerUserSearch(env, db, actorId,
    String(message.text || '').trim().split(/\s+/).slice(1).join(' '),
    (body, rows) => send(env, actorId, body, rows, fetchImpl));
  if (command === '/users') return showManagerUserHome(env, db, actorId,
    (body, rows) => send(env, actorId, body, rows, fetchImpl));
  if (command === '/operators') return showOperators(env, db, actorId, fetchImpl);
  if (command === '/reactions') return showManagerServiceInspection(env, db, 'a', 'rx',
    (body, rows) => send(env, actorId, body, rows, fetchImpl));
  if (command === '/audit') return showManagerAudit(env, db, actorId, 'a', 0, false, fetchImpl);
  if (command === '/storage' && actorId === primaryId(env)) return showStorageGroups(env, db, actorId, fetchImpl);
  if (command === '/alerts' && actorId === primaryId(env)) return showAlerts(env, db, actorId, fetchImpl);
  if (command === '/start' || command === '/menu' || command === '/groups') {
    await run(db, 'DELETE FROM manager_search_flows WHERE operator_id=?', actorId);
    return showHome(env, db, actorId, fetchImpl);
  }
}

/** Dedicated Telegram identity and webhook; service updates keep their existing routes. */
export function createManagerWorker(baseWorker, fetchImpl = fetch) {
  return {
    async fetch(request, originalEnv, ctx) {
      if (new URL(request.url).pathname !== managerPath) return baseWorker.fetch(request, originalEnv, ctx);
      if (request.method !== 'POST' || !managerConfigured(originalEnv)) return reply(404, 'Not found');
      if (!timingSafeEqual(request.headers.get('x-telegram-bot-api-secret-token') || '', originalEnv.MANAGER_WEBHOOK_SECRET)) return reply(403, 'Forbidden');
      if (!(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) return reply(415, 'Expected JSON');
      let update;
      try { update = await request.json(); } catch { return reply(400, 'Invalid JSON'); }
      if (!Number.isSafeInteger(update?.update_id)) return reply(400, 'Invalid update');
      const startedAt = Date.now();
      let errorDb = originalEnv.SUPPORT_DB, phase = 'registry', failureClass = null, telegramFailure = null;
      try {
        const hydrated = await withBotRegistry(originalEnv);
        const db = await resolveInvocationDatabase(hydrated.SUPPORT_DB, hydrated);
        errorDb = db;
        const env = { ...hydrated, SUPPORT_DB: db, MANAGER_UPDATE_ID: update.update_id };
        phase = 'dispatch';
        if (update.message?.chat?.type === 'private' && Number(update.message.from?.id) === primaryId(env)
          && /^\/storage(?:@\w+)?\s+emergency$/i.test(String(update.message.text || '').trim())) {
          await handleEmergencyStorage(env, primaryId(env), { message: { ...update.message, text: '/storage' } }, fetchImpl);
          return reply(200, 'OK');
        }
        if (storageCandidate(update)) {
          const query = update.callback_query;
          const callback = String(query?.data || '').startsWith('um:st:');
          const phrase = isStorageResetPhrase(update.message?.text);
          const rules = /^\/storage(?:@\w+)?\s+rules\s+\d+\s+\d+\s+\d+\s*$/i.test(String(update.message?.text || ''));
          if (callback || phrase || rules) {
            const actorId = Number(query?.from?.id || update.message?.from?.id);
            const source = query?.message || update.message;
            if (actorId !== primaryId(env) || source?.chat?.type !== 'private' || Number(source.chat.id) !== actorId) {
              if (query) await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'answerCallbackQuery',
                body: { callback_query_id: query.id, text: translateManager(await getManagerLanguage(db, actorId), 'Откройте Хранилище в личке Админушки.'), show_alert: true },
                fetchImpl, timeoutMs: 5000 });
              return reply(200, 'OK');
            }
            if (callback && managerHeaderMatches(source.text, EMERGENCY_STORAGE_MARKER)) {
              const managerName = String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, '').toLowerCase();
              const action = String(query.data).slice('um:st:'.length).split(':')[0];
              if (!emergencyStorageActions.has(action) || source.from?.is_bot !== true
                || String(source.from.username || '').toLowerCase() !== managerName) return reply(200, 'OK');
              await handleEmergencyStorage(env, actorId, update, fetchImpl);
              return reply(200, 'OK');
            }
            const session = await first(db, 'SELECT group_id,screen_message_id FROM manager_storage_sessions WHERE owner_id=?', actorId);
            if (callback && Number(session?.screen_message_id) !== Number(source.message_id)) {
              await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'answerCallbackQuery',
                body: { callback_query_id: query.id, text: translateManager(await getManagerLanguage(db, actorId), 'Этот экран устарел. Откройте Хранилище заново.'), show_alert: true },
                fetchImpl, timeoutMs: 5000 });
              return reply(200, 'OK');
            }
            if (!session && phrase) {
              const control = await first(db, "SELECT confirmation_actor,confirmation_group,confirmation_stage FROM storage_control WHERE id=1");
              if (Number(control?.confirmation_actor) === actorId && Number(control.confirmation_group) === Number(env.SUPPORT_GROUP_ID)
                && control.confirmation_stage === 'phrase') await handleEmergencyStorage(env, actorId, update, fetchImpl);
              return reply(200, 'OK');
            }
            if (!session) return reply(200, 'OK');
            const group = await first(db, 'SELECT group_id,title FROM support_groups WHERE group_id=?', Number(session.group_id));
            if (!group) return reply(200, 'OK');
            await handlePrivateStorage(env, db, actorId, group, update, fetchImpl);
            return reply(200, 'OK');
          }
          if (update.message?.chat?.type === 'supergroup') return reply(200, 'OK');
        }
        if (db.storageMode === 'reset' && (String(update.callback_query?.data || '') === 'mg:storage'
          || update.message?.chat?.type === 'private' && /^\/storage(?:@\w+)?$/.test(String(update.message?.text || '').trim()))) {
          const actorId = Number(update.callback_query?.from?.id || update.message?.from?.id);
          if (actorId === primaryId(env)) {
            const session = await first(db, 'SELECT group_id FROM manager_storage_sessions WHERE owner_id=?', actorId);
            await openStorageGroup(env, db, actorId, Number(session?.group_id || env.SUPPORT_GROUP_ID), fetchImpl);
          }
          return reply(200, 'OK');
        }
        if (db.storageMode === 'reset') return reply(503, 'Storage maintenance; retry later');
        await dispatchManagerUpdate(env, update, fetchImpl, ctx);
        return reply(200, 'OK');
      } catch (error) {
        failureClass = error?.constructor?.name || 'Error';
        if (error instanceof ManagerError) telegramFailure = error.telegramFailure;
        if (error instanceof ManagerError && !error.retryable) {
          const actorId = Number(update.callback_query?.from?.id || update.message?.from?.id);
          if (Number.isSafeInteger(actorId) && actorId > 0) {
            let locale = 'en';
            try { locale = await getManagerLanguage(errorDb, actorId); } catch {}
            const notice = await requestTelegram({ token: originalEnv.MANAGER_BOT_TOKEN, method: 'sendMessage',
              body: { chat_id: actorId, text: translateManager(locale, error.message) }, fetchImpl, timeoutMs: 10000 });
            if (!notice.ok) console.warn(JSON.stringify({ event: 'manager_error_notice_failed',
              update_id: update.update_id, retryable: notice.retryable || notice.deliveryUncertain }));
          }
          // A permanent Telegram rejection cannot be fixed by replaying the
          // same update. The saved state is visible on a fresh /case or /start.
          return reply(200, 'OK');
        }
        console.warn(JSON.stringify({ event: 'manager_update_retry', update_id: update.update_id, retryable: error?.retryable === true }));
        return reply(503, 'Manager update failed; retry later');
      } finally {
        const sourceDate = Number(update.message?.date);
        const command = /^\/(start|menu|groups)(?:@\w+)?(?:\s|$)/i.exec(String(update.message?.text || ''))?.[1]?.toLowerCase();
        console.info(JSON.stringify({ event: 'manager_update_timing', update_id: update.update_id,
          kind: command || (update.callback_query ? 'callback' : 'message'),
          elapsed_ms: Date.now() - startedAt,
          ...(Number.isSafeInteger(sourceDate) && sourceDate > 0 ? { source_age_ms: Math.max(0, startedAt - sourceDate * 1000) } : {}),
          queries: errorDb.used, phase, ...(failureClass ? { failure_class: failureClass } : {}), ...telegramFailure }));
      }
    },
    scheduled(controller, env, ctx) { return baseWorker.scheduled(controller, env, ctx); },
  };
}
