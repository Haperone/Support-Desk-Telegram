import legacyWorker, { isIgnoredTelegramServiceMessage, managementBotKey, parseAdminIds, parseBotRegistry, timingSafeEqual } from "./worker.js";
import { CONTROL_PLANE_CONTEXT, isGeneralCommand, stablePendingNonce } from "./control-plane-contract.js";
import { storageCandidate } from './storage-ui.js';
import { prepareTelegramCleanup, settleTelegramCleanup, isConfirmedMessageDeletion } from './telegram-cleanup.js';
import { recordOperationalSignal } from './support-health.js';
import { backgroundDbRun, resolveInvocationDatabase } from "./recovery-budget.js";
import { requestTelegram } from "./telegram-response.js";
import { assertTelegramReady, deferredTelegramResult, recordTelegramCooldown, telegramRequestGate } from "./telegram-cooldown.js";

const GENERAL_CONTROL_LEASE_MS = 30_000;
const GENERAL_OWNER_GRACE_MS = 1_500;
const MAX_GENERAL_OWNER_GRACE_MS = 5_000;
const DEFAULT_TELEGRAM_TIMEOUT_MS = 10_000;
const MAX_TELEGRAM_TIMEOUT_MS = 30_000;
const CALLBACK_RECOVERY_LEASE_MS = 60_000;


function reply(status, text) {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
function nowIso() { return new Date().toISOString(); }
function isoAfter(ms) { return new Date(Date.now() + ms).toISOString(); }
function supportGroupId(env) {
  const value = Number(env.SUPPORT_GROUP_ID);
  if (!Number.isSafeInteger(value)) throw new Error("SUPPORT_GROUP_ID must be an integer");
  return value;
}
function asPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function asNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
function leaseMs(env) { return asPositiveInteger(env.GENERAL_CONTROL_LEASE_MS, GENERAL_CONTROL_LEASE_MS); }
function telegramTimeoutMs(env) {
  return Math.min(asPositiveInteger(env.TELEGRAM_TIMEOUT_MS, DEFAULT_TELEGRAM_TIMEOUT_MS), MAX_TELEGRAM_TIMEOUT_MS);
}
function sleep(ms) { return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve(); }
function dbFirst(db, sql, ...params) { return db.prepare(sql).bind(...params).first(); }
function dbRun(db, sql, ...params) { return db.prepare(sql).bind(...params).run(); }

function commandOf(message) {
  const text = String(message?.text || "").trim();
  if (!text.startsWith("/")) return null;
  const token = text.split(/\s+/, 1)[0].toLowerCase();
  return token.split("@", 1)[0];
}
function isGeneralMessage(message, env) {
  if (!message || String(message.chat?.id) !== String(supportGroupId(env))) return false;
  const threadId = message.message_thread_id;
  return threadId === undefined || threadId === null || Number(threadId) === 1;
}
function webhookBotId(request) {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  return parts.length === 2 && parts[0] === "tg" && /^[a-z0-9-]+$/i.test(parts[1]) ? parts[1] : null;
}
function expectedWebhookSecret(env, config) {
  const value = env[config.webhookSecretBinding];
  if (!value || !/^[A-Za-z0-9_-]{1,256}$/.test(String(value))) throw new Error(`Missing or invalid webhook secret for bot ${config.id}`);
  return String(value);
}
function actualBotToken(env, config) {
  const token = env[config.tokenBinding];
  if (!token) throw new Error(`Missing secret binding for bot ${config.id}`);
  return String(token);
}
function delegatedUpdateId(messageId) {
  const numericMessageId = Number(messageId);
  if (!Number.isSafeInteger(numericMessageId) || numericMessageId <= 0) throw new Error("General message id must be a positive safe integer");
  // Telegram update_id is non-negative. Reserve a negative namespace keyed only by the
  // shared support-group message id, so every bot delivery of the same General message
  // hits the same legacy processed_updates key. This is the cross-bot exactly-once barrier.
  const value = -1_000_000_000_000 - numericMessageId;
  if (!Number.isSafeInteger(value)) throw new Error("Delegated General update id exceeds safe integer range");
  return value;
}
function rewriteWebhookRequest(request, update, logicalConfig, env) {
  const url = new URL(request.url);
  url.pathname = `/tg/${logicalConfig.id}`;
  const headers = new Headers(request.headers);
  headers.set("x-telegram-bot-api-secret-token", expectedWebhookSecret(env, logicalConfig));
  headers.set("content-type", "application/json");
  return new Request(url.toString(), { method: "POST", headers, body: JSON.stringify(update) });
}
function rebuildOriginalRequest(request, bodyText) {
  return new Request(request.url, { method: request.method, headers: new Headers(request.headers), body: bodyText });
}

function managerConfigured(env) {
  return Boolean(env.MANAGER_BOT_TOKEN)
    && /^[A-Za-z0-9_]{5,32}$/.test(String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, ''));
}

async function effectiveGroupCommandOwner(db, registry, env) {
  if (managerConfigured(env)) return null;
  const persisted = await db.prepare("SELECT id, enabled FROM bots").all();
  const enabledById = new Map((persisted.results || []).map((row) => [row.id, Number(row.enabled) !== 0]));
  const enabled = (config) => config.enabled && enabledById.get(config.id) !== false;
  if (!registry.some((config) => config.groupCommandOwner)) return null;
  return registry.find((config) => enabled(config) && config.groupCommandOwner)
    || registry.find(enabled) || null;
}
async function incomingBotEnabled(db, config) {
  if (!config.enabled) return false;
  const row = await dbFirst(db, "SELECT enabled FROM bots WHERE id = ?", config.id);
  return !row || Number(row.enabled) !== 0;
}
async function isRelevantGeneralMessage(db, message) {
  const command = commandOf(message);
  if (command) return isGeneralCommand(command);
  if (!message?.from?.id) return false;
  const pending = await dbFirst(db, "SELECT 1 AS present FROM operator_pending_actions WHERE operator_id = ? AND expires_at > ? LIMIT 1", message.from.id, nowIso());
  if (pending) return true;
  const team = await dbFirst(db, "SELECT 1 AS present FROM support_operator_flows WHERE owner_id = ? AND expires_at > ? AND suspended=0 UNION ALL SELECT 1 FROM bot_message_flows WHERE owner_id = ? AND expires_at > ? AND suspended=0 UNION ALL SELECT 1 FROM operator_work_inputs WHERE operator_id=? AND suspended=0 UNION ALL SELECT 1 FROM operator_input_prompts WHERE chat_id=? AND message_id=? UNION ALL SELECT 1 FROM operator_input_guards WHERE operator_id=? AND active=1 LIMIT 1", message.from.id, nowIso(), message.from.id, nowIso(),message.from.id,message.chat.id,message.reply_to_message?.message_id||0,message.from.id);
  return Boolean(team);
}

export async function claimGeneralControl(db, env, messageId, handlerBotId) {
  const ownerToken = crypto.randomUUID();
  const groupId = supportGroupId(env);
  const expiresAt = isoAfter(leaseMs(env));
  let row = await dbFirst(db,
    "INSERT INTO general_message_claims (support_group_id, message_id, handler_bot_id, owner_token, lease_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(support_group_id, message_id) DO NOTHING RETURNING owner_token",
    groupId, Number(messageId), handlerBotId, ownerToken, expiresAt, nowIso());
  if (row?.owner_token) return { status: "acquired", ownerToken };
  const current = await dbFirst(db, "SELECT * FROM general_message_claims WHERE support_group_id = ? AND message_id = ?", groupId, Number(messageId));
  if (current?.completed_at) return { status: "completed" };
  if (current?.dispatch_succeeded_at) return { status: "dispatched" };
  if (current?.lease_expires_at && Date.parse(current.lease_expires_at) <= Date.now()) {
    row = await dbFirst(db,
      "UPDATE general_message_claims SET handler_bot_id = ?, owner_token = ?, lease_expires_at = ? WHERE support_group_id = ? AND message_id = ? AND completed_at IS NULL AND dispatch_succeeded_at IS NULL AND owner_token = ? AND lease_expires_at <= ? RETURNING owner_token",
      handlerBotId, ownerToken, expiresAt, groupId, Number(messageId), current.owner_token, nowIso());
    if (row?.owner_token) return { status: "acquired", ownerToken };
  }
  return { status: "busy" };
}
export async function renewGeneralControl(db, env, messageId, ownerToken, background = false) {
  const result = await (background ? backgroundDbRun : dbRun)(db,
    "UPDATE general_message_claims SET lease_expires_at = ? WHERE support_group_id = ? AND message_id = ? AND owner_token = ? AND completed_at IS NULL AND lease_expires_at > ?",
    isoAfter(leaseMs(env)), supportGroupId(env), Number(messageId), ownerToken, nowIso());
  return result === null ? null : result.meta?.changes === 1;
}
async function markGeneralDispatchSucceeded(db, env, messageId, ownerToken) {
  const result = await dbRun(db,
    "UPDATE general_message_claims SET dispatch_succeeded_at = COALESCE(dispatch_succeeded_at, ?) WHERE support_group_id = ? AND message_id = ? AND owner_token = ? AND completed_at IS NULL AND lease_expires_at > ?",
    nowIso(), supportGroupId(env), Number(messageId), ownerToken, nowIso());
  if (result.meta?.changes !== 1) throw new Error("General control-plane dispatch marker could not be saved");
}
async function completeGeneralControl(db, env, messageId, ownerToken) {
  const result = await dbRun(db,
    "UPDATE general_message_claims SET completed_at = COALESCE(completed_at, ?), lease_expires_at = ? WHERE support_group_id = ? AND message_id = ? AND owner_token = ? AND completed_at IS NULL AND dispatch_succeeded_at IS NOT NULL",
    nowIso(), nowIso(), supportGroupId(env), Number(messageId), ownerToken);
  if (result.meta?.changes !== 1) throw new Error("General control-plane claim could not be completed");
}
async function settleDispatchedGeneralControl(db, env, messageId) {
  await dbRun(db,
    "UPDATE general_message_claims SET completed_at = COALESCE(completed_at, ?), lease_expires_at = ? WHERE support_group_id = ? AND message_id = ? AND completed_at IS NULL AND dispatch_succeeded_at IS NOT NULL",
    nowIso(), nowIso(), supportGroupId(env), Number(messageId));
}
async function releaseGeneralControl(db, env, messageId, ownerToken) {
  await dbRun(db,
    "DELETE FROM general_message_claims WHERE support_group_id = ? AND message_id = ? AND owner_token = ? AND completed_at IS NULL",
    supportGroupId(env), Number(messageId), ownerToken);
}
export function startGeneralControlHeartbeat(db, env, messageId, ownerToken) {
  const interval = Math.max(10, Math.min(
    asPositiveInteger(env.GENERAL_CONTROL_RENEW_MS, Math.floor(leaseMs(env) / 3)),
    Math.max(10, Math.floor(leaseMs(env) / 3)),
  ));
  let stopped = false;
  let lost = false;
  let renewal = Promise.resolve();
  const renew = async () => {
    if (stopped || lost) return;
    try {
      if (await renewGeneralControl(db, env, messageId, ownerToken, true) === false) lost = true;
    } catch {
      lost = true;
    }
  };
  const timer = setInterval(() => { renewal = renewal.then(renew, renew); }, interval);
  return {
    async fence() {
      await renewal;
      if (stopped || lost) throw new Error("General control-plane lease was lost");
      try {
        if (!await renewGeneralControl(db, env, messageId, ownerToken)) lost = true;
      } catch {
        lost = true;
      }
      if (lost) throw new Error("General control-plane lease was lost");
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await renewal.catch(() => {});
    },
    get lost() { return lost; },
  };
}

export { stablePendingNonce };
export function createHardenedDatabase(realDb, context = {}) {
  const delegatedContext = Object.freeze({
    generalOwnerToken: context.generalOwnerToken || null,
    stableSeed: context.stableSeed || null,
    managementUiBotId: context.managementUiBotId || null,
  });
  return new Proxy(realDb, {
    get(target, property) {
      if (property === CONTROL_PLANE_CONTEXT) return delegatedContext;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
function createDelegatedEnv(env, db, executorConfig) {
  // These overrides must remain enumerable when the downstream Worker adds
  // invocation-local health metadata using an environment spread.
  return { ...env, SUPPORT_DB: db, MANAGEMENT_UI_BOT_ID: executorConfig?.id || null };
}

async function isAuthorizedOperator(db, env, userId) {
  if (parseAdminIds(env.ADMIN_IDS).has(String(userId))) return true;
  return Boolean(await dbFirst(db, "SELECT 1 AS present FROM support_operators WHERE user_id = ? AND active = 1", Number(userId)));
}
async function pendingAction(db, operatorId) {
  return dbFirst(db, "SELECT * FROM operator_pending_actions WHERE operator_id = ? AND expires_at > ?", Number(operatorId), nowIso());
}
function pendingMatchesMessage(pending, message) {
  const pendingThread = pending?.thread_id === null || pending?.thread_id === undefined || Number(pending.thread_id) === 1 ? null : Number(pending.thread_id);
  const messageThread = message?.message_thread_id === null || message?.message_thread_id === undefined || Number(message.message_thread_id) === 1 ? null : Number(message.message_thread_id);
  return Boolean(pending && String(pending.chat_id) === String(message?.chat?.id) && pendingThread === messageThread);
}
function pendingCallbackNonce(data) {
  const parts = String(data || "").split(":");
  if (parts[0] !== "um" || parts[1] !== "pa") return null;
  return parts[2] === "service" ? parts[4] || null : parts[3] || null;
}
async function recoveryServiceConfigs(db, pending, registry) {
  if (!Number.isSafeInteger(Number(pending?.user_id))) return [];
  const rows = await db.prepare(`SELECT DISTINCT bot_id FROM (
      SELECT bot_id, user_id FROM conversations
      UNION SELECT bot_id, user_id FROM pending_messages
      UNION SELECT bot_id, user_id FROM user_abuse_state
      UNION SELECT bot_id, user_id FROM banned_users
    ) WHERE user_id = ? ORDER BY bot_id`).bind(Number(pending.user_id)).all();
  const allowed = new Set((rows.results || []).map((row) => String(row.bot_id)));
  return registry.filter((item) => allowed.has(item.id));
}
const recoveryCopy = {
  en: { cancel:'Cancel',confirm:'Confirm',confirmMessage:'The management bot changed. Confirm the action on this refreshed panel.',reason:'The management bot changed. Enter the block reason again.',duration:'The management bot changed. Enter the duration again: 45m, 6h, or 7d.',service:'The management bot changed. Select the service on this refreshed panel.',stale:'The action is already running or stale. Open a fresh panel.',oldPanel:'This panel is stale. Open a fresh panel.' },
  ru: { cancel:'Отмена',confirm:'Подтвердить',confirmMessage:'Управляющий бот изменился. Подтвердите действие на обновлённой панели.',reason:'Управляющий бот изменился. Укажите причину блокировки ещё раз.',duration:'Управляющий бот изменился. Укажите срок ещё раз: 45m, 6h или 7d.',service:'Управляющий бот изменился. Выберите сервис на обновлённой панели.',stale:'Действие уже выполняется или устарело. Откройте свежую панель.',oldPanel:'Эта панель устарела. Откройте свежую панель.' },
  es: { cancel:'Cancelar',confirm:'Confirmar',confirmMessage:'El bot administrador ha cambiado. Confirme la acción en el panel actualizado.',reason:'El bot administrador ha cambiado. Indique de nuevo el motivo del bloqueo.',duration:'El bot administrador ha cambiado. Indique de nuevo la duración: 45m, 6h o 7d.',service:'El bot administrador ha cambiado. Seleccione el servicio en el panel actualizado.',stale:'La acción ya está en curso o ha caducado. Abra un panel nuevo.',oldPanel:'Este panel ha caducado. Abra uno nuevo.' },
  zh: { cancel:'取消',confirm:'确认',confirmMessage:'管理员机器人已更改。请在更新后的面板中确认操作。',reason:'管理员机器人已更改。请重新输入封禁原因。',duration:'管理员机器人已更改。请重新输入时长：45m、6h 或 7d。',service:'管理员机器人已更改。请在更新后的面板中选择服务。',stale:'操作已在进行或已过期。请打开新面板。',oldPanel:'此面板已过期。请打开新面板。' },
};
const controlCopy = locale => recoveryCopy[locale] || recoveryCopy.en;
async function recoveryPanel(config, pending, registry, db) {
  const copy = controlCopy(config.locale);
  const cancel = { text: copy.cancel, callback_data: `um:pa:cancel:${pending.flow_nonce}` };
  if (pending.stage === "confirm") {
    return { text: copy.confirmMessage, reply_markup: { inline_keyboard: [[{ text: copy.confirm, callback_data: `um:pa:confirm:${pending.flow_nonce}` }, cancel]] } };
  }
  if (pending.stage === "reason") return { text: copy.reason, reply_markup: { inline_keyboard: [[cancel]] } };
  if (pending.stage === "duration") return { text: copy.duration, reply_markup: { inline_keyboard: [[cancel]] } };
  if (pending.stage === "service") {
    const available = await recoveryServiceConfigs(db, pending, registry);
    const serviceButtons = available.map((item) => [
      { text: item.displayName, callback_data: `um:pa:service:${managementBotKey(registry, item.id)}:${pending.flow_nonce}` },
    ]);
    return { text: copy.service, reply_markup: { inline_keyboard: [...serviceButtons, [cancel]] } };
  }
  return { text: copy.stale, reply_markup: { inline_keyboard: [] } };
}

async function telegramDirect(env, config, method, body, fetchImpl) {
  const bot = { ...config, token: actualBotToken(env, config) };
  const cleanup = method === 'deleteMessage' && env.TELEGRAM_COOLDOWN_ENABLED === 'true'
    && await prepareTelegramCleanup(env.SUPPORT_DB, bot, body);
  const deferred = deferredTelegramResult(env.SUPPORT_DB, bot);
  if (deferred) return deferred;
  env.SUPPORT_DB?.recoveryTelegramCheckpoint?.();
  const result = await requestTelegram({ token: bot.token, method, body, timeoutMs: telegramTimeoutMs(env), fetchImpl });
  if (env.TELEGRAM_COOLDOWN_ENABLED === "true" && result.rateLimited) {
    try { await recordTelegramCooldown(env.SUPPORT_DB, bot, method, result); }
    catch { console.error(JSON.stringify({ event: "telegram_cooldown_not_saved", bot_id: bot.id, method })); }
  }
  if (cleanup) {
    try { await settleTelegramCleanup(env.SUPPORT_DB, bot, body, result); }
    catch { console.error(JSON.stringify({ event: 'telegram_cleanup_result_not_saved', bot_id: bot.id })); }
  }
  if (!result.ok && !(method === 'deleteMessage' && isConfirmedMessageDeletion(result)))
    await recordOperationalSignal(env, bot.id, result.rateLimited ? 'telegram_429' : result.deliveryUncertain ? 'telegram_uncertain' : 'telegram_failed');
  return result;
}
async function telegramDirectBestEffort(env, config, method, body, fetchImpl) {
  try { return await telegramDirect(env, config, method, body, fetchImpl); } catch { return { ok: false }; }
}

async function claimCallbackRecovery(db, incomingBotId, updateId) {
  const ownerToken = crypto.randomUUID();
  const leaseExpiresAt = isoAfter(CALLBACK_RECOVERY_LEASE_MS);
  let row = await dbFirst(db,
    "INSERT INTO general_callback_recoveries (incoming_bot_id, update_id, owner_token, lease_expires_at, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(incoming_bot_id, update_id) DO NOTHING RETURNING owner_token",
    incomingBotId, Number(updateId), ownerToken, leaseExpiresAt, nowIso());
  if (row?.owner_token) return { status: "acquired", ownerToken };
  const current = await dbFirst(db, "SELECT * FROM general_callback_recoveries WHERE incoming_bot_id = ? AND update_id = ?", incomingBotId, Number(updateId));
  if (current?.completed_at || current?.delivery_uncertain_at) return { status: "completed" };
  if (current?.lease_expires_at && Date.parse(current.lease_expires_at) <= Date.now()) {
    row = await dbFirst(db,
      "UPDATE general_callback_recoveries SET owner_token = ?, lease_expires_at = ?, created_at = ? WHERE incoming_bot_id = ? AND update_id = ? AND completed_at IS NULL AND delivery_uncertain_at IS NULL AND owner_token = ? AND lease_expires_at <= ? RETURNING owner_token",
      ownerToken, leaseExpiresAt, nowIso(), incomingBotId, Number(updateId), current.owner_token, nowIso());
    if (row?.owner_token) return { status: "acquired", ownerToken };
  }
  return { status: "busy" };
}
async function releaseCallbackRecovery(db, incomingBotId, updateId, ownerToken) {
  await dbRun(db, "DELETE FROM general_callback_recoveries WHERE incoming_bot_id = ? AND update_id = ? AND owner_token = ? AND completed_at IS NULL AND delivery_uncertain_at IS NULL", incomingBotId, Number(updateId), ownerToken);
}
async function markCallbackDeliveryStarted(db, incomingBotId, updateId, ownerToken, sender) {
  assertTelegramReady(db, sender);
  const gate = telegramRequestGate(db, sender);
  db.recoveryCheckpoint?.(db.telegramCooldownEnabled ? 3 : 2); // Include the possible cooldown write after a known rejection.
  const result = await dbRun(db, "UPDATE general_callback_recoveries SET delivery_started_at = COALESCE(delivery_started_at, ?) WHERE incoming_bot_id = ? AND update_id = ? AND owner_token = ? AND completed_at IS NULL" + gate.sql, nowIso(), incomingBotId, Number(updateId), ownerToken, ...gate.params);
  if (result.meta?.changes !== 1) throw new Error("Callback recovery fence was lost before delivery");
}
async function completeCallbackRecovery(db, incomingBotId, updateId, ownerToken, outcome = "sent") {
  const result = await dbRun(db, "UPDATE general_callback_recoveries SET completed_at = COALESCE(completed_at, ?), outcome = COALESCE(outcome, ?), lease_expires_at = ? WHERE incoming_bot_id = ? AND update_id = ? AND owner_token = ? AND completed_at IS NULL", nowIso(), outcome, nowIso(), incomingBotId, Number(updateId), ownerToken);
  if (result.meta?.changes !== 1) throw new Error("Callback recovery completion fence was lost");
}
async function quarantineCallbackRecovery(db, incomingBotId, updateId, ownerToken) {
  await dbRun(db, "UPDATE general_callback_recoveries SET delivery_uncertain_at = COALESCE(delivery_uncertain_at, ?), outcome = COALESCE(outcome, 'delivery_uncertain'), lease_expires_at = ? WHERE incoming_bot_id = ? AND update_id = ? AND owner_token = ? AND completed_at IS NULL", nowIso(), nowIso(), incomingBotId, Number(updateId), ownerToken);
}


function stableSeedForMessage(message) { return `m:${message?.chat?.id ?? ""}:${message?.message_id ?? ""}:${message?.from?.id ?? ""}`; }
function stableSeedForCallback(update, query) { return `c:${update?.update_id ?? ""}:${query?.id ?? ""}`; }

async function recoverPendingCallback(env, registry, incomingConfig, currentOwner, update, pending, fetchImpl, recoverySender = currentOwner) {
  const db = env.SUPPORT_DB;
  const query = update.callback_query;
  const recovery = await claimCallbackRecovery(db, incomingConfig.id, update.update_id);
  if (recovery.status === "completed") return reply(200, "OK");
  if (recovery.status !== "acquired") return reply(500, "Callback recovery busy; retry");
  let deliveryStarted = false;
  try {
    if (pending.management_bot_id !== recoverySender.id) {
      const changed = await dbRun(db,
        "UPDATE operator_pending_actions SET management_bot_id = ? WHERE operator_id = ? AND flow_nonce = ? AND management_bot_id = ? AND expires_at > ?",
        recoverySender.id, query.from.id, pending.flow_nonce, pending.management_bot_id, nowIso());
      if (changed.meta?.changes !== 1) throw new Error("Pending management flow could not be rebound");
      pending = await pendingAction(db, query.from.id);
      if (!pending || pending.management_bot_id !== recoverySender.id) throw new Error("Pending management flow disappeared during rebind");
    }
    const panel = await recoveryPanel(recoverySender, pending, registry, db);
    const body = { chat_id: pending.chat_id, text: panel.text, reply_markup: panel.reply_markup };
    if (pending.thread_id !== null && pending.thread_id !== undefined && Number(pending.thread_id) !== 1) body.message_thread_id = Number(pending.thread_id);
    await markCallbackDeliveryStarted(db, incomingConfig.id, update.update_id, recovery.ownerToken, { ...recoverySender, token: actualBotToken(env, recoverySender) });
    deliveryStarted = true;
    const sent = await telegramDirect(env, recoverySender, "sendMessage", body, fetchImpl);
    if (!sent.ok) {
      if (sent.deliveryUncertain) {
        await quarantineCallbackRecovery(db, incomingConfig.id, update.update_id, recovery.ownerToken);
        console.error(JSON.stringify({ level: "error", event: "general_callback_recovery_delivery_uncertain", bot_id: incomingConfig.id, update_id: update.update_id, description: sent.description }));
        return reply(200, "OK");
      }
      if (sent.retryable) {
        await releaseCallbackRecovery(db, incomingConfig.id, update.update_id, recovery.ownerToken);
        return reply(500, "Callback recovery send failed; retry");
      }
      await completeCallbackRecovery(db, incomingConfig.id, update.update_id, recovery.ownerToken, "terminal_send_failure");
      return reply(200, "OK");
    }
    await completeCallbackRecovery(db, incomingConfig.id, update.update_id, recovery.ownerToken, "sent");
    await telegramDirectBestEffort(env, incomingConfig, "answerCallbackQuery", { callback_query_id: query.id }, fetchImpl);
    await telegramDirectBestEffort(env, incomingConfig, "editMessageReplyMarkup", { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }, fetchImpl);
    return reply(200, "OK");
  } catch (error) {
    if (deliveryStarted) {
      try { await quarantineCallbackRecovery(db, incomingConfig.id, update.update_id, recovery.ownerToken); } catch {}
      console.error(JSON.stringify({ level: "error", event: "general_callback_recovery_failed_after_delivery_start", bot_id: incomingConfig.id, update_id: update.update_id, message: String(error?.message || error).slice(0, 800) }));
      return reply(200, "OK");
    }
    try { await releaseCallbackRecovery(db, incomingConfig.id, update.update_id, recovery.ownerToken); } catch {}
    throw error;
  }
}

async function routeGeneralCallback(baseWorker, fetchImpl, request, update, env, registry, incomingConfig, ctx, options = {}) {
  const query = update.callback_query;
  if (!query?.from?.id || !isGeneralMessage(query.message, env) || !String(query.data || "").startsWith("um:")) {
    return baseWorker.fetch(rebuildOriginalRequest(request, JSON.stringify(update)), env, ctx);
  }
  const db = env.SUPPORT_DB;
  const existingRecovery = await dbFirst(
    db,
    "SELECT owner_token, lease_expires_at, delivery_started_at, delivery_uncertain_at, completed_at FROM general_callback_recoveries WHERE incoming_bot_id = ? AND update_id = ?",
    incomingConfig.id,
    Number(update.update_id),
  );
  if (existingRecovery?.completed_at || existingRecovery?.delivery_uncertain_at) return reply(200, "OK");
  if (existingRecovery?.lease_expires_at && Date.parse(existingRecovery.lease_expires_at) > Date.now()) {
    return reply(500, "Callback recovery busy; retry");
  }
  if (existingRecovery?.delivery_started_at) {
    await dbRun(
      db,
      "UPDATE general_callback_recoveries SET delivery_uncertain_at = COALESCE(delivery_uncertain_at, ?), outcome = COALESCE(outcome, 'delivery_uncertain'), lease_expires_at = ? WHERE incoming_bot_id = ? AND update_id = ? AND completed_at IS NULL",
      nowIso(), nowIso(), incomingConfig.id, Number(update.update_id),
    );
    return reply(200, "OK");
  }
  const currentOwner = await effectiveGroupCommandOwner(db, registry, env);
  if (!currentOwner) return reply(200, "OK");
  const pending = String(query.data || "").startsWith("um:pa:") ? await pendingAction(db, query.from.id) : null;
  const suppliedNonce = pendingCallbackNonce(query.data);
  const pendingIsThisFlow = Boolean(pending && suppliedNonce === pending.flow_nonce && pendingMatchesMessage(pending, query.message));
  const authorized = pendingIsThisFlow ? await isAuthorizedOperator(db, env, query.from.id) : false;
  const needsRecovery = Boolean(existingRecovery)
    || options.incomingDisabled
    || (pendingIsThisFlow && pending.management_bot_id !== incomingConfig.id);
  if (pendingIsThisFlow && authorized && needsRecovery) {
    // management_bot_id is the Telegram bot that owns the current management UI;
    // target_bot_id remains the logical service being mutated. A fallback panel that
    // was physically sent by the incoming live bot must stay on that bot so its next
    // CallbackQuery reaches a working webhook. If that incoming bot is disabled, move
    // the UI to the current effective owner instead.
    const legacyFallbackPanel = !options.incomingDisabled
      && incomingConfig.id !== currentOwner.id
      && pending.management_bot_id === currentOwner.id;
    const recoverySender = (!options.incomingDisabled && (pending.management_bot_id === incomingConfig.id || legacyFallbackPanel))
      ? incomingConfig
      : currentOwner;
    return recoverPendingCallback(env, registry, incomingConfig, currentOwner, update, pending, fetchImpl, recoverySender);
  }
  if (options.incomingDisabled) {
    await telegramDirectBestEffort(env, incomingConfig, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: controlCopy(incomingConfig.locale).oldPanel,
      show_alert: true,
    }, fetchImpl);
    return reply(200, "OK");
  }
  // CallbackQuery belongs to the bot that created the keyboard. Keep the request on
  // that bot so answerCallbackQuery/editMessage* always use the correct Telegram token.
  // Target service identity is already encoded in callback data or pending.target_bot_id.
  return baseWorker.fetch(rebuildOriginalRequest(request, JSON.stringify(update)), env, ctx);
}

async function routeGeneralMessage(baseWorker, request, update, env, registry, incomingConfig, ctx) {
  const message = update.message;
  if (!isGeneralMessage(message, env) || !await isRelevantGeneralMessage(env.SUPPORT_DB, message)) {
    return baseWorker.fetch(rebuildOriginalRequest(request, JSON.stringify(update)), env, ctx);
  }
  let owner = await effectiveGroupCommandOwner(env.SUPPORT_DB, registry, env);
  if (!owner) return reply(200, "OK");
  if (owner.id !== incomingConfig.id) {
    const grace = Math.min(asNonNegativeInteger(env.GENERAL_OWNER_GRACE_MS, GENERAL_OWNER_GRACE_MS), MAX_GENERAL_OWNER_GRACE_MS);
    await sleep(grace);
    owner = await effectiveGroupCommandOwner(env.SUPPORT_DB, registry, env);
    if (!owner) return reply(200, "OK");
  }
  const claim = await claimGeneralControl(env.SUPPORT_DB, env, message.message_id, incomingConfig.id);
  if (claim.status === "completed") return reply(200, "OK");
  if (claim.status === "dispatched") {
    try { await settleDispatchedGeneralControl(env.SUPPORT_DB, env, message.message_id); }
    catch (error) {
      console.error(JSON.stringify({ level: "error", event: "general_dispatch_settle_failed", bot_id: incomingConfig.id, message_id: message.message_id, message: String(error?.message || error).slice(0, 800) }));
    }
    return reply(200, "OK");
  }
  if (claim.status !== "acquired") return reply(500, "General control-plane message is busy; retry");
  let heartbeat = startGeneralControlHeartbeat(env.SUPPORT_DB, env, message.message_id, claim.ownerToken);
  let delegatedSucceeded = false;
  let dispatchMarked = false;
  try {
    const hardenedDb = createHardenedDatabase(env.SUPPORT_DB, {
      fakeGeneralClaim: true,
      generalOwnerToken: claim.ownerToken,
      stableSeed: stableSeedForMessage(message),
      managementUiBotId: incomingConfig.id,
      env,
    });
    const delegatedEnv = createDelegatedEnv(env, hardenedDb, incomingConfig);
    const delegatedUpdate = { ...update, update_id: delegatedUpdateId(message.message_id) };
    const delegatedRequest = rewriteWebhookRequest(request, delegatedUpdate, owner, env);
    const response = await baseWorker.fetch(delegatedRequest, delegatedEnv, ctx);
    if (response.status < 200 || response.status >= 300) {
      await heartbeat.stop();
      heartbeat = null;
      await releaseGeneralControl(env.SUPPORT_DB, env, message.message_id, claim.ownerToken);
      return response.status >= 500 ? response : reply(500, "Internal control-plane routing error");
    }
    delegatedSucceeded = true;
    // The dispatch marker itself checks owner and lease expiry. Stop renewals
    // before using the completion reserve instead of spending another work slot.
    await heartbeat.stop();
    heartbeat = null;
    let markerError = null;
    for (let attempt = 0; attempt < 3 && !dispatchMarked; attempt += 1) {
      try {
        await markGeneralDispatchSucceeded(env.SUPPORT_DB, env, message.message_id, claim.ownerToken);
        dispatchMarked = true;
      } catch (error) {
        markerError = error;
        if (attempt < 2) await sleep(25 * (attempt + 1));
      }
    }
    if (!dispatchMarked) throw markerError || new Error("General dispatch marker could not be saved");
    await completeGeneralControl(env.SUPPORT_DB, env, message.message_id, claim.ownerToken);
    return response;
  } catch (error) {
    if (heartbeat) await heartbeat.stop();
    // Once delegated execution returned 2xx, never delete the outer claim: doing so can
    // make another bot replay the same General side effect. A durable dispatch marker
    // lets retries ACK without re-entering legacy execution; without a marker we retain
    // the lease rather than deliberately reopening the message immediately.
    if (!delegatedSucceeded) {
      try { await releaseGeneralControl(env.SUPPORT_DB, env, message.message_id, claim.ownerToken); } catch {}
    } else if (!dispatchMarked) {
      console.error(JSON.stringify({ level: "error", event: "general_dispatch_marker_failed_after_success", bot_id: incomingConfig.id, message_id: message.message_id, message: String(error?.message || error).slice(0, 800) }));
    }
    throw error;
  }
}

export function createControlPlaneWorker(baseWorker = legacyWorker, fetchImpl = fetch) {
  return {
    async fetch(request, env, ctx) {
      const incomingBotId = webhookBotId(request);
      if (!incomingBotId || request.method.toUpperCase() !== "POST") return baseWorker.fetch(request, env, ctx);
      let registry;
      try { registry = parseBotRegistry(env.BOT_REGISTRY); }
      catch { return reply(500, "Configuration error"); }
      const incomingConfig = registry.find((item) => item.id === incomingBotId);
      if (!incomingConfig) return reply(404, "Not found");
      let expectedSecret;
      try { expectedSecret = expectedWebhookSecret(env, incomingConfig); }
      catch { return reply(500, "Configuration error"); }
      const suppliedSecret = request.headers.get("x-telegram-bot-api-secret-token") || "";
      if (!timingSafeEqual(suppliedSecret, expectedSecret)) return reply(403, "Forbidden");
      if (!(request.headers.get("content-type") || "").toLowerCase().includes("application/json")) return reply(415, "Expected application/json");
      let bodyText;
      let update;
      try {
        bodyText = await request.text();
        update = JSON.parse(bodyText);
      } catch { return reply(400, "Invalid JSON"); }
      if (!update || typeof update !== "object" || !Number.isSafeInteger(update.update_id)) return reply(400, "Invalid Telegram update");
      if (isIgnoredTelegramServiceMessage(update.message)) return reply(200, "OK");
      const originalRequest = rebuildOriginalRequest(request, bodyText);
      if (storageCandidate(update)) return baseWorker.fetch(originalRequest, env, ctx);
      const generalCandidate = (update.callback_query && isGeneralMessage(update.callback_query.message, env) && String(update.callback_query.data || "").startsWith("um:"))
        || (update.message && isGeneralMessage(update.message, env));
      if (!generalCandidate) return baseWorker.fetch(originalRequest, env, ctx);
      let incomingEnabled;
      try {
        if (env.SUPPORT_DB && !env.SUPPORT_DB.invocationBudget) {
          env = { ...env, SUPPORT_DB: await resolveInvocationDatabase(env.SUPPORT_DB, env) };
        }
        if (env.SUPPORT_DB?.storageMode === 'reset') return reply(503, 'Storage maintenance; retry later');
        incomingEnabled = await incomingBotEnabled(env.SUPPORT_DB, incomingConfig);
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "general_incoming_bot_state_lookup_failed", bot_id: incomingBotId, update_id: update.update_id, message: String(error?.message || error).slice(0, 800) }));
        return reply(500, "Database error");
      }
      if (managerConfigured(env)) {
        if (update.callback_query) return incomingEnabled
          ? baseWorker.fetch(originalRequest, env, ctx) : reply(200, "OK");
        const mention = String(update.message?.text || '').trim().split(/\s+/, 1)[0].split('@')[1];
        return incomingEnabled && mention?.toLowerCase() === incomingConfig.username?.toLowerCase()
          ? baseWorker.fetch(originalRequest, env, ctx) : reply(200, "OK");
      }
      try {
        if (deferredTelegramResult(env.SUPPORT_DB, { ...incomingConfig, token: actualBotToken(env, incomingConfig) })) return reply(503, "Telegram sending paused; retry later");
        if (update.callback_query) return await routeGeneralCallback(baseWorker, fetchImpl, request, update, env, registry, incomingConfig, ctx, { incomingDisabled: !incomingEnabled });
        if (!incomingEnabled) return reply(200, "OK");
        if (update.message) return await routeGeneralMessage(baseWorker, request, update, env, registry, incomingConfig, ctx);
        return baseWorker.fetch(originalRequest, env, ctx);
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "general_control_plane_failed", bot_id: incomingBotId, update_id: update.update_id, message: String(error?.message || error).slice(0, 800) }));
        return reply(500, "Internal Server Error");
      }
    },
    scheduled(controller, env, ctx) { return baseWorker.scheduled(controller, env, ctx); },
  };
}

export default createControlPlaneWorker();
