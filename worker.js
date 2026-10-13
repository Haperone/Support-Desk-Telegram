import { supportHelp } from './support-help.js';
import { messageDeletionText, messageDeletionWarning } from './message-deletion-copy.js';
import { DEFAULT_LANGUAGE, supportedLanguage } from './language.js';
import { customerName } from './user-display.js';
import { getManagerLanguage } from './manager-language.js';
import { backgroundDbRun, resolveInvocationDatabase, recoveryCheckpoint, RecoveryBudgetExhausted } from "./recovery-budget.js";
import { recordStatisticsTelegramFailure } from './support-statistics.js';
import { runStatisticsSchedule } from './manager-statistics.js';
import { CONTROL_PLANE_CONTEXT, isGeneralCommand, stablePendingNonce } from "./control-plane-contract.js";
import { readCloudflarePlan } from "./cloudflare-plan.js";
import { manualDeliveryText, deliverySnapshot } from './manual-delivery.js';
import { requestTelegram } from "./telegram-response.js";
import { reactionUpdates } from './telegram-updates.js';
import { createReactionChecks, REACTION_DIRECTIONS, reactionDirection, reactionDirectionLabel, reactionSummary } from './reaction-checks.js';
import { recordOperationalSignal } from "./support-health.js";
import { handleStorageUpdate, storageCandidate } from "./storage-ui.js";
import { touchStorageTopic, runStorageJob, storageMaintenance, maintenanceStatement } from "./storage-retention.js";
import { runFullReset } from "./storage-reset.js";
import { prepareTelegramCleanup, settleTelegramCleanup, isConfirmedMessageDeletion } from './telegram-cleanup.js';
import { assertTelegramReady, deferredTelegramResult, recordTelegramCooldown, telegramRequestGate, TelegramCooldownError } from "./telegram-cooldown.js";
import { renderWorkspace, workspaceSession, workspaceBack, repliedInternalPrompt, topicLink } from './operator-workspace.js';
import { workQueue, workCounts, readWork, changeWork, workStateLabel, workAge, assigneeLabel, tomorrowMorning, WORK_FILTERS } from './conversation-work.js';
import { serviceChecks } from './service-checks.js';
import { queueInboundNotice, queueTransferNotice, markSentNoticeLinksForRoute,
  stageDueNotices, dispatchNextNotice, syncNextSentNoticeLink, markExpiredClaimsUncertain,
  terminalNoticePruneStatement } from './service-notifications.js';

async function stageConfirmedInboundNotice(bot, env, userId, groupId, threadId) {
  if (!env.MANAGER_BOT_TOKEN) return;
  const db=requireDb(env);
  // A confirmed delivery takes priority over the optional DM in a Free invocation.
  if (db.plan==='free' && db.used>29) return;
  try {
    await queueInboundNotice(db, {botId:bot.id,userId:Number(userId),adminId:primaryOperatorId(env),
      groupId:Number(groupId),threadId:Number(threadId),delivered:true});
    if (db.plan!=='free' || db.used<=33) await sendNextServiceNotice(bot, env);
  } catch (error) {
    // Delivery is already confirmed; Cron can recover the notification from its durable receipt.
    log(bot, 'error', 'service_notice_stage_failed', {user_id:userId,message:error.message});
  }
}

async function sendNextServiceNotice(bot, env) {
  const db=requireDb(env);
  return dispatchNextNotice(db,{botId:bot.id,adminId:primaryOperatorId(env),send:async (notice)=>{
    const customer=await dbOne(db,`SELECT c.first_name,c.last_name,c.username,w.state,w.cycle_started_at
      FROM conversations c LEFT JOIN conversation_work w ON w.bot_id=c.bot_id AND w.user_id=c.user_id
      WHERE c.bot_id=? AND c.user_id=?`,notice.bot_id,notice.user_id);
    const name=customerName(customer,notice.user_id);
    const locale=await getManagerLanguage(db,Number(notice.recipient_id));
    const labels={new:{ru:'Новое обращение',en:'New conversation',es:'Nueva conversación',zh:'新会话'},reply:{ru:'Ответ клиента',en:'Customer reply',es:'Respuesta del cliente',zh:'客户回复'},transfer:{ru:'Передача обращения',en:'Conversation transferred',es:'Conversación transferida',zh:'会话已转交'},reminder:{ru:'Ожидает ответа',en:'Awaiting reply',es:'Pendiente de respuesta',zh:'等待回复'},fallback:{ru:'Нужна помощь с ответом',en:'Reply needs attention',es:'Se necesita ayuda para responder',zh:'需要协助回复'}};
    const states={needs_reply:{ru:'ожидает ответа',en:'needs reply',es:'pendiente de respuesta',zh:'待回复'},snoozed:{ru:'отложено',en:'snoozed',es:'pospuesta',zh:'已暂缓'},waiting:{ru:'ожидает клиента',en:'waiting for customer',es:'esperando al cliente',zh:'等待客户'},resolved:{ru:'решено',en:'resolved',es:'resuelta',zh:'已解决'}};
    const label=labels[notice.kind]?.[locale]||labels[notice.kind]?.en||'Support update';
    const state=states[customer?.state]?.[locale]||states.needs_reply[locale]||states.needs_reply.en;
    const link=topicLink(notice.group_id,notice.thread_id);
    const words={ru:['Клиент','Обращение','Состояние','С первого сообщения','Заметка','Открыть тему'],en:['Customer','Conversation','Status','Since first message','Note','Open topic'],es:['Cliente','Conversación','Estado','Desde el primer mensaje','Nota','Abrir tema'],zh:['客户','会话','状态','始于首条消息','备注','打开话题']}[locale]||['Customer','Conversation','Status','Since first message','Note','Open topic'];
    const noteText=notice.note==='Группа сервиса изменилась. Откройте актуальную тему.'
      ? ({ru:notice.note,en:'The service group changed. Open the current topic.',es:'El grupo del servicio ha cambiado. Abre el tema actual.',zh:'服务群组已更改，请打开当前话题。'}[locale]||'The service group changed. Open the current topic.')
      : notice.note;
    const text=[`${label}: ${bot.displayName}`,`${words[0]}: ${name}`,`${words[1]}: ${notice.user_id}`,
      `${words[2]}: ${state}`,`${words[3]}: ${customer?.cycle_started_at||notice.created_at}`,
      noteText?`${words[4]}: ${noteText}`:null,
      link?'\n'+messageDeletionWarning(locale, bot.username):null].filter(Boolean).join('\n');
    return requestTelegram({token:env.MANAGER_BOT_TOKEN,method:'sendMessage',body:{chat_id:Number(notice.recipient_id),text,
      ...(link?{reply_markup:{inline_keyboard:[[{text:words[5],url:link}]]}}:{})},timeoutMs:10000});
  }});
}
import { archiveConversationForNewGroup, findTopicByGroup, resolveActiveGroup } from './service-groups.js';

// Telegram support router for Cloudflare Workers.
// All durable application state lives in D1; this Worker deliberately has no KV binding.

const DEFAULT_BURST_LIMIT = 8;
const DEFAULT_MINUTE_LIMIT = 25;
const DEFAULT_ABSOLUTE_LIMIT = 100;
const DEFAULT_RISK_TURNSTILE_THRESHOLD = 7;
const DEFAULT_RISK_MUTE_THRESHOLD = 12;
const DEFAULT_TRUSTED_DAYS = 30;
const DEFAULT_WARNING_COOLDOWN_SECONDS = 60;
const DEFAULT_PENDING_MESSAGE_LIMIT = 10;
const DEFAULT_ATTACK_EVENT_THRESHOLD = 20;
const DEFAULT_RISK_WEIGHTS = Object.freeze({
  burst: 2,
  minute: 3,
  duplicateMessage: 3,
  repeatedUrl: 4,
  manyUrls: 3,
  mentions: 2,
  spamKeyword: 3,
  newUserUrl: 1,
  failedTurnstile: 3,
  passedTurnstile: 5,
});
const DEFAULT_SPAM_KEYWORDS = Object.freeze(["crypto", "airdrop", "giveaway", "casino", "bet", "loan", "sex", "spam"]);
const RISK_DECAY_MS = 30 * 60_000;
const CHALLENGE_TTL_MS = 15 * 60_000;
const PENDING_FLUSH_LEASE_MS = 5 * 60_000;
const ABUSE_DECISION_LEASE_MS = 5 * 60_000;
const VERIFICATION_ATTEMPT_LEASE_MS = 2 * 60_000;
const ATTACK_EXIT_MS = 15 * 60_000;
const DEFAULT_TELEGRAM_TIMEOUT_MS = 10_000;
const MAX_TELEGRAM_TIMEOUT_MS = 30_000;
const TURNSTILE_TIMEOUT_MS = 15_000;
const DEFAULT_ALBUM_SETTLE_MS = 3_000;
const LOCK_STALE_MS = 60_000;
const UPDATE_LEASE_MS = 5 * 60_000;
const MANAGEMENT_PAGE_SIZE = 5;
const OPERATOR_ACTION_TTL_MS = 10 * 60_000;
const OPERATOR_LIST_PAGE_SIZE = 5;
const MIN_RESTRICTION_MS = 5 * 60_000;
const MAX_RESTRICTION_MS = 30 * 86_400_000;
const REACTION_SYNC_LEASE_MS = 60_000;
const REACTION_SETTINGS_LEASE_MS = 5 * 60_000;
const GENERAL_CONTROL_LEASE_MS = 30_000;
const DEFAULT_GENERAL_OWNER_GRACE_MS = 1_500;
const MAX_GENERAL_OWNER_GRACE_MS = 5_000;
const OPERATOR_EXECUTION_LEASE_MS = 60_000;
const REOPEN_RECOVERY_LEASE_MS = 2 * 60_000;
// Full standard catalog: https://core.telegram.org/bots/api#reactiontypeemoji (2026-09-14).
const STANDARD_REACTIONS = new Set([
  "❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢",
  "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳",
  "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓",
  "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈",
  "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿",
  "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀",
  "😡",
]);
// Top-level Telegram Message service fields are events, not messages to relay.
// Do not inspect reply_to_message/pinned_message recursively: replies to events
// are still ordinary operator messages. Topic close/reopen is handled separately.
const TELEGRAM_SERVICE_FIELDS = Object.freeze([
  "new_chat_members", "left_chat_member", "chat_owner_left", "chat_owner_changed",
  "new_chat_title", "new_chat_photo", "delete_chat_photo", "group_chat_created",
  "supergroup_chat_created", "channel_chat_created", "message_auto_delete_timer_changed",
  "migrate_to_chat_id", "migrate_from_chat_id", "pinned_message", "successful_payment",
  "refunded_payment", "users_shared", "chat_shared", "gift", "unique_gift", "gift_upgrade_sent",
  "connected_website", "write_access_allowed", "passport_data", "proximity_alert_triggered",
  "boost_added", "chat_background_set", "checklist_tasks_done", "checklist_tasks_added",
  "community_chat_added", "community_chat_joined", "community_chat_removed", "direct_message_price_changed",
  "forum_topic_created", "forum_topic_edited", "forum_topic_closed", "forum_topic_reopened",
  "general_forum_topic_hidden", "general_forum_topic_unhidden", "giveaway_created", "giveaway_completed",
  "managed_bot_created", "paid_message_price_changed", "poll_option_added", "poll_option_deleted",
  "suggested_post_approved", "suggested_post_approval_failed", "suggested_post_declined",
  "suggested_post_paid", "suggested_post_refunded", "video_chat_scheduled", "video_chat_started",
  "video_chat_ended", "video_chat_participants_invited", "web_app_data",
]);

export function isIgnoredTelegramServiceMessage(message) {
  if (!message) return false;
  if (message.chat?.type === "supergroup" && (message.forum_topic_closed || message.forum_topic_reopened)) return false;
  return TELEGRAM_SERVICE_FIELDS.some((field) => Object.hasOwn(message, field));
}

const MESSAGES = {
  en: {
    userLabel: "User", serviceLabel: "Service", botLabel: "Bot", userIdLabel: "User ID", topicLabel: "Topic", statusLabel: "Status", openStatus: "open", closedStatus: "closed",
    tooMany: "Too many messages. Please try again in a minute.",
    deliveryFailed: "Your message could not be delivered. Please try a different message format or contact support later.",
    albumFailed: "This album could not be delivered. Please send the files separately.",
    operatorAlbumFailed: "⚠️ Album delivery failed", operatorDeliveryFailed: "⚠️ Delivery failed",
    supportBots: "🤖 Support bots", users: "Users", selfCheck: "🔎 Self-check", disabled: "disabled",
    token: "token", group: "group", topics: "topics", ok: "ok", failed: "failed",
    privacy: "BotFather Group Privacy must be disabled manually for every bot.",
    useInTopic: "Use this command inside a support topic.", banned: "✅ User banned for this service only.",
    unbanned: "✅ User unbanned for this service.", opened: "✅ Conversation opened.",
    captchaDisabled: "ℹ️ CAPTCHA is intentionally disabled. Use /ban for abuse control.",
    unauthorized: "⛔ You no longer have access to support management.", callback: "Support is handled without CAPTCHA.",
    verify: "To protect support from abuse, please complete verification: ", verificationPending: "Your message is queued and will be delivered after verification.",
    muted: "Messages are temporarily paused due to unusual activity. Please try again later.", risk: "Risk", trusted: "✅ User is trusted for this service.", untrusted: "✅ User trust was removed.", riskReset: "✅ User risk was reset.", attack: "Anti-abuse mode",
    restrictedUntil: "Your ability to send support messages is temporarily restricted until", bannedNotice: "Your ability to contact support has been restricted.",
    panelTitle: "User management", staleAction: "This screen is outdated. Open a fresh user card.", actionCancelled: "Action cancelled.",
    reactions: "Reactions", reactionsOn: "Reactions are enabled", reactionsOff: "Reactions are disabled", reactionsUnavailable: "Run the Telegram check first. Each direction is verified and enabled separately.", reactionsSaveFailed: "The reaction setting was not changed. Try again.", reactionsBusy: "Another reaction setting is being changed. Try again in a moment.",
  },
  ru: {
    userLabel: "Пользователь", serviceLabel: "Сервис", botLabel: "Бот", userIdLabel: "ID пользователя", topicLabel: "Тема", statusLabel: "Статус", openStatus: "открыт", closedStatus: "закрыт",
    tooMany: "Слишком много сообщений. Повторите попытку через минуту.",
    deliveryFailed: "Не удалось доставить сообщение. Попробуйте другой формат или обратитесь позже.",
    albumFailed: "Не удалось доставить альбом. Отправьте файлы по отдельности.",
    operatorAlbumFailed: "⚠️ Не удалось доставить альбом", operatorDeliveryFailed: "⚠️ Не удалось доставить сообщение",
    supportBots: "🤖 Боты поддержки", users: "Пользователи", selfCheck: "🔎 Самопроверка", disabled: "отключён",
    token: "токен", group: "группа", topics: "темы", ok: "ок", failed: "ошибка",
    privacy: "Group Privacy в BotFather нужно вручную отключить для каждого бота.",
    useInTopic: "Используйте эту команду внутри темы поддержки.", banned: "✅ Пользователь заблокирован только для этого сервиса.",
    unbanned: "✅ Пользователь разблокирован для этого сервиса.", opened: "✅ Диалог открыт.",
    captchaDisabled: "ℹ️ CAPTCHA намеренно отключена. Для защиты от злоупотреблений используйте /ban.",
    unauthorized: "⛔ У вас больше нет доступа к управлению поддержкой.", callback: "Поддержка работает без CAPTCHA.",
    verify: "Чтобы защитить поддержку от злоупотреблений, пройдите проверку: ", verificationPending: "Сообщение сохранено и будет доставлено после проверки.",
    muted: "Из-за необычной активности сообщения временно приостановлены. Повторите позже.", risk: "Риск", trusted: "✅ Пользователь добавлен в доверенные для этого сервиса.", untrusted: "✅ Доверие пользователя для этого сервиса снято.", riskReset: "✅ Риск пользователя сброшен.", attack: "Анти-абьюз режим",
    restrictedUntil: "Возможность отправлять сообщения в поддержку временно ограничена до", bannedNotice: "Возможность обращения в поддержку ограничена.",
    panelTitle: "Управление пользователем", staleAction: "Этот экран устарел. Откройте свежую карточку пользователя.", actionCancelled: "Действие отменено.",
    reactions: "Реакции", reactionsOn: "Реакции включены", reactionsOff: "Реакции выключены", reactionsUnavailable: "Сначала запустите проверку в Telegram. Каждое направление проверяется и включается отдельно.", reactionsSaveFailed: "Состояние реакций не изменено. Попробуйте ещё раз.", reactionsBusy: "Другая настройка реакций сейчас изменяется. Повторите через несколько секунд.",
  },
  es: {
    userLabel: "Usuario", serviceLabel: "Servicio", botLabel: "Bot", userIdLabel: "ID de usuario", topicLabel: "Tema", statusLabel: "Estado", openStatus: "abierto", closedStatus: "cerrado",
    tooMany: "Has enviado demasiados mensajes. Inténtalo de nuevo en un minuto.",
    deliveryFailed: "No se pudo entregar tu mensaje. Prueba otro formato o contacta con soporte más tarde.", albumFailed: "No se pudo entregar este álbum. Envía los archivos por separado.",
    operatorAlbumFailed: "⚠️ No se pudo entregar el álbum", operatorDeliveryFailed: "⚠️ No se pudo entregar el mensaje",
    supportBots: "🤖 Bots de soporte", users: "Usuarios", selfCheck: "🔎 Autocomprobación", disabled: "desactivado", token: "token", group: "grupo", topics: "temas", ok: "correcto", failed: "error",
    privacy: "Debes desactivar manualmente Group Privacy en BotFather para cada bot.", useInTopic: "Usa este comando dentro de un tema de soporte.", banned: "✅ Usuario bloqueado solo para este servicio.",
    unbanned: "✅ Usuario desbloqueado para este servicio.", opened: "✅ Conversación abierta.", captchaDisabled: "ℹ️ CAPTCHA está desactivado intencionadamente. Usa /ban para controlar abusos.",
    unauthorized: "⛔ Ya no tienes acceso a la administración del soporte.", callback: "El soporte funciona sin CAPTCHA.", verify: "Para proteger el soporte contra abusos, completa la verificación: ", verificationPending: "Tu mensaje está en cola y se entregará después de la verificación.",
    muted: "Los mensajes se han pausado temporalmente por actividad inusual. Inténtalo más tarde.", risk: "Riesgo", trusted: "✅ Usuario marcado como de confianza para este servicio.", untrusted: "✅ Se retiró la confianza del usuario para este servicio.", riskReset: "✅ Se restableció el riesgo del usuario.", attack: "Modo antiabuso",
    restrictedUntil: "Tu capacidad para enviar mensajes al soporte está restringida temporalmente hasta", bannedNotice: "Se ha restringido tu acceso al soporte.", panelTitle: "Administración de usuarios", staleAction: "Esta pantalla está desactualizada. Abre una nueva ficha del usuario.", actionCancelled: "Acción cancelada.",
    reactions: "Reacciones", reactionsOn: "Las reacciones están activadas", reactionsOff: "Las reacciones están desactivadas", reactionsUnavailable: "Primero ejecuta la comprobación de Telegram. Cada dirección se verifica y activa por separado.", reactionsSaveFailed: "No se cambió la configuración de reacciones. Inténtalo de nuevo.", reactionsBusy: "Se está cambiando otra opción de reacciones. Inténtalo dentro de un momento.",
  },
  zh: {
    userLabel: "用户", serviceLabel: "服务", botLabel: "机器人", userIdLabel: "用户 ID", topicLabel: "话题", statusLabel: "状态", openStatus: "开启", closedStatus: "已关闭",
    tooMany: "消息过多，请一分钟后重试。", deliveryFailed: "消息未能送达。请尝试其他消息格式，或稍后联系支持团队。", albumFailed: "相册未能送达，请分开发送文件。",
    operatorAlbumFailed: "⚠️ 相册发送失败", operatorDeliveryFailed: "⚠️ 消息发送失败", supportBots: "🤖 支持机器人", users: "用户", selfCheck: "🔎 自检", disabled: "已停用", token: "令牌", group: "群组", topics: "话题", ok: "正常", failed: "失败",
    privacy: "必须在 BotFather 中为每个机器人手动关闭 Group Privacy。", useInTopic: "请在支持话题中使用此命令。", banned: "✅ 用户仅在此服务中被封禁。", unbanned: "✅ 用户已在此服务中解除封禁。", opened: "✅ 会话已开启。",
    captchaDisabled: "ℹ️ CAPTCHA 已按设计停用。请使用 /ban 处理滥用行为。", unauthorized: "⛔ 你已无权管理支持服务。", callback: "支持服务无需 CAPTCHA。", verify: "为防止滥用，请完成验证：", verificationPending: "消息已排队，将在验证通过后送达。",
    muted: "由于检测到异常活动，消息暂时暂停。请稍后重试。", risk: "风险", trusted: "✅ 用户已在此服务中设为可信。", untrusted: "✅ 已取消此服务对用户的信任设置。", riskReset: "✅ 用户风险状态已重置。", attack: "反滥用模式",
    restrictedUntil: "你向支持团队发送消息的权限暂时受限，截止时间：", bannedNotice: "你联系支持团队的权限已受限。", panelTitle: "用户管理", staleAction: "此页面已过期，请打开新的用户卡片。", actionCancelled: "操作已取消。",
    reactions: "表情反应", reactionsOn: "表情反应已启用", reactionsOff: "表情反应已停用", reactionsUnavailable: "请先运行 Telegram 检查。两个方向需分别验证和启用。", reactionsSaveFailed: "表情反应设置未更改，请重试。", reactionsBusy: "正在更改另一项表情反应设置，请稍后重试。",
  },
};

function t(bot, key) { return (MESSAGES[bot?.locale] || MESSAGES.en)[key]; }

const UI_TRANSLATIONS = {
  es: {
    '← Users':'← Usuarios','Only the primary operator can change topic appearance.':'Solo el administrador principal puede cambiar la apariencia de los temas.','Topic appearance is available to the primary operator in General.':'El administrador principal puede configurar la apariencia de los temas en General.','Choose a bot to style its new topics.':'Elige un bot para configurar la apariencia de sus nuevos temas.','← Back':'← Volver','Standard icon color':'Color del icono estándar','These are all 6 colors Telegram allows bots to use. A selected emoji icon replaces the standard colored icon.':'Estos son los 6 colores que Telegram permite usar a los bots. El icono emoji seleccionado sustituye al icono de color estándar.','Default':'Predeterminado','Could not load icons. Appearance was not changed.':'No se pudieron cargar los iconos. No se cambió la apariencia.','Retry loading':'Reintentar carga','Choose an icon':'Elige un icono','The full set available to bots in Telegram. Use → for more icons.':'Conjunto completo disponible para los bots de Telegram. Usa → para ver más iconos.','Standard icon':'Icono estándar','Topic appearance':'Apariencia de los temas','Color: ':'Color: ','Icon: ':'Icono: ','Preview: ':'Vista previa: ','Applies to new topics. An emoji replaces the standard colored icon.':'Se aplica a los temas nuevos. Un emoji sustituye al icono de color estándar.','Color':'Color','Icon':'Icono','Reset appearance':'Restablecer apariencia','← Plan':'← Plan','Only the primary administrator can manage the plan in General.':'Solo el administrador principal puede gestionar el plan en General.','Only the primary administrator can edit these messages.':'Solo el administrador principal puede editar estos mensajes.','Send the new text in one message (up to 3500 characters).':'Envía el texto nuevo en un solo mensaje (hasta 3500 caracteres).','Cancel':'Cancelar','Settings have changed. Reopen the bot messages.':'La configuración ha cambiado. Vuelve a abrir los mensajes del bot.','Choose a bot to configure messages.':'Elige un bot para configurar sus mensajes.','Welcome: ':'Bienvenida: ','Auto-reply: ':'Respuesta automática: ','on':'activado','off':'desactivado','not configured':'sin configurar','Text is retained when disabled. Open a message to review its text and delivery switch.':'El texto se conserva al desactivar el envío. Abre un mensaje para revisar su contenido y el control de envío.','Welcome':'Bienvenida','Conversation auto-reply':'Respuesta automática a la conversación','← Bot':'← Bot','Save text first.':'Guarda primero el texto.','Edit':'Editar','Off. No text configured.':'Desactivado. No hay texto configurado.','Enable delivery':'Activar envío','Disable, keep text':'Desactivar y conservar el texto','Clear and disable':'Borrar y desactivar','Send the text in one message (up to 3500 characters), then preview and save. Messages use plain text.':'Envía el texto en un solo mensaje (hasta 3500 caracteres), revísalo y guárdalo. Los mensajes se envían como texto sin formato.','Preview:\n\n':'Vista previa:\n\n','The text will be cleared. This message will no longer be sent.':'Se borrará el texto y este mensaje dejará de enviarse.','Save':'Guardar','Resume input':'Continuar entrada','Start again':'Volver a empezar','Enter 1–3500 characters. Use Clear and disable to turn the message off.':'Introduce entre 1 y 3500 caracteres. Usa «Borrar y desactivar» para apagar el mensaje.'
  },
  zh: {
    '← Users':'← 用户','Only the primary operator can change topic appearance.':'只有主管理员可以更改话题外观。','Topic appearance is available to the primary operator in General.':'主管理员可以在 General 中配置话题外观。','Choose a bot to style its new topics.':'请选择要配置新话题外观的机器人。','← Back':'← 返回','Standard icon color':'标准图标颜色','These are all 6 colors Telegram allows bots to use. A selected emoji icon replaces the standard colored icon.':'这是 Telegram 允许机器人使用的全部 6 种颜色。选择的表情图标会替代标准彩色图标。','Default':'默认','Could not load icons. Appearance was not changed.':'无法加载图标，外观未更改。','Retry loading':'重新加载','Choose an icon':'选择图标','The full set available to bots in Telegram. Use → for more icons.':'这是 Telegram 机器人可用的全部图标。点击 → 查看更多。','Standard icon':'标准图标','Topic appearance':'话题外观','Color: ':'颜色：','Icon: ':'图标：','Preview: ':'预览：','Applies to new topics. An emoji replaces the standard colored icon.':'此设置应用于新话题。表情会替代标准彩色图标。','Color':'颜色','Icon':'图标','Reset appearance':'重置外观','← Plan':'← 套餐','Only the primary administrator can manage the plan in General.':'只有主管理员可以在 General 中管理套餐。','Only the primary administrator can edit these messages.':'只有主管理员可以编辑这些消息。','Send the new text in one message (up to 3500 characters).':'请在一条消息中发送新文本（最多 3500 个字符）。','Cancel':'取消','Settings have changed. Reopen the bot messages.':'设置已更改，请重新打开机器人消息。','Choose a bot to configure messages.':'请选择要配置消息的机器人。','Welcome: ':'欢迎消息：','Auto-reply: ':'自动回复：','on':'已启用','off':'已停用','not configured':'未配置','Text is retained when disabled. Open a message to review its text and delivery switch.':'停用后文本仍会保留。打开消息可查看文本并切换发送状态。','Welcome':'欢迎消息','Conversation auto-reply':'会话自动回复','← Bot':'← 机器人','Save text first.':'请先保存文本。','Edit':'编辑','Off. No text configured.':'已停用，尚未配置文本。','Enable delivery':'启用发送','Disable, keep text':'停用并保留文本','Clear and disable':'清除并停用','Send the text in one message (up to 3500 characters), then preview and save. Messages use plain text.':'请在一条消息中发送文本（最多 3500 个字符），然后预览并保存。消息将以纯文本发送。','Preview:\n\n':'预览：\n\n','The text will be cleared. This message will no longer be sent.':'文本将被清除，此消息也将停止发送。','Save':'保存','Resume input':'继续输入','Start again':'重新开始','Enter 1–3500 characters. Use Clear and disable to turn the message off.':'请输入 1–3500 个字符。使用“清除并停用”来关闭消息。'
  }
};
Object.assign(UI_TRANSLATIONS.es, {
  ' to all bots and the monitor?':' a todos los bots y al monitor?','D1: up to 1000 queries per invocation. Monitor: billing month, renewal day ':'D1: hasta 1000 consultas por ejecución. Monitor: mes de facturación, día de renovación ','D1: up to 50 queries per invocation. Monitor: daily Free quotas.':'D1: hasta 50 consultas por ejecución. Monitor: cuotas diarias del plan Free.','Enable Workers Paid in Cloudflare first.':'Primero activa Workers Paid en Cloudflare.','This button changes application settings, not your Cloudflare subscription.':'Este botón cambia la configuración de la aplicación, no tu suscripción de Cloudflare.','Workers Paid is active — apply':'Workers Paid está activo — aplicar','Apply Free':'Aplicar Free','Renewal day':'Día de renovación','Use deployment config':'Usar configuración del despliegue','Source: ':'Origen: ','D1: 1000 queries per invocation.\nMonitor: month from renewal day (':'D1: 1000 consultas por ejecución.\nMonitor: mes desde el día de renovación (','not set':'no definido','D1: 50 queries per invocation.\nMonitor: daily, reset at 00:00 UTC.':'D1: 50 consultas por ejecución.\nMonitor: diario, se reinicia a las 00:00 UTC.','Saved for all bots. Applies to the next request and monitor check. Change your Cloudflare subscription separately.':'Guardado para todos los bots. Se aplica en la próxima solicitud y comprobación del monitor. Cambia tu suscripción de Cloudflare por separado.','Free':'Free','Paid':'Paid','All bots':'Todos los bots','Select a support bot. Bulk changes are not applied in All bots mode.':'Elige un bot de soporte. En el modo «Todos los bots» no se aplican cambios masivos.','Select a support bot. All-bots mode never applies bulk changes.':'Elige un bot de soporte. El modo «Todos los bots» nunca aplica cambios masivos.','User not found.':'No se encontró el usuario.','Search':'Buscar','Profiles found':'Perfiles encontrados','Select the exact user and service.':'Elige el usuario y el servicio exactos.','First 20 shown. Refine by ID or username.':'Se muestran los primeros 20. Concreta la búsqueda por ID o nombre de usuario.','The user exists in multiple bots. Select one service.':'El usuario existe en varios bots. Elige un servicio concreto.','Primary operator found in the group.':'Se encontró al administrador principal en el grupo.','The primary operator’s presence in the group is unconfirmed.':'No se pudo confirmar la presencia del administrador principal en el grupo.','Choose a service to check its connection and message delivery.':'Elige un servicio para comprobar su conexión y el envío de mensajes.'
});
Object.assign(UI_TRANSLATIONS.zh, {
  ' to all bots and the monitor?':'到所有机器人和监控器？','D1: up to 1000 queries per invocation. Monitor: billing month, renewal day ':'D1：每次运行最多 1000 次查询。监控器：计费月份，续订日 ','D1: up to 50 queries per invocation. Monitor: daily Free quotas.':'D1：每次运行最多 50 次查询。监控器：Free 每日额度。','Enable Workers Paid in Cloudflare first.':'请先在 Cloudflare 中启用 Workers Paid。','This button changes application settings, not your Cloudflare subscription.':'此按钮更改应用设置，不会更改 Cloudflare 订阅。','Workers Paid is active — apply':'Workers Paid 已启用 — 应用','Apply Free':'应用 Free','Renewal day':'续订日','Use deployment config':'使用部署配置','Source: ':'来源：','D1: 1000 queries per invocation.\nMonitor: month from renewal day (':'D1：每次运行 1000 次查询。\n监控器：从续订日开始的月份（','not set':'未设置','D1: 50 queries per invocation.\nMonitor: daily, reset at 00:00 UTC.':'D1：每次运行 50 次查询。\n监控器：每日额度，于 UTC 00:00 重置。','Saved for all bots. Applies to the next request and monitor check. Change your Cloudflare subscription separately.':'已为所有机器人保存。将在下次请求和监控器检查时生效。Cloudflare 订阅需另行更改。','Free':'Free','Paid':'Paid','All bots':'所有机器人','Select a support bot. Bulk changes are not applied in All bots mode.':'请选择支持机器人。“所有机器人”模式不会批量应用更改。','Select a support bot. All-bots mode never applies bulk changes.':'请选择支持机器人。“所有机器人”模式不会批量应用更改。','User not found.':'未找到用户。','Search':'搜索','Profiles found':'用户资料数','Select the exact user and service.':'请选择准确的用户和服务。','First 20 shown. Refine by ID or username.':'仅显示前 20 项。请按 ID 或用户名缩小搜索范围。','The user exists in multiple bots. Select one service.':'此用户存在于多个机器人中，请选择一项服务。','Primary operator found in the group.':'已在群组中找到主管理员。','The primary operator’s presence in the group is unconfirmed.':'无法确认主管理员是否在群组中。','Choose a service to check its connection and message delivery.':'请选择服务以检查连接和消息收发。'
});
Object.assign(UI_TRANSLATIONS.es, {
  'Input paused. The draft is retained; you can continue ordinary work.':'Entrada pausada. Se conserva el borrador; puedes seguir con el trabajo habitual.',
  'Search all bots. Reply to this message with an ID, @username or part of a name.':'Busca en todos los bots. Responde a este mensaje con un ID, @username o parte de un nombre.'
});
Object.assign(UI_TRANSLATIONS.zh, {
  'Input paused. The draft is retained; you can continue ordinary work.':'输入已暂存，草稿已保留；你可以继续处理其他工作。',
  'Search all bots. Reply to this message with an ID, @username or part of a name.':'搜索所有机器人。请回复此消息并提供 ID、@用户名或部分姓名。'
});
Object.assign(UI_TRANSLATIONS.es, {
  'Needs reply':'Pendientes de respuesta','Mine':'Mías','Find user':'Buscar usuario','Drafts':'Borradores','Users':'Usuarios','Services':'Servicios','Team':'Equipo','System':'Sistema','Help':'Ayuda',
  'This action is available only in General. Open /menu here.':'Esta acción solo está disponible en General. Abre /menu aquí.','Support management\n\nChoose an action below. Type / to see commands and descriptions.\nInside a user\'s topic, /menu opens the conversation panel.':'Gestión del soporte\n\nElige una acción. Escribe / para ver los comandos y sus descripciones.\nEn el tema de un usuario, /menu abre la ficha de la conversación.',
  'Open my menu':'Abrir mi menú','Conversation':'Conversación','Conversations':'Conversaciones','Refresh panel':'Actualizar panel','Enter the internal block reason':'Indica el motivo interno del bloqueo','Enter a duration: 45m, 6h, or 7d.':'Indica una duración: 45m, 6h o 7d.','Only the primary operator can change the support team.':'Solo el administrador principal puede cambiar el equipo de soporte.','← Back to list':'← Volver a la lista','Role: primary operator':'Rol: administrador principal','The primary operator is configured during initial setup and cannot be removed here.':'El administrador principal se configura durante la instalación y no se puede eliminar aquí.','Reply to the future operator\'s message in this group or send their numeric Telegram ID.':'Responde al mensaje del futuro operador en este grupo o envía su ID numérico de Telegram.','✅ Operator added.':'✅ Operador añadido.','✅ Operator removed.':'✅ Operador eliminado.'
});
Object.assign(UI_TRANSLATIONS.zh, {
  'Needs reply':'待回复','Mine':'我的','Find user':'查找用户','Drafts':'草稿','Users':'用户','Services':'服务','Team':'团队','System':'系统','Help':'帮助',
  'This action is available only in General. Open /menu here.':'此操作仅在 General 中可用。请在此处打开 /menu。','Support management\n\nChoose an action below. Type / to see commands and descriptions.\nInside a user\'s topic, /menu opens the conversation panel.':'支持管理\n\n请选择操作。输入 / 查看命令及说明。\n在用户话题中，/menu 会打开会话卡片。',
  'Open my menu':'打开我的菜单','Conversation':'会话','Conversations':'会话列表','Refresh panel':'刷新面板','Enter the internal block reason':'请输入封禁的内部原因','Enter a duration: 45m, 6h, or 7d.':'请输入时长：45m、6h 或 7d。','Only the primary operator can change the support team.':'只有主管理员可以更改支持团队。','← Back to list':'← 返回列表','Role: primary operator':'角色：主管理员','The primary operator is configured during initial setup and cannot be removed here.':'主管理员在初始设置时配置，无法在此处删除。','Reply to the future operator\'s message in this group or send their numeric Telegram ID.':'请回复该群中未来操作员的消息，或发送其 Telegram 数字 ID。','✅ Operator added.':'✅ 已添加操作员。','✅ Operator removed.':'✅ 已移除操作员。'
});
Object.assign(UI_TRANSLATIONS.es, {
  'Reason must be 3–500 characters and contain no secrets.':'El motivo debe tener entre 3 y 500 caracteres y no incluir secretos.','Open the user\'s topic and choose an action in /menu.':'Abre el tema del usuario y elige una acción en /menu.','Only the primary administrator can connect bots.':'Solo el administrador principal puede conectar bots.','Continue setup in the private chat. Do not send the token here.':'Continúa la configuración en el chat privado. No envíes el token aquí.','Operator management is available only in General.':'La gestión de operadores solo está disponible en General.','Manage reactions in the General topic.':'Gestiona las reacciones en el tema General.','Unknown support bot.':'Bot de soporte desconocido.','Select a specific support bot.':'Elige un bot de soporte concreto.','Provide an exact Telegram user ID.':'Indica el ID exacto del usuario en Telegram.','Only the primary administrator in General can retry delivery.':'Solo el administrador principal en General puede reintentar la entrega.','Delivery recovery service unavailable. Check the deployment.':'El servicio de recuperación de entregas no está disponible. Comprueba el despliegue.'
});
Object.assign(UI_TRANSLATIONS.zh, {
  'Reason must be 3–500 characters and contain no secrets.':'原因须为 3–500 个字符，且不能包含机密信息。','Open the user\'s topic and choose an action in /menu.':'请打开用户的话题并在 /menu 中选择操作。','Only the primary administrator can connect bots.':'只有主管理员可以连接机器人。','Continue setup in the private chat. Do not send the token here.':'请在私聊中继续设置。不要在此处发送令牌。','Operator management is available only in General.':'只能在 General 中管理操作员。','Manage reactions in the General topic.':'请在 General 话题中管理表情反应。','Unknown support bot.':'未知的支持机器人。','Select a specific support bot.':'请选择具体的支持机器人。','Provide an exact Telegram user ID.':'请输入准确的 Telegram 用户 ID。','Only the primary administrator in General can retry delivery.':'只有主管理员可以在 General 中重试发送。','Delivery recovery service unavailable. Check the deployment.':'发送恢复服务不可用。请检查部署。'
});
Object.assign(UI_TRANSLATIONS.es, {
  'Trust':'Confiar','Untrust':'Quitar confianza','Remove manual restriction':'Quitar la restricción manual','Restrict':'Restringir','Unblock':'Desbloquear','Block':'Bloquear','Risk, CAPTCHA and auto-mute…':'Riesgo, CAPTCHA y silencio automático…','← Back':'← Volver','Open conversation':'Abrir conversación','Only the primary administrator can run checks in General.':'Solo el administrador principal puede iniciar comprobaciones en General.','The support bot is disabled by the D1 emergency switch.':'El bot de soporte está desactivado por el interruptor de emergencia de D1.','Normal messages will continue to work.':'Los mensajes normales seguirán funcionando.','15 minutes':'15 minutos','1 hour':'1 hora','24 hours':'24 horas','Custom':'Otro plazo','Cancel':'Cancelar','➕ Add bot':'➕ Añadir bot','Only the primary operator can change the support team.':'Solo el administrador principal puede cambiar el equipo de soporte.'
});
Object.assign(UI_TRANSLATIONS.zh, {
  'Trust':'设为可信','Untrust':'取消信任','Remove manual restriction':'解除手动限制','Restrict':'限制','Unblock':'解除封禁','Block':'封禁','Risk, CAPTCHA and auto-mute…':'风险、验证码和自动禁言…','← Back':'← 返回','Open conversation':'打开会话','Only the primary administrator can run checks in General.':'只有主管理员可以在 General 中启动检查。','The support bot is disabled by the D1 emergency switch.':'支持机器人已被 D1 紧急开关停用。','Normal messages will continue to work.':'普通消息仍会正常发送。','15 minutes':'15 分钟','1 hour':'1 小时','24 hours':'24 小时','Custom':'自定义时长','Cancel':'取消','➕ Add bot':'➕ 添加机器人'
});
function localizedWorkerSay(locale, russian, english) {
  if (locale === 'ru') return russian;
  return UI_TRANSLATIONS[locale]?.[english] || english;
}

function log(bot, level, event, data = {}) {
  const record = { ...data, level, event, bot_id: bot?.id };
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(JSON.stringify(record));
}

function asPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function asNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveRegistryInteger(entry, key) {
  if (!Object.hasOwn(entry, key)) return;
  if (!Number.isSafeInteger(entry[key]) || entry[key] <= 0) {
    throw new Error(`BOT_REGISTRY entry ${entry.id} ${key} must be a positive integer`);
  }
}

function parseRiskWeights(entry) {
  const source = entry.risk_weights;
  if (source === undefined) return { ...DEFAULT_RISK_WEIGHTS };
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error(`BOT_REGISTRY entry ${entry.id} risk_weights must be an object`);
  const aliases = {
    burst_limit: "burst", minute_limit: "minute", duplicate_message: "duplicateMessage",
    repeated_url: "repeatedUrl", many_urls: "manyUrls", mentions: "mentions",
    spam_keyword: "spamKeyword", new_user_url: "newUserUrl",
    failed_turnstile: "failedTurnstile", passed_turnstile: "passedTurnstile",
  };
  const result = { ...DEFAULT_RISK_WEIGHTS };
  for (const [key, value] of Object.entries(source)) {
    const target = aliases[key];
    if (!target || !Number.isSafeInteger(value) || value < 0 || value > 100) throw new Error(`BOT_REGISTRY entry ${entry.id} contains an invalid risk weight`);
    result[target] = value;
  }
  return result;
}

function parseSpamKeywords(entry) {
  if (entry.spam_keywords === undefined) return [...DEFAULT_SPAM_KEYWORDS];
  if (!Array.isArray(entry.spam_keywords) || entry.spam_keywords.length > 100) throw new Error(`BOT_REGISTRY entry ${entry.id} spam_keywords must be an array with at most 100 entries`);
  const values = entry.spam_keywords.map(normalizeForAbuseText);
  if (values.some((value) => !value || value.length > 64)) throw new Error(`BOT_REGISTRY entry ${entry.id} contains an invalid spam keyword`);
  return [...new Set(values)];
}

function isoAfter(ms) { return new Date(Date.now() + ms).toISOString(); }
function isFuture(value) { return Boolean(value && Date.parse(value) > Date.now()); }

export function parseBotRegistry(raw) {
  let value;
  try { value = JSON.parse(raw || "[]"); } catch { throw new Error("BOT_REGISTRY must be valid JSON"); }
  if (!Array.isArray(value)) throw new Error("BOT_REGISTRY must be an array");
  const ids = new Set();
  const secretBindings = new Set();
  const owners = [];
  const registry = value.map((entry) => {
    if (!entry || !/^[a-z0-9-]{1,64}$/.test(entry.id || "") || ids.has(entry.id)) throw new Error("BOT_REGISTRY contains an invalid or duplicate bot id");
    if (![entry.displayName, entry.topicPrefix, entry.tokenBinding, entry.webhookSecretBinding].every((v) => typeof v === "string" && v.trim())) throw new Error(`BOT_REGISTRY entry ${entry.id} is incomplete`);
    const tokenBinding = entry.tokenBinding.trim();
    const webhookSecretBinding = entry.webhookSecretBinding.trim();
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(tokenBinding) || !/^[A-Z][A-Z0-9_]{0,127}$/.test(webhookSecretBinding)) {
      throw new Error(`BOT_REGISTRY entry ${entry.id} has an invalid binding name`);
    }
    if (Object.hasOwn(entry, "enabled") && typeof entry.enabled !== "boolean") {
      throw new Error(`BOT_REGISTRY entry ${entry.id} enabled must be boolean`);
    }
    if (Object.hasOwn(entry, "locale") && !supportedLanguage(entry.locale)) {
      throw new Error(`BOT_REGISTRY entry ${entry.id} locale must be ru, en, es, or zh`);
    }
    if (Object.hasOwn(entry, "verification_mode") && !["off", "adaptive", "always"].includes(entry.verification_mode)) {
      throw new Error(`BOT_REGISTRY entry ${entry.id} verification_mode must be off, adaptive, or always`);
    }
    if (Object.hasOwn(entry, "attack_mode_manual_override") && !["on", "off", null].includes(entry.attack_mode_manual_override)) {
      throw new Error(`BOT_REGISTRY entry ${entry.id} attack_mode_manual_override must be on, off, or null`);
    }
    for (const key of ["antispam_enabled", "risk_enabled", "attack_mode_enabled"]) {
      if (Object.hasOwn(entry, key) && typeof entry[key] !== "boolean") throw new Error(`BOT_REGISTRY entry ${entry.id} ${key} must be boolean`);
    }
    for (const key of ["burst_limit", "minute_limit", "absolute_limit", "risk_mute_threshold", "trusted_days", "warning_cooldown_seconds", "pending_message_limit"]) positiveRegistryInteger(entry, key);
    if (Object.hasOwn(entry, "risk_turnstile_threshold") && (!Number.isSafeInteger(entry.risk_turnstile_threshold) || entry.risk_turnstile_threshold < 0)) {
      throw new Error(`BOT_REGISTRY entry ${entry.id} risk_turnstile_threshold must be a non-negative integer`);
    }
    if (Object.hasOwn(entry, "burst_limit") && entry.burst_limit !== DEFAULT_BURST_LIMIT) throw new Error(`BOT_REGISTRY entry ${entry.id} burst_limit must match the deployed ABUSE_BURST_LIMITER profile (${DEFAULT_BURST_LIMIT}/10s)`);
    if (Object.hasOwn(entry, "minute_limit") && entry.minute_limit !== DEFAULT_MINUTE_LIMIT) throw new Error(`BOT_REGISTRY entry ${entry.id} minute_limit must match the deployed ABUSE_MINUTE_LIMITER profile (${DEFAULT_MINUTE_LIMIT}/60s)`);
    if (Object.hasOwn(entry, "absolute_limit") && entry.absolute_limit !== DEFAULT_ABSOLUTE_LIMIT) throw new Error(`BOT_REGISTRY entry ${entry.id} absolute_limit must match the deployed ABUSE_ABSOLUTE_LIMITER profile (${DEFAULT_ABSOLUTE_LIMIT}/60s)`);
    if (Object.hasOwn(entry, "token") || Object.hasOwn(entry, "webhookSecret")) {
      throw new Error(`BOT_REGISTRY entry ${entry.id} must contain binding names, never secret values`);
    }
    if (secretBindings.has(tokenBinding) || secretBindings.has(webhookSecretBinding) || tokenBinding === webhookSecretBinding) {
      throw new Error("Every bot must use unique token and webhook-secret bindings");
    }
    ids.add(entry.id);
    secretBindings.add(tokenBinding);
    secretBindings.add(webhookSecretBinding);
    if (entry.groupCommandOwner === true) owners.push(entry.id);
    return {
      id: entry.id,
      displayName: entry.displayName.trim(),
      topicPrefix: entry.topicPrefix.trim(),
      tokenBinding,
      webhookSecretBinding,
      username: typeof entry.username === "string" ? entry.username.replace(/^@/, "") : "",
      locale: entry.locale || DEFAULT_LANGUAGE,
      enabled: entry.enabled !== false,
      groupCommandOwner: entry.groupCommandOwner === true,
      antispamEnabled: entry.antispam_enabled !== false,
      verificationMode: entry.verification_mode || "adaptive",
      riskEnabled: entry.risk_enabled !== false,
      burstLimit: asPositiveInteger(entry.burst_limit, DEFAULT_BURST_LIMIT),
      minuteLimit: asPositiveInteger(entry.minute_limit, DEFAULT_MINUTE_LIMIT),
      absoluteLimit: asPositiveInteger(entry.absolute_limit, DEFAULT_ABSOLUTE_LIMIT),
      riskTurnstileThreshold: asNonNegativeInteger(entry.risk_turnstile_threshold, DEFAULT_RISK_TURNSTILE_THRESHOLD),
      riskMuteThreshold: asPositiveInteger(entry.risk_mute_threshold, DEFAULT_RISK_MUTE_THRESHOLD),
      trustedDays: asPositiveInteger(entry.trusted_days, DEFAULT_TRUSTED_DAYS),
      attackModeEnabled: entry.attack_mode_enabled !== false,
      attackModeManualOverride: entry.attack_mode_manual_override || null,
      warningCooldownSeconds: asPositiveInteger(entry.warning_cooldown_seconds, DEFAULT_WARNING_COOLDOWN_SECONDS),
      pendingMessageLimit: asPositiveInteger(entry.pending_message_limit, DEFAULT_PENDING_MESSAGE_LIMIT),
      riskWeights: parseRiskWeights(entry),
      spamKeywords: parseSpamKeywords(entry),
    };
  });
  if (owners.length > 1) throw new Error("BOT_REGISTRY may contain only one groupCommandOwner");
  return registry;
}

export function getWebhookBotId(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  return parts.length === 2 && parts[0] === "tg" ? parts[1] : null;
}

export function timingSafeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}

export function topicTitle(bot, user) {
  const name = customerName({ first_name: user.first_name, last_name: user.last_name });
  const username = (user.username || "").replace(/[^a-zA-Z0-9_]/g, "");
  const title = `[${bot.topicPrefix}] ${(name || `${t(bot, "userLabel")} ${user.id}`)}${username ? ` @${username}` : ""}`;
  return Array.from(title).slice(0, 128).join("");
}

export function isOwnedByBot(conversation, botId) { return Boolean(conversation && conversation.bot_id === botId); }

export function parseAdminIds(raw) {
  const configured = String(raw || "").trim();
  if (!configured) throw new Error("ADMIN_IDS must contain exactly one primary operator Telegram user id");
  const values = configured.split(/[,;\s]+/);
  if (values.some((id) => !/^\d+$/.test(id))) throw new Error("ADMIN_IDS contains an invalid Telegram user id");
  if (values.length !== 1) throw new Error("ADMIN_IDS must contain exactly one primary operator Telegram user id");
  if (!Number.isSafeInteger(Number(values[0])) || Number(values[0]) <= 0) throw new Error("ADMIN_IDS contains an invalid Telegram user id");
  return new Set(values);
}

function primaryOperatorId(env) {
  return Number([...parseAdminIds(env.ADMIN_IDS)][0]);
}

export function isMissingTopicError(description) {
  const value = String(description || "").toLowerCase().replaceAll("_", " ");
  // Reopening a deleted forum topic may return this code instead of "not found".
  return /\btopic id invalid\b/.test(value)
    || ["thread not found", "topic not found", "message thread not found", "topic deleted", "thread deleted", "forum topic not found"]
    .some((fragment) => value.includes(fragment));
}

export function isAlreadyTopicState(description, state) {
  const value = String(description || "").toLowerCase();
  return value.includes(`topic is already ${state}`)
    || value.includes(`topic already ${state}`)
    || value.includes(`forum topic is already ${state}`)
    || value.includes("topic_not_modified")
    || (state === "closed" && value.includes("topic_closed"));
}

function isMessageNotModifiedError(description) {
  const value = String(description || "").toLowerCase();
  return value.includes("message is not modified") || value.includes("message_not_modified");
}

export function extractAlbumMedia(message) {
  const common = {
    caption: message.caption || "",
    captionEntities: Array.isArray(message.caption_entities) ? message.caption_entities : [],
    hasSpoiler: Boolean(message.has_media_spoiler),
  };
  if (message.photo?.length) return { type: "photo", media: message.photo.at(-1).file_id, ...common };
  for (const type of ["video", "audio", "document"]) {
    if (message[type]?.file_id) return { type, media: message[type].file_id, ...common };
  }
  return null;
}

export function storedAlbumInputMedia(item) {
  const media = { type: item.media_type, media: item.file_id };
  if (item.caption) media.caption = item.caption;
  if (item.caption_entities_json) {
    try {
      const entities = JSON.parse(item.caption_entities_json);
      if (Array.isArray(entities) && entities.length) media.caption_entities = entities;
    } catch {}
  }
  if (["photo", "video"].includes(item.media_type) && Number(item.has_spoiler) === 1) media.has_spoiler = true;
  return media;
}

function isDeliveryOutcomeUncertain(result) {
  if (result?.deliveryUncertain === true) return true;
  const description = String(result?.description || "").toLowerCase();
  return description.includes("timed out") || description.includes("network error") || description.includes("without json");
}

function terminalDispatchError(message) {
  const error = new Error(message);
  error.terminalDispatch = true;
  return error;
}

export function formatInfo(conversation, bot) {
  const user = conversation.username ? `@${conversation.username}` : customerName({
    first_name: conversation.first_name, last_name: conversation.last_name }, '—');
  const status = conversation.status === "closed" ? t(bot, "closedStatus") : t(bot, "openStatus");
  return [`👤 ${t(bot, "userLabel")}`, "", `${t(bot, "serviceLabel")}: ${bot.displayName}`, bot.username ? `${t(bot, "botLabel")}: @${bot.username}` : "", `${t(bot, "userLabel")}: ${user}`, `${t(bot, "userIdLabel")}: ${conversation.user_id}`, `${t(bot, "topicLabel")}: ${conversation.thread_id}`, `${t(bot, "statusLabel")}: ${status}`].filter(Boolean).join("\n");
}

export function parseRestrictionDuration(value) {
  const match = String(value || "").trim().toLowerCase().match(/^(\d{1,4})(m|h|d)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  const durationMs = amount * multiplier;
  return durationMs >= MIN_RESTRICTION_MS && durationMs <= MAX_RESTRICTION_MS ? durationMs : null;
}

function operatorName(user) {
  const clean = (value) => String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  const name = [user?.first_name, user?.last_name].map(clean).filter(Boolean).join(" ");
  const username = clean(user?.username).replace(/[^a-zA-Z0-9_]/g, "");
  return (name || (username ? `@${username}` : `operator ${user?.id}`)).slice(0, 128);
}

function validateManagementReason(value) {
  const reason = String(value || "").normalize("NFKC").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").trim();
  if (reason.length < 3 || reason.length > 500) return null;
  if (/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/.test(reason)) return null;
  return reason;
}

function formatOperatorDate(bot, value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(({ru:"ru-RU",en:"en-GB",es:"es-ES",zh:"zh-CN"})[bot.locale] || "en-GB", {
    timeZone: "Europe/Budapest",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function isManuallyRestricted(state) {
  return isFuture(state?.manual_restricted_until);
}

function reply(status, text) { return new Response(text, { status }); }
function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function dbOne(db, sql, ...params) { return db.prepare(sql).bind(...params).first(); }
function dbRun(db, sql, ...params) { return db.prepare(sql).bind(...params).run(); }
function dbAll(db, sql, ...params) { return db.prepare(sql).bind(...params).all(); }
function requireDb(env) { if (!env.SUPPORT_DB) throw new Error("SUPPORT_DB D1 binding is required"); return env.SUPPORT_DB; }

async function webhookEnvironment(env) {
  const db = requireDb(env);
  const budget = await resolveInvocationDatabase(db, env);
  return budget === db ? env : { ...env, SUPPORT_DB: budget };
}

function supportGroupId(env) {
  const raw = String(env.SUPPORT_GROUP_ID || "");
  const value = Number(raw);
  if (!raw.startsWith("-100") || !Number.isSafeInteger(value)) {
    throw new Error("SUPPORT_GROUP_ID must be a valid Telegram forum id starting with -100");
  }
  return value;
}

function historicalTopicNotice(bot, topic) {
  const currentThreadId = topic.current_thread_id || topic.replacement_thread_id;
  const link = currentThreadId
    ? topicLink(Number(topic.replacement_group_id), Number(currentThreadId))
    : null;
  const copy=({
    ru:{archived:'Это архивная тема. Ответ клиенту не отправлен.',current:' Актуальная тема: ',next:' Новая тема появится после следующего сообщения клиента.'},
    en:{archived:'This topic is archived. Your reply was not sent to the customer.',current:' Current topic: ',next:' A new topic will open after the customer writes again.'},
    es:{archived:'Este tema está archivado. La respuesta no se envió al cliente.',current:' Tema actual: ',next:' Se abrirá un tema nuevo cuando el cliente vuelva a escribir.'},
    zh:{archived:'此话题已归档，回复未发送给客户。',current:' 当前话题：',next:'客户下次发消息时会创建新话题。'},
  })[bot.locale]||{archived:'This topic is archived. Your reply was not sent to the customer.',current:' Current topic: ',next:' A new topic will open after the customer writes again.'};
  return copy.archived+(link?copy.current+link:copy.next);
}

async function redirectHistoricalTopic(bot, env, threadId) {
  const oldGroupId = supportGroupId(env);
  const activeGroupId = Number(env.SERVICE_ACTIVE_GROUP_ID);
  const db = requireDb(env);
  const topic = await findTopicByGroup(db, oldGroupId, threadId);
  if (!topic || !isOwnedByBot(topic, bot.id)) return null;
  let current = await findConversation(db, bot.id, topic.user_id);
  if (!current || Number(current.support_group_id) !== activeGroupId) {
    current = await provisionConversation(bot, { ...env, SUPPORT_GROUP_ID: String(activeGroupId) }, {
      id: Number(topic.user_id), username: topic.username || null,
      first_name: topic.first_name || 'User', last_name: topic.last_name || null,
    });
    await dbRun(db, `UPDATE service_topic_history SET replacement_thread_id=?
      WHERE bot_id=? AND user_id=? AND support_group_id=? AND replacement_group_id=?
        AND replacement_thread_id IS NULL`, current.thread_id, bot.id, topic.user_id, oldGroupId, activeGroupId);
  }
  await dbRun(db, `UPDATE service_notification_outbox SET group_id=?,thread_id=?
    WHERE bot_id=? AND user_id=? AND group_id=? AND status IN ('pending','retryable')`,
    activeGroupId, current.thread_id, bot.id, topic.user_id, oldGroupId);
  await markSentNoticeLinksForRoute(db,{botId:bot.id,userId:Number(topic.user_id),
    groupId:activeGroupId,threadId:Number(current.thread_id)});
  if (env.MANAGER_BOT_TOKEN) {
    try {
      await queueTransferNotice(db, { botId: bot.id, userId: Number(topic.user_id),
        groupId: activeGroupId, threadId: Number(current.thread_id),
        note: `Группа сервиса изменена. История: ${topicLink(oldGroupId, threadId)}` });
    } catch (error) {
      log(bot, 'error', 'group_cutover_transfer_notice_failed', { user_id: topic.user_id, message: error.message });
    }
  }
  return { ...topic, replacement_group_id: activeGroupId, current_thread_id: current.thread_id };
}

function resolveBot(env, id, includeSecrets = true) {
  const config = parseBotRegistry(env.BOT_REGISTRY).find((bot) => bot.id === id) || null;
  if (!config || !includeSecrets) return config;
  const token = env[config.tokenBinding];
  const webhookSecret = env[config.webhookSecretBinding];
  if (!token || !webhookSecret) throw new Error(`Missing secret binding for bot ${config.id}`);
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(String(webhookSecret))) throw new Error(`Invalid webhook secret for bot ${config.id}`);
  return { ...config, token: String(token), webhookSecret: String(webhookSecret) };
}

async function telegram(bot, method, body, env, fetchImpl = fetch, { durableCleanup = true } = {}) {
  const cleanup = durableCleanup && method === 'deleteMessage' && env.TELEGRAM_COOLDOWN_ENABLED === 'true'
    && await prepareTelegramCleanup(env.SUPPORT_DB, bot, body);
  const deferred = deferredTelegramResult(env.SUPPORT_DB, bot);
  if (deferred) return deferred;
  env.SUPPORT_DB?.recoveryTelegramCheckpoint?.();
  const deliveryEvents = env.MANUAL_DELIVERY_EVENTS;
  if (deliveryEvents && ['copyMessage', 'forwardMessage', 'copyMessages', 'forwardMessages', 'sendMediaGroup'].includes(method)) deliveryEvents.attempts++;
  const result = await requestTelegram({ token: bot.token, method, body, fetchImpl,
    timeoutMs: Math.min(asPositiveInteger(env.TELEGRAM_TIMEOUT_MS, DEFAULT_TELEGRAM_TIMEOUT_MS), MAX_TELEGRAM_TIMEOUT_MS) });
  const failed = !result.ok && !(method === 'deleteMessage' && isConfirmedMessageDeletion(result));
  if (failed) await recordStatisticsTelegramFailure(env.SUPPORT_DB,bot.id,result);
  if (env.TELEGRAM_COOLDOWN_ENABLED === "true" && result.rateLimited) {
    try { await recordTelegramCooldown(env.SUPPORT_DB, bot, method, result); }
    catch (error) { log(bot, "error", "telegram_cooldown_not_saved", { method, message: error.message }); }
  }
  if (cleanup) {
    try { await settleTelegramCleanup(env.SUPPORT_DB, bot, body, result); }
    catch (error) { log(bot, 'error', 'telegram_cleanup_result_not_saved', { message: error.message }); }
  }
  if (failed && !result.deferred) await recordOperationalSignal(env, bot.id, result.rateLimited ? "telegram_429" : result.deliveryUncertain ? "telegram_uncertain" : "telegram_failed");
  if (deliveryEvents && !result.ok && deliveryEvents.errors.length < 3) deliveryEvents.errors.push(`${method}: ${String(result.description || 'Telegram error').slice(0, 180)}`);
  return result;
}

function reactionEmoji(value) {
  if (!value || value.type !== "emoji" || typeof value.emoji !== "string") return null;
  // Presentation selectors do not change the emoji identity; send Telegram's canonical spelling.
  const emoji = value.emoji.replace(/\uFE0F/g, "");
  return STANDARD_REACTIONS.has(emoji) ? emoji : null;
}

function reactionFromUpdate(update) {
  const event = update?.message_reaction;
  if (!event || !Array.isArray(event.new_reaction)) return { event: null, emoji: null, unsupported: false };
  if (event.new_reaction.length === 0) return { event, emoji: null, unsupported: false };
  const emoji = event.new_reaction.map(reactionEmoji).filter(Boolean).at(-1) || null;
  const previousEmoji = Array.isArray(event.old_reaction)
    ? event.old_reaction.map(reactionEmoji).filter(Boolean).at(-1) || null
    : null;
  return { event, emoji, unsupported: !emoji && !previousEmoji };
}

function ignoreReactionBeforeDatabase(bot, env, update) {
  if (!update?.message_reaction) return false;
  const parsed = reactionFromUpdate(update);
  const event = parsed.event;
  if (!event?.chat || parsed.unsupported || event.user?.is_bot || event.actor_chat || !Number.isSafeInteger(Number(event.user?.id)) || !Number.isSafeInteger(Number(event.date))) return true;
  if (event.chat.type === "private") return String(event.chat.id) !== String(event.user.id);
  if (!env) return false;
  if (String(event.chat.id) !== String(supportGroupId(env))) return true;
  // The effective General owner and additional operators are D1-backed, so
  // both checks intentionally happen after the cheap ingress validation.
  return false;
}

async function allowReactionIngress(bot, env, update) {
  if (!update?.message_reaction) return true;
  const actorId = update.message_reaction.user?.id;
  try {
    return await checkEdgeLimit(env, "REACTION_LIMITER", `reaction-ingress:${bot.id}:${actorId}`);
  } catch (error) {
    log(bot, "error", "reaction_ingress_limiter_failed", { actor_id: Number(actorId), message: error.message });
    return false;
  }
}

async function ensureReactionSettings(db, botId) {
  await dbRun(db, "INSERT INTO reaction_settings (bot_id, updated_at) VALUES (?, ?) ON CONFLICT(bot_id) DO NOTHING", botId, nowIso());
  return dbOne(db, "SELECT * FROM reaction_settings WHERE bot_id = ?", botId);
}

async function reactionStateMap(db) {
  const rows = await dbAll(db, `SELECT r.*, EXISTS(SELECT 1 FROM reaction_checks c WHERE c.bot_id = r.bot_id
    AND c.expires_at > ? AND c.state IN ('waiting', 'preparing', 'ready')) AS checking FROM reaction_settings r`, nowIso());
  return new Map((rows.results || []).map((row) => [row.bot_id, {
    enabled: REACTION_DIRECTIONS.some(direction => { const s = reactionDirection(row, direction); return s.enabled && s.verified; }),
    verified: true,
    checking: Number(row.checking) === 1,
  }]));
}

function desiredReactionSubscriptions(registry, states, ownerId = null) {
  const owner = ownerId ? registry.find((config) => config.id === ownerId) : null;
  const effective = new Map(registry.map((config) => {
    const state = states.get(config.id);
    return [config.id, Boolean(config.enabled && (state?.checking || state?.enabled && state?.verified))];
  }));
  const anyEnabled = [...effective.values()].some(Boolean);
  return new Map(registry.map((config) => [config.id, effective.get(config.id) || (config.id === owner?.id && anyEnabled)]));
}

async function setReactionWebhookSubscription(config, env, includeReactions) {
  const bot = resolveBot(env, config.id);
  const result = await telegram(bot, "setWebhook", {
    url: `${publicBaseOrigin(env.PUBLIC_BASE_URL)}/tg/${config.id}`,
    secret_token: bot.webhookSecret,
    allowed_updates: reactionUpdates(includeReactions),
    drop_pending_updates: false,
  }, env);
  if (!result.ok && isDeliveryOutcomeUncertain(result)) {
    const info = await telegram(bot, "getWebhookInfo", {}, env);
    if (info.ok) {
      const allowed = new Set(Array.isArray(info.result?.allowed_updates) ? info.result.allowed_updates : []);
      const hasReactions = allowed.has("message_reaction");
      if (info.result?.url === `${publicBaseOrigin(env.PUBLIC_BASE_URL)}/tg/${config.id}`
          && reactionUpdates(includeReactions).every(type => allowed.has(type)) && hasReactions === Boolean(includeReactions)) {
        log(bot, "warn", "reaction_webhook_reconciled_after_uncertain_response", { include_reactions: Boolean(includeReactions) });
        return;
      }
    }
  }
  if (!result.ok) throw new Error(`setWebhook failed for ${config.id}: ${result.description}`);
}

function retryableReactionError(message) {
  const error = new Error(message);
  error.retryableReaction = true;
  return error;
}

async function claimReactionSyncLock(db, mappingId, direction) {
  const ownerToken = crypto.randomUUID();
  const leaseExpiresAt = isoAfter(REACTION_SYNC_LEASE_MS);
  const inserted = await dbRun(
    db,
    "INSERT INTO reaction_sync_locks (mapping_id, direction, owner_token, lease_expires_at, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(mapping_id, direction) DO NOTHING",
    mappingId,
    direction,
    ownerToken,
    leaseExpiresAt,
    nowIso(),
  );
  if (inserted.meta?.changes === 1) return ownerToken;
  const current = await dbOne(db, "SELECT owner_token, lease_expires_at FROM reaction_sync_locks WHERE mapping_id = ? AND direction = ?", mappingId, direction);
  if (!current?.lease_expires_at || Date.parse(current.lease_expires_at) > Date.now()) return null;
  const reclaimed = await dbRun(
    db,
    "UPDATE reaction_sync_locks SET owner_token = ?, lease_expires_at = ?, created_at = ? WHERE mapping_id = ? AND direction = ? AND owner_token = ? AND lease_expires_at <= ?",
    ownerToken,
    leaseExpiresAt,
    nowIso(),
    mappingId,
    direction,
    current.owner_token,
    nowIso(),
  );
  return reclaimed.meta?.changes === 1 ? ownerToken : null;
}

async function releaseReactionSyncLock(db, mappingId, direction, ownerToken) {
  await dbRun(db, "DELETE FROM reaction_sync_locks WHERE mapping_id = ? AND direction = ? AND owner_token = ?", mappingId, direction, ownerToken);
}

async function renewReactionSyncLock(db, mappingId, direction, ownerToken) {
  const renewed = await dbRun(
    db,
    "UPDATE reaction_sync_locks SET lease_expires_at = ? WHERE mapping_id = ? AND direction = ? AND owner_token = ? AND lease_expires_at > ?",
    isoAfter(REACTION_SYNC_LEASE_MS),
    mappingId,
    direction,
    ownerToken,
    nowIso(),
  );
  return renewed.meta?.changes === 1;
}

async function handleReactionUpdate(bot, env, update) {
  const parsed = reactionFromUpdate(update);
  const event = parsed.event;
  if (!event || !event.chat || !Number.isSafeInteger(Number(event.message_id)) || !Number.isSafeInteger(Number(event.date))) return;
  if (parsed.unsupported) return;
  if (await reactionChecks(env).reaction(bot.id, update, parsed)) return;
  const groupId = String(supportGroupId(env));
  const isGroup = String(event.chat.id) === groupId;
  const actorId = event.user?.id;
  if (event.user?.is_bot || event.actor_chat || !Number.isSafeInteger(Number(actorId))) return;
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const db = requireDb(env);
  if (isGroup) {
    const route = await dbOne(db, "SELECT group_id FROM service_group_routes WHERE bot_id = ?", bot.id);
    if (Number(route?.group_id) !== Number(event.chat.id)) {
      const owner = await effectiveGroupCommandOwner(db, registry, env);
      if (!owner || owner.id !== bot.id) return;
    }
    if (!await isAdmin(bot, env, actorId)) return;
  } else if (event.chat.type === "private") {
    if (String(event.chat.id) !== String(actorId)) return;
  } else return;

  const rows = isGroup
    ? await dbAll(db, `SELECT m.id, m.bot_id, m.user_id, m.thread_id, m.support_group_id, m.user_message_id, m.support_message_id,
                             m.user_reaction_update_id, m.support_reaction_update_id
        FROM message_mappings m INDEXED BY message_mappings_support_reaction_lookup_idx
        JOIN reaction_settings r ON r.bot_id = m.bot_id
          AND COALESCE(r.support_to_user_enabled, r.enabled) = 1 AND COALESCE(r.support_to_user_verified, r.capability_verified) = 1
        LEFT JOIN bots b ON b.id = m.bot_id
       WHERE m.support_group_id = ? AND m.support_message_id = ? AND m.user_message_id IS NOT NULL
         AND (b.enabled IS NULL OR b.enabled = 1)
       LIMIT 2`, supportGroupId(env), Number(event.message_id))
    : await dbAll(db, `SELECT m.id, m.bot_id, m.user_id, m.thread_id, m.support_group_id, m.user_message_id, m.support_message_id,
                             m.user_reaction_update_id, m.support_reaction_update_id,
                             m.user_reaction_date, m.support_reaction_date
        FROM message_mappings m
        JOIN reaction_settings r ON r.bot_id = m.bot_id
          AND COALESCE(r.user_to_support_enabled, r.enabled) = 1 AND COALESCE(r.user_to_support_verified, r.capability_verified) = 1
        LEFT JOIN bots b ON b.id = m.bot_id
       WHERE m.bot_id = ? AND m.user_id = ? AND m.user_message_id = ? AND m.support_message_id IS NOT NULL
         AND (b.enabled IS NULL OR b.enabled = 1)
       LIMIT 2`, bot.id, Number(event.chat.id), Number(event.message_id));
  const matches = rows.results || [];
  if (matches.length !== 1 || Number(matches[0].thread_id) === 1) return;
  const mapping = matches[0];
  const targetConfig = registry.find((item) => item.id === mapping.bot_id);
  if (!targetConfig?.enabled) return;
  const targetBot = resolveBot(env, mapping.bot_id);
  let allowed;
  try {
    allowed = await checkEdgeLimit(env, "REACTION_LIMITER", `reaction-target:${targetBot.id}:${actorId}`);
  } catch (error) {
    log(targetBot, "error", "reaction_limiter_failed", { direction: isGroup ? "support_to_user" : "user_to_support", message: error.message });
    return;
  }
  if (!allowed) {
    log(targetBot, "warn", "reaction_rate_limited", { actor_id: Number(actorId), direction: isGroup ? "support_to_user" : "user_to_support" });
    return;
  }
  const targetMessageId = isGroup ? mapping.user_message_id : mapping.support_message_id;
  const targetChatId = isGroup ? mapping.user_id : Number(mapping.support_group_id);
  if (!Number.isSafeInteger(Number(targetMessageId))) return;
  const direction = isGroup ? "support_to_user" : "user_to_support";
  const markerColumn = isGroup ? "support_reaction_update_id" : "user_reaction_update_id";
  const markerDateColumn = isGroup ? "support_reaction_date" : "user_reaction_date";
  const lockToken = await claimReactionSyncLock(db, Number(mapping.id), direction);
  if (!lockToken) throw retryableReactionError("Reaction synchronization is busy");
  try {
    const latest = await dbOne(db, `SELECT ${markerColumn} AS update_id, ${markerDateColumn} AS reaction_date FROM message_mappings WHERE id = ?`, Number(mapping.id));
    if (!latest) return;
    await touchStorageTopic({ ...env, SUPPORT_GROUP_ID: String(mapping.support_group_id) }, mapping.bot_id, mapping.thread_id, mapping.user_id);
    const incomingDate = Number(event.date);
    const latestDate = latest.reaction_date === null ? null : Number(latest.reaction_date);
    const latestUpdateId = latest.update_id === null ? null : Number(latest.update_id);
    if (latestDate !== null && (latestDate > incomingDate || (latestDate === incomingDate && latestUpdateId !== null && latestUpdateId >= Number(update.update_id)))) return;
    if (!await renewReactionSyncLock(db, Number(mapping.id), direction, lockToken)) throw retryableReactionError("Reaction synchronization lease was lost");
    let result;
    if (isGroup) {
      try {
        result = await withAuthorizedOperatorExecution(targetBot, env, actorId, async (renewOperatorFence) => {
          await renewOperatorFence();
          return telegram(targetBot, "setMessageReaction", {
            chat_id: targetChatId,
            message_id: Number(targetMessageId),
            reaction: parsed.emoji ? [{ type: "emoji", emoji: parsed.emoji }] : [],
          }, env);
        });
      } catch (error) {
        if (error?.operatorRevoked) {
          log(targetBot, "warn", "operator_access_revoked_before_reaction", { actor_id: Number(actorId), message_id: Number(event.message_id) });
          return;
        }
        throw error;
      }
    } else {
      result = await telegram(targetBot, "setMessageReaction", {
        chat_id: targetChatId,
        message_id: Number(targetMessageId),
        reaction: parsed.emoji ? [{ type: "emoji", emoji: parsed.emoji }] : [],
      }, env);
    }
    if (!result.ok) {
      log(targetBot, "warn", "reaction_sync_failed", { direction, target_chat_id: targetChatId, target_message_id: Number(targetMessageId), description: result.description });
      if (isRetryableTelegramFailure(result) || result.deliveryUncertain === true) {
        throw retryableReactionError(`Reaction synchronization failed transiently: ${result.description}`);
      }
      return;
    }
    const marked = await dbRun(
      db,
      `UPDATE message_mappings SET ${markerDateColumn} = ?, ${markerColumn} = ?
        WHERE id = ? AND (${markerDateColumn} IS NULL OR ${markerDateColumn} < ?
          OR (${markerDateColumn} = ? AND (${markerColumn} IS NULL OR ${markerColumn} < ?)))
          AND EXISTS (
            SELECT 1 FROM reaction_sync_locks l
             WHERE l.mapping_id = ? AND l.direction = ? AND l.owner_token = ? AND l.lease_expires_at > ?
          )`,
      incomingDate,
      Number(update.update_id),
      Number(mapping.id),
      incomingDate,
      incomingDate,
      Number(update.update_id),
      Number(mapping.id),
      direction,
      lockToken,
      nowIso(),
    );
    if (marked.meta?.changes !== 1) throw retryableReactionError("Reaction ordering marker was not saved");
  } finally {
    try { await releaseReactionSyncLock(db, Number(mapping.id), direction, lockToken); }
    catch (error) { log(targetBot, "error", "reaction_sync_lock_release_failed", { direction, message: error.message }); }
  }
}

function isRetryableTelegramFailure(result) {
  return result?.retryable === true;
}

async function sendTopic(bot, env, threadId, text) {
  const body = { chat_id: env.SUPPORT_GROUP_ID, text };
  if (threadId !== undefined && threadId !== null) body.message_thread_id = threadId;
  const result = await telegram(bot, "sendMessage", body, env);
  if (!result.ok) throw new Error(`sendMessage failed: ${result.description}`);
  if (threadId !== undefined && threadId !== null && Number(threadId) !== 1 && !deliveredToExpectedThread(result, threadId)) {
    const removed = await removeRedirectedMessage(bot, env, result, threadId);
    const error = new Error("Telegram redirected a service message outside the expected Topic");
    error.deliveryUncertain = !removed;
    throw error;
  }
  return result;
}

async function claimUpdate(db, botId, updateId) {
  const ownerToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + UPDATE_LEASE_MS).toISOString();
  const inserted = await dbRun(
    db,
    "INSERT INTO processed_updates (bot_id, update_id, state, owner_token, lease_expires_at, processed_at, completed_at) VALUES (?, ?, 'processing', ?, ?, ?, NULL) ON CONFLICT(bot_id, update_id) DO NOTHING",
    botId,
    updateId,
    ownerToken,
    leaseExpiresAt,
    nowIso(),
  );
  if (inserted.meta?.changes === 1) return { status: "acquired", ownerToken };

  const current = await dbOne(db, "SELECT state, owner_token, lease_expires_at, dispatch_succeeded_at FROM processed_updates WHERE bot_id = ? AND update_id = ?", botId, updateId);
  if (current?.state === "completed") return { status: "completed" };
  if (current?.dispatch_succeeded_at) {
    try { await dbRun(db, "UPDATE processed_updates SET state = 'completed', completed_at = COALESCE(completed_at, dispatch_succeeded_at), lease_expires_at = NULL WHERE bot_id = ? AND update_id = ? AND dispatch_succeeded_at IS NOT NULL", botId, updateId); } catch {}
    return { status: "completed" };
  }
  if (current?.lease_expires_at && Date.parse(current.lease_expires_at) <= Date.now()) {
    const reclaimed = await dbRun(
      db,
      "UPDATE processed_updates SET owner_token = ?, lease_expires_at = ?, processed_at = ? WHERE bot_id = ? AND update_id = ? AND state = 'processing' AND owner_token = ? AND lease_expires_at <= ?",
      ownerToken,
      leaseExpiresAt,
      nowIso(),
      botId,
      updateId,
      current.owner_token,
      nowIso(),
    );
    if (reclaimed.meta?.changes === 1) return { status: "acquired", ownerToken };
  }
  return { status: "busy" };
}

async function markDispatchSucceeded(db, botId, updateId, ownerToken) {
  const marked = await dbRun(
    db,
    "UPDATE processed_updates SET dispatch_succeeded_at = COALESCE(dispatch_succeeded_at, ?) WHERE bot_id = ? AND update_id = ? AND state = 'processing' AND owner_token = ?",
    nowIso(),
    botId,
    updateId,
    ownerToken,
  );
  if (marked.meta?.changes !== 1) throw new Error("Processed-update dispatch marker was not saved");
}

async function completeUpdate(db, botId, updateId, ownerToken) {
  const completed = await dbRun(
    db,
    "UPDATE processed_updates SET state = 'completed', dispatch_succeeded_at = COALESCE(dispatch_succeeded_at, ?), completed_at = ?, lease_expires_at = NULL WHERE bot_id = ? AND update_id = ? AND state = 'processing' AND owner_token = ?",
    nowIso(),
    nowIso(),
    botId,
    updateId,
    ownerToken,
  );
  if (completed.meta?.changes !== 1) throw new Error("Processed-update lease was lost before completion");
}

async function releaseUpdate(db, botId, updateId, ownerToken) {
  await dbRun(db, "DELETE FROM processed_updates WHERE bot_id = ? AND update_id = ? AND state = 'processing' AND owner_token = ?", botId, updateId, ownerToken);
}

function limiterKey(bot, userId) { return `${bot.id}:${userId}`; }

async function checkEdgeLimit(env, bindingName, key) {
  try {
    const limiter = env[bindingName];
    if (!limiter || typeof limiter.limit !== "function") throw new Error(`${bindingName} Rate Limiting binding is required`);
    const result = await limiter.limit({ key });
    if (result?.success !== true) await recordOperationalSignal(env, env.HEALTH_BOT_ID || "all", `limiter:${bindingName}:denied`);
    return result?.success === true;
  } catch (error) {
    await recordOperationalSignal(env, env.HEALTH_BOT_ID || "all", `limiter:${bindingName}:unavailable`);
    throw error;
  }
}

async function checkAbsoluteLimit(bot, env, userId) {
  try {
    return { allowed: await checkEdgeLimit(env, "ABUSE_ABSOLUTE_LIMITER", limiterKey(bot, userId)), degraded: false };
  } catch (error) {
    log(bot, "error", "absolute_limiter_unavailable", { user_id: userId, message: error.message });
    return { allowed: true, degraded: true };
  }
}

async function checkLogicalLimits(bot, env, userId) {
  const [burstResult, minuteResult] = await Promise.allSettled([
    checkEdgeLimit(env, "ABUSE_BURST_LIMITER", limiterKey(bot, userId)),
    checkEdgeLimit(env, "ABUSE_MINUTE_LIMITER", limiterKey(bot, userId)),
  ]);
  const degraded = burstResult.status === "rejected" || minuteResult.status === "rejected";
  if (burstResult.status === "rejected") log(bot, "error", "burst_limiter_unavailable", { user_id: userId, message: burstResult.reason?.message || "unknown error" });
  if (minuteResult.status === "rejected") log(bot, "error", "minute_limiter_unavailable", { user_id: userId, message: minuteResult.reason?.message || "unknown error" });
  return {
    burst: burstResult.status === "rejected" ? true : burstResult.value === true,
    minute: minuteResult.status === "rejected" ? true : minuteResult.value === true,
    degraded,
  };
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
}

async function deterministicChallengeToken(bot, challenge) {
  if (!bot?.webhookSecret || !bot?.token) throw new Error("Challenge token derivation requires both bot secrets");
  const keyMaterial = `${bot.webhookSecret}\u0000${bot.token}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${bot.id}:${challenge.id}:${challenge.user_id}:${challenge.created_at}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function stableIdempotencyKey(value) {
  const hex = (await sha256(value)).slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  const value32 = hex.join("");
  return `${value32.slice(0, 8)}-${value32.slice(8, 12)}-${value32.slice(12, 16)}-${value32.slice(16, 20)}-${value32.slice(20)}`;
}

export function normalizeForAbuseText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}+/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}
function normalizeMessage(message) { return normalizeForAbuseText(message.text || message.caption || ""); }
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function containsSpamKeyword(text, keyword) {
  if (/\s/u.test(keyword)) return text.includes(keyword);
  return new RegExp(`(^|[^\p{L}\p{N}_])${escapeRegex(keyword)}(?=$|[^\p{L}\p{N}_])`, "iu").test(text);
}
function normalizeRiskUrl(value) {
  let raw = String(value || "").trim().replace(/[.,!?]+$/, "");
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try { const url = new URL(raw); if (!["http:", "https:"].includes(url.protocol)) return null; url.hash = ""; return url.toString().toLowerCase(); } catch { return null; }
}
function urlsIn(value) { return [...value.matchAll(/https?:\/\/[^\s<>()]+/gi)].map((m) => normalizeRiskUrl(m[0])).filter(Boolean); }
function urlsInMessage(message, normalizedText) {
  const found = new Set(urlsIn(normalizedText));
  const raw = String(message.text ?? message.caption ?? "");
  const entities = Array.isArray(message.entities) ? message.entities : (Array.isArray(message.caption_entities) ? message.caption_entities : []);
  for (const e of entities) {
    const candidate = e?.type === "text_link" ? e.url : e?.type === "url" && Number.isSafeInteger(e.offset) && Number.isSafeInteger(e.length) ? raw.slice(e.offset, e.offset + e.length) : null;
    const url = normalizeRiskUrl(candidate); if (url) found.add(url);
  }
  return [...found];
}

async function ensureAbuseState(db, botId, userId) {
  const timestamp = nowIso();
  const created = await dbOne(db, "INSERT INTO user_abuse_state (bot_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(bot_id, user_id) DO NOTHING RETURNING *", botId, userId, timestamp, timestamp);
  return created || dbOne(db, "SELECT * FROM user_abuse_state WHERE bot_id = ? AND user_id = ?", botId, userId);
}

async function recordAbuseEvent(db, botId, userId, eventKey, eventType, valueHash = null, riskDelta = 0) {
  return dbRun(db, "INSERT INTO abuse_events (bot_id, user_id, event_key, event_type, value_hash, risk_delta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(bot_id, event_key, event_type) DO NOTHING", botId, userId, eventKey, eventType, valueHash, riskDelta, nowIso());
}

async function recordMessageAbuseEvents(db, bot, userId, updateId, limits, signals, isNewUser) {
  const events = [[`update:${updateId}`, "inbound_message", null]];
  if (!limits.burst) events.push([`update:${updateId}:burst`, "burst_limit", null]);
  if (!limits.minute) events.push([`update:${updateId}:minute`, "minute_limit", null]);
  if (bot.antispamEnabled) {
    if (bot.riskEnabled) signals.hashes.forEach(([type, hash], index) => events.push([`update:${updateId}:${index}`, type, hash]));
    if (isNewUser) events.push([`new-user:${bot.id}:${userId}`, "new_user", null]);
  }
  await dbRun(db, `INSERT INTO abuse_events (bot_id, user_id, event_key, event_type, value_hash, risk_delta, created_at)
    SELECT ?, ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), 0, ?
    FROM json_each(?) WHERE 1 ON CONFLICT(bot_id, event_key, event_type) DO NOTHING`,
  bot.id, userId, nowIso(), JSON.stringify(events));
}

async function decayRisk(db, bot, userId, initialState) {
  const state = initialState || await ensureAbuseState(db, bot.id, userId);
  const lastRisk = Date.parse(state.last_risk_at || "");
  const elapsed = Number.isFinite(lastRisk) ? Math.max(0, Math.floor((Date.now() - lastRisk) / RISK_DECAY_MS)) : 0;
  if (!elapsed || Number(state.risk_score) === 0) return state;
  const advanced = new Date(lastRisk + elapsed * RISK_DECAY_MS).toISOString();
  const row = await dbOne(
    db,
    "UPDATE user_abuse_state SET risk_score = MAX(0, risk_score - ?), last_risk_at = ?, updated_at = ? WHERE bot_id = ? AND user_id = ? AND last_risk_at = ? RETURNING *",
    elapsed,
    advanced,
    nowIso(),
    bot.id,
    userId,
    state.last_risk_at,
  );
  return row || await ensureAbuseState(db, bot.id, userId);
}

async function applyRiskEvent(db, bot, userId, eventKey, eventType, delta, initialState = null) {
  if (!initialState) await ensureAbuseState(db, bot.id, userId);
  const timestamp = nowIso();
  await dbRun(
    db,
    "INSERT INTO abuse_events (bot_id, user_id, event_key, event_type, risk_delta, risk_applied, created_at) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT(bot_id, event_key, event_type) DO NOTHING",
    bot.id,
    userId,
    eventKey,
    eventType,
    delta,
    timestamp,
  );
  const statements = [
    db.prepare("UPDATE user_abuse_state SET risk_score = MAX(0, risk_score - CASE WHEN last_risk_at IS NULL THEN 0 ELSE MAX(0, CAST((unixepoch(?) - unixepoch(last_risk_at)) / 1800 AS INTEGER)) END + ?), last_risk_at = ?, updated_at = ? WHERE bot_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM abuse_events WHERE bot_id = ? AND event_key = ? AND event_type = ? AND risk_applied = 0)")
      .bind(timestamp, delta, timestamp, timestamp, bot.id, userId, bot.id, eventKey, eventType),
    db.prepare("UPDATE abuse_events SET risk_applied = 1 WHERE bot_id = ? AND event_key = ? AND event_type = ? AND risk_applied = 0")
      .bind(bot.id, eventKey, eventType),
  ];
  const [stateResult, eventResult] = await db.batch(statements);
  const state = await dbOne(db, "SELECT * FROM user_abuse_state WHERE bot_id = ? AND user_id = ?", bot.id, userId);
  if (stateResult.meta?.changes === 1 && eventResult.meta?.changes === 1) {
    log(bot, "info", "risk_changed", { user_id: userId, delta, score: Number(state.risk_score), reason: eventType });
  }
  return state;
}

function mediaRiskFingerprint(message) {
  const candidates = [
    ["photo", Array.isArray(message?.photo) ? message.photo.at(-1)?.file_unique_id : null],
    ["video", message?.video?.file_unique_id],
    ["document", message?.document?.file_unique_id],
    ["animation", message?.animation?.file_unique_id],
    ["audio", message?.audio?.file_unique_id],
    ["voice", message?.voice?.file_unique_id],
    ["video_note", message?.video_note?.file_unique_id],
    ["sticker", message?.sticker?.file_unique_id],
  ];
  const found = candidates.find(([, id]) => typeof id === "string" && id);
  return found ? `media:${found[0]}:${found[1]}` : "";
}

async function messageRiskSignals(db, bot, message, conversation) {
  const text = normalizeMessage(message);
  const contentFingerprint = text || mediaRiskFingerprint(message);
  if (!contentFingerprint) return { delta: 0, hashes: [] };
  const hashes = [];
  let delta = 0;
  const contentHash = await sha256(contentFingerprint);
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const urls = urlsInMessage(message, text);
  const urlHashes = await Promise.all(urls.map(sha256));
  const uniqueUrlHashes = [...new Set(urlHashes)];
  const history = await dbAll(db, `SELECT event_type, value_hash, COUNT(*) AS count FROM abuse_events
    WHERE bot_id = ? AND user_id = ? AND created_at >= ?
      AND ((event_type = 'message' AND value_hash = ?) OR (? = 1 AND event_type = 'url' AND value_hash IS NOT NULL))
    GROUP BY event_type, value_hash`, bot.id, message.from.id, since, contentHash, urls.length ? 1 : 0);
  const duplicates = (history.results || []).find((row) => row.event_type === "message");
  if (Number(duplicates?.count || 0) >= 2) delta += bot.riskWeights.duplicateMessage;
  hashes.push(["message", contentHash]);
  const previousUrls = new Map((history.results || []).filter((row) => row.event_type === "url").map((row) => [row.value_hash, Number(row.count)]));
  let hasRepeatedUrl = false;
  for (const urlHash of uniqueUrlHashes) {
    if ((previousUrls.get(urlHash) || 0) >= 2) hasRepeatedUrl = true;
    hashes.push(["url", urlHash]);
  }
  if (hasRepeatedUrl) delta += bot.riskWeights.repeatedUrl;
  const distinctUrls = new Set([...previousUrls.keys(), ...uniqueUrlHashes]);
  if (urls.length > 0 && distinctUrls.size >= 3) delta += bot.riskWeights.manyUrls;
  if ((text.match(/@[a-z0-9_]{3,}/gi) || []).length >= 3) delta += bot.riskWeights.mentions;
  if (bot.spamKeywords.some((keyword) => containsSpamKeyword(text, keyword))) delta += bot.riskWeights.spamKeyword;
  if (!conversation && urls.length) delta += bot.riskWeights.newUserUrl;
  return { delta, hashes };
}

async function serviceMetrics(db, botId) {
  const since = new Date(Date.now() - 60_000).toISOString();
  const rows = await dbAll(db, "SELECT event_type, COUNT(*) AS count FROM abuse_events WHERE bot_id = ? AND created_at >= ? GROUP BY event_type", botId, since);
  const counts = Object.fromEntries((rows.results || []).map((row) => [row.event_type, Number(row.count)]));
  return {
    inbound: counts.inbound_message || 0,
    newUsers: counts.new_user || 0,
    challenges: counts.verification_requested || 0,
    failures: counts.verification_failed || 0,
    rateLimited: (counts.burst_limit || 0) + (counts.minute_limit || 0) + (counts.absolute_limit || 0),
    riskEvents: counts.risk || 0,
    mutes: counts.temporary_mute || 0,
  };
}

async function notifyAttackTransition(bot, env, mode, metrics, enteredAt) {
  if (!env) return;
  const duration = enteredAt ? Math.max(0, Math.round((Date.now() - Date.parse(enteredAt)) / 60_000)) : 0;
  const text = mode === "attack"
    ? `🛡 ${bot.displayName} entered ATTACK MODE.\nNew users/min: ${metrics.newUsers}\nMessages/min: ${metrics.inbound}\nNew untrusted users now require verification.`
    : `✅ ${bot.displayName} returned to NORMAL mode.\nAttack duration: ${duration} min\nChallenges/min: ${metrics.challenges}\nTemporary mutes/min: ${metrics.mutes}`;
  try {
    const result = await telegram(bot, "sendMessage", { chat_id: supportGroupId(env), text }, env);
    if (!result.ok) log(bot, "warn", "attack_notification_failed", { mode, description: result.description });
  } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error;
    log(bot, "warn", "attack_notification_failed", { mode, message: error.message });
  }
}

async function attackState(db, bot, env) {
  const timestamp = nowIso();
  await dbRun(db, "INSERT INTO service_attack_state (bot_id, updated_at) VALUES (?, ?) ON CONFLICT(bot_id) DO NOTHING", bot.id, timestamp);
  const state = await dbOne(db, "SELECT * FROM service_attack_state WHERE bot_id = ?", bot.id);
  if(state?.override_until && state.override_until<=timestamp) {
    const fresh=await dbOne(db,"UPDATE service_attack_state SET manual_override=NULL,override_until=NULL,mode='normal',entered_at=NULL WHERE bot_id=? AND override_until<=? RETURNING *",bot.id,timestamp);
    Object.assign(state,fresh||await dbOne(db,'SELECT * FROM service_attack_state WHERE bot_id=?',bot.id));
  }
  const manualOverride = state?.manual_override || (state?.manual_controlled?null:bot.attackModeManualOverride);
  const metrics = await serviceMetrics(db, bot.id);
  if (!bot.attackModeEnabled || manualOverride === "off" || manualOverride === "on") {
    const targetMode = bot.attackModeEnabled && manualOverride === "on" ? "attack" : "normal";
    if (state?.mode !== targetMode) {
      const enteredAt = targetMode === "attack" ? timestamp : state?.entered_at;
      const transitioned = await dbRun(db, "UPDATE service_attack_state SET mode = ?, entered_at = ?, updated_at = ? WHERE bot_id = ? AND mode != ?", targetMode, targetMode === "attack" ? timestamp : null, timestamp, bot.id, targetMode);
      if (transitioned.meta?.changes === 1) {
        await recordAbuseEvent(db, bot.id, 0, `attack-${targetMode}:${timestamp}`, targetMode === "attack" ? "attack_mode_enter" : "attack_mode_exit");
        await notifyAttackTransition(bot, env, targetMode, metrics, enteredAt);
      }
    }
    return { ...state, mode: targetMode, manual_override: manualOverride, entered_at: targetMode === "attack" ? state?.entered_at || timestamp : null };
  }
  const anomalous = metrics.newUsers >= DEFAULT_ATTACK_EVENT_THRESHOLD || metrics.riskEvents >= DEFAULT_ATTACK_EVENT_THRESHOLD * 2 || metrics.inbound >= DEFAULT_ABSOLUTE_LIMIT;
  if (anomalous) {
    const entered = await dbRun(db, "UPDATE service_attack_state SET mode = 'attack', anomaly_seen_at = ?, entered_at = COALESCE(entered_at, ?), updated_at = ? WHERE bot_id = ? AND mode = 'normal' AND manual_override IS NULL", timestamp, timestamp, timestamp, bot.id);
    if (entered.meta?.changes === 1) {
      await recordAbuseEvent(db, bot.id, 0, `attack-enter:${timestamp}`, "attack_mode_enter");
      await notifyAttackTransition(bot, env, "attack", metrics, timestamp);
      return { ...state, mode: "attack", anomaly_seen_at: timestamp, entered_at: state?.entered_at || timestamp };
    }
    const current = await dbOne(db, "SELECT * FROM service_attack_state WHERE bot_id = ?", bot.id);
    if (current?.mode === "attack" && current.manual_override === null) {
      await dbRun(db, "UPDATE service_attack_state SET anomaly_seen_at = ?, updated_at = ? WHERE bot_id = ? AND mode = 'attack' AND manual_override IS NULL", timestamp, timestamp, bot.id);
      return { ...current, anomaly_seen_at: timestamp };
    }
    return current || state || { mode: "normal" };
  }
  if (state?.mode === "attack" && state.anomaly_seen_at && Date.now() - Date.parse(state.anomaly_seen_at) >= ATTACK_EXIT_MS) {
    const exited = await dbRun(db, "UPDATE service_attack_state SET mode = 'normal', entered_at = NULL, updated_at = ? WHERE bot_id = ? AND mode = 'attack' AND manual_override IS NULL", timestamp, bot.id);
    if (exited.meta?.changes === 1) {
      await recordAbuseEvent(db, bot.id, 0, `attack-exit:${timestamp}`, "attack_mode_exit");
      await notifyAttackTransition(bot, env, "normal", metrics, state.entered_at);
      return { ...state, mode: "normal", entered_at: null };
    }
    return await dbOne(db, "SELECT * FROM service_attack_state WHERE bot_id = ?", bot.id);
  }
  return state || { mode: "normal" };
}

function challengeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function getOrCreateChallenge(db, bot, userId, rotateUnsent = false) {
  const active = await dbOne(db, "SELECT * FROM verification_challenges WHERE bot_id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?", bot.id, userId, nowIso());
  if (active) {
    await dbRun(db, "UPDATE pending_messages SET challenge_id = ? WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL AND failed_at IS NULL AND (challenge_id IS NULL OR challenge_id <> ?)", active.id, bot.id, userId, active.id);
    if (active.notice_sent_at && !rotateUnsent) return { challenge: active, token: null };
    const token = await deterministicChallengeToken(bot, active);
    const tokenHash = await sha256(token);
    if (active.token_hash !== tokenHash && !active.notice_sent_at) {
      const normalized = await dbOne(db, "UPDATE verification_challenges SET token_hash = ? WHERE id = ? AND status = 'pending' AND notice_sent_at IS NULL RETURNING *", tokenHash, active.id);
      if (normalized) return { challenge: normalized, token };
    }
    return { challenge: active, token: active.notice_sent_at ? null : token };
  }
  await dbRun(db, "UPDATE verification_challenges SET status = 'expired' WHERE bot_id = ? AND user_id = ? AND status = 'pending' AND expires_at <= ?", bot.id, userId, nowIso());
  let created;
  try {
    const createdAt = nowIso();
    const placeholder = `pending:${crypto.randomUUID()}`;
    created = await dbOne(db, "INSERT INTO verification_challenges (bot_id, user_id, token_hash, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?) RETURNING *", bot.id, userId, placeholder, createdAt, isoAfter(CHALLENGE_TTL_MS));
  } catch (error) {
    const raced = await dbOne(db, "SELECT * FROM verification_challenges WHERE bot_id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?", bot.id, userId, nowIso());
    if (raced) {
      await dbRun(db, "UPDATE pending_messages SET challenge_id = ? WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL AND failed_at IS NULL AND (challenge_id IS NULL OR challenge_id <> ?)", raced.id, bot.id, userId, raced.id);
      const racedToken = raced.notice_sent_at ? null : await deterministicChallengeToken(bot, raced);
      if (racedToken && raced.token_hash !== await sha256(racedToken)) {
        const normalized = await dbOne(db, "UPDATE verification_challenges SET token_hash = ? WHERE id = ? AND status = 'pending' AND notice_sent_at IS NULL RETURNING *", await sha256(racedToken), raced.id);
        return { challenge: normalized || raced, token: racedToken };
      }
      return { challenge: raced, token: racedToken };
    }
    throw error;
  }
  const token = await deterministicChallengeToken(bot, created);
  created = await dbOne(db, "UPDATE verification_challenges SET token_hash = ? WHERE id = ? AND status = 'pending' RETURNING *", await sha256(token), created.id);
  if (!created) throw new Error("Verification challenge token could not be finalized");
  await dbRun(db, "UPDATE pending_messages SET challenge_id = ? WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL AND failed_at IS NULL AND (challenge_id IS NULL OR challenge_id <> ?)", created.id, bot.id, userId, created.id);
  await recordAbuseEvent(db, bot.id, userId, `challenge:${created.id}`, "verification_requested");
  return { challenge: created, token };
}

async function claimAbuseDecisionLock(db, botId, userId) {
  const ownerToken = crypto.randomUUID();
  let leaseExpiresAt = isoAfter(ABUSE_DECISION_LEASE_MS);
  let claimed = await dbRun(
    db,
    "INSERT INTO abuse_decision_locks (bot_id, user_id, owner_token, lease_expires_at, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(bot_id, user_id) DO NOTHING",
    botId,
    userId,
    ownerToken,
    leaseExpiresAt,
    nowIso(),
  );
  if (claimed.meta?.changes === 1) return ownerToken;
  {
    const current = await dbOne(db, "SELECT owner_token, lease_expires_at FROM abuse_decision_locks WHERE bot_id = ? AND user_id = ?", botId, userId);
    if (!current) {
      leaseExpiresAt = isoAfter(ABUSE_DECISION_LEASE_MS);
      claimed = await dbRun(db, "INSERT INTO abuse_decision_locks (bot_id, user_id, owner_token, lease_expires_at, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(bot_id, user_id) DO NOTHING", botId, userId, ownerToken, leaseExpiresAt, nowIso());
      if (claimed.meta?.changes === 1) return ownerToken;
    } else if (current.lease_expires_at && Date.parse(current.lease_expires_at) <= Date.now()) {
      leaseExpiresAt = isoAfter(ABUSE_DECISION_LEASE_MS);
      claimed = await dbRun(
        db,
        "UPDATE abuse_decision_locks SET owner_token = ?, lease_expires_at = ?, created_at = ? WHERE bot_id = ? AND user_id = ? AND owner_token = ? AND lease_expires_at <= ?",
        ownerToken,
        leaseExpiresAt,
        nowIso(),
        botId,
        userId,
        current.owner_token,
        nowIso(),
      );
      if (claimed.meta?.changes === 1) return ownerToken;
    }
  }
  throw new Error("User abuse decision is already in progress; retry this update");
}

async function releaseAbuseDecisionLock(db, botId, userId, ownerToken) {
  await dbRun(db, "DELETE FROM abuse_decision_locks WHERE bot_id = ? AND user_id = ? AND owner_token = ?", botId, userId, ownerToken);
}

function logicalMessageKey(message, updateId) {
  return message.media_group_id ? `album:${message.media_group_id}` : `update:${updateId}`;
}

async function claimLogicalMessage(db, bot, message, updateId) {
  const logicalKey = logicalMessageKey(message, updateId);
  const ownerToken = crypto.randomUUID();
  const leaseExpiresAt = isoAfter(2 * 60_000);
  let marker = await dbRun(
    db,
    "INSERT INTO logical_message_guards (bot_id, user_id, logical_key, state, owner_token, lease_expires_at, created_at) VALUES (?, ?, ?, 'claimed', ?, ?, ?) ON CONFLICT DO NOTHING",
    bot.id,
    message.from.id,
    logicalKey,
    ownerToken,
    leaseExpiresAt,
    nowIso(),
  );
  if (marker.meta?.changes === 1) return { evaluate: true, logicalKey, ownerToken };
  {
    const current = await dbOne(db, "SELECT state, owner_token, lease_expires_at, burst_allowed, minute_allowed, risk_delta FROM logical_message_guards WHERE bot_id = ? AND user_id = ? AND logical_key = ?", bot.id, message.from.id, logicalKey);
    if (current?.state === "decided") {
      return {
        evaluate: false,
        logicalKey,
        ownerToken: null,
        limits: { burst: Number(current.burst_allowed) === 1, minute: Number(current.minute_allowed) === 1 },
      };
    }
    if (current?.state === "limited" && !current.owner_token) {
      marker = await dbRun(
        db,
        "UPDATE logical_message_guards SET owner_token = ?, lease_expires_at = ?, created_at = ? WHERE bot_id = ? AND user_id = ? AND logical_key = ? AND state = 'limited' AND owner_token IS NULL",
        ownerToken,
        leaseExpiresAt,
        nowIso(),
        bot.id,
        message.from.id,
        logicalKey,
      );
      if (marker.meta?.changes === 1) {
        return {
          evaluate: true,
          edgeEvaluated: true,
          logicalKey,
          ownerToken,
          limits: { burst: Number(current.burst_allowed) === 1, minute: Number(current.minute_allowed) === 1 },
          riskDelta: current.risk_delta,
        };
      }
    }
    if (current?.lease_expires_at && Date.parse(current.lease_expires_at) <= Date.now()) {
      const sql = current.state === "limited"
        ? "UPDATE logical_message_guards SET owner_token = ?, lease_expires_at = ?, created_at = ? WHERE bot_id = ? AND user_id = ? AND logical_key = ? AND state = 'limited' AND owner_token = ? AND lease_expires_at <= ?"
        : "UPDATE logical_message_guards SET owner_token = ?, lease_expires_at = ?, burst_allowed = NULL, minute_allowed = NULL, risk_delta = NULL, created_at = ? WHERE bot_id = ? AND user_id = ? AND logical_key = ? AND state = 'claimed' AND owner_token = ? AND lease_expires_at <= ?";
      marker = await dbRun(db, sql, ownerToken, leaseExpiresAt, nowIso(), bot.id, message.from.id, logicalKey, current.owner_token, nowIso());
      if (marker.meta?.changes === 1) {
        if (current.state !== "limited") return { evaluate: true, logicalKey, ownerToken };
        return {
          evaluate: true,
          edgeEvaluated: true,
          logicalKey,
          ownerToken,
          limits: { burst: Number(current.burst_allowed) === 1, minute: Number(current.minute_allowed) === 1 },
          riskDelta: current.risk_delta,
        };
      }
    }
  }
  throw new Error("Logical anti-abuse decision is already in progress; retry this update");
}

async function persistLogicalEdgeOutcome(db, bot, userId, claim, limits) {
  if (!claim.evaluate) return;
  const persisted = await dbRun(
    db,
    "UPDATE logical_message_guards SET state = 'limited', burst_allowed = ?, minute_allowed = ? WHERE bot_id = ? AND user_id = ? AND logical_key = ? AND state = 'claimed' AND owner_token = ?",
    limits.burst ? 1 : 0,
    limits.minute ? 1 : 0,
    bot.id,
    userId,
    claim.logicalKey,
    claim.ownerToken,
  );
  if (persisted.meta?.changes !== 1) throw new Error("Logical rate-limit outcome lease was lost");
  claim.edgeEvaluated = true;
  claim.limits = limits;
}

async function persistLogicalRiskDelta(db, bot, userId, claim, delta) {
  if (!claim.evaluate) return delta;
  if (claim.riskDelta !== null && claim.riskDelta !== undefined) return Number(claim.riskDelta);
  const persisted = await dbOne(
    db,
    "UPDATE logical_message_guards SET risk_delta = ? WHERE bot_id = ? AND user_id = ? AND logical_key = ? AND state = 'limited' AND owner_token = ? AND risk_delta IS NULL RETURNING risk_delta",
    delta,
    bot.id,
    userId,
    claim.logicalKey,
    claim.ownerToken,
  );
  if (!persisted) throw new Error("Logical risk outcome lease was lost");
  claim.riskDelta = Number(persisted.risk_delta);
  return claim.riskDelta;
}

async function completeLogicalMessage(db, bot, userId, claim) {
  if (!claim.evaluate) return;
  const completed = await dbRun(
    db,
    "UPDATE logical_message_guards SET state = 'decided', owner_token = NULL, lease_expires_at = NULL WHERE bot_id = ? AND user_id = ? AND logical_key = ? AND state = 'limited' AND owner_token = ? AND risk_delta IS NOT NULL",
    bot.id,
    userId,
    claim.logicalKey,
    claim.ownerToken,
  );
  if (completed.meta?.changes !== 1) throw new Error("Logical anti-abuse decision lease was lost");
}

async function releaseLogicalMessage(db, bot, userId, claim) {
  if (!claim?.evaluate) return;
  await dbRun(db, "UPDATE logical_message_guards SET owner_token = NULL, lease_expires_at = NULL WHERE bot_id = ? AND user_id = ? AND logical_key = ? AND state = 'limited' AND owner_token = ?", bot.id, userId, claim.logicalKey, claim.ownerToken);
  await dbRun(db, "DELETE FROM logical_message_guards WHERE bot_id = ? AND user_id = ? AND logical_key = ? AND state = 'claimed' AND owner_token = ?", bot.id, userId, claim.logicalKey, claim.ownerToken);
}

async function queuePendingMessage(db, bot, message, updateId, challengeId) {
  const existing = await dbOne(db, "SELECT id FROM pending_messages WHERE bot_id = ? AND update_id = ?", bot.id, updateId);
  if (existing) return { queued: true, duplicate: true };
  const media = message.media_group_id ? extractAlbumMedia(message) : null;
  const inserted = await dbOne(
    db,
    `INSERT INTO pending_messages (bot_id, user_id, challenge_id, update_id, source_chat_id, source_message_id, media_group_id, media_type, file_id, caption, caption_entities_json, has_spoiler, source_username, source_first_name, source_last_name, created_at, source_created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (? IS NULL OR EXISTS (SELECT 1 FROM verification_challenges WHERE id = ? AND bot_id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?))
       AND (
         (? IS NOT NULL AND EXISTS (SELECT 1 FROM pending_messages WHERE bot_id = ? AND user_id = ? AND media_group_id = ? AND delivered_at IS NULL AND failed_at IS NULL))
         OR (SELECT COUNT(DISTINCT COALESCE(media_group_id, 'update:' || update_id)) FROM pending_messages WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL AND failed_at IS NULL) < ?
       )
     ON CONFLICT(bot_id, update_id) DO NOTHING
     RETURNING id`,
    bot.id,
    message.from.id,
    challengeId,
    updateId,
    message.chat.id,
    message.message_id,
    message.media_group_id || null,
    media?.type || null,
    media?.media || null,
    media?.caption ? media.caption.slice(0, 1024) : null,
    media?.captionEntities?.length ? JSON.stringify(media.captionEntities) : null,
    media?.hasSpoiler ? 1 : 0,
    message.from.username || null,
    message.from.first_name || null,
    message.from.last_name || null,
    nowIso(),
    sourceCreatedAt(message),
    challengeId,
    challengeId,
    bot.id,
    message.from.id,
    nowIso(),
    message.media_group_id || null,
    bot.id,
    message.from.id,
    message.media_group_id || null,
    bot.id,
    message.from.id,
    bot.pendingMessageLimit,
  );
  if (inserted) return { queued: true };
  const raced = await dbOne(db, "SELECT id FROM pending_messages WHERE bot_id = ? AND update_id = ?", bot.id, updateId);
  if (raced) return { queued: true, duplicate: true };
  if (challengeId !== null) {
    const active = await dbOne(db, "SELECT 1 FROM verification_challenges WHERE id = ? AND status = 'pending' AND expires_at > ?", challengeId, nowIso());
    if (!active) throw new Error("Verification challenge changed while queueing; retry this update");
  }
  return { queued: false, full: true };
}

async function maybeNotify(bot, env, userId, text, state) {
  if (state?.last_warning_at && Date.now() - Date.parse(state.last_warning_at) < bot.warningCooldownSeconds * 1000) return;
  const sent = await telegram(bot, "sendMessage", { chat_id: userId, text }, env);
  if (!sent.ok && isRetryableTelegramFailure(sent)) throw new Error(`anti-abuse notice failed: ${sent.description}`);
  await dbRun(requireDb(env), "UPDATE user_abuse_state SET last_warning_at = ?, updated_at = ? WHERE bot_id = ? AND user_id = ?", nowIso(), nowIso(), bot.id, userId);
}

async function sendVerificationNotice(bot, env, userId, challengeResult) {
  if (!challengeResult.token) return;
  const url = `${publicBaseOrigin(env.PUBLIC_BASE_URL)}/verify/${challengeResult.token}`;
  const result = await telegram(bot, "sendMessage", {
    chat_id: userId,
    text: t(bot, "verify"),
    reply_markup: { inline_keyboard: [[{ text: ({ru:"Проверить",en:"Verify",es:"Verificar",zh:"验证"})[bot.locale] || "Verify", url }]] },
  }, env);
  if (!result.ok && isRetryableTelegramFailure(result)) throw new Error(`verification notice failed: ${result.description}`);
  const noticeMessageId = result.ok && Number.isSafeInteger(result.result?.message_id) ? result.result.message_id : null;
  await dbRun(requireDb(env), "UPDATE verification_challenges SET notice_sent_at = COALESCE(notice_sent_at, ?), notice_message_id = COALESCE(notice_message_id, ?) WHERE id = ? AND token_hash = ?", nowIso(), noticeMessageId, challengeResult.challenge.id, await sha256(challengeResult.token));
  await dbRun(requireDb(env), "UPDATE user_abuse_state SET last_warning_at = ?, updated_at = ? WHERE bot_id = ? AND user_id = ?", nowIso(), nowIso(), bot.id, userId);
}

async function applyTemporaryMute(db, bot, userId, state, eventKey, reason, force = false) {
  if (!force && Number(state.risk_score) < bot.riskMuteThreshold) return state;
  if (isFuture(state.muted_until)) {
    const timestamp = nowIso();
    await db.batch([
      db.prepare("UPDATE user_abuse_state SET verification_required = 0, pending_release_required = CASE WHEN EXISTS (SELECT 1 FROM pending_messages WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL AND failed_at IS NULL) THEN 1 ELSE pending_release_required END, updated_at = ? WHERE bot_id = ? AND user_id = ?").bind(bot.id, userId, timestamp, bot.id, userId),
      db.prepare("UPDATE verification_challenges SET status = 'expired', failed_at = COALESCE(failed_at, ?) WHERE bot_id = ? AND user_id = ? AND (status = 'pending' OR (status = 'passed' AND flushed_at IS NULL))").bind(timestamp, bot.id, userId),
      db.prepare("DELETE FROM pending_flush_locks WHERE bot_id = ? AND user_id = ?").bind(bot.id, userId),
    ]);
    return await ensureAbuseState(db, bot.id, userId);
  }
  const nextLevel = Number(state.mute_level || 0) + 1;
  const duration = nextLevel === 1 ? 15 * 60_000 : 60 * 60_000;
  const timestamp = nowIso();
  const [mutedResult] = await db.batch([
    db.prepare("UPDATE user_abuse_state SET muted_until = ?, mute_level = mute_level + 1, verification_required = 0, pending_release_required = CASE WHEN EXISTS (SELECT 1 FROM pending_messages WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL AND failed_at IS NULL) THEN 1 ELSE pending_release_required END, updated_at = ? WHERE bot_id = ? AND user_id = ? AND (muted_until IS NULL OR muted_until <= ?)")
      .bind(isoAfter(duration), bot.id, userId, timestamp, bot.id, userId, timestamp),
    db.prepare("UPDATE verification_challenges SET status = 'expired', failed_at = COALESCE(failed_at, ?) WHERE bot_id = ? AND user_id = ? AND (status = 'pending' OR (status = 'passed' AND flushed_at IS NULL))")
      .bind(timestamp, bot.id, userId),
    db.prepare("DELETE FROM pending_flush_locks WHERE bot_id = ? AND user_id = ?").bind(bot.id, userId),
  ]);
  const muted = await ensureAbuseState(db, bot.id, userId);
  if (mutedResult.meta?.changes > 0) {
    await recordAbuseEvent(db, bot.id, userId, eventKey, "temporary_mute", null, 0);
    log(bot, "warn", "temporary_mute", { user_id: userId, mute_level: Number(muted.mute_level), reason, muted_until: muted.muted_until });
  }
  return muted;
}

async function renewPendingFlushLease(db, botId, userId, ownerToken) {
  const renewed = await dbRun(db, "UPDATE pending_flush_locks SET lease_expires_at = ? WHERE bot_id = ? AND user_id = ? AND owner_token = ?", isoAfter(PENDING_FLUSH_LEASE_MS), botId, userId, ownerToken);
  if (renewed.meta?.changes !== 1) throw new Error("Pending flush lease was lost");
}

async function authorizePendingFlush(db, bot, userId, ownerToken, challengeId) {
  const timestamp = nowIso();
  const authorized = await dbOne(
    db,
    `SELECT 1
       FROM pending_flush_locks AS lock
       JOIN user_abuse_state AS state ON state.bot_id = lock.bot_id AND state.user_id = lock.user_id
      WHERE lock.bot_id = ? AND lock.user_id = ? AND lock.owner_token = ? AND lock.lease_expires_at > ?
        AND (state.muted_until IS NULL OR state.muted_until <= ?)
        AND (state.manual_restricted_until IS NULL OR state.manual_restricted_until <= ?)
        AND state.verification_required = 0
        AND NOT EXISTS (SELECT 1 FROM banned_users WHERE bot_id = lock.bot_id AND user_id = lock.user_id)
        AND NOT EXISTS (SELECT 1 FROM bots WHERE id = lock.bot_id AND enabled = 0)
        AND (
          (? IS NULL AND state.pending_release_required = 1)
          OR (? IS NOT NULL
              AND EXISTS (SELECT 1 FROM verification_challenges WHERE id = ? AND bot_id = lock.bot_id AND user_id = lock.user_id AND status = 'passed')
              AND NOT EXISTS (SELECT 1 FROM verification_challenges WHERE bot_id = lock.bot_id AND user_id = lock.user_id AND status = 'pending' AND expires_at > ? AND id <> ?))
        )`,
    bot.id,
    userId,
    ownerToken,
    timestamp,
    timestamp,
    timestamp,
    challengeId,
    challengeId,
    challengeId,
    timestamp,
    challengeId,
  );
  if (!authorized) throw new Error("Pending flush authorization was revoked");
}

async function fencePendingFlush(db, bot, userId, ownerToken, challengeId) {
  await renewPendingFlushLease(db, bot.id, userId, ownerToken);
  await authorizePendingFlush(db, bot, userId, ownerToken, challengeId);
}

async function beginPendingDeliveryAttempt(db, bot, items, ownerToken, challengeId) {
  if (!items.length || items.some((item) => item.bot_id !== bot.id || Number(item.user_id) !== Number(items[0].user_id))) throw new Error("Pending batch crosses user boundary");
  await fencePendingFlush(db, bot, items[0].user_id, ownerToken, challengeId);
  const startedAt = nowIso();
  const result = await dbRun(db,
    "UPDATE pending_messages SET delivery_started_at = ?, request_started_at = NULL WHERE id IN (SELECT value FROM json_each(?)) AND delivered_at IS NULL AND failed_at IS NULL AND delivery_started_at IS NULL",
    startedAt, JSON.stringify(items.map((item) => item.id)));
  if (result.meta?.changes !== items.length) throw new Error("Pending delivery fence could not be acquired");
  return startedAt;
}

async function markPendingRequestStarted(db, bot, items, startedAt) {
  assertTelegramReady(db, bot);
  const gate = telegramRequestGate(db, bot);
  recoveryCheckpoint(db, 4);
  const requestStartedAt = nowIso();
  const result = await dbRun(db,
    "UPDATE pending_messages SET request_started_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND delivery_started_at = ? AND request_started_at IS NULL AND delivery_completed_at IS NULL AND delivered_at IS NULL AND failed_at IS NULL" + gate.sql,
    requestStartedAt, JSON.stringify(items.map((item) => item.id)), startedAt, ...gate.params);
  if (result.meta?.changes !== items.length) throw new Error("Pending request-start marker could not be saved");
  return requestStartedAt;
}

async function clearPendingDeliveryAttempt(db, items, startedAt) {
  const result = await dbRun(db,
    "UPDATE pending_messages SET delivery_started_at = NULL, request_started_at = NULL, delivery_completed_at = NULL WHERE id IN (SELECT value FROM json_each(?)) AND delivery_started_at = ? AND delivery_completed_at IS NULL AND delivered_at IS NULL AND failed_at IS NULL",
    JSON.stringify(items.map((item) => item.id)), startedAt);
  if (result.meta?.changes !== items.length) throw new Error("Pending delivery fence could not be released");
}

async function completePendingDeliveryAttempt(db, items, startedAt, targets = [], targetThreadId = null) {
  const completedAt = nowIso();
  const result = await dbAll(db, `UPDATE pending_messages SET delivery_completed_at = ?,
    target_message_id = (SELECT json_extract(value, '$.target') FROM json_each(?) WHERE json_extract(value, '$.id') = pending_messages.id),
    target_thread_id = ? WHERE id IN (SELECT value FROM json_each(?)) AND delivery_started_at = ? AND delivery_completed_at IS NULL AND delivered_at IS NULL AND failed_at IS NULL RETURNING id`,
    completedAt, JSON.stringify(items.map((item, index) => ({ id: item.id, target: Number(targets[index]?.message_id) || null }))),
    Number.isSafeInteger(Number(targetThreadId)) ? Number(targetThreadId) : null, JSON.stringify(items.map((item) => item.id)), startedAt);
  // Count the fenced rows themselves; auto-reply triggers add D1 meta changes.
  if (result.results?.length !== items.length) throw new Error("Pending delivery completion fence could not be persisted");
  return completedAt;
}

async function withPendingDecisionLock(db, bot, userId, decisionLocked, callback) {
  if (decisionLocked) return callback();
  const owner = await claimAbuseDecisionLock(db, bot.id, userId);
  try { return await callback(); }
  finally { await releaseAbuseDecisionLock(db, bot.id, userId, owner); }
}

async function deliverPendingItem(bot, env, item, conversation, flushOwner, challengeId, allowRoutingRepair = true, decisionLocked = false) {
  const db = requireDb(env);
  await fencePendingFlush(db, bot, item.user_id, flushOwner, challengeId);
  const probe = await probeForumThread(bot, env, conversation.thread_id, 9 + (decisionLocked ? 0 : 1));
  if (!probe.ok && (isDeliveryOutcomeUncertain(probe) || isRetryableTelegramFailure(probe))) {
    throw new Error(`Topic probe failed before pending delivery: ${probe.description}`);
  }
  let result = probe;
  let attemptedCopy = false;
  let deliveryStartedAt = null;
  if (probe.ok) {
    const delivery = await withPendingDecisionLock(db, bot, item.user_id, decisionLocked, async () => {
      await fencePendingFlush(db, bot, item.user_id, flushOwner, challengeId);
      const startedAt = await beginPendingDeliveryAttempt(db, bot, [item], flushOwner, challengeId);
      await markPendingRequestStarted(db, bot, [item], startedAt);
      const sent = await telegram(bot, "copyMessage", { chat_id: supportGroupId(env), from_chat_id: item.source_chat_id, message_id: item.source_message_id, message_thread_id: conversation.thread_id }, env);
      return { startedAt, sent };
    });
    deliveryStartedAt = delivery.startedAt;
    attemptedCopy = true;
    result = delivery.sent;
  }
  if (!result.ok && deliveryStartedAt && isDeliveryOutcomeUncertain(result)) {
    log(bot, "error", "pending_delivery_outcome_uncertain", { user_id: item.user_id, source_message_id: item.source_message_id, description: result.description });
    return { ok: false, terminal: true, failureCode: "telegram_delivery_outcome_unknown", conversation };
  }
  if (!result.ok && deliveryStartedAt) await clearPendingDeliveryAttempt(db, [item], deliveryStartedAt);
  if (!result.ok && allowRoutingRepair && isTopicClosedError(result.description)) {
    await fencePendingFlush(db, bot, item.user_id, flushOwner, challengeId);
    await dbRun(db, "UPDATE conversations SET status = 'closed' WHERE id = ?", conversation.id);
    const current = await findConversation(db, bot.id, item.user_id);
    if (!current) throw new Error("Conversation disappeared before pending Topic routing could be repaired");
    const repaired = await reopenConversationForUserMessage(bot, env, current, {
      id: item.user_id,
      username: item.source_username || null,
      first_name: item.source_first_name || "User",
      last_name: item.source_last_name || null,
    });
    return deliverPendingItem(bot, env, item, repaired, flushOwner, challengeId, false, decisionLocked);
  }
  if (!result.ok && allowRoutingRepair && (isMissingTopicError(result.description) || String(result.description || "").includes("redirected"))) {
    await fencePendingFlush(db, bot, item.user_id, flushOwner, challengeId);
    await invalidateConversationTopic(db, bot.id, item.user_id, conversation.thread_id);
    const recreated = await provisionConversation(bot, env, {
      id: item.user_id,
      username: item.source_username || null,
      first_name: item.source_first_name || "User",
      last_name: item.source_last_name || null,
    });
    return deliverPendingItem(bot, env, item, recreated, flushOwner, challengeId, false, decisionLocked);
  }
  if (!result.ok) {
    if (reopenRoutingError(result.description)) throw new Error(`Pending Topic routing repair deferred: ${result.description}`);
    if (isRetryableTelegramFailure(result)) throw new Error(`pending delivery failed: ${result.description}`);
    if (attemptedCopy && Number(result.errorCode || result.httpStatus) === 400) {
      log(bot, "warn", "pending_delivery_permanent_failure", { user_id: item.user_id, source_message_id: item.source_message_id, description: result.description });
      return { ok: false, terminal: true, failureCode: "telegram_source_unavailable", conversation };
    }
    throw new Error(`pending delivery unavailable: ${result.description}`);
  }
  await completePendingDeliveryAttempt(db, [item], deliveryStartedAt, [result.result], conversation.thread_id);
  await fencePendingFlush(db, bot, item.user_id, flushOwner, challengeId);
  const mappingSaved = await recordMapping(bot, db, {
    botId: bot.id,
    userId: item.user_id,
    threadId: conversation.thread_id,
    groupId: conversation.support_group_id,
    userMessageId: item.source_message_id,
    supportMessageId: result.result?.message_id,
  });
  if (mappingSaved) await dbRun(db, "UPDATE pending_messages SET mapping_synced_at = COALESCE(mapping_synced_at, ?) WHERE id = ?", nowIso(), item.id);
  await finalizeConversationReopenAfterDelivery(db, bot.id, item.user_id, [Number(item.source_message_id)]);
  await stageConfirmedInboundNotice(bot, env, item.user_id, conversation.support_group_id, conversation.thread_id);
  return { ok: true, conversation };
}

async function deliverPendingAlbum(bot, env, items, conversation, owner, challengeId, decisionLocked = false, allowRoutingRepair = true) {
  const db = requireDb(env);
  const ordered = [...items].sort((a, b) => Number(a.source_message_id) - Number(b.source_message_id));
  if (!ordered.every((item) => item.media_type && item.file_id)) {
    return { ok: false, result: { ok: false, description: "Pending album lacks reusable media metadata" }, conversation };
  }
  await fencePendingFlush(db, bot, ordered[0].user_id, owner, challengeId);
  const probe = await probeForumThread(bot, env, conversation.thread_id, 9 + (decisionLocked ? 0 : 1));
  if (!probe.ok && (isDeliveryOutcomeUncertain(probe) || isRetryableTelegramFailure(probe))) {
    throw new Error(`Topic probe failed before pending album delivery: ${probe.description}`);
  }
  if (!probe.ok && allowRoutingRepair && isTopicClosedError(probe.description)) {
    await dbRun(db, "UPDATE conversations SET status = 'closed' WHERE id = ?", conversation.id);
    const current = await findConversation(db, bot.id, ordered[0].user_id);
    if (!current) throw new Error("Conversation disappeared before pending album routing could be repaired");
    const repaired = await reopenConversationForUserMessage(bot, env, current, {
      id: ordered[0].user_id,
      username: ordered[0].source_username || null,
      first_name: ordered[0].source_first_name || "User",
      last_name: ordered[0].source_last_name || null,
    });
    return deliverPendingAlbum(bot, env, ordered, repaired, owner, challengeId, decisionLocked, false);
  }
  if (!probe.ok && allowRoutingRepair && (isMissingTopicError(probe.description) || String(probe.description || "").includes("redirected"))) {
    await invalidateConversationTopic(db, bot.id, ordered[0].user_id, conversation.thread_id);
    const recreated = await provisionConversation(bot, env, {
      id: ordered[0].user_id,
      username: ordered[0].source_username || null,
      first_name: ordered[0].source_first_name || "User",
      last_name: ordered[0].source_last_name || null,
    });
    return deliverPendingAlbum(bot, env, ordered, recreated, owner, challengeId, decisionLocked, false);
  }
  if (!probe.ok) return { ok: false, result: probe, conversation };
  const delivery = await withPendingDecisionLock(db, bot, ordered[0].user_id, decisionLocked, async () => {
    await fencePendingFlush(db, bot, ordered[0].user_id, owner, challengeId);
    const startedAt = await beginPendingDeliveryAttempt(db, bot, ordered, owner, challengeId);
    await markPendingRequestStarted(db, bot, ordered, startedAt);
    const sent = await telegram(bot, "sendMediaGroup", {
      chat_id: supportGroupId(env),
      message_thread_id: conversation.thread_id,
      media: ordered.map(storedAlbumInputMedia),
    }, env);
    return { startedAt, sent };
  });
  const deliveryStartedAt = delivery.startedAt;
  let result = delivery.sent;
  if (result.ok) {
    const delivered = Array.isArray(result.result) ? result.result : [];
    const redirected = delivered.length !== ordered.length
      || delivered.some((item) => Number(item.message_thread_id) !== Number(conversation.thread_id));
    if (redirected) {
      let cleanupFailed = false;
      for (const deliveredItem of delivered) {
        if (!deliveredItem?.message_id) continue;
        const removed = await telegram(bot, "deleteMessage", { chat_id: supportGroupId(env), message_id: deliveredItem.message_id }, env);
        if (!removed.ok) {
          cleanupFailed = true;
          log(bot, "error", "redirected_message_cleanup_failed", { expected_thread_id: conversation.thread_id, actual_thread_id: deliveredItem.message_thread_id, message_id: deliveredItem.message_id, description: removed.description });
        }
      }
      result = { ok: false, description: "Telegram redirected pending album outside the expected Topic", deliveryUncertain: cleanupFailed };
    }
  }
  if (!result.ok) {
    if (isDeliveryOutcomeUncertain(result)) {
      log(bot, "error", "pending_album_delivery_outcome_uncertain", { user_id: ordered[0].user_id, media_group_id: ordered[0].media_group_id, description: result.description });
      return { ok: false, terminal: true, failureCode: "telegram_delivery_outcome_unknown", result, conversation, ordered };
    }
    await clearPendingDeliveryAttempt(db, ordered, deliveryStartedAt);
    return { ok: false, result, conversation };
  }
  const delivered = Array.isArray(result.result) ? result.result : [];
  await completePendingDeliveryAttempt(db, ordered, deliveryStartedAt, delivered, conversation.thread_id);
  for (let i = 0; i < ordered.length; i++) {
    await fencePendingFlush(db, bot, ordered[i].user_id, owner, challengeId);
    const mappingSaved = await recordMapping(bot, db, { botId: bot.id, userId: ordered[i].user_id, threadId: conversation.thread_id, groupId: conversation.support_group_id, userMessageId: ordered[i].source_message_id, supportMessageId: delivered[i]?.message_id });
    if (mappingSaved) await dbRun(db, "UPDATE pending_messages SET mapping_synced_at = COALESCE(mapping_synced_at, ?) WHERE id = ?", nowIso(), ordered[i].id);
  }
  await finalizeConversationReopenAfterDelivery(db, bot.id, ordered[0].user_id, ordered.map((item) => Number(item.source_message_id)));
  await stageConfirmedInboundNotice(bot, env, ordered[0].user_id, conversation.support_group_id, conversation.thread_id);
  return { ok: true, conversation, ordered };
}

async function deliverPendingMessages(bot, env, userId, challengeId = null, decisionLocked = false) {
  const db = requireDb(env);
  const owner = crypto.randomUUID();
  const expires = isoAfter(PENDING_FLUSH_LEASE_MS);
  let claimed = await dbRun(db, "INSERT INTO pending_flush_locks (bot_id, user_id, owner_token, lease_expires_at, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(bot_id, user_id) DO NOTHING", bot.id, userId, owner, expires, nowIso());
  if (claimed.meta?.changes !== 1) {
    const current = await dbOne(db, "SELECT owner_token, lease_expires_at FROM pending_flush_locks WHERE bot_id = ? AND user_id = ?", bot.id, userId);
    if (current?.lease_expires_at && Date.parse(current.lease_expires_at) <= Date.now()) {
      claimed = await dbRun(db, "UPDATE pending_flush_locks SET owner_token = ?, lease_expires_at = ?, created_at = ? WHERE bot_id = ? AND user_id = ? AND owner_token = ? AND lease_expires_at <= ?", owner, expires, nowIso(), bot.id, userId, current.owner_token, nowIso());
    }
  }
  if (claimed.meta?.changes !== 1) return { status: "busy", delivered: 0 };
  let delivered = 0;
  let failed = 0;
  try {
    await fencePendingFlush(db, bot, userId, owner, challengeId);
    const repairedDelivered = challengeId === null
      ? await dbRun(db, "UPDATE pending_messages SET delivered_at = delivery_completed_at WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL AND failed_at IS NULL AND delivery_completed_at IS NOT NULL", bot.id, userId)
      : await dbRun(db, "UPDATE pending_messages SET delivered_at = delivery_completed_at WHERE bot_id = ? AND user_id = ? AND challenge_id = ? AND delivered_at IS NULL AND failed_at IS NULL AND delivery_completed_at IS NOT NULL", bot.id, userId, challengeId);
    delivered += Number(repairedDelivered.meta?.changes || 0);
    if (challengeId === null) {
      await dbRun(db, "UPDATE pending_messages SET delivery_started_at = NULL, request_started_at = NULL WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL AND failed_at IS NULL AND delivery_started_at IS NOT NULL AND request_started_at IS NULL AND delivery_completed_at IS NULL", bot.id, userId);
    } else {
      await dbRun(db, "UPDATE pending_messages SET delivery_started_at = NULL, request_started_at = NULL WHERE bot_id = ? AND user_id = ? AND challenge_id = ? AND delivered_at IS NULL AND failed_at IS NULL AND delivery_started_at IS NOT NULL AND request_started_at IS NULL AND delivery_completed_at IS NULL", bot.id, userId, challengeId);
    }
    const quarantined = challengeId === null
      ? await dbRun(db, "UPDATE pending_messages SET failed_at = ?, failure_code = COALESCE(failure_code, 'telegram_delivery_outcome_unknown') WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL AND failed_at IS NULL AND delivery_started_at IS NOT NULL AND request_started_at IS NOT NULL AND delivery_completed_at IS NULL", nowIso(), bot.id, userId)
      : await dbRun(db, "UPDATE pending_messages SET failed_at = ?, failure_code = COALESCE(failure_code, 'telegram_delivery_outcome_unknown') WHERE bot_id = ? AND user_id = ? AND challenge_id = ? AND delivered_at IS NULL AND failed_at IS NULL AND delivery_started_at IS NOT NULL AND request_started_at IS NOT NULL AND delivery_completed_at IS NULL", nowIso(), bot.id, userId, challengeId);
    failed += Number(quarantined.meta?.changes || 0);
    const rows = challengeId === null
      ? await dbAll(db, "SELECT * FROM pending_messages WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL AND failed_at IS NULL ORDER BY id LIMIT ?", bot.id, userId, bot.pendingMessageLimit * 10)
      : await dbAll(db, "SELECT * FROM pending_messages WHERE bot_id = ? AND user_id = ? AND challenge_id = ? AND delivered_at IS NULL AND failed_at IS NULL ORDER BY id LIMIT ?", bot.id, userId, challengeId, bot.pendingMessageLimit * 10);
    const items = rows.results || [];
    if (!items.length) return { status: "empty", delivered, failed };
    const first = items[0];
    await fencePendingFlush(db, bot, userId, owner, challengeId);
    const user = { id: userId, username: first.source_username || null, first_name: first.source_first_name || "User", last_name: first.source_last_name || null };
    let conversation = await provisionConversation(bot, env, user);
    conversation = await reopenConversationForUserMessage(bot, env, conversation, user);
    const processedIds = new Set();
    const albumFallbackGroups = new Set();
    for (const item of items) {
      if (processedIds.has(item.id)) continue;
      const albumItems = item.media_group_id
        ? items.filter((candidate) => candidate.media_group_id === item.media_group_id && !processedIds.has(candidate.id)).sort((a, b) => Number(a.source_message_id) - Number(b.source_message_id))
        : [item];
      const canBatchAlbum = Boolean(item.media_group_id)
        && !albumFallbackGroups.has(item.media_group_id)
        && albumItems.length > 1
        && albumItems.every((candidate) => candidate.media_type && candidate.file_id);
      if (canBatchAlbum) {
        const mappings = await dbAll(db, "SELECT user_message_id FROM message_mappings WHERE bot_id = ? AND user_id = ? AND user_message_id IN (SELECT value FROM json_each(?)) AND support_message_id IS NOT NULL", bot.id, userId, JSON.stringify(albumItems.map((item) => item.source_message_id)));
        const mappedIds = new Set((mappings.results || []).map((row) => Number(row.user_message_id)));
        const mappedRows = albumItems.map((item) => mappedIds.has(Number(item.source_message_id)));
        if (mappedRows.every(Boolean)) {
          for (const candidate of albumItems) {
            const repaired = await dbRun(db, "UPDATE pending_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL", nowIso(), candidate.id);
            if (repaired.meta?.changes > 0) delivered += 1;
            processedIds.add(candidate.id);
          }
          continue;
        }
        if (mappedRows.some(Boolean)) {
          albumFallbackGroups.add(item.media_group_id);
          for (let i = 0; i < albumItems.length; i++) {
            if (!mappedRows[i]) continue;
            const repaired = await dbRun(db, "UPDATE pending_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL", nowIso(), albumItems[i].id);
            if (repaired.meta?.changes > 0) delivered += 1;
            processedIds.add(albumItems[i].id);
          }
          if (processedIds.has(item.id)) continue;
        } else {
          const albumDelivery = await deliverPendingAlbum(bot, env, albumItems, conversation, owner, challengeId, decisionLocked);
          if (albumDelivery.ok) {
            conversation = albumDelivery.conversation;
            for (const candidate of albumItems) {
              const marked = await dbRun(db, "UPDATE pending_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL", nowIso(), candidate.id);
              if (marked.meta?.changes > 0) delivered += 1;
              processedIds.add(candidate.id);
            }
            continue;
          }
          if (albumDelivery.terminal) {
            for (const candidate of albumItems) {
              const markedFailed = await dbRun(db, "UPDATE pending_messages SET failed_at = ?, failure_code = ? WHERE id = ? AND delivered_at IS NULL AND failed_at IS NULL", nowIso(), albumDelivery.failureCode, candidate.id);
              if (markedFailed.meta?.changes > 0) {
                failed += 1;
                await recordAbuseEvent(db, bot.id, userId, `pending-failed:${candidate.id}`, "pending_delivery_failed");
              }
              processedIds.add(candidate.id);
            }
            continue;
          }
          if (isRetryableTelegramFailure(albumDelivery.result)) throw new Error(`pending album delivery failed: ${albumDelivery.result.description}`);
          albumFallbackGroups.add(item.media_group_id);
        }
      }
      if (processedIds.has(item.id)) continue;
      processedIds.add(item.id);
      await fencePendingFlush(db, bot, userId, owner, challengeId);
      const mapped = await dbOne(db, "SELECT support_message_id FROM message_mappings WHERE bot_id = ? AND user_id = ? AND user_message_id = ? AND support_message_id IS NOT NULL ORDER BY id DESC LIMIT 1", bot.id, userId, item.source_message_id);
      if (mapped) {
        const repaired = await dbRun(db, "UPDATE pending_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL", nowIso(), item.id);
        if (repaired.meta?.changes > 0) delivered += 1;
        continue;
      }
      const delivery = await deliverPendingItem(bot, env, item, conversation, owner, challengeId, true, decisionLocked);
      conversation = delivery.conversation;
      if (!delivery.ok && delivery.terminal) {
        const markedFailed = await dbRun(db, "UPDATE pending_messages SET failed_at = ?, failure_code = ? WHERE id = ? AND delivered_at IS NULL AND failed_at IS NULL", nowIso(), delivery.failureCode, item.id);
        if (markedFailed.meta?.changes > 0) {
          failed += 1;
          await recordAbuseEvent(db, bot.id, userId, `pending-failed:${item.id}`, "pending_delivery_failed");
        }
        continue;
      }
      const marked = await dbRun(db, "UPDATE pending_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL", nowIso(), item.id);
      if (marked.meta?.changes > 0) delivered += 1;
    }
    return { status: "complete", delivered, failed };
  } finally {
    await dbRun(db, "DELETE FROM pending_flush_locks WHERE bot_id = ? AND user_id = ? AND owner_token = ?", bot.id, userId, owner);
    await tryAutoReply(bot, env, userId);
  }
}

async function flushReleasedPendingMessages(bot, env, userId, decisionLocked = false) {
  const db = requireDb(env);
  const result = await deliverPendingMessages(bot, env, userId, null, decisionLocked);
  if (["complete", "empty"].includes(result.status)) {
    await dbRun(db, "UPDATE user_abuse_state SET pending_release_required = 0, updated_at = ? WHERE bot_id = ? AND user_id = ? AND verification_required = 0", nowIso(), bot.id, userId);
  }
  return result;
}

function escapeHtmlAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function verificationHeaders(contentType = "text/html; charset=utf-8") {
  return {
    "content-type": contentType,
    "cache-control": "no-store, max-age=0",
    "content-security-policy": "default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
}

const verificationHttpCopy = {
  en: { inactive: "This verification link is no longer active.", expired: "Verification link has expired.", retry: "Please try again later.", unavailable: "Verification is temporarily unavailable.", unavailablePlain: "Verification is unavailable.", processing: "Verification is already being processed.", queued: "Verification is temporarily unavailable; your messages are safe in the queue.", used: "Verification was already used or has expired." },
  ru: { inactive: "Эта ссылка для проверки больше не активна.", expired: "Срок действия ссылки для проверки истёк.", retry: "Попробуйте ещё раз позже.", unavailable: "Проверка временно недоступна.", unavailablePlain: "Проверка недоступна.", processing: "Проверка уже выполняется.", queued: "Проверка временно недоступна; ваши сообщения надёжно сохранены в очереди.", used: "Проверка уже использована или срок её действия истёк." },
  es: { inactive: "Este enlace de verificación ya no está activo.", expired: "El enlace de verificación ha caducado.", retry: "Inténtalo de nuevo más tarde.", unavailable: "La verificación no está disponible temporalmente.", unavailablePlain: "La verificación no está disponible.", processing: "La verificación ya se está procesando.", queued: "La verificación no está disponible temporalmente; tus mensajes están guardados en la cola.", used: "La verificación ya se usó o ha caducado." },
  zh: { inactive: "此验证链接已失效。", expired: "验证链接已过期。", retry: "请稍后重试。", unavailable: "验证暂时不可用。", unavailablePlain: "验证不可用。", processing: "此验证正在处理中。", queued: "验证暂时不可用；你的消息已安全保存在队列中。", used: "此验证已使用或已过期。" },
};

function verificationHttpResponse(locale, key, status) {
  const language = ["ru", "en", "es", "zh"].includes(locale) ? locale : "en";
  return new Response(verificationHttpCopy[language][key], {
    status,
    headers: verificationHeaders("text/plain; charset=utf-8"),
  });
}

function verificationPage(siteKey, locale, action, error = "") {
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(String(siteKey || ""))) throw new Error("TURNSTILE_SITE_KEY is invalid");
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(action)) throw new Error("TURNSTILE_EXPECTED_ACTION is invalid");
  const copy = ({ru:["Проверка не пройдена. Попробуйте ещё раз.","Проверка поддержки","Подтвердите, что вы человек","Продолжить"],en:["Verification failed. Please try again.","Support verification","Verify that you are human","Continue"],es:["La verificación no se completó. Inténtalo de nuevo.","Verificación de soporte","Confirma que eres una persona","Continuar"],zh:["验证未通过，请重试。","支持验证","请确认你是真人","继续"]})[locale] || ["Verification failed. Please try again.","Support verification","Verify that you are human","Continue"];
  const lang = ["ru","en","es","zh"].includes(locale) ? locale : "en";
  const safeError = error ? `<p>${copy[0]}</p>` : "";
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy[1]}</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head><body><main><h1>${copy[2]}</h1>${safeError}<form method="post"><div class="cf-turnstile" data-sitekey="${escapeHtmlAttribute(siteKey)}" data-action="${escapeHtmlAttribute(action)}" data-language="${lang}"></div><button type="submit">${copy[3]}</button></form></main></body></html>`;
}

function publicBaseOrigin(raw) {
  const url = new URL(String(raw || ""));
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password) throw new Error("PUBLIC_BASE_URL must be an HTTPS origin");
  return url.origin;
}

async function checkVerificationPreLimits(env, tokenHash, ip) {
  const checks = [
    checkEdgeLimit(env, "VERIFY_LIMITER", `verify-token:${tokenHash}`),
    checkEdgeLimit(env, "VERIFY_LIMITER", `verify-ip:${ip}`),
  ];
  const results = await Promise.all(checks);
  return results.every(Boolean);
}

function checkVerificationUserLimit(env, challenge) {
  return checkEdgeLimit(env, "VERIFY_LIMITER", `verify-user:${challenge.bot_id}:${challenge.user_id}`);
}

async function claimVerificationAttempt(db, challengeId, responseToken) {
  const responseHash = await sha256(`${challengeId}:${responseToken}`);
  const ownerToken = crypto.randomUUID();
  let leaseExpiresAt = isoAfter(VERIFICATION_ATTEMPT_LEASE_MS);
  let claimed = await dbRun(
    db,
    "INSERT INTO verification_attempts (challenge_id, response_hash, status, owner_token, lease_expires_at, created_at) VALUES (?, ?, 'processing', ?, ?, ?) ON CONFLICT(challenge_id, response_hash) DO NOTHING",
    challengeId,
    responseHash,
    ownerToken,
    leaseExpiresAt,
    nowIso(),
  );
  if (claimed.meta?.changes === 1) return { status: "acquired", responseHash, ownerToken };
  {
    const current = await dbOne(db, "SELECT status, owner_token, lease_expires_at, effects_applied FROM verification_attempts WHERE challenge_id = ? AND response_hash = ?", challengeId, responseHash);
    if (current?.status !== "processing") return { ...current, responseHash, ownerToken: null };
    if (current.lease_expires_at && Date.parse(current.lease_expires_at) <= Date.now()) {
      leaseExpiresAt = isoAfter(VERIFICATION_ATTEMPT_LEASE_MS);
      claimed = await dbRun(
        db,
        "UPDATE verification_attempts SET owner_token = ?, lease_expires_at = ? WHERE challenge_id = ? AND response_hash = ? AND status = 'processing' AND owner_token = ? AND lease_expires_at <= ?",
        ownerToken,
        leaseExpiresAt,
        challengeId,
        responseHash,
        current.owner_token,
        nowIso(),
      );
      if (claimed.meta?.changes === 1) return { status: "acquired", responseHash, ownerToken };
    }
  }
  return { status: "busy", responseHash, ownerToken: null };
}

async function releaseVerificationAttempt(db, challengeId, attempt) {
  if (attempt?.status !== "acquired") return;
  await dbRun(db, "DELETE FROM verification_attempts WHERE challenge_id = ? AND response_hash = ? AND status = 'processing' AND owner_token = ?", challengeId, attempt.responseHash, attempt.ownerToken);
}

async function safelyReleaseVerificationAttempt(db, challenge, attempt) {
  try {
    await releaseVerificationAttempt(db, challenge.id, attempt);
  } catch (error) {
    log({ id: challenge.bot_id }, "error", "verification_attempt_release_failed", { challenge_id: challenge.id, message: error.message });
  }
}

async function applyFailedVerificationEffects(db, config, challenge, responseHash) {
  const attempt = await dbOne(db, "SELECT status, effects_applied FROM verification_attempts WHERE challenge_id = ? AND response_hash = ?", challenge.id, responseHash);
  if (attempt?.status !== "failed" || Number(attempt.effects_applied) === 1) return;
  const eventKey = `challenge:${challenge.id}:failed:${responseHash}`;
  const failedState = await applyRiskEvent(db, config, challenge.user_id, eventKey, "verification_failed", config.riskWeights.failedTurnstile);
  await applyTemporaryMute(db, config, challenge.user_id, failedState, `challenge-mute:${challenge.id}:${responseHash}`, "verification_failed");
  await dbRun(db, "UPDATE verification_attempts SET effects_applied = 1 WHERE challenge_id = ? AND response_hash = ? AND status = 'failed'", challenge.id, responseHash);
}

async function recoverFailedVerificationEffects(db, config, challenge) {
  const pending = await dbAll(
    db,
    "SELECT response_hash FROM verification_attempts WHERE challenge_id = ? AND status = 'failed' AND effects_applied = 0 ORDER BY created_at",
    challenge.id,
  );
  for (const failed of pending.results || []) {
    await applyFailedVerificationEffects(db, config, challenge, failed.response_hash);
  }
}

function expectedTurnstileHostname(env) {
  const configured = String(env.TURNSTILE_EXPECTED_HOSTNAME || "").trim().toLowerCase();
  const hostname = configured || new URL(publicBaseOrigin(env.PUBLIC_BASE_URL)).hostname.toLowerCase();
  if (hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(hostname)) {
    throw new Error("TURNSTILE_EXPECTED_HOSTNAME is invalid");
  }
  return hostname;
}

async function persistedBotEnabled(db, botId) {
  const persisted = await dbOne(db, "SELECT enabled FROM bots WHERE id = ?", botId);
  return !persisted || Number(persisted.enabled) !== 0;
}

function verificationSuccessResponse(bot) {
  const lang = ["ru","en","es","zh"].includes(bot.locale) ? bot.locale : "en";
  const copy = ({ru:['✅ Проверка пройдена','Можно закрыть эту страницу и вернуться в Telegram. Повторно проходить эту проверку не нужно.'],en:['✅ Verification passed','You can close this page and return to Telegram. You do not need to repeat this verification.'],es:['✅ Verificación completada','Puedes cerrar esta página y volver a Telegram. No es necesario repetir esta verificación.'],zh:['✅ 验证通过','你可以关闭此页面并返回 Telegram。无需再次进行此验证。']})[lang];
  const [title,text] = copy;
  return new Response(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`, { headers: verificationHeaders() });
}

export async function syncVerificationNotice(env, challengeId, allowLegacy = false) {
  const db = requireDb(env);
  recoveryCheckpoint(db, 7);
  const current = await dbOne(db, `SELECT c.*, EXISTS(SELECT 1 FROM banned_users b WHERE b.bot_id=c.bot_id AND b.user_id=c.user_id) AS banned,
    EXISTS(SELECT 1 FROM verification_challenges newer WHERE newer.bot_id=c.bot_id AND newer.user_id=c.user_id
      AND newer.id<>c.id AND newer.status='pending' AND newer.expires_at>?) AS newer_pending,
    COALESCE((SELECT verification_required FROM user_abuse_state s WHERE s.bot_id=c.bot_id AND s.user_id=c.user_id),0) AS verification_required
    FROM verification_challenges c WHERE c.id=? AND c.status='passed' AND c.notice_resolved_at IS NULL`, nowIso(), challengeId);
  if (!current) return;
  // Move a failing or temporarily ineligible notice behind other users. One old
  // Telegram error must not monopolize this bounded recovery queue.
  if (current.notice_message_id) await dbRun(db, "UPDATE verification_challenges SET notice_retry_at=? WHERE id=? AND status='passed' AND notice_resolved_at IS NULL", isoAfter(5 * 60_000), current.id);
  if (current.banned || current.newer_pending || current.verification_required) return;
  const config = resolveBot(env, current.bot_id, false);
  if (!config?.enabled || !await persistedBotEnabled(db, current.bot_id)) return;
  const bot = resolveBot(env, current.bot_id);
  assertTelegramReady(db, bot);
  const text = ({ru:'✅ Проверка пройдена.',en:'✅ Verification passed.',es:'✅ Verificación completada.',zh:'✅ 验证通过。'})[bot.locale] || '✅ Verification passed.';
  if (current.notice_message_id) {
    // Editing the same message to the same text is safe to replay even after a
    // timeout or a lost D1 completion write. Never replace a newer challenge.
    const result = await telegram(bot, 'editMessageText', { chat_id: current.user_id,
      message_id: current.notice_message_id, text, reply_markup: { inline_keyboard: [] } }, env);
    if (result.ok || isMessageNotModifiedError(result.description)) {
      await dbRun(db, "UPDATE verification_challenges SET notice_resolved_at=COALESCE(notice_resolved_at,?) WHERE id=? AND status='passed' AND notice_message_id=?", nowIso(), current.id, current.notice_message_id);
      return;
    }
    if (!/message to edit not found|message can't be edited|message can not be edited/i.test(result.description)) {
      throw new Error(`verification status edit failed: ${result.description}`);
    }
    // A deleted/uneditable prompt cannot have a useful button removed. A single
    // separately fenced success notice is still useful to the person verifying.
  } else if (!allowLegacy || !current.notice_sent_at) return;
  if (current.notice_resolution_started_at) return; // unknown send outcome: no replay
  recoveryCheckpoint(db, 4);
  const token = crypto.randomUUID();
  const gate = telegramRequestGate(db, bot);
  const claimed = await dbRun(db, "UPDATE verification_challenges SET notice_resolution_token=?, notice_resolution_started_at=? WHERE id=? AND status='passed' AND notice_resolved_at IS NULL AND notice_resolution_started_at IS NULL" + gate.sql,
    token, nowIso(), current.id, ...gate.params);
  if (claimed.meta?.changes !== 1) return;
  const result = await telegram(bot, 'sendMessage', { chat_id: current.user_id, text }, env);
  if (result.ok) {
    await dbRun(db, "UPDATE verification_challenges SET notice_resolved_at=? WHERE id=? AND notice_resolution_token=?", nowIso(), current.id, token);
  } else if (!isDeliveryOutcomeUncertain(result)) {
    await dbRun(db, "UPDATE verification_challenges SET notice_resolution_started_at=NULL, notice_resolution_token=NULL WHERE id=? AND notice_resolution_token=?", current.id, token);
  }
  if (!result.ok) throw new Error(`verification success notice failed: ${result.description}`);
}

async function tryVerificationNotice(env, challengeId, allowLegacy) {
  try {
    if (env.VERIFICATION_STATUS_SERVICE) await env.VERIFICATION_STATUS_SERVICE.sync(challengeId, allowLegacy);
    else await syncVerificationNotice(env, challengeId, allowLegacy);
  } catch (error) {
    // Status delivery cannot undo the verified state or falsely fail the browser.
    log(null, 'warn', 'verification_status_deferred', { challenge_id: challengeId, message: error.message });
  }
}

async function finishPassedChallenge(env, challenge, locale = "en") {
  const db = requireDb(env);
  const current = await dbOne(db, "SELECT * FROM verification_challenges WHERE id = ?", challenge.id);
  if (!current || current.status !== "passed") return verificationHttpResponse(locale, "inactive", 410);
  if (!await persistedBotEnabled(db, current.bot_id)) return verificationHttpResponse(locale, "inactive", 410);
  const banned = await dbOne(db, "SELECT 1 FROM banned_users WHERE bot_id = ? AND user_id = ?", challenge.bot_id, challenge.user_id);
  if (banned) return verificationHttpResponse(locale, "inactive", 410);
  const state = await dbOne(db, "SELECT * FROM user_abuse_state WHERE bot_id = ? AND user_id = ?", current.bot_id, current.user_id);
  const hasNewChallenge = await dbOne(db, "SELECT 1 FROM verification_challenges WHERE bot_id = ? AND user_id = ? AND status = 'pending' AND expires_at > ? AND id <> ?", current.bot_id, current.user_id, nowIso(), current.id);
  if (!state || isFuture(state.muted_until) || Number(state.verification_required) !== 0 || hasNewChallenge) {
    return verificationHttpResponse(locale, "inactive", 410);
  }
  const bot = resolveBot(env, current.bot_id);
  if (db.invocationBudget === 'webhook') await tryVerificationNotice(env, current.id, true);
  let result;
  try { result = await deliverPendingMessages(bot, env, current.user_id, current.id); }
  catch (error) {
    if (db.invocationBudget !== 'webhook') throw error;
    if (error instanceof RecoveryBudgetExhausted) {
      log(bot, 'info', 'verification_delivery_deferred_by_budget', { challenge_id: current.id, queries: db.used, limit: db.limit, plan: db.plan });
    } else log(bot, 'warn', 'verified_delivery_deferred', { challenge_id: current.id, message: error.message });
    return verificationSuccessResponse(bot);
  }
  if (["complete", "empty"].includes(result.status)) {
    try { await dbRun(db, "UPDATE verification_challenges SET flushed_at = COALESCE(flushed_at, ?) WHERE id = ? AND status = 'passed'", nowIso(), current.id); }
    catch (error) {
      if (db.invocationBudget !== 'webhook') throw error;
      log(bot, 'warn', 'verified_flush_marker_deferred', { challenge_id: current.id, message: error.message });
    }
  }
  return verificationSuccessResponse(bot);
}

async function handleVerification(request, env, token) {
  if (!token || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return reply(404, "Not found");
  if (!["GET", "POST"].includes(request.method)) return reply(405, "Method not allowed");
  const tokenHash = await sha256(token);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  try {
    if (!await checkVerificationPreLimits(env, tokenHash, ip)) return new Response("Try again later", { status: 429, headers: verificationHeaders("text/plain; charset=utf-8") });
  } catch (error) {
    log(null, "error", "verification_limiter_failed", { message: error.message });
    return new Response("Verification is temporarily unavailable", { status: 503, headers: verificationHeaders("text/plain; charset=utf-8") });
  }
  env = await webhookEnvironment(env);
  const db = requireDb(env);
  if (db.storageMode === 'reset') return reply(503, 'Storage maintenance; retry later');
  const challenge = await dbOne(db, "SELECT * FROM verification_challenges WHERE token_hash = ?", tokenHash);
  if (!challenge) return reply(410, "Verification link expired");
  const config = resolveBot(env, challenge.bot_id, false);
  if (!config?.enabled) return config
    ? verificationHttpResponse(config.locale, "expired", 410)
    : reply(410, "Verification link expired");
  try {
    if (!await checkVerificationUserLimit(env, challenge)) return verificationHttpResponse(config.locale, "retry", 429);
  } catch (error) {
    log({ id: challenge.bot_id }, "error", "verification_user_limiter_failed", { message: error.message });
    return verificationHttpResponse(config.locale, "unavailable", 503);
  }
  const expectedAction = String(env.TURNSTILE_EXPECTED_ACTION || "support_verify");
  const expectedHostname = expectedTurnstileHostname(env);
  if (!await persistedBotEnabled(db, challenge.bot_id)) return verificationHttpResponse(config.locale, "expired", 410);
  if (await dbOne(db, "SELECT 1 FROM banned_users WHERE bot_id = ? AND user_id = ?", challenge.bot_id, challenge.user_id)) return verificationHttpResponse(config.locale, "expired", 410);
  if (challenge.status === "passed") return finishPassedChallenge(env, challenge, config.locale);
  if (challenge.status !== "pending" || !isFuture(challenge.expires_at)) return verificationHttpResponse(config.locale, "expired", 410);
  const abuseState = await dbOne(db, "SELECT * FROM user_abuse_state WHERE bot_id = ? AND user_id = ?", challenge.bot_id, challenge.user_id);
  if (!abuseState || isFuture(abuseState.muted_until) || Number(abuseState.verification_required) !== 1) return verificationHttpResponse(config.locale, "expired", 410);
  if (request.method === "GET") {
    if (!env.TURNSTILE_SITE_KEY) return verificationHttpResponse(config.locale, "unavailablePlain", 503);
    return new Response(verificationPage(env.TURNSTILE_SITE_KEY, config.locale, expectedAction), { headers: verificationHeaders() });
  }
  if (request.method !== "POST") return reply(405, "Method not allowed");
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) return verificationHttpResponse(config.locale, "unavailablePlain", 503);
  const form = await request.formData();
  const responseToken = String(form.get("cf-turnstile-response") || "");
  if (!responseToken || responseToken.length > 2048) return new Response(verificationPage(env.TURNSTILE_SITE_KEY, config.locale, expectedAction, "missing"), { status: 400, headers: verificationHeaders() });
  const attempt = await claimVerificationAttempt(db, challenge.id, responseToken);
  if (attempt.status === "busy") return verificationHttpResponse(config.locale, "processing", 409);
  if (attempt.status === "failed") {
    await applyFailedVerificationEffects(db, config, challenge, attempt.responseHash);
    return new Response(verificationPage(env.TURNSTILE_SITE_KEY, config.locale, expectedAction, "failed"), { status: 403, headers: verificationHeaders() });
  }
  if (attempt.status === "passed") return finishPassedChallenge(env, challenge, config.locale);
  if (attempt.status === "denied") return verificationHttpResponse(config.locale, "inactive", 410);
  try {
    await recoverFailedVerificationEffects(db, config, challenge);
    const [currentChallenge, currentState] = await Promise.all([
      dbOne(db, "SELECT status, expires_at FROM verification_challenges WHERE id = ?", challenge.id),
      dbOne(db, "SELECT verification_required, muted_until FROM user_abuse_state WHERE bot_id = ? AND user_id = ?", config.id, challenge.user_id),
    ]);
    if (currentChallenge?.status !== "pending" || !isFuture(currentChallenge.expires_at)
      || !currentState || Number(currentState.verification_required) !== 1 || isFuture(currentState.muted_until)) {
      await releaseVerificationAttempt(db, challenge.id, attempt);
      return verificationHttpResponse(config.locale, "inactive", 410);
    }
  } catch (error) {
    await safelyReleaseVerificationAttempt(db, challenge, attempt);
    log({ id: challenge.bot_id }, "error", "verification_effect_recovery_failed", { challenge_id: challenge.id, message: error.message });
    return verificationHttpResponse(config.locale, "unavailable", 503);
  }
  let siteverify;
  const siteverifyController = new AbortController();
  const siteverifyTimeout = setTimeout(() => siteverifyController.abort(), TURNSTILE_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({ secret: String(env.TURNSTILE_SECRET_KEY), response: responseToken, remoteip: ip, idempotency_key: await stableIdempotencyKey(`${challenge.id}:${responseToken}`) });
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: siteverifyController.signal });
    if (!response.ok) throw new Error(`Siteverify returned HTTP ${response.status}`);
    siteverify = await response.json();
  } catch (error) {
    await safelyReleaseVerificationAttempt(db, challenge, attempt);
    log({ id: challenge.bot_id }, "error", "turnstile_unavailable", { message: error.message });
    return verificationHttpResponse(config.locale, "queued", 503);
  } finally {
    clearTimeout(siteverifyTimeout);
  }
  const validSiteverify = siteverify?.success === true
    && siteverify.action === expectedAction
    && String(siteverify.hostname || "").toLowerCase() === expectedHostname;
  if (!validSiteverify) {
    const timestamp = nowIso();
    try {
      await db.batch([
        db.prepare("UPDATE verification_challenges SET attempt_count = attempt_count + 1, failed_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ? AND EXISTS (SELECT 1 FROM verification_attempts WHERE challenge_id = ? AND response_hash = ? AND status = 'processing' AND owner_token = ? AND lease_expires_at > ?)")
          .bind(timestamp, challenge.id, timestamp, challenge.id, attempt.responseHash, attempt.ownerToken, timestamp),
        db.prepare("UPDATE verification_attempts SET status = 'failed', owner_token = NULL, lease_expires_at = NULL, completed_at = ? WHERE challenge_id = ? AND response_hash = ? AND status = 'processing' AND owner_token = ? AND lease_expires_at > ? AND EXISTS (SELECT 1 FROM verification_challenges WHERE id = ? AND status = 'pending' AND expires_at > ?)")
          .bind(timestamp, challenge.id, attempt.responseHash, attempt.ownerToken, timestamp, challenge.id, timestamp),
        db.prepare("UPDATE verification_attempts SET status = 'denied', owner_token = NULL, lease_expires_at = NULL, completed_at = ? WHERE challenge_id = ? AND response_hash = ? AND status = 'processing' AND owner_token = ?")
          .bind(timestamp, challenge.id, attempt.responseHash, attempt.ownerToken),
      ]);
    } catch (error) {
      await safelyReleaseVerificationAttempt(db, challenge, attempt);
      throw error;
    }
    const outcome = await dbOne(db, "SELECT status FROM verification_attempts WHERE challenge_id = ? AND response_hash = ?", challenge.id, attempt.responseHash);
    if (outcome?.status === "failed") await applyFailedVerificationEffects(db, config, challenge, attempt.responseHash);
    if (outcome?.status === "processing") return verificationHttpResponse(config.locale, "processing", 409);
    if (outcome?.status === "denied") return verificationHttpResponse(config.locale, "inactive", 410);
    return new Response(verificationPage(env.TURNSTILE_SITE_KEY, config.locale, expectedAction, "failed"), { status: 403, headers: verificationHeaders() });
  }
  await ensureAbuseState(db, config.id, challenge.user_id);
  const timestamp = nowIso();
  const trustedUntil = isoAfter(config.trustedDays * 86_400_000);
  let challengeResult;
  let stateResult;
  try {
    [challengeResult, stateResult] = await db.batch([
      db.prepare("UPDATE verification_challenges SET status = 'passed', verified_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ? AND EXISTS (SELECT 1 FROM user_abuse_state WHERE bot_id = ? AND user_id = ? AND verification_required = 1 AND risk_score < ? AND (muted_until IS NULL OR muted_until <= ?)) AND NOT EXISTS (SELECT 1 FROM banned_users WHERE bot_id = ? AND user_id = ?) AND NOT EXISTS (SELECT 1 FROM bots WHERE id = ? AND enabled = 0) AND NOT EXISTS (SELECT 1 FROM verification_attempts WHERE challenge_id = ? AND status = 'failed' AND effects_applied = 0) AND EXISTS (SELECT 1 FROM verification_attempts WHERE challenge_id = ? AND response_hash = ? AND status = 'processing' AND owner_token = ? AND lease_expires_at > ?)")
        .bind(timestamp, challenge.id, timestamp, config.id, challenge.user_id, config.riskMuteThreshold, timestamp, config.id, challenge.user_id, config.id, challenge.id, challenge.id, attempt.responseHash, attempt.ownerToken, timestamp),
      db.prepare("UPDATE user_abuse_state SET risk_score = MAX(0, risk_score - ?), trusted_until = ?, verification_required = 0, updated_at = ? WHERE bot_id = ? AND user_id = ? AND risk_score < ? AND (muted_until IS NULL OR muted_until <= ?) AND EXISTS (SELECT 1 FROM verification_challenges WHERE id = ? AND status = 'passed' AND verified_at = ?)")
        .bind(config.riskWeights.passedTurnstile, trustedUntil, timestamp, config.id, challenge.user_id, config.riskMuteThreshold, timestamp, challenge.id, timestamp),
      db.prepare("UPDATE verification_attempts SET status = 'passed', owner_token = NULL, lease_expires_at = NULL, completed_at = ? WHERE challenge_id = ? AND response_hash = ? AND status = 'processing' AND owner_token = ? AND lease_expires_at > ? AND EXISTS (SELECT 1 FROM verification_challenges WHERE id = ? AND status = 'passed' AND verified_at = ?)")
        .bind(timestamp, challenge.id, attempt.responseHash, attempt.ownerToken, timestamp, challenge.id, timestamp),
      db.prepare("UPDATE verification_attempts SET status = 'denied', owner_token = NULL, lease_expires_at = NULL, completed_at = ? WHERE challenge_id = ? AND response_hash = ? AND status = 'processing' AND owner_token = ?")
        .bind(timestamp, challenge.id, attempt.responseHash, attempt.ownerToken),
    ]);
  } catch (error) {
    await safelyReleaseVerificationAttempt(db, challenge, attempt);
    throw error;
  }
  if (!(stateResult.meta?.changes > 0) || !(challengeResult.meta?.changes > 0)) {
    const current = await dbOne(db, "SELECT * FROM verification_challenges WHERE id = ?", challenge.id);
    if (current?.status === "passed") return finishPassedChallenge(env, current, config.locale);
    return verificationHttpResponse(config.locale, "used", 409);
  }
  await recordAbuseEvent(db, config.id, challenge.user_id, `challenge:${challenge.id}`, "verification_passed", null, -config.riskWeights.passedTurnstile);
  return finishPassedChallenge(env, { ...challenge, status: "passed", verified_at: timestamp }, config.locale);
}
async function findConversation(db, botId, userId) { return dbOne(db, "SELECT * FROM conversations WHERE bot_id = ? AND user_id = ?", botId, userId); }

async function invalidateConversationTopic(db, botId, userId, threadId, closedOnly = false) {
  // Retire the obsolete provisioning result in the same transaction as its route.
  // Otherwise a retry can reinstall the deleted Topic from a completed attempt.
  const condition = "bot_id = ? AND user_id = ? AND thread_id = ?" + (closedOnly ? " AND status = 'closed'" : "");
  const params = [botId, userId, threadId];
  recoveryCheckpoint(db, 2);
  const results = await db.batch([
    db.prepare("DELETE FROM conversation_provision_attempts WHERE bot_id = ? AND user_id = ? AND thread_id = ? AND completed_at IS NOT NULL AND EXISTS (SELECT 1 FROM conversations WHERE " + condition + ")").bind(...params, ...params),
    db.prepare("DELETE FROM conversations WHERE " + condition).bind(...params),
  ]);
  return results[1];
}

async function upsertBotMetadata(db, bot) {
  await dbRun(
    db,
    "INSERT INTO bots (id, display_name, topic_prefix, enabled, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, topic_prefix = excluded.topic_prefix",
    bot.id,
    bot.displayName,
    bot.topicPrefix,
    bot.enabled ? 1 : 0,
    nowIso(),
  );
}

async function ensureBotMetadata(db, bot) {
  let persisted = await dbOne(db, `SELECT b.enabled, r.group_id FROM (SELECT ? AS id) x
    LEFT JOIN bots b ON b.id=x.id LEFT JOIN service_group_routes r ON r.bot_id=x.id`, bot.id);
  if (persisted?.enabled != null) return persisted;
  const created = await dbOne(
    db,
    "INSERT INTO bots (id, display_name, topic_prefix, enabled, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING enabled",
    bot.id,
    bot.displayName,
    bot.topicPrefix,
    bot.enabled ? 1 : 0,
    nowIso(),
  );
  if (created) return { ...created, group_id: persisted?.group_id ?? null };
  persisted = await dbOne(db, `SELECT b.enabled, r.group_id FROM bots b
    LEFT JOIN service_group_routes r ON r.bot_id=b.id WHERE b.id=?`, bot.id);
  if (!persisted) throw new Error("Bot metadata could not be initialized");
  return persisted;
}

async function beginConversationProvisionAttempt(db, bot, user) {
  recoveryCheckpoint(db, 6); // Preparation, style lookup, request marker and durable result.
  const startedAt = nowIso();
  const inserted = await dbRun(db, `INSERT INTO conversation_provision_attempts (bot_id, user_id, started_at)
    SELECT ?, ?, ? WHERE NOT EXISTS(SELECT 1 FROM conversations WHERE bot_id=? AND user_id=?)
    ON CONFLICT(bot_id, user_id) DO NOTHING`, bot.id, user.id, startedAt, bot.id, user.id);
  if (inserted.meta?.changes === 1) return { status: "acquired", startedAt };
  let existing = await dbOne(db, "SELECT * FROM conversation_provision_attempts WHERE bot_id = ? AND user_id = ?", bot.id, user.id);
  if (!existing) {
    const active = await findConversation(db, bot.id, user.id);
    if (active) return { status: 'already_active', row: active };
  }
  if (existing?.completed_at && Number.isSafeInteger(Number(existing.thread_id)) && Number(existing.thread_id) !== 1) return { status: "completed", row: existing };
  if (existing?.request_started_at) {
    if (!existing.failure_code) await markConversationProvisionUncertain(db, bot, user, "Interrupted Topic creation has no confirmed result");
    return { status: "uncertain", row: existing };
  }
  if (existing) {
    const age = Date.now() - Date.parse(existing.started_at || "");
    if (!Number.isFinite(age) || age < LOCK_STALE_MS) return { status: "busy", row: existing };
    const cleared = await dbRun(db, "DELETE FROM conversation_provision_attempts WHERE bot_id = ? AND user_id = ? AND completed_at IS NULL AND request_started_at IS NULL AND started_at = ?", bot.id, user.id, existing.started_at);
    if (cleared.meta?.changes !== 1) return { status: "busy", row: existing };
    existing = null;
  }
  const retried = await dbRun(db, `INSERT INTO conversation_provision_attempts (bot_id, user_id, started_at)
    SELECT ?, ?, ? WHERE NOT EXISTS(SELECT 1 FROM conversations WHERE bot_id=? AND user_id=?)
    ON CONFLICT(bot_id, user_id) DO NOTHING`, bot.id, user.id, startedAt, bot.id, user.id);
  if (retried.meta?.changes === 1) return { status: "acquired", startedAt };
  const raced = await dbOne(db, "SELECT * FROM conversation_provision_attempts WHERE bot_id = ? AND user_id = ?", bot.id, user.id);
  if (raced?.completed_at && Number.isSafeInteger(Number(raced.thread_id)) && Number(raced.thread_id) !== 1) return { status: "completed", row: raced };
  if (raced?.request_started_at) return { status: "uncertain", row: raced };
  return { status: "busy", row: raced };
}

async function markConversationProvisionRequestStarted(db, bot, user, startedAt) {
  assertTelegramReady(db, bot);
  const gate = telegramRequestGate(db, bot);
  recoveryCheckpoint(db, 4);
  const requestStartedAt = nowIso();
  const marked = await dbRun(db, "UPDATE conversation_provision_attempts SET request_started_at = ? WHERE bot_id = ? AND user_id = ? AND started_at = ? AND completed_at IS NULL AND request_started_at IS NULL" + gate.sql, requestStartedAt, bot.id, user.id, startedAt, ...gate.params);
  if (marked.meta?.changes !== 1) throw new Error("Conversation provisioning request-start marker could not be saved");
  return requestStartedAt;
}

async function markConversationProvisionUncertain(db, bot, user, description) {
  await dbRun(db, "UPDATE conversation_provision_attempts SET failure_code = COALESCE(failure_code, 'telegram_topic_create_outcome_unknown'), failure_detail = COALESCE(failure_detail, ?) WHERE bot_id = ? AND user_id = ? AND completed_at IS NULL AND request_started_at IS NOT NULL", String(description || "").slice(0, 500), bot.id, user.id);
}

async function provisionConversation(bot, env, user, knownConversation = undefined) {
  const db = requireDb(env);
  const existing = knownConversation === undefined ? await findConversation(db, bot.id, user.id) : knownConversation;
  if (existing && Number(existing.support_group_id) === supportGroupId(env)) return existing;
  const lockOwner = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + LOCK_STALE_MS).toISOString();
  let lock = await dbRun(
    db,
    "INSERT INTO conversation_locks (bot_id, user_id, owner_token, lease_expires_at, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(bot_id, user_id) DO NOTHING",
    bot.id,
    user.id,
    lockOwner,
    leaseExpiresAt,
    nowIso(),
  );
  if (lock.meta?.changes !== 1) {
    const current = await findConversation(db, bot.id, user.id);
    if (current && Number(current.support_group_id) === supportGroupId(env)) return current;
    const held = await dbOne(db, "SELECT owner_token, lease_expires_at FROM conversation_locks WHERE bot_id = ? AND user_id = ?", bot.id, user.id);
    if (held?.lease_expires_at && Date.parse(held.lease_expires_at) <= Date.now()) {
      const nextLease = new Date(Date.now() + LOCK_STALE_MS).toISOString();
      lock = await dbRun(
        db,
        "UPDATE conversation_locks SET owner_token = ?, lease_expires_at = ?, created_at = ? WHERE bot_id = ? AND user_id = ? AND owner_token = ? AND lease_expires_at <= ?",
        lockOwner,
        nextLease,
        nowIso(),
        bot.id,
        user.id,
        held.owner_token,
        nowIso(),
      );
    }
    if (lock.meta?.changes !== 1) throw new Error("Conversation provisioning is already in progress; Telegram should retry this update");
  }
  let createdThreadId = null;
  try {
    const refreshed = await dbRun(
      db,
      "UPDATE conversation_locks SET lease_expires_at = ? WHERE bot_id = ? AND user_id = ? AND owner_token = ?",
      new Date(Date.now() + LOCK_STALE_MS).toISOString(),
      bot.id,
      user.id,
      lockOwner,
    );
    if (refreshed.meta?.changes !== 1) throw new Error("Conversation-provisioning lease was lost");
    await upsertBotMetadata(db, bot);
    // A returning user keeps the old topic in history; only this lock holder
    // may remove its active row and provision a replacement in the new group.
    if (existing && Number(existing.support_group_id) !== supportGroupId(env)) {
      const archived = await archiveConversationForNewGroup(db, bot.id, user.id, supportGroupId(env));
      if (!archived) throw new Error('group_cutover_archive_blocked');
    }
    const provisionAttempt = await beginConversationProvisionAttempt(db, bot, user);
    if (provisionAttempt.status === 'already_active') {
      if (Number(provisionAttempt.row.support_group_id) !== supportGroupId(env)) throw new Error('group_route_changed_during_provision');
      return provisionAttempt.row;
    }
    let provisionPersisted = provisionAttempt.status === "completed";
    if (provisionAttempt.status === "completed") {
      createdThreadId = Number(provisionAttempt.row.thread_id);
    } else if (provisionAttempt.status === "uncertain") {
      throw terminalDispatchError("Conversation Topic creation outcome is uncertain and will not be replayed automatically");
    } else if (provisionAttempt.status === "busy") {
      throw new Error("Conversation Topic preparation is still in progress; retry this update");
    } else {
      const style = await dbOne(db, "SELECT icon_color, icon_custom_emoji_id FROM topic_style_settings WHERE bot_id = ?", bot.id);
      const topicBody = { chat_id: supportGroupId(env), name: topicTitle(bot, user) };
      if (style?.icon_color != null) topicBody.icon_color = style.icon_color;
      if (style?.icon_custom_emoji_id) topicBody.icon_custom_emoji_id = style.icon_custom_emoji_id;
      await markConversationProvisionRequestStarted(db, bot, user, provisionAttempt.startedAt);
      const created = await telegram(bot, "createForumTopic", topicBody, env);
      if (!created.ok) {
        if (isDeliveryOutcomeUncertain(created)) {
          await markConversationProvisionUncertain(db, bot, user, created.description);
          throw terminalDispatchError(`createForumTopic outcome uncertain: ${created.description}`);
        }
        await dbRun(db, "DELETE FROM conversation_provision_attempts WHERE bot_id = ? AND user_id = ? AND completed_at IS NULL", bot.id, user.id);
        const error = new Error(`createForumTopic failed: ${created.description}`);
        error.supportGroupUnavailable = isSupportGroupUnavailable(created);
        throw error;
      }
      if (!created.result?.message_thread_id || Number(created.result.message_thread_id) === 1) {
        await dbRun(db, "DELETE FROM conversation_provision_attempts WHERE bot_id = ? AND user_id = ? AND completed_at IS NULL", bot.id, user.id);
        throw new Error("createForumTopic failed: Telegram returned General instead of a Topic");
      }
      createdThreadId = Number(created.result.message_thread_id);
      const persistedAttempt = await dbRun(db, "UPDATE conversation_provision_attempts SET completed_at = ?, thread_id = ?, failure_code = NULL, failure_detail = NULL WHERE bot_id = ? AND user_id = ? AND completed_at IS NULL", nowIso(), createdThreadId, bot.id, user.id);
      if (persistedAttempt.meta?.changes !== 1) throw new Error("Topic was created but its durable provisioning marker could not be saved");
      provisionPersisted = true;
    }
    const insertedConversation = await dbOne(db, `INSERT INTO conversations (bot_id, user_id, username, first_name, last_name, support_group_id, thread_id, status, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) ON CONFLICT(bot_id, user_id) DO NOTHING RETURNING *`, bot.id, user.id, user.username || null, user.first_name || null, user.last_name || null, supportGroupId(env), createdThreadId, nowIso(), nowIso());
    const conversation = insertedConversation || await findConversation(db, bot.id, user.id);
    if (Number(conversation?.support_group_id) !== supportGroupId(env)) throw new Error('group_route_changed_during_provision');
    if (existing && Number(existing.support_group_id) !== supportGroupId(env))
      await dbRun(db, `UPDATE service_topic_history SET replacement_thread_id=?
        WHERE bot_id=? AND user_id=? AND replacement_group_id=? AND replacement_thread_id IS NULL`,
        conversation.thread_id, bot.id, user.id, supportGroupId(env));
    try {
      await refreshTopicPanel(bot, env, conversation);
    } catch (panelError) { if (panelError instanceof RecoveryBudgetExhausted) throw panelError;
      log(bot, "error", "topic_panel_create_failed", { user_id: user.id, thread_id: createdThreadId, message: panelError.message });
    }
    try { await dbRun(db, "DELETE FROM conversation_provision_attempts WHERE bot_id = ? AND user_id = ? AND completed_at IS NOT NULL", bot.id, user.id); } catch (cleanupError) { if (cleanupError instanceof RecoveryBudgetExhausted) throw cleanupError; log(bot, "error", "conversation_provision_marker_cleanup_failed", { user_id: user.id, message: cleanupError.message }); }
    log(bot, "info", "conversation_created", { user_id: user.id, thread_id: createdThreadId });
    return conversation;
  } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error;
    const persistedAttempt = await dbOne(db, "SELECT completed_at, thread_id FROM conversation_provision_attempts WHERE bot_id = ? AND user_id = ?", bot.id, user.id);
    if (createdThreadId && !persistedAttempt?.completed_at) {
      const compensation = await telegram(bot, "deleteForumTopic", {
        chat_id: supportGroupId(env),
        message_thread_id: createdThreadId,
      }, env);
      if (!compensation.ok) {
        log(bot, "error", "orphan_topic_cleanup_failed", { thread_id: createdThreadId, description: compensation.description });
        await markConversationProvisionUncertain(db, bot, user, `Topic ${createdThreadId} cleanup failed: ${compensation.description}`);
        throw terminalDispatchError("Created Topic could not be safely compensated; automatic replay suppressed");
      }
      await dbRun(db, "DELETE FROM conversation_provision_attempts WHERE bot_id = ? AND user_id = ? AND completed_at IS NULL", bot.id, user.id);
    }
    throw error;
  } finally {
    await dbRun(db, "DELETE FROM conversation_locks WHERE bot_id = ? AND user_id = ? AND owner_token = ?", bot.id, user.id, lockOwner);
  }
}

function isTopicClosedError(description) {
  const value = String(description || "").toLowerCase();
  return value.includes("topic_closed")
    || value.includes("topic is closed")
    || value.includes("topic closed")
    || value.includes("message thread is closed");
}

async function activeConversationReopenEffect(db, botId, userId) {
  return dbOne(db, "SELECT * FROM conversation_reopen_effects WHERE bot_id = ? AND user_id = ? AND completed_at IS NULL ORDER BY id DESC LIMIT 1", botId, userId);
}

async function queueReopenBusinessMessage(db, bot, message, updateId) {
  if (!message?.from?.id || !Number.isSafeInteger(Number(updateId))) return null;
  const media = extractAlbumMedia(message);
  const inserted = await dbRun(
    db,
    `INSERT INTO reopen_business_messages
      (bot_id, user_id, update_id, source_chat_id, source_message_id, reply_to_source_message_id,
       source_username, source_first_name, source_last_name, media_group_id, media_type, file_id,
       caption, caption_entities_json, has_spoiler, created_at, source_created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bot_id, update_id) DO NOTHING`,
    bot.id,
    Number(message.from.id),
    Number(updateId),
    Number(message.chat.id),
    Number(message.message_id),
    Number.isSafeInteger(Number(message.reply_to_message?.message_id)) ? Number(message.reply_to_message.message_id) : null,
    message.from.username || null,
    message.from.first_name || null,
    message.from.last_name || null,
    message.media_group_id ? String(message.media_group_id) : null,
    media?.type || null,
    media?.media || null,
    media?.caption ? media.caption.slice(0, 1024) : null,
    media?.captionEntities?.length ? JSON.stringify(media.captionEntities) : null,
    media?.hasSpoiler ? 1 : 0,
    nowIso(),
    sourceCreatedAt(message),
  );
  // Retries are not new input: do not spend their delivery budget on reloading
  // the same row or restart the album settling window for an existing message.
  if (inserted.meta?.changes > 0) {
    await dbRun(db, "UPDATE conversation_reopen_effects SET last_business_queued_at = ? WHERE bot_id = ? AND user_id = ? AND completed_at IS NULL", nowIso(), bot.id, Number(message.from.id));
  }
}

async function discardReopenBusinessMessage(db, botId, updateId) {
  if (!Number.isSafeInteger(Number(updateId))) return;
  await dbRun(db, "DELETE FROM reopen_business_messages WHERE bot_id = ? AND update_id = ? AND delivered_at IS NULL", botId, Number(updateId));
}

async function claimConversationReopenEffectLease(db, effectId) {
  const ownerToken = crypto.randomUUID();
  const claimed = await dbRun(
    db,
    `UPDATE conversation_reopen_effects
        SET recovery_owner_token = ?, recovery_lease_expires_at = ?
      WHERE id = ? AND completed_at IS NULL
        AND (recovery_owner_token IS NULL OR recovery_lease_expires_at IS NULL OR recovery_lease_expires_at <= ?)`,
    ownerToken, isoAfter(REOPEN_RECOVERY_LEASE_MS), effectId, nowIso(),
  );
  return claimed.meta?.changes === 1 ? ownerToken : null;
}

async function renewConversationReopenEffectLease(db, effectId, ownerToken) {
  const renewed = await dbRun(
    db,
    "UPDATE conversation_reopen_effects SET recovery_lease_expires_at = ? WHERE id = ? AND recovery_owner_token = ? AND recovery_lease_expires_at > ? AND completed_at IS NULL",
    isoAfter(REOPEN_RECOVERY_LEASE_MS), effectId, ownerToken, nowIso(),
  );
  if (renewed.meta?.changes !== 1) throw new Error("Conversation reopen recovery lease was lost");
}

async function releaseConversationReopenEffectLease(db, effectId, ownerToken) {
  await dbRun(db, "UPDATE conversation_reopen_effects SET recovery_owner_token = NULL, recovery_lease_expires_at = NULL WHERE id = ? AND recovery_owner_token = ?", effectId, ownerToken);
}

function reopenAuditContext(effect, active) {
  return `reopen_effect_id=${effect.id}; old_topic=${effect.old_thread_id}; new_topic=${active.thread_id}`;
}

async function ensureConversationReopenAudit(db, bot, effect, active) {
  const context = reopenAuditContext(effect, active);
  const statements = [
    db.prepare("INSERT OR IGNORE INTO operator_audit (bot_id, user_id, actor_type, action, reason, result, created_at, reopen_effect_id) VALUES (?, ?, 'system', ?, ?, 'success', ?, ?)")
      .bind(bot.id, effect.user_id, "conversation_reopened_by_user", context, nowIso(), effect.id),
  ];
  if (Number(effect.recreated) === 1) {
    statements.push(
      db.prepare("INSERT OR IGNORE INTO operator_audit (bot_id, user_id, actor_type, action, reason, result, created_at, reopen_effect_id) VALUES (?, ?, 'system', ?, ?, 'success', ?, ?)")
        .bind(bot.id, effect.user_id, "conversation_topic_restored", context, nowIso(), effect.id),
    );
  }
  await db.batch(statements);
}

async function refreshReopenBusinessCompletion(db, effect) {
  const pending = await dbOne(
    db,
    "SELECT COUNT(*) AS count FROM reopen_business_messages WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL AND failure_code IS NULL",
    effect.bot_id, effect.user_id,
  );
  if (Number(pending?.count || 0) === 0) {
    await dbRun(db, "UPDATE conversation_reopen_effects SET business_delivered_at = COALESCE(business_delivered_at, ?) WHERE id = ?", nowIso(), effect.id);
  }
}

async function completeConversationReopenEffect(db, effectId) {
  const effect = await dbOne(db, "SELECT * FROM conversation_reopen_effects WHERE id = ?", effectId);
  if (!effect) return;
  await refreshReopenBusinessCompletion(db, effect);
  await dbRun(
    db,
    `UPDATE conversation_reopen_effects
        SET completed_at = ?
      WHERE id = ? AND completed_at IS NULL AND business_delivered_at IS NOT NULL AND panel_refreshed_at IS NOT NULL
        AND (marker_delivered_at IS NOT NULL OR ((marker_outcome_uncertain_at IS NOT NULL OR marker_failure IS NOT NULL) AND marker_alerted_at IS NOT NULL))
        AND NOT EXISTS (
          SELECT 1 FROM reopen_business_messages b
           WHERE b.bot_id = conversation_reopen_effects.bot_id AND b.user_id = conversation_reopen_effects.user_id
             AND b.delivered_at IS NULL AND (b.failure_code IS NULL OR b.failure_alerted_at IS NULL)
        )`,
    nowIso(), effectId,
  );
}

async function finalizeConversationReopenAfterDelivery(db, botId, userId, sourceMessageIds = []) {
  const ids = [...new Set((sourceMessageIds || []).map(Number).filter(Number.isSafeInteger))];
  if (ids.length) {
    for (const sourceMessageId of ids) {
      await dbRun(
        db,
        "UPDATE reopen_business_messages SET delivered_at = COALESCE(delivered_at, ?), failure_code = NULL, failure_detail = NULL WHERE bot_id = ? AND user_id = ? AND source_message_id = ?",
        nowIso(), botId, userId, sourceMessageId,
      );
    }
  }
  const effect = await activeConversationReopenEffect(db, botId, userId);
  if (!effect) return;
  await refreshReopenBusinessCompletion(db, effect);
  await completeConversationReopenEffect(db, effect.id);
}

async function alertConversationReopenEffect(bot, env, effect, active) {
  if (effect.marker_alerted_at || (!effect.marker_outcome_uncertain_at && !effect.marker_failure)) return;
  const reason = effect.marker_outcome_uncertain_at ? "delivery outcome is unknown" : effect.marker_failure;
  const text = `⚠️ Reopen marker requires attention. service=${bot.displayName}; user=${effect.user_id}; topic=${active.thread_id}; reason=${reason}`;
  const alert = await telegram(bot, "sendMessage", { chat_id: supportGroupId(env), text }, env);
  if (alert.ok) await dbRun(requireDb(env), "UPDATE conversation_reopen_effects SET marker_alerted_at = COALESCE(marker_alerted_at, ?) WHERE id = ?", nowIso(), effect.id);
}

async function conversationReopenEligibility(db, bot, userId) {
  if (!await persistedBotEnabled(db, bot.id)) return { allowed: false, cancel: false, reason: "bot_disabled" };
  if (await dbOne(db, "SELECT 1 FROM banned_users WHERE bot_id = ? AND user_id = ?", bot.id, userId)) {
    return { allowed: false, cancel: true, reason: "banned" };
  }
  const state = await dbOne(db, "SELECT muted_until, manual_restricted_until, verification_required FROM user_abuse_state WHERE bot_id = ? AND user_id = ?", bot.id, userId);
  if (!state) return { allowed: true, cancel: false, reason: null };
  if (isManuallyRestricted(state)) return { allowed: false, cancel: true, reason: "manual_restriction" };
  if (isFuture(state.muted_until)) return { allowed: false, cancel: false, reason: "muted" };
  if (Number(state.verification_required || 0) === 1) return { allowed: false, cancel: false, reason: "verification_required" };
  return { allowed: true, cancel: false, reason: null };
}

async function cancelConversationReopenEffect(db, effect, reason) {
  const timestamp = nowIso();
  await db.batch([
    db.prepare("UPDATE conversation_reopen_effects SET cancelled_at = COALESCE(cancelled_at, ?), cancellation_reason = COALESCE(cancellation_reason, ?), completed_at = COALESCE(completed_at, ?), recovery_owner_token = NULL, recovery_lease_expires_at = NULL WHERE id = ? AND completed_at IS NULL").bind(timestamp, reason, timestamp, effect.id),
    db.prepare("DELETE FROM reopen_business_messages WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL").bind(effect.bot_id, effect.user_id),
  ]);
}

async function recoverReopenQueueEntry(bot, env, effect) {
  const db = requireDb(env);
  const owner = await claimAbuseDecisionLock(db, bot.id, Number(effect.user_id));
  try {
    const eligibility = await conversationReopenEligibility(db, bot, Number(effect.user_id));
    if (!eligibility.allowed) {
      if (eligibility.cancel && !env.MANUAL_DELIVERY_EVENTS) await cancelConversationReopenEffect(db, effect, eligibility.reason);
      return { reason: eligibility.reason };
    }
    const user = { id: effect.user_id, username: effect.username, first_name: effect.first_name || 'User', last_name: effect.last_name };
    if (!effect.conversation_id) {
      const source = await dbOne(db, 'SELECT source_username, source_first_name, source_last_name FROM reopen_business_messages WHERE bot_id = ? AND user_id = ? ORDER BY id LIMIT 1', bot.id, effect.user_id);
      Object.assign(user, { username: source?.source_username, first_name: source?.source_first_name || 'User', last_name: source?.source_last_name });
    }
    const conversation = effect.conversation_id ? { ...effect, id: effect.conversation_id }
      : await provisionConversation(bot, env, user, null);
    await reopenConversationForUserMessage(bot, env, conversation, user);
  } finally {
    await releaseAbuseDecisionLock(db, bot.id, Number(effect.user_id), owner);
  }
}

export async function runManualDeliveryTarget(env, target) {
  const db = requireDb(env);
  const bot = resolveBot(env, target.botId);
  if (!bot?.enabled || !await persistedBotEnabled(db, bot.id)) return { reason: 'disabled' };
  const activeGroup = await resolveActiveGroup(db, bot.id, env);
  if (!activeGroup) return { reason: 'group_not_connected' };
  if (target.kind === 'album' && target.direction === 'support_to_user'
    && Number(target.sourceChatId) !== activeGroup) return { reason: 'historical_topic' };
  env = { ...env, SUPPORT_GROUP_ID: String(activeGroup) };
  assertTelegramReady(db, bot);
  if (target.kind === 'reopen') {
    const effect = await dbOne(db, `SELECT e.*, c.id AS conversation_id, c.thread_id, c.status, c.username, c.first_name, c.last_name, c.support_group_id, c.panel_message_id, c.topic_state_update_id
      FROM conversation_reopen_effects e LEFT JOIN conversations c ON c.bot_id=e.bot_id AND c.user_id=e.user_id
      WHERE e.bot_id=? AND e.user_id=? AND e.completed_at IS NULL ORDER BY e.created_at LIMIT 1`, bot.id, target.userId);
    if (!effect) return { reason: 'missing_effect' };
    return recoverReopenQueueEntry(bot, env, effect);
  }
  if (target.kind === 'album') return flushMediaGroup(bot, env, [bot.id, target.direction, target.groupId, Number(target.sourceChatId)], 0);
  if (target.kind === 'challenge') {
    const challenge = await dbOne(db, "SELECT * FROM verification_challenges WHERE id=? AND bot_id=? AND user_id=? AND status='passed' AND flushed_at IS NULL", target.id, bot.id, target.userId);
    if (challenge) return finishPassedChallenge(env, challenge);
  }
  if (target.kind === 'release') return flushReleasedPendingMessages(bot, env, Number(target.userId));
}

async function markConversationClosedForRouting(db, botId, userId, threadId) {
  await dbRun(db, "UPDATE conversations SET status = 'closed' WHERE bot_id = ? AND user_id = ? AND thread_id = ?", botId, userId, threadId);
}

function reopenRoutingError(value) {
  const description = value instanceof Error ? value.message : String(value || "");
  return isTopicClosedError(description) || isMissingTopicError(description) || description.toLowerCase().includes("redirected");
}

async function deliverReopenBusinessQueue(bot, env, active, effect, recoveryOwnerToken) {
  const db = requireDb(env);
  await renewConversationReopenEffectLease(db, effect.id, recoveryOwnerToken);
  const rows = await dbAll(
    db,
    "SELECT * FROM reopen_business_messages WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL AND failure_code IS NULL ORDER BY source_message_id, id",
    bot.id, effect.user_id,
  );
  const items = rows.results || [];
  if (!items.length) return;
  const processedAlbums = new Set();
  for (const row of items) {
    await renewConversationReopenEffectLease(db, effect.id, recoveryOwnerToken);
    if (row.media_group_id) {
      if (processedAlbums.has(row.media_group_id)) continue;
      processedAlbums.add(row.media_group_id);
      const albumRows = items.filter((item) => item.media_group_id === row.media_group_id);
      if (!albumRows.every((item) => item.media_type && item.file_id)) {
        for (const item of albumRows) {
          await dbRun(db, "UPDATE reopen_business_messages SET failure_code = 'reopen_album_metadata_missing', failure_detail = 'Album metadata was unavailable for durable recovery' WHERE id = ?", item.id);
        }
        continue;
      }
      const latestQueued = Math.max(...albumRows.map((item) => Date.parse(item.created_at) || 0), Date.parse(effect.last_business_queued_at || '') || 0);
      if (Date.now() - latestQueued < Math.max(50, Math.min(asPositiveInteger(env.ALBUM_SETTLE_MS, DEFAULT_ALBUM_SETTLE_MS), 500))) continue;
      const key = [bot.id, "user_to_support", String(row.media_group_id), Number(row.source_chat_id)];
      const staleReceivedAt = Date.now() - asPositiveInteger(env.ALBUM_SETTLE_MS, DEFAULT_ALBUM_SETTLE_MS) - 100;
      for (const item of albumRows) {
        await dbRun(
          db,
          "INSERT INTO media_groups (bot_id, direction, media_group_id, source_chat_id, target_chat_id, thread_id, user_id, operator_id, last_received_at, version, claimed_at, claimed_version, created_at) VALUES (?, 'user_to_support', ?, ?, ?, ?, ?, NULL, ?, 1, NULL, NULL, ?) ON CONFLICT(bot_id, direction, media_group_id, source_chat_id) DO UPDATE SET target_chat_id = excluded.target_chat_id, thread_id = excluded.thread_id, user_id = excluded.user_id, last_received_at = excluded.last_received_at, version = media_groups.version + 1",
          bot.id, String(item.media_group_id), Number(item.source_chat_id), supportGroupId(env), Number(active.thread_id), Number(item.user_id), staleReceivedAt, item.created_at,
        );
        await dbRun(
          db,
          "INSERT INTO media_group_items (bot_id, direction, media_group_id, source_chat_id, message_id, media_type, file_id, caption, caption_entities_json, has_spoiler, received_at, source_created_at) VALUES (?, 'user_to_support', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(bot_id, direction, media_group_id, source_chat_id, message_id) DO NOTHING",
          bot.id, String(item.media_group_id), Number(item.source_chat_id), Number(item.source_message_id), item.media_type, item.file_id, item.caption || '', item.caption_entities_json || null, Number(item.has_spoiler) === 1 ? 1 : 0, staleReceivedAt, item.source_created_at || item.created_at,
        );
      }
      try {
        await flushMediaGroup(bot, env, key, 0, true, 1);
      } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error;
        if (reopenRoutingError(error)) {
          await markConversationClosedForRouting(db, bot.id, effect.user_id, active.thread_id);
        }
        throw error;
      }
      continue;
    }

    const probe = await probeForumThread(bot, env, active.thread_id, 6 + (row.reply_to_source_message_id ? 1 : 0));
    if (!probe.ok) {
      if (reopenRoutingError(probe.description)) {
        await markConversationClosedForRouting(db, bot.id, effect.user_id, active.thread_id);
        throw new Error(`Reopen business routing changed: ${probe.description}`);
      }
      if (isDeliveryOutcomeUncertain(probe) || isRetryableTelegramFailure(probe)) throw new Error(`Topic probe failed before reopen business delivery: ${probe.description}`);
      await dbRun(db, "UPDATE reopen_business_messages SET failure_code = 'telegram_source_unavailable', failure_detail = ? WHERE id = ?", String(probe.description || '').slice(0, 500), row.id);
      continue;
    }
    const replyParameters = await mappedReplyParameters(db, bot.id, row.user_id, active.thread_id, row.reply_to_source_message_id, "user_to_support", active.support_group_id);
    const body = { chat_id: supportGroupId(env), from_chat_id: Number(row.source_chat_id), message_id: Number(row.source_message_id), message_thread_id: Number(active.thread_id) };
    if (replyParameters) body.reply_parameters = replyParameters;
    const details = {
      direction: "user_to_support",
      sourceChatId: Number(row.source_chat_id),
      sourceMessageId: Number(row.source_message_id),
      sourceCreatedAt: row.source_created_at || row.created_at,
      userId: Number(row.user_id),
      threadId: Number(active.thread_id),
      targetChatId: supportGroupId(env),
      method: "copyMessage",
    };
    const attempt = await runMessageDeliveryAttempt(bot, env, details, () => telegram(bot, "copyMessage", body, env));
    const result = attempt.result;
    if (!result.ok) {
      if (reopenRoutingError(result.description)) {
        await markConversationClosedForRouting(db, bot.id, effect.user_id, active.thread_id);
        throw new Error(`Reopen business routing changed: ${result.description}`);
      }
      if (isDeliveryOutcomeUncertain(result)) {
        await dbRun(db, "UPDATE reopen_business_messages SET failure_code = 'telegram_delivery_outcome_unknown', failure_detail = ? WHERE id = ?", String(result.description || '').slice(0, 500), row.id);
        continue;
      }
      if (isRetryableTelegramFailure(result)) throw new Error(`Reopen business delivery failed: ${result.description}`);
      await dbRun(db, "UPDATE reopen_business_messages SET failure_code = 'telegram_source_unavailable', failure_detail = ? WHERE id = ?", String(result.description || '').slice(0, 500), row.id);
      continue;
    }
    await persistSingleDeliveryBookkeeping(bot, db, details, attempt.startedAt, result.result?.message_id, {
      botId: bot.id,
      userId: Number(row.user_id),
      threadId: Number(active.thread_id),
      userMessageId: Number(row.source_message_id),
      supportMessageId: Number(result.result?.message_id),
    });
    await dbRun(db, "UPDATE reopen_business_messages SET delivered_at = COALESCE(delivered_at, ?), target_message_id = COALESCE(target_message_id, ?) WHERE id = ?", nowIso(), Number(result.result?.message_id) || null, row.id);
  }
  // The caller completes the effect after draining the queue. Repeating that
  // bookkeeping here can consume the remaining Free budget before completion.
}

async function recoverConversationReopenEffects(bot, env, active, effect, recoveryOwnerToken) {
  const db = requireDb(env);
  await renewConversationReopenEffectLease(db, effect.id, recoveryOwnerToken);
  await ensureConversationReopenAudit(db, bot, effect, active);
  let current = await activeConversationReopenEffect(db, bot.id, effect.user_id) || effect;
  const recreated = Number(current.recreated) === 1;
  if (!current.marker_delivered_at && !current.marker_outcome_uncertain_at && !current.marker_failure) {
    if (current.marker_request_started_at) {
      await dbRun(db, "UPDATE conversation_reopen_effects SET marker_outcome_uncertain_at = COALESCE(marker_outcome_uncertain_at, ?) WHERE id = ?", nowIso(), current.id);
    } else {
      if (!current.marker_prepared_at) {
        await dbRun(db, "UPDATE conversation_reopen_effects SET marker_prepared_at = COALESCE(marker_prepared_at, ?) WHERE id = ? AND marker_delivered_at IS NULL AND marker_outcome_uncertain_at IS NULL AND marker_failure IS NULL", nowIso(), current.id);
      }
      await renewConversationReopenEffectLease(db, current.id, recoveryOwnerToken);
      recoveryCheckpoint(db, 3);
      assertTelegramReady(db, bot);
      const gate = telegramRequestGate(db, bot);
      const requestStartedAt = nowIso();
      const marked = await dbRun(db, "UPDATE conversation_reopen_effects SET marker_request_started_at = ? WHERE id = ? AND marker_request_started_at IS NULL AND marker_delivered_at IS NULL AND marker_outcome_uncertain_at IS NULL AND marker_failure IS NULL" + gate.sql, requestStartedAt, current.id, ...gate.params);
      if (marked.meta?.changes === 1) {
        const markerCopy = {
          ru: ["🔄 Пользователь возобновил обращение.", "🔄 Пользователь возобновил обращение. Предыдущая тема была удалена."],
          en: ["🔄 The user reopened the conversation.", "🔄 The user reopened the conversation. The previous topic had been deleted."],
          es: ["🔄 El usuario reabrió la conversación.", "🔄 El usuario reabrió la conversación. El tema anterior se había eliminado."],
          zh: ["🔄 用户重新开启了会话。", "🔄 用户重新开启了会话。之前的话题已被删除。"],
        }[bot.locale] || ["🔄 The user reopened the conversation.", "🔄 The user reopened the conversation. The previous topic had been deleted."];
        const marker = markerCopy[recreated ? 1 : 0];
        let result = await telegram(bot, "sendMessage", { chat_id: supportGroupId(env), message_thread_id: active.thread_id, text: marker }, env);
        if (result.ok && !deliveredToExpectedThread(result, active.thread_id)) {
          const removed = await removeRedirectedMessage(bot, env, result, active.thread_id);
          result = { ok: false, description: "Telegram redirected the reopen marker outside the expected Topic", deliveryUncertain: !removed };
        }
        if (result.ok) {
          await dbRun(db, "UPDATE conversation_reopen_effects SET marker_delivered_at = ?, marker_message_id = ?, marker_request_started_at = NULL WHERE id = ? AND marker_request_started_at = ?", nowIso(), Number(result.result?.message_id) || null, current.id, requestStartedAt);
        } else if (reopenRoutingError(result.description)) {
          await dbRun(db, "UPDATE conversation_reopen_effects SET marker_request_started_at = NULL WHERE id = ? AND marker_request_started_at = ?", current.id, requestStartedAt);
          await markConversationClosedForRouting(db, bot.id, current.user_id, active.thread_id);
          throw new Error(`Reopen marker routing changed: ${result.description}`);
        } else if (isDeliveryOutcomeUncertain(result)) {
          await dbRun(db, "UPDATE conversation_reopen_effects SET marker_outcome_uncertain_at = COALESCE(marker_outcome_uncertain_at, ?) WHERE id = ? AND marker_request_started_at = ?", nowIso(), current.id, requestStartedAt);
        } else if (isRetryableTelegramFailure(result)) {
          await dbRun(db, "UPDATE conversation_reopen_effects SET marker_request_started_at = NULL WHERE id = ? AND marker_request_started_at = ?", current.id, requestStartedAt);
          throw new Error(`reopen marker delivery failed: ${result.description}`);
        } else {
          await dbRun(db, "UPDATE conversation_reopen_effects SET marker_failure = ?, marker_request_started_at = NULL WHERE id = ? AND marker_request_started_at = ?", String(result.description || "permanent Telegram failure").slice(0, 500), current.id, requestStartedAt);
        }
      }
    }
  }
  current = await activeConversationReopenEffect(db, bot.id, effect.user_id) || current;
  await alertConversationReopenEffect(bot, env, current, active);
  if (!current.panel_refreshed_at) {
    await renewConversationReopenEffectLease(db, current.id, recoveryOwnerToken);
    try {
      await refreshTopicPanel(bot, env, active);
      await dbRun(db, "UPDATE conversation_reopen_effects SET panel_refreshed_at = COALESCE(panel_refreshed_at, ?) WHERE id = ?", nowIso(), current.id);
    } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error;
      if (reopenRoutingError(error)) await markConversationClosedForRouting(db, bot.id, current.user_id, active.thread_id);
      throw error;
    }
  }
  await deliverReopenBusinessQueue(bot, env, active, current, recoveryOwnerToken);
  await completeConversationReopenEffect(db, current.id);
}

async function reopenConversationForUserMessage(bot, env, conversation, user, trigger = null) {
  const db = requireDb(env);
  let effect = await activeConversationReopenEffect(db, bot.id, user.id);
  if (conversation.status !== "closed" && !effect) return conversation;
  if (!effect) {
    await dbRun(db, "INSERT OR IGNORE INTO conversation_reopen_effects (bot_id, user_id, old_thread_id, created_at) VALUES (?, ?, ?, ?)", bot.id, user.id, conversation.thread_id, nowIso());
    effect = await activeConversationReopenEffect(db, bot.id, user.id);
    if (!effect) throw new Error("Conversation reopen effect could not be claimed");
  }
  if (trigger?.message && Number.isSafeInteger(Number(trigger.updateId))) {
    await queueReopenBusinessMessage(db, bot, trigger.message, Number(trigger.updateId));
    effect = await activeConversationReopenEffect(db, bot.id, user.id) || effect;
  }
  const recoveryOwnerToken = await claimConversationReopenEffectLease(db, effect.id);
  if (!recoveryOwnerToken) throw new Error("Conversation reopen recovery is already in progress; retry this update");
  try {
    let active = await findConversation(db, bot.id, user.id) || conversation;
    effect = await activeConversationReopenEffect(db, bot.id, user.id) || effect;
    let recreated = Number(effect.recreated) === 1 || Number(active.thread_id) !== Number(effect.old_thread_id);
    if (active.status === "closed") {
      await renewConversationReopenEffectLease(db, effect.id, recoveryOwnerToken);
      const reopened = await telegram(bot, "reopenForumTopic", {
        chat_id: supportGroupId(env),
        message_thread_id: active.thread_id,
      }, env);
      if (!reopened.ok && isMissingTopicError(reopened.description)) {
        const removed = await invalidateConversationTopic(db, bot.id, user.id, active.thread_id, true);
        // D1 includes storage-topic trigger writes in meta.changes. The unique
        // bot/user/thread predicate still removes at most one conversation.
        if (!(removed.meta?.changes > 0)) {
          const current = await findConversation(db, bot.id, user.id);
          if (!current) throw new Error("Closed conversation disappeared before it could be recreated");
          active = current;
        } else {
          active = await provisionConversation(bot, env, user);
        }
        recreated = Number(active.thread_id) !== Number(effect.old_thread_id);
      } else if (!reopened.ok && !isAlreadyTopicState(reopened.description, "open")) {
        throw new Error(`reopenForumTopic failed: ${reopened.description}`);
      } else {
        const opened = await dbRun(db, "UPDATE conversations SET status = 'open' WHERE id = ? AND status = 'closed'", active.id);
        if (!(opened.meta?.changes > 0)) {
          const current = await findConversation(db, bot.id, user.id);
          if (!current) throw new Error("Conversation disappeared after Telegram reopened its Topic");
          active = current;
        } else active = { ...active, status: "open" };
      }
    }
    await dbRun(db, "UPDATE conversation_reopen_effects SET new_thread_id = ?, recreated = ?, opened_at = COALESCE(opened_at, ?) WHERE id = ?", active.thread_id, recreated ? 1 : 0, nowIso(), effect.id);
    effect = await activeConversationReopenEffect(db, bot.id, user.id) || { ...effect, new_thread_id: active.thread_id, recreated: recreated ? 1 : 0 };
    await recoverConversationReopenEffects(bot, env, active, effect, recoveryOwnerToken);
    log(bot, "info", "conversation_reopened_by_user", { user_id: user.id, thread_id: active.thread_id, recreated });
    return active;
  } finally {
    try { await releaseConversationReopenEffectLease(db, effect.id, recoveryOwnerToken); }
    catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error; log(bot, "error", "conversation_reopen_lease_release_failed", { user_id: user.id, message: error.message }); }
  }
}

async function recordMapping(bot, db, mapping) {
  try {
    await dbRun(
      db,
      `INSERT OR IGNORE INTO message_mappings (bot_id, user_id, thread_id, support_group_id, user_message_id, support_message_id, created_at)
       VALUES (?, ?, ?, COALESCE(?, (SELECT support_group_id FROM conversations WHERE bot_id=? AND user_id=?)), ?, ?, ?)`,
      mapping.botId,
      mapping.userId,
      mapping.threadId,
      mapping.groupId ?? null,
      mapping.botId,
      mapping.userId,
      mapping.userMessageId ?? null,
      mapping.supportMessageId ?? null,
      nowIso(),
    );
    return true;
  } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error;
    // Delivery already happened. Keep the durable delivery row so Cron can repair this mapping.
    log(bot, "error", "message_mapping_failed_after_delivery", { message: error.message, ...mapping });
    return false;
  }
}

function sourceCreatedAt(message) {
  const seconds = Number(message?.date);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds < 8640000000000
    ? new Date(seconds * 1000).toISOString() : nowIso();
}

async function beginMessageDeliveryAttempt(db, bot, details) {
  const startedAt = nowIso();
  let inserted = await dbRun(db, `INSERT INTO message_delivery_attempts
    (bot_id, direction, source_chat_id, source_message_id, user_id, thread_id, target_chat_id, method, started_at, source_created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bot_id, direction, source_chat_id, source_message_id) DO NOTHING`,
    bot.id, details.direction, details.sourceChatId, details.sourceMessageId, details.userId, details.threadId, details.targetChatId, details.method, startedAt, details.sourceCreatedAt || startedAt);
  if (inserted.meta?.changes > 0) return { status: "acquired", startedAt };
  let row = await dbOne(db, "SELECT * FROM message_delivery_attempts WHERE bot_id = ? AND direction = ? AND source_chat_id = ? AND source_message_id = ?", bot.id, details.direction, details.sourceChatId, details.sourceMessageId);
  if (row?.completed_at && Number.isSafeInteger(Number(row.target_message_id))) return { status: "completed", row };
  if (row?.request_started_at || row?.failure_code) {
    if (!row.failure_code) await markMessageDeliveryUncertain(db, bot, details, row.started_at, "Interrupted message delivery has no confirmed result");
    return { status: "uncertain", row };
  }
  if (row) {
    const age = Date.now() - Date.parse(row.started_at || "");
    if (!Number.isFinite(age) || age < LOCK_STALE_MS) return { status: "busy", row };
    const cleared = await dbRun(db, "DELETE FROM message_delivery_attempts WHERE bot_id = ? AND direction = ? AND source_chat_id = ? AND source_message_id = ? AND completed_at IS NULL AND request_started_at IS NULL AND started_at = ?", bot.id, details.direction, details.sourceChatId, details.sourceMessageId, row.started_at);
    if (cleared.meta?.changes !== 1) return { status: "busy", row };
    inserted = await dbRun(db, `INSERT INTO message_delivery_attempts
      (bot_id, direction, source_chat_id, source_message_id, user_id, thread_id, target_chat_id, method, started_at, source_created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id, direction, source_chat_id, source_message_id) DO NOTHING`,
      bot.id, details.direction, details.sourceChatId, details.sourceMessageId, details.userId, details.threadId, details.targetChatId, details.method, nowIso(), row.source_created_at || details.sourceCreatedAt || row.started_at);
    if (inserted.meta?.changes > 0) {
      const fresh = await dbOne(db, "SELECT started_at FROM message_delivery_attempts WHERE bot_id = ? AND direction = ? AND source_chat_id = ? AND source_message_id = ?", bot.id, details.direction, details.sourceChatId, details.sourceMessageId);
      return { status: "acquired", startedAt: fresh.started_at };
    }
  }
  row = await dbOne(db, "SELECT * FROM message_delivery_attempts WHERE bot_id = ? AND direction = ? AND source_chat_id = ? AND source_message_id = ?", bot.id, details.direction, details.sourceChatId, details.sourceMessageId);
  return row?.request_started_at ? { status: "uncertain", row } : { status: "busy", row };
}

async function markMessageDeliveryRequestStarted(db, bot, details, startedAt) {
  assertTelegramReady(db, bot);
  const gate = telegramRequestGate(db, bot);
  recoveryCheckpoint(db, details.direction === "support_to_user" ? 4 : 3);
  const requestStartedAt = nowIso();
  const marked = await dbRun(db, "UPDATE message_delivery_attempts SET request_started_at = ? WHERE bot_id = ? AND direction = ? AND source_chat_id = ? AND source_message_id = ? AND started_at = ? AND completed_at IS NULL AND request_started_at IS NULL" + gate.sql, requestStartedAt, bot.id, details.direction, details.sourceChatId, details.sourceMessageId, startedAt, ...gate.params);
  if (marked.meta?.changes !== 1) throw new Error("Message delivery request-start marker could not be saved");
  return requestStartedAt;
}

async function clearMessageDeliveryAttempt(db, bot, details, startedAt) {
  await dbRun(db, "DELETE FROM message_delivery_attempts WHERE bot_id = ? AND direction = ? AND source_chat_id = ? AND source_message_id = ? AND started_at = ? AND completed_at IS NULL", bot.id, details.direction, details.sourceChatId, details.sourceMessageId, startedAt);
}

async function markMessageDeliveryUncertain(db, bot, details, startedAt, description) {
  await dbRun(db, "UPDATE message_delivery_attempts SET failure_code = COALESCE(failure_code, 'telegram_delivery_outcome_unknown'), failure_detail = COALESCE(failure_detail, ?) WHERE bot_id = ? AND direction = ? AND source_chat_id = ? AND source_message_id = ? AND started_at = ? AND completed_at IS NULL AND request_started_at IS NOT NULL", String(description || "").slice(0, 500), bot.id, details.direction, details.sourceChatId, details.sourceMessageId, startedAt);
}

async function completeMessageDeliveryAttempt(db, bot, details, startedAt, targetMessageId) {
  const completed = await dbRun(db, "UPDATE message_delivery_attempts SET completed_at = ?, target_message_id = ?, failure_code = NULL, failure_detail = NULL WHERE bot_id = ? AND direction = ? AND source_chat_id = ? AND source_message_id = ? AND started_at = ? AND completed_at IS NULL", nowIso(), Number(targetMessageId), bot.id, details.direction, details.sourceChatId, details.sourceMessageId, startedAt);
  if (!(completed.meta?.changes > 0)) throw new Error("Message delivery completion fence could not be persisted");
}

async function markMessageDeliveryMappingSynced(db, bot, details) {
  await dbRun(db, "UPDATE message_delivery_attempts SET mapping_synced_at = COALESCE(mapping_synced_at, ?) WHERE bot_id = ? AND direction = ? AND source_chat_id = ? AND source_message_id = ? AND completed_at IS NOT NULL", nowIso(), bot.id, details.direction, details.sourceChatId, details.sourceMessageId);
}

async function persistSingleDeliveryBookkeeping(bot, db, details, startedAt, targetMessageId, mapping) {
  const numericTargetId = Number(targetMessageId);
  let completionPersisted = !startedAt;
  let lastCompletionError = null;
  if (startedAt) {
    for (let attempt = 0; attempt < 5 && !completionPersisted; attempt++) {
      try {
        await completeMessageDeliveryAttempt(db, bot, details, startedAt, numericTargetId);
        completionPersisted = true;
      } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error;
        lastCompletionError = error;
        try {
          const row = await dbOne(db, "SELECT completed_at, target_message_id FROM message_delivery_attempts WHERE bot_id = ? AND direction = ? AND source_chat_id = ? AND source_message_id = ?", bot.id, details.direction, details.sourceChatId, details.sourceMessageId);
          if (row?.completed_at && Number(row.target_message_id) === numericTargetId) completionPersisted = true;
        } catch {}
        if (!completionPersisted && attempt < 4) await sleep(25 * (attempt + 1));
      }
    }
  }

  let mappingPersisted = false;
  for (let attempt = 0; attempt < 5 && !mappingPersisted; attempt++) {
    mappingPersisted = await recordMapping(bot, db, { ...mapping,
      groupId: details.direction === 'user_to_support' ? details.targetChatId : details.sourceChatId });
    if (!mappingPersisted && attempt < 4) await sleep(25 * (attempt + 1));
  }
  if (mappingPersisted) {
    try { await markMessageDeliveryMappingSynced(db, bot, details); }
    catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error; log(bot, "error", "delivery_mapping_marker_failed", { direction: details.direction, source_message_id: details.sourceMessageId, message: error.message }); }
  }
  if (!completionPersisted) {
    log(bot, "error", "single_delivery_completion_marker_exhausted", { direction: details.direction, source_message_id: details.sourceMessageId, target_message_id: numericTargetId, message: lastCompletionError?.message || "unknown D1 failure", mapping_persisted: mappingPersisted });
  }
  if (!completionPersisted && !mappingPersisted) {
    log(bot, "error", "single_delivery_bookkeeping_unrecoverable_during_d1_outage", { direction: details.direction, source_message_id: details.sourceMessageId, target_message_id: numericTargetId });
  }
  return { completionPersisted, mappingPersisted };
}

async function runMessageDeliveryAttempt(bot, env, details, send) {
  const db = requireDb(env);
  recoveryCheckpoint(db, 6);
  const attempt = await beginMessageDeliveryAttempt(db, bot, details);
  if (attempt.status === "completed") {
    return { result: { ok: true, result: { message_id: Number(attempt.row.target_message_id), ...(details.direction === "user_to_support" ? { message_thread_id: Number(details.threadId) } : {}) }, replayed: true }, startedAt: null, replayed: true };
  }
  if (attempt.status === "uncertain") {
    return { result: { ok: false, description: "Previous Telegram delivery outcome is uncertain", deliveryUncertain: true, retryable: false }, startedAt: null, replayed: true };
  }
  if (attempt.status === "busy") {
    return { result: { ok: false, description: "Delivery preparation is still in progress", deliveryUncertain: false, retryable: true }, startedAt: null, replayed: true };
  }
  await markMessageDeliveryRequestStarted(db, bot, details, attempt.startedAt);
  const result = await send();
  if (!result.ok) {
    if (isDeliveryOutcomeUncertain(result)) await markMessageDeliveryUncertain(db, bot, details, attempt.startedAt, result.description);
    else await clearMessageDeliveryAttempt(db, bot, details, attempt.startedAt);
  }
  return { result, startedAt: attempt.startedAt, replayed: false };
}

function deliveredToExpectedThread(result, expectedThreadId) {
  return result.ok && Number(result.result?.message_thread_id) === Number(expectedThreadId);
}

function isForwardUnsupportedError(description) {
  const value = String(description || "").toLowerCase();
  return value.includes("can't be forwarded")
    || value.includes("cannot be forwarded")
    || value.includes("message is protected")
    || value.includes("protected content");
}

async function mappedReplyParameters(db, botId, userId, threadId, sourceMessageId, direction, groupId) {
  if (!sourceMessageId) return null;
  const row = direction === "user_to_support"
    ? await dbOne(db, "SELECT support_message_id AS target_message_id FROM message_mappings WHERE bot_id = ? AND user_id = ? AND support_group_id = ? AND user_message_id = ? AND support_message_id IS NOT NULL ORDER BY id DESC LIMIT 1", botId, userId, groupId, sourceMessageId)
    : await dbOne(db, "SELECT user_message_id AS target_message_id FROM message_mappings WHERE bot_id = ? AND support_group_id = ? AND thread_id = ? AND support_message_id = ? AND user_message_id IS NOT NULL ORDER BY id DESC LIMIT 1", botId, groupId, threadId, sourceMessageId);
  return row?.target_message_id
    ? { message_id: Number(row.target_message_id), allow_sending_without_reply: true }
    : null;
}

async function removeRedirectedMessage(bot, env, result, expectedThreadId) {
  const messageId = result.result?.message_id;
  if (!messageId) return false;
  const removed = await telegram(bot, "deleteMessage", { chat_id: supportGroupId(env), message_id: messageId }, env);
  if (!removed.ok) {
    log(bot, "error", "redirected_message_cleanup_failed", {
      expected_thread_id: expectedThreadId,
      actual_thread_id: result.result?.message_thread_id,
      message_id: messageId,
      description: removed.description,
    });
    return false;
  }
  return true;
}

async function probeForumThread(bot, env, expectedThreadId, deliveryQueries = 6) {
  // A probe must leave enough budget for its cleanup and the delivery it tests.
  // Otherwise webhook retries only flash a temporary message and make no progress.
  const cleanupQueries = env.TELEGRAM_COOLDOWN_ENABLED === 'true' ? 2 : 0;
  recoveryCheckpoint(requireDb(env), cleanupQueries + deliveryQueries);
  const probe = await telegram(bot, "sendMessage", {
    chat_id: supportGroupId(env),
    message_thread_id: Number(expectedThreadId),
    text: "🔎",
    disable_notification: true,
  }, env);
  if (!probe.ok) return probe;

  const actualThreadId = probe.result?.message_thread_id;
  const probeMessageId = probe.result?.message_id;
  if (probeMessageId) {
    const removed = await telegram(bot, "deleteMessage", {
      chat_id: supportGroupId(env),
      message_id: probeMessageId,
    }, env);
    if (!removed.ok) {
      log(bot, "error", "topic_probe_cleanup_failed", {
        expected_thread_id: expectedThreadId,
        actual_thread_id: actualThreadId,
        message_id: probeMessageId,
        description: removed.description,
      });
    }
  }
  if (Number(actualThreadId) !== Number(expectedThreadId)) {
    return {
      ok: false,
      description: "Telegram redirected the Topic probe outside the expected Topic",
      retryable: false,
    };
  }
  return { ok: true };
}

function isSupportGroupUnavailable(result) {
  const description = String(result?.description || "").toLowerCase();
  return Number(result?.errorCode || result?.httpStatus) === 403
    || description.includes("not enough rights")
    || description.includes("bot is not a member")
    || description.includes("chat not found");
}

async function queueUnavailableInbound(bot, env, message, updateId) {
  const db = requireDb(env);
  await dbRun(db, `INSERT INTO pending_messages
    (bot_id, user_id, update_id, source_chat_id, source_message_id, source_username,
     source_first_name, source_last_name, created_at, source_created_at, failure_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'support_group_unavailable')
    ON CONFLICT(bot_id, update_id) DO NOTHING`,
    bot.id, Number(message.from.id), Number(updateId), Number(message.chat.id), Number(message.message_id),
    message.from.username || null, message.from.first_name || null, message.from.last_name || null,
    nowIso(), sourceCreatedAt(message));
  await dbRun(db, "UPDATE user_abuse_state SET pending_release_required = 1, updated_at = ? WHERE bot_id = ? AND user_id = ? AND verification_required = 0", nowIso(), bot.id, Number(message.from.id));
}

async function alertUnavailableInbound(bot, env, row) {
  const adminId = primaryOperatorId(env);
  const text = `⚠️ Сообщение клиента сохранено: ${bot.displayName}; клиент=${row.user_id}; сообщение=${row.source_message_id}. Проверьте доступ бота к группе; доставка возобновится после восстановления прав.`;
  const alert = env.MANAGER_BOT_TOKEN
    ? await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: "sendMessage", body: { chat_id: adminId, text }, timeoutMs: 10000 })
    : await telegram(bot, "sendMessage", { chat_id: adminId, text }, env);
  if (alert.ok) await dbRun(requireDb(env), "UPDATE pending_messages SET failure_alerted_at = COALESCE(failure_alerted_at, ?) WHERE id = ? AND failure_alerted_at IS NULL", nowIso(), row.id);
}

async function saveUnavailableInbound(bot, env, message, updateId, description) {
  await queueUnavailableInbound(bot, env, message, updateId);
  try {
    const row = await dbOne(requireDb(env), "SELECT id, user_id, source_message_id FROM pending_messages WHERE bot_id = ? AND update_id = ? AND failure_code = 'support_group_unavailable' AND failure_alerted_at IS NULL", bot.id, Number(updateId));
    if (row) await alertUnavailableInbound(bot, env, row);
  } catch (error) {
    log(bot, 'error', 'group_unavailable_alert_failed', { user_id: message.from.id, message: error.message });
  }
  log(bot, 'warn', 'user_delivery_queued_for_group_recovery', {
    user_id: message.from.id, source_message_id: message.message_id, description,
  });
}

async function forwardUserMessage(bot, env, message, conversation, allowRoutingRepair = true, updateId = null) {
  const db = requireDb(env);
  const body = { chat_id: supportGroupId(env), from_chat_id: message.chat.id, message_id: message.message_id, message_thread_id: conversation.thread_id };
  const replyParameters = await mappedReplyParameters(
    db,
    bot.id,
    message.from.id,
    conversation.thread_id,
    message.reply_to_message?.message_id,
    "user_to_support",
    conversation.support_group_id,
  );
  if (replyParameters) body.reply_parameters = replyParameters;
  const details = {
    direction: "user_to_support",
    sourceChatId: Number(message.chat.id),
    sourceMessageId: Number(message.message_id),
      sourceCreatedAt: sourceCreatedAt(message),
    userId: Number(message.from.id),
    threadId: Number(conversation.thread_id),
    targetChatId: supportGroupId(env),
    method: replyParameters ? "copyMessage" : "forwardMessage",
  };
  const initialMethod = details.method;
  let attempt;
  if (initialMethod === "copyMessage") {
    const probe = await probeForumThread(bot, env, conversation.thread_id);
    if (!probe.ok && (isDeliveryOutcomeUncertain(probe) || isRetryableTelegramFailure(probe))) {
      throw new Error(`Topic probe failed before user delivery: ${probe.description}`);
    }
    attempt = probe.ok
      ? await runMessageDeliveryAttempt(bot, env, details, () => telegram(bot, "copyMessage", body, env))
      : { result: probe, startedAt: null, replayed: false };
  } else {
    attempt = await runMessageDeliveryAttempt(bot, env, details, () => telegram(bot, "forwardMessage", body, env));
  }
  let result = attempt.result;
  if (initialMethod === "forwardMessage" && result.ok && !deliveredToExpectedThread(result, conversation.thread_id)) {
    const removed = await removeRedirectedMessage(bot, env, result, conversation.thread_id);
    if (attempt.startedAt) {
      if (removed) await clearMessageDeliveryAttempt(db, bot, details, attempt.startedAt);
      else await markMessageDeliveryUncertain(db, bot, details, attempt.startedAt, "Redirected message could not be removed");
    }
    result = { ok: false, description: "Telegram redirected the message outside the expected Topic", deliveryUncertain: !removed };
  } else if (!result.ok && initialMethod === "forwardMessage" && !isDeliveryOutcomeUncertain(result) && isForwardUnsupportedError(result.description)) {
    const probe = await probeForumThread(bot, env, conversation.thread_id);
    if (probe.ok) {
      details.method = "copyMessage";
      attempt = await runMessageDeliveryAttempt(bot, env, details, () => telegram(bot, "copyMessage", body, env));
      result = attempt.result;
    } else {
      result = probe;
    }
  }

  if (!result.ok && isDeliveryOutcomeUncertain(result)) {
    log(bot, "error", "single_delivery_outcome_uncertain", { direction: "user_to_support", user_id: message.from.id, source_message_id: message.message_id, description: result.description });
    return null;
  }
  if (!result.ok && allowRoutingRepair && isTopicClosedError(result.description)) {
    await dbRun(db, "UPDATE conversations SET status = 'closed' WHERE id = ?", conversation.id);
    const current = await findConversation(db, bot.id, message.from.id);
    if (!current) throw new Error("Conversation disappeared before Topic routing could be repaired");
    const repaired = await reopenConversationForUserMessage(bot, env, current, message.from);
    return forwardUserMessage(bot, env, message, repaired, false, updateId);
  }
  if (!result.ok && allowRoutingRepair && (isMissingTopicError(result.description) || result.description.includes("redirected"))) {
    await invalidateConversationTopic(db, bot.id, message.from.id, conversation.thread_id);
    const recreated = await provisionConversation(bot, env, message.from);
    return forwardUserMessage(bot, env, message, recreated, false, updateId);
  }
  if (!result.ok) {
    if (reopenRoutingError(result.description)) throw new Error(`Topic routing repair deferred: ${result.description}`);
    if (isRetryableTelegramFailure(result)) throw new Error(`user-to-support delivery failed: ${result.description}`);
    if (isSupportGroupUnavailable(result) && Number.isSafeInteger(Number(updateId))) {
      await saveUnavailableInbound(bot, env, message, updateId, result.description);
      return null;
    }
    const notice = await telegram(bot, "sendMessage", { chat_id: message.chat.id, text: t(bot, "deliveryFailed") }, env);
    if (!notice.ok && isRetryableTelegramFailure(notice) && !isDeliveryOutcomeUncertain(notice)) throw new Error(`delivery-failure notice failed: ${notice.description}`);
    log(bot, "warn", "user_delivery_permanent_failure", { user_id: message.from.id, description: result.description });
    return null;
  }
  const mapping = {
    botId: bot.id,
    userId: message.from.id,
    threadId: conversation.thread_id,
    userMessageId: message.message_id,
    supportMessageId: result.result?.message_id,
  };
  await persistSingleDeliveryBookkeeping(bot, db, details, attempt.startedAt, result.result?.message_id, mapping);
  await finalizeConversationReopenAfterDelivery(db, bot.id, message.from.id, [Number(message.message_id)]);
  await stageConfirmedInboundNotice(bot, env, message.from.id, conversation.support_group_id, conversation.thread_id);
  return result;
}

async function queueMediaGroup(bot, env, message, conversation, direction) {
  const media = extractAlbumMedia(message);
  if (!media) return false;
  const db = requireDb(env);
  const key = [bot.id, direction, String(message.media_group_id), Number(message.chat.id)];
  const receivedAt = Date.now();
  const targetChatId = direction === "user_to_support" ? supportGroupId(env) : Number(conversation.user_id);
  const operatorId = direction === "support_to_user" ? Number(message.from?.id) : null;
  await dbRun(
    db,
    "INSERT INTO media_groups (bot_id, direction, media_group_id, source_chat_id, target_chat_id, thread_id, user_id, operator_id, last_received_at, version, claimed_at, claimed_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?) ON CONFLICT(bot_id, direction, media_group_id, source_chat_id) DO UPDATE SET target_chat_id = excluded.target_chat_id, thread_id = excluded.thread_id, user_id = excluded.user_id, operator_id = excluded.operator_id, last_received_at = excluded.last_received_at, version = media_groups.version + 1",
    ...key,
    targetChatId,
    Number(conversation.thread_id),
    Number(conversation.user_id),
    operatorId,
    receivedAt,
    nowIso(),
  );
  await dbRun(
    db,
    `INSERT INTO media_group_items (bot_id, direction, media_group_id, source_chat_id, message_id, media_type, file_id, caption, caption_entities_json, has_spoiler, received_at, source_created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS(SELECT 1 FROM message_mappings
        WHERE bot_id = ? AND ${direction === 'user_to_support' ? 'user_id = ? AND user_message_id = ?' : 'support_group_id = ? AND thread_id = ? AND support_message_id = ?'})
      ON CONFLICT(bot_id, direction, media_group_id, source_chat_id, message_id) DO NOTHING`,
    ...key,
    message.message_id,
    media.type,
    media.media,
    media.caption.slice(0, 1024),
    media.captionEntities.length ? JSON.stringify(media.captionEntities) : null,
    media.hasSpoiler ? 1 : 0,
    receivedAt,
    sourceCreatedAt(message),
    bot.id,
    ...(direction === 'user_to_support' ? [Number(conversation.user_id)] : [Number(message.chat.id), Number(conversation.thread_id)]),
    Number(message.message_id),
  );
  await sleep(asPositiveInteger(env.ALBUM_SETTLE_MS, DEFAULT_ALBUM_SETTLE_MS));
  const outcome = await flushMediaGroup(bot, env, key, 0);
  return ["operator_access_revoked", "operator_identity_unknown"].includes(outcome) ? outcome : true;
}

async function flushMediaGroup(bot, env, key, depth, decisionLocked = false, routingRetry = 0) {
  const db = requireDb(env);
  const group = await dbOne(db, "SELECT * FROM media_groups WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
  if (!group) return;
  if (group.delivery_started_at && !group.delivery_completed_at && group.claimed_at != null
      && Date.now() - Number(group.claimed_at) < LOCK_STALE_MS) return;
  const requestMayHaveStarted = Boolean(group.request_started_at);
  const supportActorUnknown = group.direction === "support_to_user"
    && (group.operator_id === null || group.operator_id === undefined || !Number.isSafeInteger(Number(group.operator_id)) || Number(group.operator_id) <= 0);
  if (supportActorUnknown && !group.delivery_completed_at) {
    await dbRun(db, "UPDATE media_groups SET operator_identity_unknown_at = COALESCE(operator_identity_unknown_at, ?) WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", nowIso(), ...key);
    log(bot, "warn", "operator_album_identity_unknown", { user_id: Number(group.user_id), media_group_id: group.media_group_id });
    return "operator_identity_unknown";
  }
  const supportActorRevoked = group.direction === "support_to_user" && !await isAdmin(bot, env, Number(group.operator_id));
  if (supportActorRevoked && !group.delivery_started_at && !group.delivery_completed_at) {
    await dbRun(db, "DELETE FROM media_group_items WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
    await dbRun(db, "DELETE FROM media_groups WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
    log(bot, "warn", "operator_album_revoked_before_delivery", { operator_id: Number(group.operator_id), user_id: Number(group.user_id), media_group_id: group.media_group_id });
    return "operator_access_revoked";
  }
  if (group.direction === "user_to_support" && !decisionLocked) {
    const ownerToken = await claimAbuseDecisionLock(db, bot.id, Number(group.user_id));
    try { return await flushMediaGroup(bot, env, key, depth, true, routingRetry); }
    finally {
      await releaseAbuseDecisionLock(db, bot.id, Number(group.user_id), ownerToken);
      await tryAutoReply(bot, env, Number(group.user_id));
    }
  }
  if (group.direction === "user_to_support") {
    const [banned, state] = await Promise.all([
      dbOne(db, "SELECT 1 FROM banned_users WHERE bot_id = ? AND user_id = ?", bot.id, Number(group.user_id)),
      dbOne(db, "SELECT muted_until, manual_restricted_until FROM user_abuse_state WHERE bot_id = ? AND user_id = ?", bot.id, Number(group.user_id)),
    ]);
    if (banned || isManuallyRestricted(state)) {
      await dbRun(db, "DELETE FROM media_group_items WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
      await dbRun(db, "DELETE FROM media_groups WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
      log(bot, "info", "album_revoked_before_delivery", { user_id: Number(group.user_id), media_group_id: group.media_group_id });
      return;
    }
    if (isFuture(state?.muted_until)) return;
  }
  if (group.delivery_completed_at) {
    const unsynced = await dbAll(db, "SELECT * FROM media_group_items WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND delivered_at IS NOT NULL AND mapping_synced_at IS NULL AND target_message_id IS NOT NULL ORDER BY message_id", ...key);
    for (const source of unsynced.results || []) {
      const mappingSaved = await recordMapping(bot, db, {
        botId: bot.id, userId: Number(group.user_id), threadId: Number(group.thread_id),
        groupId: group.direction === 'user_to_support' ? group.target_chat_id : group.source_chat_id,
        userMessageId: group.direction === "user_to_support" ? Number(source.message_id) : Number(source.target_message_id),
        supportMessageId: group.direction === "user_to_support" ? Number(source.target_message_id) : Number(source.message_id),
      });
      if (mappingSaved) await dbRun(db, "UPDATE media_group_items SET mapping_synced_at = COALESCE(mapping_synced_at, ?) WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND message_id = ?", nowIso(), ...key, source.message_id);
    }
    await dbRun(db, "DELETE FROM media_group_items WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND delivered_at IS NOT NULL AND mapping_synced_at IS NOT NULL", ...key);
    const counts = await dbOne(db, "SELECT COUNT(*) AS total, SUM(CASE WHEN delivered_at IS NULL AND delivery_uncertain_at IS NULL THEN 1 ELSE 0 END) AS undelivered FROM media_group_items WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
    if (Number(counts?.total || 0) === 0) {
      await dbRun(db, "DELETE FROM media_groups WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND delivery_completed_at = ?", ...key, group.delivery_completed_at);
      return;
    }
    if (Number(counts?.undelivered || 0) === 0) return;
    const reset = await dbRun(db, "UPDATE media_groups SET delivery_started_at = NULL, request_started_at = NULL, delivery_completed_at = NULL, claimed_at = NULL, claimed_version = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND delivery_completed_at = ?", ...key, group.delivery_completed_at);
    if (reset.meta?.changes !== 1) return;
    group.delivery_started_at = null;
    group.delivery_completed_at = null;
    group.claimed_at = null;
    group.claimed_version = null;
  } else if (group.delivery_started_at) {
    const previousStartedAt = group.delivery_started_at;
    if (!requestMayHaveStarted) {
      await dbRun(db, "UPDATE media_group_items SET delivery_attempt_started_at = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND delivery_attempt_started_at = ? AND delivered_at IS NULL AND delivery_uncertain_at IS NULL", ...key, previousStartedAt);
      await dbRun(db, "UPDATE media_groups SET delivery_started_at = NULL, request_started_at = NULL, delivery_completed_at = NULL, claimed_at = NULL, claimed_version = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND delivery_started_at = ?", ...key, previousStartedAt);
      log(bot, "warn", "album_prepared_attempt_recovered", { direction: group.direction, media_group_id: group.media_group_id });
    } else {
      await dbRun(db, "UPDATE media_group_items SET delivery_uncertain_at = COALESCE(delivery_uncertain_at, ?), delivery_attempt_started_at = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND delivery_attempt_started_at = ? AND delivered_at IS NULL", nowIso(), ...key, previousStartedAt);
      await dbRun(db, "UPDATE media_groups SET delivery_started_at = NULL, request_started_at = NULL, delivery_completed_at = NULL, claimed_at = NULL, claimed_version = NULL, delivery_uncertain_at = COALESCE(delivery_uncertain_at, ?) WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND delivery_started_at = ?", nowIso(), ...key, previousStartedAt);
      log(bot, "error", "album_delivery_outcome_uncertain", { direction: group.direction, media_group_id: group.media_group_id, delivery_started_at: previousStartedAt });
    }
    group.delivery_started_at = null;
    group.request_started_at = null;
    group.delivery_completed_at = null;
    group.claimed_at = null;
    group.claimed_version = null;
  }
  if (supportActorRevoked && !group.delivery_completed_at) {
    // Once Telegram may have received a request, retain the uncertain
    // generation for audit/recovery. A prepared-only generation is discardable.
    if (!requestMayHaveStarted) {
      await dbRun(db, "DELETE FROM media_group_items WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
      await dbRun(db, "DELETE FROM media_groups WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
    }
    log(bot, "warn", "operator_album_revoked_during_delivery", { operator_id: Number(group.operator_id) || null, user_id: Number(group.user_id), media_group_id: group.media_group_id });
    return;
  }
  if (group.claimed_at !== null && group.claimed_at !== undefined) {
    if (Date.now() - Number(group.claimed_at) < LOCK_STALE_MS) return;
    await dbRun(db, "UPDATE media_groups SET claimed_at = NULL, claimed_version = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND claimed_at = ?", ...key, group.claimed_at);
    group.claimed_at = null;
  }
  const settleMs = asPositiveInteger(env.ALBUM_SETTLE_MS, DEFAULT_ALBUM_SETTLE_MS);
  if (Date.now() - Number(group.last_received_at) < settleMs - 25) return;

  const claimedAt = Date.now();
  const claim = await dbRun(
    db,
    "UPDATE media_groups SET claimed_at = ?, claimed_version = version WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND claimed_at IS NULL AND version = ?",
    claimedAt,
    ...key,
    group.version,
  );
  if (claim.meta?.changes !== 1) return;

  try {
    const result = await dbAll(
      db,
      "SELECT * FROM media_group_items WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND delivered_at IS NULL AND delivery_uncertain_at IS NULL ORDER BY message_id",
      ...key,
    );
    const items = result.results || [];
    if (!items.length) {
      const retained = await dbOne(db, "SELECT COUNT(*) AS count FROM media_group_items WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
      if (Number(retained?.count || 0) === 0) await dbRun(db, "DELETE FROM media_groups WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
      else await dbRun(db, "UPDATE media_groups SET claimed_at = NULL, claimed_version = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
      return;
    }

    const body = { chat_id: Number(group.target_chat_id) };
    if (group.direction === "user_to_support") body.message_thread_id = Number(group.thread_id);
    const beginDeliveryAttempt = async () => {
      recoveryCheckpoint(db, items.length + 5);
      const startedAt = nowIso();
      const results = await db.batch([
        db.prepare("UPDATE media_groups SET delivery_started_at = ?, request_started_at = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND version = ? AND claimed_version = ? AND delivery_started_at IS NULL AND delivery_completed_at IS NULL").bind(startedAt, ...key, group.version, group.version),
        db.prepare("UPDATE media_group_items SET delivery_attempt_started_at = ? WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND message_id IN (SELECT value FROM json_each(?)) AND delivered_at IS NULL AND delivery_uncertain_at IS NULL AND delivery_attempt_started_at IS NULL").bind(startedAt, ...key, JSON.stringify(items.map((item) => item.message_id))),
      ]);
      if (results[0].meta?.changes !== 1 || results[1].meta?.changes !== items.length) throw new Error("Album delivery fence could not be acquired");
      return startedAt;
    };
    const markAlbumRequestStarted = async (startedAt) => {
      assertTelegramReady(db, bot);
      const gate = telegramRequestGate(db, bot);
      recoveryCheckpoint(db, items.length + (group.direction === "support_to_user" ? 4 : 3));
      const marked = await dbRun(db, "UPDATE media_groups SET request_started_at = ? WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND delivery_started_at = ? AND request_started_at IS NULL AND delivery_completed_at IS NULL" + gate.sql, nowIso(), ...key, startedAt, ...gate.params);
      if (marked.meta?.changes !== 1) throw new Error("Album request-start marker could not be saved");
    };
    const sendOperatorAlbum = async (deliveryStartedAt, send) => {
      try {
        return await withAuthorizedOperatorExecution(bot, env, Number(group.operator_id), async (renewOperatorFence) => {
          await markAlbumRequestStarted(deliveryStartedAt);
          await renewOperatorFence();
          return send();
        });
      } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error;
        if (!error?.operatorRevoked) throw error;
        await db.batch([
          ...items.map((item) => db.prepare("UPDATE media_group_items SET delivery_attempt_started_at = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND message_id = ? AND delivery_attempt_started_at = ? AND delivered_at IS NULL").bind(...key, item.message_id, deliveryStartedAt)),
          db.prepare("UPDATE media_groups SET delivery_started_at = NULL, request_started_at = NULL, claimed_at = NULL, claimed_version = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND delivery_started_at = ? AND request_started_at IS NULL").bind(...key, deliveryStartedAt),
        ]);
        await db.batch([
          db.prepare("DELETE FROM media_group_items WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?").bind(...key),
          db.prepare("DELETE FROM media_groups WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND request_started_at IS NULL").bind(...key),
        ]);
        log(bot, "warn", "operator_album_revoked_before_delivery", { operator_id: Number(group.operator_id), media_group_id: group.media_group_id });
        return { ok: false, description: "Operator access was revoked", accessRevoked: true, retryable: false };
      }
    };
    let deliveryStartedAt = null;
    let sent;
    if (items.length === 1) {
      const copyBody = { ...body, from_chat_id: Number(group.source_chat_id), message_id: items[0].message_id };
      if (group.direction === "user_to_support") {
        const probe = await probeForumThread(bot, env, Number(group.thread_id));
        if (probe.ok) {
          deliveryStartedAt = await beginDeliveryAttempt();
          await markAlbumRequestStarted(deliveryStartedAt);
          sent = await telegram(bot, "copyMessage", copyBody, env);
        } else if (isDeliveryOutcomeUncertain(probe) || isRetryableTelegramFailure(probe)) {
          throw new Error(`Topic probe failed before album delivery: ${probe.description}`);
        } else sent = probe;
      } else {
        deliveryStartedAt = await beginDeliveryAttempt();
        sent = await sendOperatorAlbum(deliveryStartedAt, () => telegram(bot, "copyMessage", copyBody, env));
        if (sent.accessRevoked) return "operator_access_revoked";
      }
      if (sent.ok) sent.result = [sent.result];
    } else {
      deliveryStartedAt = await beginDeliveryAttempt();
      if (group.direction === "support_to_user") {
        sent = await sendOperatorAlbum(deliveryStartedAt, () => telegram(bot, "sendMediaGroup", {
          ...body,
          media: items.map(storedAlbumInputMedia),
        }, env));
        if (sent.accessRevoked) return "operator_access_revoked";
      } else {
        await markAlbumRequestStarted(deliveryStartedAt);
        sent = await telegram(bot, "sendMediaGroup", {
          ...body,
          media: items.map(storedAlbumInputMedia),
        }, env);
      }
    }
    if (sent.ok && group.direction === "user_to_support" && items.length > 1) {
      const redirected = !Array.isArray(sent.result)
        || sent.result.some((item) => Number(item.message_thread_id) !== Number(group.thread_id));
      if (redirected) {
        let cleanupFailed = false;
        for (const item of sent.result || []) {
          const removed = await telegram(bot, "deleteMessage", { chat_id: supportGroupId(env), message_id: item.message_id }, env);
          if (!removed.ok) {
            cleanupFailed = true;
            log(bot, "error", "redirected_message_cleanup_failed", {
              expected_thread_id: group.thread_id,
              actual_thread_id: item.message_thread_id,
              message_id: item.message_id,
              description: removed.description,
            });
          }
        }
        sent = { ok: false, description: "Telegram redirected album outside the expected Topic", deliveryUncertain: cleanupFailed };
      }
    }
    if (!sent.ok) {
      if (deliveryStartedAt && isDeliveryOutcomeUncertain(sent)) {
        await db.batch([
          ...items.map((item) => db.prepare("UPDATE media_group_items SET delivery_uncertain_at = COALESCE(delivery_uncertain_at, ?), delivery_attempt_started_at = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND message_id = ? AND delivered_at IS NULL").bind(nowIso(), ...key, item.message_id)),
          db.prepare("UPDATE media_groups SET delivery_started_at = NULL, request_started_at = NULL, delivery_completed_at = NULL, claimed_at = NULL, claimed_version = NULL, delivery_uncertain_at = COALESCE(delivery_uncertain_at, ?) WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND delivery_started_at = ?").bind(nowIso(), ...key, deliveryStartedAt),
        ]);
        log(bot, "error", "album_delivery_outcome_uncertain", { direction: group.direction, media_group_id: group.media_group_id, description: sent.description });
        return;
      }
      if (deliveryStartedAt) {
        await db.batch([
          ...items.map((item) => db.prepare("UPDATE media_group_items SET delivery_attempt_started_at = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND message_id = ? AND delivery_attempt_started_at = ? AND delivered_at IS NULL").bind(...key, item.message_id, deliveryStartedAt)),
          db.prepare("UPDATE media_groups SET delivery_started_at = NULL, request_started_at = NULL, delivery_completed_at = NULL, claimed_at = NULL, claimed_version = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND delivery_started_at = ?").bind(...key, deliveryStartedAt),
        ]);
      } else {
        await dbRun(db, "UPDATE media_groups SET claimed_at = NULL, claimed_version = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
      }
      const topicRoutingFailure = group.direction === "user_to_support"
        && (isMissingTopicError(sent.description) || isTopicClosedError(sent.description));
      if (topicRoutingFailure && routingRetry < 1) {
        await dbRun(db, "UPDATE conversations SET status = 'closed' WHERE bot_id = ? AND user_id = ? AND thread_id = ?", bot.id, group.user_id, group.thread_id);
        const current = await findConversation(db, bot.id, Number(group.user_id));
        if (!current) throw new Error("Conversation disappeared before album Topic routing could be repaired");
        const repaired = await reopenConversationForUserMessage(bot, env, current, { id: Number(group.user_id), first_name: "User" });
        await dbRun(db, "UPDATE media_groups SET thread_id = ?, target_chat_id = ? WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", repaired.thread_id, supportGroupId(env), ...key);
        return flushMediaGroup(bot, env, key, depth, true, routingRetry + 1);
      }
      const redirected = group.direction === "user_to_support" && sent.description.includes("redirected");
      if (redirected) {
        await invalidateConversationTopic(db, bot.id, group.user_id, group.thread_id);
      }
      if (topicRoutingFailure || redirected || isRetryableTelegramFailure(sent)) {
        throw new Error(`album delivery failed: ${sent.description}`);
      }

      if (group.direction === "user_to_support") {
        const notice = await telegram(bot, "sendMessage", {
          chat_id: Number(group.user_id),
          text: t(bot, "albumFailed"),
        }, env);
        if (!notice.ok && isRetryableTelegramFailure(notice)) throw new Error(`album failure notice failed: ${notice.description}`);
      } else {
        await sendTopic(bot, env, Number(group.thread_id), `${t(bot, "operatorAlbumFailed")}: ${sent.description}`);
      }
      await dbRun(db, "DELETE FROM media_group_items WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
      await dbRun(db, "DELETE FROM media_groups WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
      log(bot, "warn", "album_permanent_failure", { direction: group.direction, media_group_id: group.media_group_id, description: sent.description });
      return;
    }

    const completedAt = nowIso();
    const delivered = Array.isArray(sent.result) ? sent.result : [];
    const completionResults = await db.batch([
      db.prepare("UPDATE media_groups SET delivery_completed_at = ?, request_started_at = NULL, delivery_uncertain_at = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND delivery_started_at = ? AND delivery_completed_at IS NULL").bind(completedAt, ...key, deliveryStartedAt),
      ...items.map((source, index) => db.prepare("UPDATE media_group_items SET delivered_at = ?, target_message_id = ?, delivery_attempt_started_at = NULL, delivery_uncertain_at = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND message_id = ? AND delivered_at IS NULL").bind(completedAt, Number(delivered[index]?.message_id) || null, ...key, source.message_id)),
    ]);
    if (completionResults.some((result) => !(result.meta?.changes > 0))) throw new Error("Album delivery completion fence could not be persisted");
    for (let index = 0; index < items.length; index++) {
      const source = items[index];
      const target = delivered[index];
      const mappingSaved = await recordMapping(bot, db, {
        botId: bot.id,
        userId: Number(group.user_id),
        threadId: Number(group.thread_id),
        groupId: group.direction === 'user_to_support' ? group.target_chat_id : group.source_chat_id,
        userMessageId: group.direction === "user_to_support" ? source.message_id : target?.message_id,
        supportMessageId: group.direction === "user_to_support" ? target?.message_id : source.message_id,
      });
      if (mappingSaved) await dbRun(db, "UPDATE media_group_items SET mapping_synced_at = COALESCE(mapping_synced_at, ?) WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND message_id = ?", nowIso(), ...key, source.message_id);
    }
    if (group.direction === "user_to_support") await finalizeConversationReopenAfterDelivery(db, bot.id, Number(group.user_id), items.map((item) => Number(item.message_id)));
    if (group.direction === "user_to_support") await stageConfirmedInboundNotice(bot, env, group.user_id, group.target_chat_id, group.thread_id);

    try {
      const cleanup = items.map((source) => db.prepare("DELETE FROM media_group_items WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND message_id = ? AND mapping_synced_at IS NOT NULL").bind(...key, source.message_id));
      if (cleanup.length) await db.batch(cleanup);
      const remaining = await dbOne(db, "SELECT COUNT(*) AS total, SUM(CASE WHEN delivered_at IS NULL AND delivery_uncertain_at IS NULL THEN 1 ELSE 0 END) AS pending FROM media_group_items WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
      if (Number(remaining?.total || 0) === 0) {
        await dbRun(db, "DELETE FROM media_groups WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
        return;
      }
      await dbRun(db, "UPDATE media_groups SET delivery_started_at = NULL, request_started_at = NULL, delivery_completed_at = NULL, claimed_at = NULL, claimed_version = NULL WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", ...key);
      if (Number(remaining?.pending || 0) > 0) {
        if (depth < 2) {
          await sleep(settleMs);
          await flushMediaGroup(bot, env, key, depth + 1, decisionLocked, routingRetry);
        } else {
          log(bot, "warn", "album_late_parts_deferred", { direction: key[1], media_group_id: key[2] });
        }
      }
    } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error;
      // Never replay a successfully delivered Telegram album because a bookkeeping write failed.
      log(bot, "error", "album_cleanup_failed_after_delivery", { direction: key[1], media_group_id: key[2], message: error.message });
    }

  } catch (error) {
    if ((error instanceof RecoveryBudgetExhausted || error instanceof TelegramCooldownError) && !error.albumPreparationReleased) {
      // A yield before HTTP must not strand the prepared generation. Fence both
      // writes by this exact claim; completed/in-flight deliveries stay untouched.
      await db.batch([
        db.prepare(`UPDATE media_group_items SET delivery_attempt_started_at = NULL
          WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?
            AND delivered_at IS NULL AND delivery_uncertain_at IS NULL
            AND EXISTS (SELECT 1 FROM media_groups g WHERE g.bot_id = media_group_items.bot_id
              AND g.direction = media_group_items.direction AND g.media_group_id = media_group_items.media_group_id
              AND g.source_chat_id = media_group_items.source_chat_id AND g.claimed_at = ? AND g.claimed_version = ?
              AND g.request_started_at IS NULL AND g.delivery_completed_at IS NULL)`).bind(...key, claimedAt, group.version),
        db.prepare(`UPDATE media_groups SET delivery_started_at = NULL, claimed_at = NULL, claimed_version = NULL
          WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?
            AND claimed_at = ? AND claimed_version = ? AND request_started_at IS NULL AND delivery_completed_at IS NULL`).bind(...key, claimedAt, group.version),
      ]);
      error.albumPreparationReleased = true;
    }
    throw error;
  }
}

async function handlePrivateMessageLocked(bot, env, message, updateId, releaseDecision) {
  if (!message.from?.id) return;
  const db = requireDb(env);
  const limiterEventKey = `${logicalMessageKey(message, updateId)}:limiter`;
  // An outage belongs to the same logical message as its cached edge decision,
  // including later album parts. Keep reading old per-update keys on retries.
  // Combine this with admission so the Free budget needs no extra statement.
  const admission = await dbOne(db, `SELECT
    EXISTS(SELECT 1 FROM banned_users WHERE bot_id = ? AND user_id = ?) AS banned,
    EXISTS(SELECT 1 FROM abuse_events WHERE bot_id = ? AND user_id = ? AND event_key IN (?, ?) AND event_type = 'limiter_unavailable') AS limiter_unavailable,
    EXISTS(SELECT 1 FROM pending_messages WHERE bot_id = ? AND update_id = ? AND failure_code = 'support_group_unavailable' AND delivered_at IS NULL) AS queued_for_recovery`,
  bot.id, message.from.id, bot.id, message.from.id, limiterEventKey, `update:${updateId}:limiter`, bot.id, Number(updateId));
  if (Number(admission.banned) === 1) { await discardReopenBusinessMessage(db, bot.id, updateId); return; }
  let state = await ensureAbuseState(db, bot.id, message.from.id);
  let conversation = await findConversation(db, bot.id, message.from.id);
  if (isManuallyRestricted(state)) {
    await discardReopenBusinessMessage(db, bot.id, updateId);
    await releaseDecision();
    return;
  }
  if (isFuture(state.muted_until)) {
    await discardReopenBusinessMessage(db, bot.id, updateId);
    await releaseDecision();
    await maybeNotify(bot, env, message.from.id, t(bot, "muted"), state);
    return;
  }
  const absoluteLimit = await checkAbsoluteLimit(bot, env, message.from.id);
  let limiterDegraded = absoluteLimit.degraded || Number(admission.limiter_unavailable) === 1;
  if (absoluteLimit.degraded) {
    await recordAbuseEvent(db, bot.id, message.from.id, limiterEventKey, "limiter_unavailable");
  }
  if (!absoluteLimit.allowed) {
    await discardReopenBusinessMessage(db, bot.id, updateId);
    await recordAbuseEvent(db, bot.id, message.from.id, `update:${updateId}`, "absolute_limit");
    state = await applyTemporaryMute(db, bot, message.from.id, state, `absolute-mute:${updateId}`, "absolute_limit", true);
    await releaseDecision();
    await maybeNotify(bot, env, message.from.id, t(bot, "muted"), state);
    return;
  }
  const logicalClaim = await claimLogicalMessage(db, bot, message, updateId);
  const logical = logicalClaim.evaluate;
  let limits = logicalClaim.limits || { burst: true, minute: true };
  if (logical) {
    try {
      if (!logicalClaim.edgeEvaluated) {
        limits = await checkLogicalLimits(bot, env, message.from.id);
        if (limits.degraded) {
          limiterDegraded = true;
          await recordAbuseEvent(db, bot.id, message.from.id, limiterEventKey, "limiter_unavailable");
        }
        await persistLogicalEdgeOutcome(db, bot, message.from.id, logicalClaim, limits);
      }
      let signals = { delta: 0, hashes: [] };
      let computedDelta = 0;
      if (bot.antispamEnabled && bot.riskEnabled) {
        signals = await messageRiskSignals(db, bot, message, conversation);
        computedDelta = (!limits.burst ? bot.riskWeights.burst : 0)
          + (!limits.minute ? bot.riskWeights.minute : 0)
          + signals.delta;
      }
      const delta = await persistLogicalRiskDelta(db, bot, message.from.id, logicalClaim, computedDelta);
      await recordMessageAbuseEvents(db, bot, message.from.id, updateId, limits, signals, !conversation);
      if (bot.antispamEnabled) {
        if (delta) {
          state = await applyRiskEvent(db, bot, message.from.id, `update:${updateId}`, "risk", delta, state);
        } else if (bot.riskEnabled) {
          state = await decayRisk(db, bot, message.from.id, state);
        }
      }
      await completeLogicalMessage(db, bot, message.from.id, logicalClaim);
    } catch (error) {
      try { await releaseLogicalMessage(db, bot, message.from.id, logicalClaim); }
      catch (releaseError) { log(bot, "error", "logical_guard_release_failed", { update_id: updateId, message: releaseError.message }); }
      throw error;
    }
  }
  if (bot.riskEnabled) state = await applyTemporaryMute(db, bot, message.from.id, state, `risk-mute:${updateId}`, "risk_threshold");
  if (isFuture(state.muted_until)) {
    await discardReopenBusinessMessage(db, bot.id, updateId);
    await releaseDecision();
    await maybeNotify(bot, env, message.from.id, t(bot, "muted"), state);
    return;
  }
  const trusted = Number(state.manual_trust) === 1 || isFuture(state.trusted_until);
  const degradedUnknown = bot.antispamEnabled && limiterDegraded && !trusted && !conversation;
  if ((bot.verificationMode === "off" || !bot.antispamEnabled) && Number(state.verification_required) === 1) {
    await db.batch([
      db.prepare("UPDATE user_abuse_state SET verification_required = 0, pending_release_required = 1, updated_at = ? WHERE bot_id = ? AND user_id = ?").bind(nowIso(), bot.id, message.from.id),
      db.prepare("UPDATE verification_challenges SET status = 'expired' WHERE bot_id = ? AND user_id = ? AND status = 'pending'").bind(bot.id, message.from.id),
    ]);
    state.verification_required = 0;
    state.pending_release_required = 1;
  }
  if (Number(state.pending_release_required) === 1 && Number(state.verification_required) === 0) {
    const released = await flushReleasedPendingMessages(bot, env, message.from.id, true);
    if (released.status === "busy") throw new Error("Pending release is already in progress; retry this update");
    state.pending_release_required = 0;
    conversation = await findConversation(db, bot.id, message.from.id);
  }
  const attack = await attackState(db, bot, env);
  const verificationNeeded = bot.antispamEnabled && !trusted && bot.verificationMode !== "off" && (
    (bot.verificationMode === "always" && !conversation)
    || (bot.riskEnabled && Number(state.risk_score) >= bot.riskTurnstileThreshold)
    || (attack?.mode === "attack" && !conversation)
    || degradedUnknown
  );
  if (!trusted && bot.antispamEnabled && bot.verificationMode !== "off" && (verificationNeeded || Number(state.verification_required) === 1)) {
    await discardReopenBusinessMessage(db, bot.id, updateId);
    await dbRun(db, "UPDATE user_abuse_state SET verification_required = 1, updated_at = ? WHERE bot_id = ? AND user_id = ?", nowIso(), bot.id, message.from.id);
    const pending = await queuePendingMessage(db, bot, message, updateId, null);
    const created = await getOrCreateChallenge(db, bot, message.from.id, pending.duplicate === true || !pending.queued);
    await releaseDecision();
    if (!pending.queued) {
      await recordAbuseEvent(db, bot.id, message.from.id, `access:${updateId}`, 'access_queue_full');
      await sendVerificationNotice(bot, env, message.from.id, created);
      await maybeNotify(bot, env, message.from.id, t(bot, "tooMany"), state);
      return;
    }
    await sendVerificationNotice(bot, env, message.from.id, created);
    return;
  }
  if (degradedUnknown) {
    await recordAbuseEvent(db, bot.id, message.from.id, `access:${updateId}`, 'access_limiter_unavailable');
    await discardReopenBusinessMessage(db, bot.id, updateId);
    await releaseDecision();
    await maybeNotify(bot, env, message.from.id, t(bot, "tooMany"), state);
    return;
  }

  if (!limits.burst || !limits.minute) {
    await recordAbuseEvent(db, bot.id, message.from.id, `access:${updateId}`, 'access_rate_limited');
    await discardReopenBusinessMessage(db, bot.id, updateId);
    await releaseDecision();
    await maybeNotify(bot, env, message.from.id, t(bot, "tooMany"), state);
    return;
  }
  let routedConversation;
  try {
    routedConversation = await provisionConversation(bot, env, message.from, conversation || null);
  } catch (error) {
    if (!error.supportGroupUnavailable) throw error;
    await saveUnavailableInbound(bot, env, message, updateId, error.message);
    return;
  }
  const ensuredConversation = await reopenConversationForUserMessage(bot, env, routedConversation, message.from, { message, updateId });
  // Reopening may already have delivered this input, including a reply. Keep
  // the extra lookup off the first-contact path, which has no reopen queue.
  const recovered = conversation || message.media_group_id
    ? await dbOne(db, "SELECT delivered_at FROM reopen_business_messages WHERE bot_id = ? AND update_id = ?", bot.id, updateId)
    : null;
  let album = false;
  let delivered;
  if (recovered?.delivered_at) {
    album = Boolean(message.media_group_id);
    delivered = true;
  } else if (message.media_group_id) {
    await releaseDecision();
    album = await queueMediaGroup(bot, env, message, ensuredConversation, "user_to_support");
    delivered = true;
  } else {
    if (Number(admission.queued_for_recovery)) return;
    delivered = await forwardUserMessage(bot, env, message, ensuredConversation, true, updateId);
  }
  if (!delivered) return;
  try {
    await dbRun(db, "UPDATE conversations SET username = ?, first_name = ?, last_name = ?, last_message_at = ? WHERE bot_id = ? AND user_id = ?", message.from.username || null, message.from.first_name || null, message.from.last_name || null, nowIso(), bot.id, message.from.id);
  } catch (error) {
    log(bot, "error", "conversation_touch_failed_after_delivery", { user_id: message.from.id, message: error.message });
  }
  log(bot, "info", "message_forwarded", { user_id: message.from.id, thread_id: ensuredConversation.thread_id, album });
}

async function handlePrivateMessage(bot, env, message, updateId) {
  if (!message.from?.id) return;
  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(message.text || "")) return sendConfiguredWelcome(bot, env, message, updateId);
  const db = requireDb(env);
  const preConversation = await findConversation(db, bot.id, message.from.id);
  const preEffect = await activeConversationReopenEffect(db, bot.id, message.from.id);
  if (preConversation?.status === "closed" || preEffect) await queueReopenBusinessMessage(db, bot, message, updateId);
  const ownerToken = await claimAbuseDecisionLock(db, bot.id, message.from.id);
  let released = false;
  const releaseDecision = async () => {
    if (released) return;
    await releaseAbuseDecisionLock(db, bot.id, message.from.id, ownerToken);
    released = true;
  };
  try {
    if (preConversation) await touchStorageTopic(env, bot.id, preConversation.thread_id, message.from.id);
    return await handlePrivateMessageLocked(bot, env, message, updateId, releaseDecision);
  } finally {
    if (!released) {
      try {
        await releaseDecision();
      } catch (error) {
        log(bot, "error", "abuse_decision_lock_release_failed", { user_id: message.from.id, message: error.message });
      }
    }
  }
}

const MANAGED_PROFILES_CTE = `
WITH profile_keys AS (
  SELECT bot_id, user_id FROM conversations
  UNION SELECT bot_id, user_id FROM pending_messages
  UNION SELECT bot_id, user_id FROM user_abuse_state
  UNION SELECT bot_id, user_id FROM banned_users
), identity_rows AS (
  SELECT bot_id, user_id, username, first_name, last_name, COALESCE(last_message_at, created_at) AS activity_at FROM conversations
  UNION ALL
  SELECT bot_id, user_id, source_username, source_first_name, source_last_name, created_at FROM pending_messages
), latest_identity AS (
  SELECT bot_id, user_id, username, first_name, last_name, activity_at,
         ROW_NUMBER() OVER (PARTITION BY bot_id, user_id ORDER BY activity_at DESC) AS row_number
    FROM identity_rows
), profiles AS (
  SELECT keys.bot_id, keys.user_id,
         identity.username, identity.first_name, identity.last_name,
         conversation.support_group_id, conversation.thread_id, conversation.status AS conversation_status, conversation.panel_message_id,
         COALESCE(conversation.last_message_at, identity.activity_at, state.updated_at, banned.banned_at) AS activity_at,
         MAX(0, COALESCE(state.risk_score, 0) - CASE WHEN state.last_risk_at IS NULL THEN 0
           ELSE MAX(0, CAST((unixepoch('now') - unixepoch(state.last_risk_at)) / 1800 AS INTEGER)) END) AS risk_score,
         state.last_risk_at, state.trusted_until,
         COALESCE(state.manual_trust, 0) AS manual_trust, state.muted_until,
         state.manual_restricted_until, state.manual_restriction_reason,
         COALESCE(state.verification_required, 0) AS verification_required,
         COALESCE(state.pending_release_required, 0) AS pending_release_required,
         banned.reason AS ban_reason, banned.banned_at
    FROM profile_keys AS keys
    LEFT JOIN latest_identity AS identity
      ON identity.bot_id = keys.bot_id AND identity.user_id = keys.user_id AND identity.row_number = 1
    LEFT JOIN conversations AS conversation
      ON conversation.bot_id = keys.bot_id AND conversation.user_id = keys.user_id
    LEFT JOIN user_abuse_state AS state
      ON state.bot_id = keys.bot_id AND state.user_id = keys.user_id
    LEFT JOIN banned_users AS banned
      ON banned.bot_id = keys.bot_id AND banned.user_id = keys.user_id
)`;

function stableManagementBotKey(botId) {
  // Keep callback_data within Telegram's 64-byte limit even for a 64-character id.
  let hash = 14695981039346656037n;
  for (const character of botId) {
    hash ^= BigInt(character.charCodeAt(0));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return `b${hash.toString(36).padStart(13, "0")}`;
}

export function managementBotKey(registry, botId) {
  if (botId === null || botId === undefined) return "a";
  const key = stableManagementBotKey(botId);
  if (managementBotFromKey(registry, key)?.id !== botId) throw new Error("Unknown or ambiguous management bot");
  return key;
}

export function managementBotFromKey(registry, key) {
  // Positional keys from older keyboards are stale; never reinterpret them.
  if (!/^b[0-9a-z]{13}$/.test(String(key))) return null;
  const matches = registry.filter((item) => stableManagementBotKey(item.id) === key);
  return matches.length === 1 ? matches[0] : null;
}

function profileDisplayName(profile) {
  return customerName(profile, `User ${profile.user_id}`);
}

function managementStateKey(profile) {
  const value = [
    profile?.banned_at || "",
    profile?.manual_restricted_until || "",
    Number(profile?.manual_trust || 0),
    profile?.trusted_until || "",
    Number(profile?.risk_score || 0),
    profile?.muted_until || "",
    Number(profile?.verification_required || 0),
    Number(profile?.pending_release_required || 0),
    profile?.conversation_status || "",
  ].join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function profilePrimaryStatus(profile, bot) {
  const copy={ru:['заблокирован','ограничен до','автоограничение до','ожидает проверку','доверенный','подозрительный','обычный'],en:['blocked','restricted until','auto-muted until','awaiting verification','trusted','suspicious','normal'],es:['bloqueado','restringido hasta','restricción automática hasta','pendiente de verificación','de confianza','sospechoso','normal'],zh:['已封禁','受限至','自动限制至','待验证','可信','可疑','普通']}[bot.locale]||['blocked','restricted until','auto-muted until','awaiting verification','trusted','suspicious','normal'];
  if (profile.banned_at) return copy[0];
  if (isFuture(profile.manual_restricted_until)) return `${copy[1]} ${formatOperatorDate(bot, profile.manual_restricted_until)}`;
  if (isFuture(profile.muted_until)) return `${copy[2]} ${formatOperatorDate(bot, profile.muted_until)}`;
  if (Number(profile.verification_required) === 1) return copy[3];
  if (Number(profile.manual_trust) === 1 || isFuture(profile.trusted_until)) return copy[4];
  if (Number(profile.risk_score) >= 4) return copy[5];
  return copy[6];
}

async function managedProfile(db, botId, userId) {
  return dbOne(db, `${MANAGED_PROFILES_CTE} SELECT profiles.*,
    (SELECT COUNT(*) FROM pending_messages p WHERE p.bot_id=profiles.bot_id AND p.user_id=profiles.user_id AND p.delivered_at IS NULL AND p.delivery_completed_at IS NULL) pending_count,
    (SELECT COUNT(*) FROM reopen_business_messages r WHERE r.bot_id=profiles.bot_id AND r.user_id=profiles.user_id AND r.delivered_at IS NULL) reopen_count
    FROM profiles WHERE bot_id = ? AND user_id = ?`, botId, userId);
}

async function managedProfilesForUser(db, userId) {
  return dbAll(db, `${MANAGED_PROFILES_CTE} SELECT * FROM profiles WHERE user_id = ? ORDER BY activity_at DESC, bot_id`, userId);
}

async function managementCounts(db, botId) {
  const timestamp = nowIso();
  return dbOne(
    db,
    `${MANAGED_PROFILES_CTE}
     SELECT COUNT(*) AS profiles, COUNT(DISTINCT user_id) AS people,
            COUNT(DISTINCT CASE WHEN banned_at IS NOT NULL THEN user_id END) AS banned,
            COUNT(DISTINCT CASE WHEN manual_restricted_until > ? OR muted_until > ? THEN user_id END) AS restricted,
            COUNT(DISTINCT CASE WHEN verification_required = 1 THEN user_id END) AS verification,
            COUNT(DISTINCT CASE WHEN risk_score >= 4 THEN user_id END) AS suspicious,
            COUNT(DISTINCT CASE WHEN manual_trust = 1 OR trusted_until > ? THEN user_id END) AS trusted,
            COUNT(DISTINCT CASE WHEN activity_at >= ? THEN user_id END) AS recent
       FROM profiles WHERE (? IS NULL OR bot_id = ?)`,
    timestamp,
    timestamp,
    timestamp,
    new Date(Date.now() - 7 * 86_400_000).toISOString(),
    botId,
    botId,
  );
}

const MANAGEMENT_FILTERS = Object.freeze({
  x: "1 = 1",
  b: "banned_at IS NOT NULL",
  r: "(manual_restricted_until > ? OR muted_until > ?)",
  v: "verification_required = 1",
  s: "risk_score >= 4",
  t: "(manual_trust = 1 OR trusted_until > ?)",
  n: "activity_at >= ?",
});

async function listManagedProfiles(db, botId, filter, page) {
  const predicate = MANAGEMENT_FILTERS[filter] || MANAGEMENT_FILTERS.x;
  const params = [];
  if (filter === "r") params.push(nowIso(), nowIso());
  if (filter === "t") params.push(nowIso());
  if (filter === "n") params.push(new Date(Date.now() - 7 * 86_400_000).toISOString());
  if (botId) params.push(botId);
  const where = `${predicate}${botId ? " AND bot_id = ?" : ""}`;
  const count = await dbOne(db, `${MANAGED_PROFILES_CTE} SELECT COUNT(*) AS count FROM profiles WHERE ${where}`, ...params);
  const pages = Math.max(1, Math.ceil(Number(count?.count || 0) / MANAGEMENT_PAGE_SIZE));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
  const rows = await dbAll(
    db,
    `${MANAGED_PROFILES_CTE} SELECT * FROM profiles WHERE ${where} ORDER BY activity_at DESC, user_id LIMIT ? OFFSET ?`,
    ...params,
    MANAGEMENT_PAGE_SIZE,
    safePage * MANAGEMENT_PAGE_SIZE,
  );
  return { rows: rows.results || [], page: safePage, pages, count: Number(count?.count || 0) };
}

async function searchManagedProfiles(db, query) {
  const normalized = String(query || "").normalize("NFKC").trim().replace(/^@/, "");
  if (!normalized || normalized.length > 128) return [];
  if (/^\d+$/.test(normalized) && Number.isSafeInteger(Number(normalized))) {
    const rows = await dbAll(db, `${MANAGED_PROFILES_CTE} SELECT * FROM profiles WHERE user_id = ? ORDER BY bot_id LIMIT 20`, Number(normalized));
    return rows.results || [];
  }
  const rows = await dbAll(
    db,
    `${MANAGED_PROFILES_CTE}
     SELECT * FROM profiles
      WHERE LOWER(COALESCE(username, '')) = LOWER(?)
         OR LOWER(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))) LIKE LOWER(?)
      ORDER BY activity_at DESC LIMIT 20`,
    normalized,
    `%${normalized}%`,
  );
  return rows.results || [];
}

function topicPanelKeyboard(bot, profile, env) {
  const labels={ru:['📥 Работа с обращением','ℹ️ Информация','📜 История','⚙️ Управление пользователем','Управление темой в Админушке','🔓 Открыть тему','🔒 Закрыть тему'],en:['📥 Conversation workflow','ℹ️ Information','📜 History','⚙️ Manage user','Manage topic with the manager','🔓 Reopen topic','🔒 Close topic'],es:['📥 Gestión de la conversación','ℹ️ Información','📜 Historial','⚙️ Gestionar usuario','Gestionar el tema con el bot administrador','🔓 Reabrir tema','🔒 Cerrar tema'],zh:['📥 会话工作流','ℹ️ 信息','📜 历史记录','⚙️ 管理用户','在管理机器人中管理话题','🔓 重新开启话题','🔒 关闭话题']}[bot.locale]||['📥 Conversation workflow','ℹ️ Information','📜 History','⚙️ Manage user','Manage topic with the manager','🔓 Reopen topic','🔒 Close topic'];
  const stateKey = managementStateKey(profile);
  const rows = [
    [{text:labels[0],callback_data:`um:w:card:${stableManagementBotKey(bot.id)}:${profile.user_id}`}],
    [
      { text: labels[1], callback_data: "um:tp:info" },
      { text: labels[2], callback_data: "um:tp:audit" },
    ],
    [{ text: labels[3], callback_data: "um:tp:manage" }],
  ];
  if (managerConfigured(env)) {
    const managerName = String(env.MANAGER_BOT_USERNAME).replace(/^@/, '');
    rows.push([{ text: labels[4],
      url: `https://t.me/${managerName}?start=case_${stableManagementBotKey(bot.id)}_${profile.user_id}` }]);
  } else rows.push([{ text: profile.conversation_status === "closed" ? labels[5] : labels[6], callback_data: `um:tp:${profile.conversation_status === "closed" ? "open" : "close"}:${stateKey}` }]);
  return { inline_keyboard: rows };
}

function topicPanelText(bot, profile) {
  const username = profile.username ? `@${profile.username}` : ({ru:'без username',en:'no username',es:'sin nombre de usuario',zh:'无用户名'}[bot.locale]||'no username');
  const displayName = profileDisplayName(profile);
  const conversationStatus = profile.conversation_status === "closed" ? t(bot, "closedStatus") : t(bot, "openStatus");
  return [
    messageDeletionWarning(bot.locale, bot.username),
    '',
    `👤 ${displayName}${displayName === username ? '' : ` · ${username}`}`,
    `Telegram ID: ${profile.user_id}`,
    `${t(bot, "serviceLabel")}: ${bot.displayName}`,
    `${t(bot, "statusLabel")}: ${profilePrimaryStatus(profile, bot)}`,
    `${({ru:'Обращение',en:'Conversation',es:'Conversación',zh:'会话'})[bot.locale]||'Conversation'}: ${conversationStatus}`,
    `${t(bot, "risk")}: ${Number(profile.risk_score || 0)}`,
  ].join("\n");
}

async function refreshTopicPanel(bot, env, conversation) {
  const db = requireDb(env);
  const current = await dbOne(db, "SELECT * FROM conversations WHERE bot_id = ? AND user_id = ?", bot.id, conversation.user_id);
  if (!current) return null;
  const profile = await managedProfile(db, bot.id, current.user_id);
  if (!profile) return null;
  const body = {
    chat_id: supportGroupId(env),
    text: topicPanelText(bot, profile),
    reply_markup: topicPanelKeyboard(bot, profile, env),
  };
  if (current.panel_message_id) {
    const edited = await telegram(bot, "editMessageText", { ...body, message_id: current.panel_message_id }, env);
    if (edited.ok || isMessageNotModifiedError(edited.description)) {
      try { await telegram(bot, "pinChatMessage", { chat_id: supportGroupId(env), message_id: current.panel_message_id, disable_notification: true }, env); }
      catch (error) { log(bot, "warn", "topic_panel_pin_deferred", { message: error.message }); }
      return current.panel_message_id;
    }
    if (isRetryableTelegramFailure(edited)) throw new Error(`panel edit failed: ${edited.description}`);
  }
  const sent = await telegram(bot, "sendMessage", { ...body, message_thread_id: current.thread_id }, env);
  if (!sent.ok) throw new Error(`panel send failed: ${sent.description}`);
  if (!deliveredToExpectedThread(sent, current.thread_id)) {
    const removed = await removeRedirectedMessage(bot, env, sent, current.thread_id);
    const error = new Error("Telegram redirected the Topic panel outside the expected Topic");
    error.deliveryUncertain = !removed;
    throw error;
  }
  const messageId = sent.result?.message_id;
  if (!Number.isSafeInteger(Number(messageId))) throw new Error("Panel send returned no message id");
  try {
    const saved = await dbRun(db, "UPDATE conversations SET panel_message_id = ? WHERE id = ?", Number(messageId), current.id);
    if (saved.meta?.changes !== 1) throw new Error("Conversation disappeared before the Topic panel pointer was saved");
  } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error;
    const removed = await telegram(bot, "deleteMessage", { chat_id: supportGroupId(env), message_id: Number(messageId) }, env);
    if (!removed.ok) log(bot, "error", "orphan_topic_panel_cleanup_failed", { user_id: current.user_id, message_id: Number(messageId), description: removed.description });
    throw error;
  }
  try { await telegram(bot, "pinChatMessage", { chat_id: supportGroupId(env), message_id: Number(messageId), disable_notification: true }, env); }
  catch (error) { log(bot, "warn", "topic_panel_pin_deferred", { message: error.message }); }
  return Number(messageId);
}

function managementUiBot(bot, env) {
  const requested = String(env.MANAGEMENT_UI_BOT_ID || "").trim();
  if (!requested || requested === bot.id) return bot;
  return resolveBot(env, requested);
}

async function operatorScreen(bot, env, sourceMessage, text, replyMarkup, edit = false) {
  const uiBot = managementUiBot(bot, env);
  const actor = env.OPERATOR_UI_ACTOR || sourceMessage?.from?.id;
  const topic=Number(sourceMessage?.message_thread_id||1)>1;
  const commandRoute=topic?{'/info':'um:tp:info','/risk':'um:tp:risk','/antispam':'um:tp:risk','/audit':'um:tp:audit','/menu':'um:tp:refresh','/panel':'um:tp:refresh'}:{'/bots':'um:n:bots','/users':'um:g:home:a','/operators':'um:o:home:0','/selfcheck':'um:n:check','/reactions':'um:r:home:a','/messages':'um:m:home:a'};
  if (actor && sourceMessage?.chat?.id) return renderWorkspace({
    db: requireDb(env), actor, source: sourceMessage, route: env.OPERATOR_UI_ROUTE||commandRoute[commandOf(sourceMessage)],
    botId: uiBot.id, text, markup: replyMarkup, locale: bot.locale, ru: bot.locale === 'ru',
    visible: route => Number(actor)===primaryOperatorId(env)||!/^um:(?:(?:m|s|st|d|dl):|n:(?:system|settings)(?::|$)|w:test:|r:(?:test|check|stop):)/.test(route),
    send: (method, body) => telegram(uiBot, method, body, env), checkpoint: count => recoveryCheckpoint(requireDb(env), count),
  });
  const body = { chat_id: supportGroupId(env), text, reply_markup: replyMarkup };
  if (edit && sourceMessage?.message_id) {
    const edited = await telegram(uiBot, "editMessageText", { ...body, message_id: sourceMessage.message_id }, env);
    if (edited.ok || isMessageNotModifiedError(edited.description)) return edited;
    if (isRetryableTelegramFailure(edited)) throw new Error(`management screen edit failed: ${edited.description}`);
  }
  const threadId = sourceMessage?.message_thread_id;
  if (threadId !== undefined && threadId !== null && Number(threadId) !== 1) body.message_thread_id = threadId;
  const sent = await telegram(uiBot, "sendMessage", body, env);
  if (!sent.ok) throw new Error(`management screen send failed: ${sent.description}`);
  return sent;
}

function filterLabel(bot, filter) {
  const labels={ru:{x:'Все',b:'Заблокированные',r:'Ограниченные',v:'На проверке',s:'Подозрительные',t:'Доверенные',n:'Недавние'},en:{x:'All',b:'Blocked',r:'Restricted',v:'Verification',s:'Suspicious',t:'Trusted',n:'Recent'},es:{x:'Todos',b:'Bloqueados',r:'Restringidos',v:'En verificación',s:'Sospechosos',t:'De confianza',n:'Recientes'},zh:{x:'全部',b:'已封禁',r:'受限',v:'待验证',s:'可疑',t:'可信',n:'最近'}};
  return (labels[bot.locale]||labels.en)[filter] || 'All';
}

async function usersHomeScreen(bot, env, selectedBotId, viewerId) {
  const db = requireDb(env);
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const selected = selectedBotId ? registry.find((item) => item.id === selectedBotId) : null;
  const counts = await managementCounts(db, selected?.id || null);
  const key = managementBotKey(registry, selected?.id || null);
  const copy={ru:['Все боты','Все','Людей','Профилей','Найти пользователя','Все пользователи','Пользователи','Заблокированы','Ограничены','На проверке','Подозрительные','Доверенные','Недавние'],en:['All bots','All','People','Profiles','Find user','All users','Users','Blocked','Restricted','Verification','Suspicious','Trusted','Recent'],es:['Todos los bots','Todos','Personas','Perfiles','Buscar usuario','Todos los usuarios','Usuarios','Bloqueados','Restringidos','En verificación','Sospechosos','De confianza','Recientes'],zh:['所有机器人','全部','用户数','资料数','搜索用户','所有用户','用户','已封禁','受限','待验证','可疑','可信','最近']}[bot.locale]||['All bots','All','People','Profiles','Find user','All users','Users','Blocked','Restricted','Verification','Suspicious','Trusted','Recent'];
  const title = selected ? selected.displayName : copy[0];
  const total = selected ? `${copy[1]}: ${counts.profiles}` : `${copy[2]}: ${counts.people}    ${copy[3]}: ${counts.profiles}`;
  const keyboard = [
      [{text:`🔎 ${copy[4]}`,callback_data:'um:w:search'}],
      [{text:copy[5],callback_data:`um:g:list:${key}:x:0`}],
      [{ text: "🚫 " + filterLabel(bot, "b"), callback_data: `um:g:list:${key}:b:0` }, { text: "⏳ " + filterLabel(bot, "r"), callback_data: `um:g:list:${key}:r:0` }],
      [{ text: "🧩 " + filterLabel(bot, "v"), callback_data: `um:g:list:${key}:v:0` }, { text: "⚠️ " + filterLabel(bot, "s"), callback_data: `um:g:list:${key}:s:0` }],
      [{ text: "✅ " + filterLabel(bot, "t"), callback_data: `um:g:list:${key}:t:0` }, { text: "🕘 " + filterLabel(bot, "n"), callback_data: `um:g:list:${key}:n:0` }],
      [{ text: `🤖 ${title} ▾`, callback_data: "um:g:bots" }],
  ];
  return {
    text: `${copy[6]} · ${title}\n\n${total}\n${copy[7]}: ${counts.banned}    ${copy[8]}: ${counts.restricted}\n${copy[9]}: ${counts.verification}    ${copy[10]}: ${counts.suspicious}\n${copy[11]}: ${counts.trusted}    ${copy[12]}: ${counts.recent}`,
    replyMarkup: { inline_keyboard: keyboard },
  };
}

function teamFlowNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function telegramMemberIsPresent(member) {
  const status = String(member?.status || "");
  return ["creator", "administrator", "member"].includes(status) || (status === "restricted" && member?.is_member !== false);
}

function operatorIdentityLine(user) {
  const name = operatorName(user);
  return `${name}${user?.username ? ` · @${user.username}` : ""} · ${user?.id}`;
}

async function telegramGroupPerson(bot, env, userId) {
  const member = await telegram(bot, "getChatMember", { chat_id: supportGroupId(env), user_id: Number(userId) }, env);
  if (!member.ok) return { ok: false, reason: member.description || "Telegram lookup failed" };
  if (!telegramMemberIsPresent(member.result)) return { ok: false, reason: "not_member" };
  const user = member.result?.user || { id: Number(userId), first_name: `User ${userId}` };
  if (!Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) return { ok: false, reason: "invalid_id" };
  if (user.is_bot) return { ok: false, reason: "bot" };
  return { ok: true, user: { id: Number(user.id), first_name: String(user.first_name || `User ${user.id}`).slice(0, 128), last_name: user.last_name ? String(user.last_name).slice(0, 128) : null, username: user.username ? String(user.username).slice(0, 64) : null } };
}

async function primaryOperatorIdentity(bot, env) {
  const primaryId = primaryOperatorId(env);
  const found = await telegramGroupPerson(bot, env, primaryId);
  return found.ok ? found.user : { id: primaryId, first_name: ({ru:'Главный оператор',en:'Primary operator',es:'Administrador principal',zh:'主管理员'})[bot.locale]||'Primary operator' };
}

async function operatorsScreen(bot, env, viewerId, page = 0) {
  const db = requireDb(env);
  await reconcilePrimaryOperator(db, env);
  const role = await operatorRole(bot, env, viewerId);
  const primary = await primaryOperatorIdentity(bot, env);
  const count = await dbOne(db, "SELECT COUNT(*) AS count FROM support_operators WHERE active = 1");
  const totalExtras = Number(count?.count || 0);
  const pages = Math.max(1, Math.ceil(totalExtras / OPERATOR_LIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const rows = await dbAll(db, "SELECT * FROM support_operators WHERE active = 1 ORDER BY added_at, user_id LIMIT ? OFFSET ?", OPERATOR_LIST_PAGE_SIZE, safePage * OPERATOR_LIST_PAGE_SIZE);
  const c={ru:['👥 Операторы','Действуют','Главный оператор','Оператор · добавлен','➕ Добавить оператора','🔄 Обновить','← Пользователи'],en:['👥 Operators','Active','Primary operator','Operator · added','➕ Add operator','🔄 Refresh','← Users'],es:['👥 Operadores','Activos','Administrador principal','Operador · añadido','➕ Añadir operador','🔄 Actualizar','← Usuarios'],zh:['👥 客服人员','在职','主管理员','客服人员 · 添加时间','➕ 添加客服人员','🔄 刷新','← 用户']}[bot.locale]||['👥 Operators','Active','Primary operator','Operator · added','➕ Add operator','🔄 Refresh','← Users'];
  const lines = [c[0], "", `${c[1]}: ${totalExtras + 1}`, "", `👑 ${operatorIdentityLine(primary)}`, `   ${c[2]}`];
  for (const row of rows.results || []) {
    lines.push("", `👤 ${operatorIdentityLine({ id: row.user_id, first_name: row.first_name, last_name: row.last_name, username: row.username })}`);
    lines.push(`   ${c[3]} ${formatOperatorDate(bot, row.added_at)}`);
  }
  const keyboard = [];
  if (role === "primary") keyboard.push([{ text: c[4], callback_data: "um:o:add" }]);
  keyboard.push([{ text: `👑 ${operatorName(primary).slice(0, 40)}`, callback_data: `um:o:primary:${safePage}` }]);
  for (const row of rows.results || []) keyboard.push([{ text: operatorName({ id: row.user_id, first_name: row.first_name, last_name: row.last_name, username: row.username }).slice(0, 45), callback_data: `um:o:card:${row.user_id}:${safePage}` }]);
  const pagination = [];
  if (safePage > 0) pagination.push({ text: "←", callback_data: `um:o:home:${safePage - 1}` });
  pagination.push({ text: `${safePage + 1} / ${pages}`, callback_data: `um:o:home:${safePage}` });
  if (safePage + 1 < pages) pagination.push({ text: "→", callback_data: `um:o:home:${safePage + 1}` });
  keyboard.push(pagination, [{ text: c[5], callback_data: `um:o:home:${safePage}` }], [{ text: c[6], callback_data: "um:g:home:a" }]);
  return { text: lines.join("\n"), replyMarkup: { inline_keyboard: keyboard } };
}

function operatorCardScreen(bot, viewerRole, row, page = 0) {
  const c={ru:['Роль','оператор','Добавлен','Добавил','🗑 Удалить из операторов','← К списку'],en:['Role','operator','Added','Added by','🗑 Remove operator','← Back to list'],es:['Rol','operador','Añadido','Añadido por','🗑 Eliminar operador','← Volver a la lista'],zh:['角色','客服人员','添加时间','添加者','🗑 移除客服人员','← 返回列表']}[bot.locale]||['Role','operator','Added','Added by','🗑 Remove operator','← Back to list'];
  const user = { id: row.user_id, first_name: row.first_name, last_name: row.last_name, username: row.username };
  const lines = [`👤 ${operatorName(user)}`, "", `Username: ${row.username ? `@${row.username}` : "—"}`, `Telegram ID: ${row.user_id}`, `${c[0]}: ${c[1]}`, `${c[2]}: ${formatOperatorDate(bot, row.added_at)}`, `${c[3]}: ${row.added_by_name}`];
  const keyboard = [];
  if (viewerRole === "primary") keyboard.push([{ text: c[4], callback_data: `um:o:rm:${row.user_id}:${page}` }]);
  keyboard.push([{ text: c[5], callback_data: `um:o:home:${page}` }]);
  return { text: lines.join("\n"), replyMarkup: { inline_keyboard: keyboard } };
}

async function saveTeamFlow(db, owner, sourceMessage, action, candidate = null, page = 0, stage = "candidate") {
  const nonce = teamFlowNonce();
  await dbRun(db, `INSERT INTO support_operator_flows
    (owner_id, owner_name, action, stage, candidate_id, candidate_first_name, candidate_last_name, candidate_username, chat_id, thread_id, flow_nonce, list_page, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET owner_name=excluded.owner_name, action=excluded.action, stage=excluded.stage, candidate_id=excluded.candidate_id, candidate_first_name=excluded.candidate_first_name, candidate_last_name=excluded.candidate_last_name, candidate_username=excluded.candidate_username, chat_id=excluded.chat_id, thread_id=excluded.thread_id, flow_nonce=excluded.flow_nonce, list_page=excluded.list_page, created_at=excluded.created_at, expires_at=excluded.expires_at, suspended=0`,
    owner.id, operatorName(owner), action, stage, candidate?.id ?? null, candidate?.first_name ?? null, candidate?.last_name ?? null, candidate?.username ?? null, sourceMessage.chat.id, sourceMessage.message_thread_id ?? null, nonce, Math.max(0, Number(page) || 0), nowIso(), isoAfter(OPERATOR_ACTION_TTL_MS));
  return dbOne(db, "SELECT * FROM support_operator_flows WHERE owner_id = ?", owner.id);
}

function addOperatorConfirmation(bot, flow) {
  const c={ru:['Добавить оператора?','Имя','Новый оператор получит доступ ко всем подключённым сервисам.','✅ Добавить','Отмена'],en:['Add operator?','Name','The new operator will have access to all connected services.','✅ Add','Cancel'],es:['¿Añadir operador?','Nombre','El nuevo operador tendrá acceso a todos los servicios conectados.','✅ Añadir','Cancelar'],zh:['添加客服人员？','姓名','新客服人员将获得所有已连接服务的访问权限。','✅ 添加','取消']}[bot.locale]||['Add operator?','Name','The new operator will have access to all connected services.','✅ Add','Cancel'];
  const user = { id: flow.candidate_id, first_name: flow.candidate_first_name, last_name: flow.candidate_last_name, username: flow.candidate_username };
  return {
    text: `${c[0]}\n\n${c[1]}: ${operatorName(user)}\nUsername: ${user.username ? `@${user.username}` : "—"}\nTelegram ID: ${user.id}\n\n${c[2]}`,
    replyMarkup: { inline_keyboard: [[{ text: c[3], callback_data: `um:o:confirm:${flow.flow_nonce}` }, { text: c[4], callback_data: `um:o:cancel:${flow.flow_nonce}` }]] },
  };
}

function removeOperatorConfirmation(bot, flow) {
  const c={ru:['Удалить оператора?','Человек сразу потеряет доступ к ответам пользователям и управлению поддержкой.','🗑 Удалить','Отмена'],en:['Remove operator?','This person will immediately lose access to user replies and support management.','🗑 Remove','Cancel'],es:['¿Eliminar operador?','Esta persona perderá de inmediato el acceso a las respuestas a usuarios y a la gestión del soporte.','🗑 Eliminar','Cancelar'],zh:['移除客服人员？','此人将立即失去回复用户和管理支持服务的权限。','🗑 移除','取消']}[bot.locale]||['Remove operator?','This person will immediately lose access to user replies and support management.','🗑 Remove','Cancel'];
  const user = { id: flow.candidate_id, first_name: flow.candidate_first_name, last_name: flow.candidate_last_name, username: flow.candidate_username };
  return {
    text: `${c[0]}\n\n${operatorIdentityLine(user)}\n\n${c[1]}`,
    replyMarkup: { inline_keyboard: [[{ text: c[2], callback_data: `um:o:confirm:${flow.flow_nonce}` }, { text: c[3], callback_data: `um:o:cancel:${flow.flow_nonce}` }]] },
  };
}

function candidateFromMessage(message) {
  const replied = message.reply_to_message?.from;
  if (replied) return { user: replied };
  const origin = message.forward_origin;
  if (origin?.type === "user" && origin.sender_user) return { user: origin.sender_user };
  if (message.forward_from) return { user: message.forward_from };
  if (origin || message.forward_sender_name) return { hidden: true };
  const value = String(message.text || "").trim();
  if (/^\d{1,20}$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0) return { user: { id: Number(value) } };
  return {};
}

async function validateOperatorCandidate(bot, env, candidateId) {
  if (!Number.isSafeInteger(Number(candidateId)) || Number(candidateId) <= 0) return { ok: false, code: "invalid" };
  if (Number(candidateId) === primaryOperatorId(env)) return { ok: false, code: "primary" };
  const existing = await dbOne(requireDb(env), "SELECT active FROM support_operators WHERE user_id = ?", Number(candidateId));
  if (Number(existing?.active) === 1) return { ok: false, code: "existing" };
  const member = await telegramGroupPerson(bot, env, candidateId);
  if (!member.ok) return { ok: false, code: member.reason };
  return { ok: true, user: member.user };
}

function candidateErrorText(bot, code) {
  const maps = {
    ru: {
    hidden: "Telegram скрыл автора пересланного сообщения. Ответьте на сообщение человека или укажите его Telegram ID.", invalid: "Укажите корректный числовой Telegram ID.", bot: "Бота нельзя назначить оператором.", not_member: "Кандидат не состоит в основной группе поддержки.", primary: "Этот человек уже является главным оператором.", existing: "Этот человек уже является оператором.",
    },
    en: {
    hidden: "Telegram hid the forwarded author. Reply to the person's message or provide their Telegram ID.", invalid: "Provide a valid numeric Telegram ID.", bot: "A bot cannot be appointed as an operator.", not_member: "The candidate is not a member of the main support group.", primary: "This person is already the primary operator.", existing: "This person is already an operator.",
    },
    es: {hidden:'Telegram ocultó al autor del mensaje reenviado. Responde al mensaje de esa persona o indica su ID de Telegram.',invalid:'Indica un ID numérico de Telegram válido.',bot:'No se puede nombrar operador a un bot.',not_member:'La persona candidata no pertenece al grupo principal de soporte.',primary:'Esta persona ya es el administrador principal.',existing:'Esta persona ya es operador.'},
    zh: {hidden:'Telegram 隐藏了转发消息的作者。请回复此人的消息或提供其 Telegram ID。',invalid:'请提供有效的数字 Telegram ID。',bot:'不能将机器人设为客服人员。',not_member:'候选人不在主要支持群组中。',primary:'此人已经是主管理员。',existing:'此人已经是客服人员。'},
  };
  const map=maps[bot.locale]||maps.en;
  return map[code] || ({ru:"Не удалось проверить кандидата.",en:"The candidate could not be verified.",es:"No se pudo verificar a la persona candidata.",zh:"无法验证候选人。"})[bot.locale] || "The candidate could not be verified.";
}

async function handlePendingTeamOperatorText(bot, env, message, command) {
  if (command && command !== '/cancel') return false;
  const db = requireDb(env);
  const flow = await dbOne(db, "SELECT * FROM support_operator_flows WHERE owner_id = ? AND expires_at > ?", message.from.id, nowIso());
  if (!flow || flow.suspended || flow.action !== "add") return false;
  const flowIsGeneral = flow.thread_id === null || Number(flow.thread_id) === 1;
  const messageIsGeneral = message.message_thread_id === undefined || message.message_thread_id === null || Number(message.message_thread_id) === 1;
  if (String(flow.chat_id) !== String(supportGroupId(env)) || !flowIsGeneral || !messageIsGeneral) {
    await showGeneralLocation(bot,env,message,true); return true;
  }
  if (command === "/cancel") {
    await dbRun(db, "DELETE FROM support_operator_flows WHERE owner_id = ?", message.from.id);
    await operatorScreen(bot, env, message, t(bot, "actionCancelled"), { inline_keyboard: [] });
    return true;
  }
  if (command) {
    await dbRun(db, 'UPDATE support_operator_flows SET suspended=1 WHERE owner_id=?', message.from.id);
    return false;
  }
  if (flow.stage !== 'candidate') {
    const screen = addOperatorConfirmation(bot, flow);
    await operatorScreen(bot, env, message, screen.text, screen.replyMarkup);
    return true;
  }
  if (await operatorRole(bot, env, message.from.id) !== "primary") {
    await dbRun(db, "DELETE FROM support_operator_flows WHERE owner_id = ?", message.from.id);
    return true;
  }
  const picked = candidateFromMessage(message);
  if (picked.hidden) {
    await operatorScreen(bot, env, message, candidateErrorText(bot, "hidden"), { inline_keyboard: [] });
    return true;
  }
  const checked = await validateOperatorCandidate(bot, env, picked.user?.id);
  if (!checked.ok) {
    await operatorScreen(bot, env, message, candidateErrorText(bot, checked.code || "invalid"), { inline_keyboard: [] });
    return true;
  }
  const next = await saveTeamFlow(db, message.from, message, "add", checked.user, flow.list_page, "confirm");
  const screen = addOperatorConfirmation(bot, next);
  await operatorScreen(bot, env, message, screen.text, screen.replyMarkup);
  return true;
}

function reactionChecks(env) {
  return createReactionChecks(env, {
    primaryId: primaryOperatorId(env), resolveBot: id => resolveBot(env, id), botKey:id=>managementBotKey(parseBotRegistry(env.BOT_REGISTRY),id),
    telegram: (bot, method, body) => telegram(bot, method, body, env),
    subscribe: (id, include) => setReactionWebhookSubscription(resolveBot(env, id), env, include),
    receiverId: async () => (await effectiveGroupCommandOwner(requireDb(env), parseBotRegistry(env.BOT_REGISTRY), env))?.id,
  });
}

function accessSummary(bot, profile) {
  const c={ru:['Блокировка оператором','Ручное ограничение до ','Автоограничение до ','Требуется CAPTCHA','Доступ к переписке:','Действующих блокировок и CAPTCHA нет.','Доверие: ','ручное','не задано','Сохранено в очередях CAPTCHA/возобновления: '],en:['Operator ban','Manual restriction until ','Automatic restriction until ','CAPTCHA required','Conversation access:','No active blocks or CAPTCHA.','Trust: ','manual','not set','Saved in CAPTCHA/reopen queues: '],es:['Bloqueo del operador','Restricción manual hasta ','Restricción automática hasta ','Se requiere CAPTCHA','Acceso a la conversación:','No hay bloqueos ni CAPTCHA activos.','Confianza: ','manual','sin definir','En colas de CAPTCHA/reapertura: '],zh:['客服人员封禁','手动限制至 ','自动限制至 ','需要 CAPTCHA','会话访问权限：','当前没有封禁或 CAPTCHA 验证。','信任状态：','手动','未设置','CAPTCHA/重新开启队列中的消息：']}[bot.locale]||['Operator ban','Manual restriction until ','Automatic restriction until ','CAPTCHA required','Conversation access:','No active blocks or CAPTCHA.','Trust: ','manual','not set','Saved in CAPTCHA/reopen queues: '];
  const blocks=[];
  if(profile.banned_at) blocks.push(c[0]);
  if(isFuture(profile.manual_restricted_until)) blocks.push(c[1]+formatOperatorDate(bot,profile.manual_restricted_until));
  if(isFuture(profile.muted_until)) blocks.push(c[2]+formatOperatorDate(bot,profile.muted_until));
  if(Number(profile.verification_required)) blocks.push(c[3]);
  return c[4]+'\n'+(blocks.length?blocks.map(s=>'• '+s).join('\n'):c[5])+'\n'+c[6]+(Number(profile.manual_trust)?c[7]:isFuture(profile.trusted_until)?formatOperatorDate(bot,profile.trusted_until):c[8])+'\n'+c[9]+(Number(profile.pending_count||0)+Number(profile.reopen_count||0));
}

function deliveryChecks(env) {
  return serviceChecks(requireDb(env),{primaryId:primaryOperatorId(env),groupId:supportGroupId(env),
    managerActive:managerConfigured(env),locale:id=>resolveBot(env,id).locale,username:id=>resolveBot(env,id).username,
    send:(id,method,body)=>telegram(resolveBot(env,id),method,body,env)});
}
async function readinessScreen(bot,env,query,key,details=false) {
  const registry=parseBotRegistry(env.BOT_REGISTRY),selected=managementBotFromKey(registry,key),ru=bot.locale==='ru';
  const b=(text,data)=>({text,callback_data:data});
  const tr={ru:{health:'Состояние системы',ownerYes:'✅ Главный оператор найден в группе.',ownerUnknown:'⚠️ Не удалось подтвердить присутствие главного оператора в группе.',choose:'Выберите сервис, чтобы проверить подключение и обмен сообщениями.',enabled:'Бот включён',permissionTopics:'Право создавать темы',permissionPin:'Право закреплять',queue:'Очередь Telegram',inbound:'Последнее подтверждённое входящее',outbound:'Последний подтверждённый ответ',isolated:'Изолированный тест',lastTest:'Последний успешный контрольный обмен',welcome:'Приветствие',autoReply:'Автоответ',disabled:'Сервис выключен.',connection:'Нет подтверждения связи с ботом.',topicsMissing:'Не подтверждено право создавать темы.',pinMissing:'Не подтверждено право закреплять сообщения.',webhook:'Подключение входящих сообщений требует проверки.',pending:'В Telegram есть сообщения, ожидающие обработки.',exchangeMissing:'Полный обмен сообщениями ещё не подтверждён.',check:'Контрольная проверка',needs:'⚠️ Требует проверки',ok:'✅ Подключение и обмен сообщениями подтверждены.',delivery:'Проблемы доставки',summary:'Краткий результат',details:'Технические детали',refresh:'Обновить',messages:'Сообщения',reactions:'Реакции',test:'🧪 Изолированная проверка'},en:{health:'System health',ownerYes:'✅ Primary operator found in the group.',ownerUnknown:'⚠️ The primary operator’s presence in the group is unconfirmed.',choose:'Choose a service to check its connection and message delivery.',enabled:'Bot enabled',permissionTopics:'Permission to create topics',permissionPin:'Permission to pin',queue:'Telegram queue',inbound:'Last confirmed incoming',outbound:'Last confirmed answer',isolated:'Isolated test',lastTest:'Last successful control exchange',welcome:'Welcome',autoReply:'Auto-reply',disabled:'The service is disabled.',connection:'The bot connection is unconfirmed.',topicsMissing:'Permission to create topics is unconfirmed.',pinMissing:'Permission to pin messages is unconfirmed.',webhook:'The incoming message connection needs checking.',pending:'Telegram has updates waiting for processing.',exchangeMissing:'A complete message exchange has not been confirmed yet.',check:'Control check',needs:'⚠️ Checks needed',ok:'✅ Connection and message exchange confirmed.',delivery:'Delivery issues',summary:'Summary',details:'Technical details',refresh:'Refresh',messages:'Messages',reactions:'Reactions',test:'🧪 Isolated check'},es:{health:'Estado del sistema',ownerYes:'✅ Se encontró al administrador principal en el grupo.',ownerUnknown:'⚠️ No se pudo confirmar la presencia del administrador principal en el grupo.',choose:'Elige un servicio para comprobar su conexión y el envío de mensajes.',enabled:'Bot activado',permissionTopics:'Permiso para crear temas',permissionPin:'Permiso para fijar mensajes',queue:'Cola de Telegram',inbound:'Último mensaje entrante confirmado',outbound:'Última respuesta confirmada',isolated:'Prueba aislada',lastTest:'Último intercambio de prueba correcto',welcome:'Bienvenida',autoReply:'Respuesta automática',disabled:'El servicio está desactivado.',connection:'No se confirmó la conexión del bot.',topicsMissing:'No se confirmó el permiso para crear temas.',pinMissing:'No se confirmó el permiso para fijar mensajes.',webhook:'Hay que comprobar la conexión de mensajes entrantes.',pending:'Hay actualizaciones de Telegram pendientes de procesar.',exchangeMissing:'Aún no se confirmó un intercambio completo de mensajes.',check:'Comprobación',needs:'⚠️ Revisiones necesarias',ok:'✅ Conexión e intercambio de mensajes confirmados.',delivery:'Problemas de entrega',summary:'Resumen',details:'Detalles técnicos',refresh:'Actualizar',messages:'Mensajes',reactions:'Reacciones',test:'🧪 Prueba aislada'},zh:{health:'系统状态',ownerYes:'✅ 已在群组中找到主管理员。',ownerUnknown:'⚠️ 无法确认主管理员是否在群组中。',choose:'请选择一项服务以检查连接和消息收发。',enabled:'机器人已启用',permissionTopics:'创建话题的权限',permissionPin:'置顶消息的权限',queue:'Telegram 队列',inbound:'最近一次确认的入站消息',outbound:'最近一次确认的回复',isolated:'隔离测试',lastTest:'最近一次成功的控制消息往返',welcome:'欢迎消息',autoReply:'自动回复',disabled:'服务已停用。',connection:'尚未确认机器人连接。',topicsMissing:'尚未确认创建话题的权限。',pinMissing:'尚未确认置顶消息的权限。',webhook:'需要检查入站消息连接。',pending:'Telegram 中有等待处理的更新。',exchangeMissing:'尚未确认完整的消息往返。',check:'控制检查',needs:'⚠️ 需要检查',ok:'✅ 连接和消息收发均已确认。',delivery:'投递问题',summary:'摘要',details:'技术详情',refresh:'刷新',messages:'消息',reactions:'表情反应',test:'🧪 隔离测试'}}[bot.locale]||{};
  if(!selected) {
    const primary=await telegramGroupPerson(bot,env,primaryOperatorId(env));
    const summary=primary.ok?tr.ownerYes:tr.ownerUnknown;
    return operatorScreen(bot,{...env,OPERATOR_UI_ROUTE:'um:n:check'},query.message,tr.health+'\n\n'+summary+'\n\n'+tr.choose,{inline_keyboard:registry.map(c=>[b(c.displayName,`um:w:ready:${managementBotKey(registry,c.id)}`)])});
  }
  const target=resolveBot(env,selected.id),db=requireDb(env);
  const me=await telegram(target,'getMe',{},env);
  const member=me.ok?await telegram(target,'getChatMember',{chat_id:supportGroupId(env),user_id:me.result.id},env):null;
  const webhook=await telegram(target,'getWebhookInfo',{},env);
  const evidence=await dbOne(db,`SELECT (SELECT MAX(completed_at) FROM message_delivery_attempts WHERE bot_id=?1 AND direction='user_to_support' AND target_message_id IS NOT NULL) inbound,
    (SELECT MAX(completed_at) FROM message_delivery_attempts WHERE bot_id=?1 AND direction='support_to_user' AND target_message_id IS NOT NULL) outbound,
    (SELECT MAX(outbound_at) FROM service_checks WHERE bot_id=?1 AND stage='done') tested,
    (SELECT stage FROM service_checks WHERE bot_id=?1 ORDER BY expires_at DESC LIMIT 1) test_stage,
    b.enabled persisted_enabled,m.welcome_text,m.auto_reply_text,p.welcome_enabled,p.auto_reply_enabled,p.welcome_reviewed,p.auto_reply_reviewed,
    r.enabled,r.capability_verified,r.support_to_user_enabled,r.support_to_user_verified,r.user_to_support_enabled,r.user_to_support_verified
    FROM (SELECT ?1 id) id LEFT JOIN bots b USING(id) LEFT JOIN bot_message_settings m ON m.bot_id=id.id
    LEFT JOIN bot_message_preferences p ON p.bot_id=id.id LEFT JOIN reaction_settings r ON r.bot_id=id.id`,selected.id);
  const ok=({ru:'✅ подтверждено',en:'✅ confirmed',es:'✅ confirmado',zh:'✅ 已确认'})[bot.locale]||'✅ confirmed',unknown=({ru:'○ нет подтверждения',en:'○ no confirmation',es:'○ sin confirmar',zh:'○ 尚未确认'})[bot.locale]||'○ no confirmation';
  const messageState=(field)=>evidence?.[field+'_text']&&evidence?.[field+'_enabled']!==0?({ru:'включено',en:'enabled',es:'activado',zh:'已启用'})[bot.locale]:(evidence?.[field+'_reviewed']||evidence?.[field+'_text'])?({ru:'выключено осознанно',en:'deliberately disabled',es:'desactivado intencionadamente',zh:'已主动停用'})[bot.locale]:({ru:'не настроено',en:'not configured',es:'sin configurar',zh:'未配置'})[bot.locale];
  const testStages={ru:{waiting:'ожидает открытия бота',creating:'результат создания темы не подтверждён',reply:'ожидает контрольного ответа',sending:'результат ответа не подтверждён',unconfirmed:'не подтверждён',done:'завершён'},en:{waiting:'waiting for the private chat',creating:'topic creation unconfirmed',reply:'waiting for control reply',sending:'reply outcome unconfirmed',unconfirmed:'unconfirmed',done:'completed'},es:{waiting:'esperando que se abra el chat privado',creating:'creación del tema sin confirmar',reply:'esperando la respuesta de prueba',sending:'respuesta sin confirmar',unconfirmed:'sin confirmar',done:'completada'},zh:{waiting:'等待用户打开私聊',creating:'话题创建结果未确认',reply:'等待测试回复',sending:'回复结果未确认',unconfirmed:'未确认',done:'已完成'}}[bot.locale]||{waiting:'waiting for the private chat',creating:'topic creation unconfirmed',reply:'waiting for control reply',sending:'reply outcome unconfirmed',unconfirmed:'unconfirmed',done:'completed'};
  const lines=[selected.displayName,(tr.enabled+': ')+(selected.enabled&&evidence?.persisted_enabled!==0?ok:unknown),
    'Telegram: '+(me.ok?ok:unknown),(tr.permissionTopics+': ')+(member?.ok&&(member.result?.can_manage_topics||member.result?.status==='creator')?ok:unknown),
    (tr.permissionPin+': ')+(member?.ok&&(member.result?.can_pin_messages||member.result?.status==='creator')?ok:unknown),
    'Webhook: '+(webhook.ok&&webhook.result?.url===String(env.PUBLIC_BASE_URL||'').replace(/\/$/,'')+'/tg/'+selected.id?ok:unknown),
    (tr.queue+': ')+(webhook.result?.pending_update_count??'—'),
    (tr.inbound+': ')+(evidence?.inbound||'—'),
    (tr.outbound+': ')+(evidence?.outbound||'—'),
    (tr.isolated+': ')+(testStages[evidence?.test_stage]||unknown),
    (tr.lastTest+': ')+(evidence?.tested?formatOperatorDate(bot,evidence.tested):'—'),
    (tr.welcome+': ')+messageState('welcome'),(tr.autoReply+': ')+messageState('auto_reply'),reactionSummary(evidence,bot.locale)];
  const concerns=[];
  if(!selected.enabled||evidence?.persisted_enabled===0)concerns.push(tr.disabled);
  if(!me.ok)concerns.push(tr.connection);
  if(!member?.ok||!(member.result?.can_manage_topics||member.result?.status==='creator'))concerns.push(tr.topicsMissing);
  if(!member?.ok||!(member.result?.can_pin_messages||member.result?.status==='creator'))concerns.push(tr.pinMissing);
  if(!webhook.ok||webhook.result?.url!==String(env.PUBLIC_BASE_URL||'').replace(/\/$/,'')+'/tg/'+selected.id)concerns.push(tr.webhook);
  if(Number(webhook.result?.pending_update_count)>0)concerns.push(tr.pending);
  if(!(evidence?.inbound&&evidence?.outbound)&&!evidence?.tested)concerns.push(tr.exchangeMissing);
  if(evidence?.test_stage&&evidence.test_stage!=='done')concerns.push(tr.check+': '+(testStages[evidence.test_stage]||unknown));
  const summary=selected.displayName+'\n\n'+(concerns.length?`${tr.needs}: ${concerns.length}`+'\n'+concerns.map(s=>'• '+s).join('\n'):tr.ok);
  const rows=[[b(tr.delivery,`um:w:problems:${key}:0:0`)],[b(details?tr.summary:tr.details,`um:w:ready:${key}${details?'':':details'}`)],[b(tr.refresh,`um:w:ready:${key}${details?':details':''}`)]];
  if(query.from.id===primaryOperatorId(env))rows.push([b(tr.messages,`um:m:home:${key}`),b(tr.reactions,`um:r:home:${key}`)]);
  if(query.from.id===primaryOperatorId(env))rows.unshift([b(tr.test,`um:w:test:${key}`)]);
  return operatorScreen(bot,{...env,OPERATOR_UI_ROUTE:`um:w:ready:${key}${details?':details':''}`},query.message,details?summary+'\n\n'+lines.slice(1).join('\n'):summary,{inline_keyboard:rows});
}
async function deliveryProblemsScreen(bot,env,query,parts) {
  const registry=parseBotRegistry(env.BOT_REGISTRY),selected=managementBotFromKey(registry,parts[3]),userId=Number(parts[4])||0,page=Math.max(0,Number(parts[5])||0),ru=bot.locale==='ru';
  const c={ru:{disabled:'Бот выключен',captcha:'Ожидается CAPTCHA',banned:'Блокировка',restricted:'Ручное ограничение',muted:'Автомьют',uncertain:'Результат неизвестен: сначала проверьте переписку',telegram:'Автоповтор недоступен: проверьте исходное сообщение',access:'Доступ пользователя',retry:'Повторить безопасно доступные',title:'Проблемы доставки',toSupport:'К оператору',toCustomer:'К клиенту',ready:'Готово к безопасному повтору',none:'Задержанных сообщений в выборке нет.',limited:'Показана ограниченная выборка.'},en:{disabled:'Bot disabled',captcha:'Awaiting CAPTCHA',banned:'Banned',restricted:'Manual restriction',muted:'Auto-mute',uncertain:'Unknown outcome: inspect conversation first',telegram:'Automatic retry unavailable: inspect source',access:'User access',retry:'Retry eligible deliveries',title:'Delivery issues',toSupport:'To support',toCustomer:'To customer',ready:'Ready for safe retry',none:'No delayed messages in this sample.',limited:'Showing a bounded sample.'},es:{disabled:'Bot desactivado',captcha:'En espera de CAPTCHA',banned:'Bloqueado',restricted:'Restricción manual',muted:'Restricción automática',uncertain:'Resultado desconocido: revisa primero la conversación',telegram:'No se puede reintentar automáticamente: revisa el mensaje original',access:'Acceso del usuario',retry:'Reintentar entregas disponibles',title:'Problemas de entrega',toSupport:'Al equipo de soporte',toCustomer:'Al cliente',ready:'Listo para reintento seguro',none:'No hay mensajes retrasados en esta muestra.',limited:'Se muestra una selección limitada.'},zh:{disabled:'机器人已停用',captcha:'等待 CAPTCHA 验证',banned:'已封禁',restricted:'手动限制',muted:'自动限制',uncertain:'结果未知：请先检查会话',telegram:'无法自动重试：请检查原始消息',access:'用户访问权限',retry:'重试符合条件的投递',title:'投递问题',toSupport:'发送给支持团队',toCustomer:'发送给客户',ready:'可以安全重试',none:'此样本中没有延迟消息。',limited:'当前显示的是有限样本。'}}[bot.locale]||{};
  if(parts[3]!=='a'&&!selected)return operatorScreen(bot,env,query.message,t(bot,'staleAction'),{inline_keyboard:[]});
  const snapshot=await deliverySnapshot(requireDb(env),env,selected?.id||null);
  const all=snapshot.rows.filter(r=>!userId||r.user_id===userId),rows=all.slice(page*5,page*5+5),keyboard=[];
  const labels=c;
  for(const r of rows) {
    const link=topicLink(supportGroupId(env),r.thread_id,r.source_chat_id===supportGroupId(env)?r.source_message_id:null);
    if(link)keyboard.push([{text:`${r.first_name||r.user_id} · #${r.source_message_id}`,url:link}]);
    keyboard.push([{text:c.access,callback_data:`um:g:card:${managementBotKey(registry,r.bot_id)}:${r.user_id}`}]);
  }
  const nav=[];if(page)nav.push({text:'←',callback_data:`um:w:problems:${parts[3]}:${userId}:${page-1}`});if(all.length>(page+1)*5)nav.push({text:'→',callback_data:`um:w:problems:${parts[3]}:${userId}:${page+1}`});if(nav.length)keyboard.push(nav);
  if(query.from.id===primaryOperatorId(env)&&isGeneralSource(query.message,env))keyboard.push([{text:c.retry,callback_data:`um:dl:home:${parts[3]}`}]);
  return operatorScreen(bot,env,query.message,c.title+'\n'+rows.map(r=>`${r.bot_id} · ${r.first_name||r.user_id} · #${r.source_message_id}\n${r.direction==='user_to_support'?c.toSupport:c.toCustomer} · ${labels[r.reason]||c.ready}\n${r.created_at}`).join('\n\n')+(!rows.length?'\n'+c.none:'')+(snapshot.limited?'\n'+c.limited:''),{inline_keyboard:keyboard});
}

async function workCard(bot,env,message,key,userId,prefix='',view='card') {
  const registry=parseBotRegistry(env.BOT_REGISTRY), config=managementBotFromKey(registry,key);
  const profile=config && await managedProfile(requireDb(env),config.id,userId);
  if(!profile) return operatorScreen(bot,env,message,t(bot,'staleAction'),{inline_keyboard:[]});
  const row=await readWork(requireDb(env),config.id,userId);
  const ru=bot.locale==='ru', b=(text,data)=>({text,callback_data:data});
  const c={ru:['💬 Открыть переписку','Снять назначение','↩️ Вернуть в работу','Доступ и модерация','Доставка','Через час','Завтра в 09:00 · Будапешт','👤 Взять себе','✅ Решено','⏳ Ждём клиента','🕒 Отложить…','👤 Передать','⚙️ Ещё…','К результатам','Следующее →','Ответственный: ','Вернуться: ','Последнее входящее: ','Подтверждённый ответ: ','Внутренняя заметка: '],en:['💬 Open conversation','Unassign','↩️ Return to work','Access and moderation','Delivery','In one hour','Tomorrow at 09:00 · Budapest','👤 Take','✅ Resolve','⏳ Wait for customer','🕒 Snooze…','👤 Transfer','⚙️ More…','Back to results','Next →','Assigned: ','Return: ','Last incoming: ','Confirmed answer: ','Internal note: '],es:['💬 Abrir conversación','Quitar asignación','↩️ Volver al trabajo','Acceso y moderación','Entrega','En una hora','Mañana a las 09:00 · Budapest','👤 Asignármela','✅ Resolver','⏳ Esperar al cliente','🕒 Posponer…','👤 Transferir','⚙️ Más…','Volver a resultados','Siguiente →','Responsable: ','Volver: ','Último mensaje entrante: ','Última respuesta confirmada: ','Nota interna: '],zh:['💬 打开会话','取消分配','↩️ 返回处理中','访问权限与审核','投递','一小时后','明天 09:00 · 布达佩斯','👤 接手','✅ 解决','⏳ 等待客户','🕒 暂缓…','👤 转交','⚙️ 更多…','返回结果','下一个 →','负责人：','返回时间：','最近入站消息：','最近一次已确认回复：','内部备注：']}[bot.locale]||['💬 Open conversation','Unassign','↩️ Return to work','Access and moderation','Delivery','In one hour','Tomorrow at 09:00 · Budapest','👤 Take','✅ Resolve','⏳ Wait for customer','🕒 Snooze…','👤 Transfer','⚙️ More…','Back to results','Next →','Assigned: ','Return: ','Last incoming: ','Confirmed answer: ','Internal note: '];
  const route=`um:w:${view}:${key}:${userId}`;
  const action=name=>`um:w:act:${name}:${key}:${userId}:${row?.revision||0}`;
  const rows=[];
  const link=topicLink(supportGroupId(env),profile.thread_id);
  if(link) rows.push([{text:c[0],url:link}]);
  if(view==='more') {
    if(row?.assigned_to)rows.push([b(c[1],action('release'))]);
    if(row&&row.state!=='needs_reply')rows.push([b(c[2],action('needs'))]);
    rows.push([b(c[3],`um:g:card:${key}:${userId}`)],[b(c[4],`um:w:problems:${key}:${userId}:0`)]);
  } else if(view==='snooze'&&row) {
    rows.push([b(c[5],action('hour'))],[b(c[6],action('tomorrow'))]);
  } else {
    if(row) {
      if(!row.assigned_to)rows.push([b(c[7],action('take'))]);
      const stateActions=[];
      if(row.state!=='resolved')stateActions.push(b(c[8],action('resolve')));
      stateActions.push(row.state==='needs_reply'?b(c[9],action('waiting')):b(c[2],action('needs')));
      rows.push(stateActions,[b(c[10],`um:w:snooze:${key}:${userId}`),b(c[11],`um:w:transfer:${key}:${userId}:${row.revision}`)]);
    }
    rows.push([b(c[12],`um:w:more:${key}:${userId}`)],
      [b(c[13],'um:w:results'),b(c[14],`um:w:next:${key}:${userId}`)]);
  }
  const text=prefix+profileDisplayName(profile)+' · '+config.displayName+'\n'+workStateLabel(row,bot.locale)+' · '+workAge(row?.last_inbound_at||row?.updated_at,bot.locale)+'\n'+
    c[15]+assigneeLabel(row,env.OPERATOR_UI_ACTOR||message.from?.id,primaryOperatorId(env),bot.locale)+
    (row?.snoozed_until?'\n'+c[16]+formatOperatorDate(bot,row.snoozed_until):'')+
    (view==='more'&&row?.last_inbound_at?'\n'+c[17]+formatOperatorDate(bot,row.last_inbound_at):'')+
    (view==='more'&&row?.last_answer_at?'\n'+c[18]+formatOperatorDate(bot,row.last_answer_at):'')+
    (row?.note?'\n'+c[19]+row.note:'')+'\n\n'+messageDeletionWarning(bot.locale, config.username);
  return operatorScreen(bot,{...env,OPERATOR_UI_ROUTE:route},message,text,{inline_keyboard:rows});
}

async function handleWorkspaceCallback(bot,env,query,parts) {
  const db=requireDb(env),ru=bot.locale==='ru',actor=query.from.id,message=query.message;
  const registry=parseBotRegistry(env.BOT_REGISTRY),action=parts[2];
  const say=(r,e)=>localizedWorkerSay(bot.locale,r,e);
  const flowCopy={
    queueLabels:{ru:{needs:'Нужен ответ',mine:'Мои',waiting:'Ждём клиента',today:'Вернуться сегодня',resolved:'Решено',all:'Все'},en:{needs:'Needs reply',mine:'Mine',waiting:'Waiting',today:'Return today',resolved:'Resolved',all:'All'},es:{needs:'Pendientes de respuesta',mine:'Mías',waiting:'Esperando al cliente',today:'Volver hoy',resolved:'Resueltas',all:'Todas'},zh:{needs:'待回复',mine:'我的',waiting:'等待客户',today:'今天返回',resolved:'已解决',all:'全部'}},
    queueBot:{ru:'Очередь какого бота?',en:'Choose a queue bot',es:'Elige la cola de un bot',zh:'请选择机器人队列'},allBots:{ru:'Все боты',en:'All bots',es:'Todos los bots',zh:'所有机器人'},
    noMore:{ru:'В этой части очереди больше нет обращений.',en:'No more conversations on this page.',es:'No hay más conversaciones en esta página.',zh:'此页没有更多会话。'},backQueue:{ru:'К очереди',en:'Back to queue',es:'Volver a la cola',zh:'返回队列'},
    handoff:{ru:'Кому передать обращение? Следующим шагом добавьте внутреннюю заметку.',en:'Choose an operator, then add an internal handoff note.',es:'Elige a quién transferir la conversación y añade una nota interna.',zh:'请选择要转交给哪位客服，然后添加内部备注。'},
    primary:{ru:'Главный администратор',en:'Primary administrator',es:'Administrador principal',zh:'主管理员'},
  };
  const flowText=(key)=>flowCopy[key]?.[bot.locale]||flowCopy[key]?.en;
  const b=(text,data)=>({text,callback_data:data});
  const show=(text,rows=[])=>operatorScreen(bot,env,message,text,{inline_keyboard:rows},true);
  if(new TextEncoder().encode(parts.join(':')).length>64)return show(t(bot,'staleAction'));
  if(action==='back'||action==='results') {
    const session=await workspaceSession(db,actor,message);
    const route=action==='back'?await workspaceBack(db,actor,message):session?.list_route||'um:w:queue:a:needs:0';
    return routeWorkspace(bot,{...env,OPERATOR_UI_ROUTE:route},query,route);
  }
  if(action==='pause') return show(say('Ввод отложен. Черновик сохранён; можно продолжать обычную работу.','Input paused. The draft is retained; you can continue ordinary work.'),[[b(say('Продолжить ввод','Resume input'),'um:w:resume')]]);
  if(action==='search') {
    if(!isGeneralSource(message,env)) return showGeneralLocation(bot,env,message);
    const nonce=teamFlowNonce();
    await dbRun(db,`INSERT INTO operator_work_inputs(operator_id,bot_id,user_id,nonce,expected_revision,chat_id,thread_id,expires_at) VALUES(?,'',0,?,0,?,1,?)
      ON CONFLICT(operator_id) DO UPDATE SET bot_id='',user_id=0,nonce=excluded.nonce,chat_id=excluded.chat_id,thread_id=1,expires_at=excluded.expires_at,draft=NULL,suspended=0`,actor,nonce,message.chat.id,isoAfter(OPERATOR_ACTION_TTL_MS));
    return show(say('Поиск по всем ботам. Ответьте на это сообщение: ID, @username или часть имени.','Search all bots. Reply to this message with an ID, @username or part of a name.'),[[b(say('Отмена','Cancel'),`um:w:notecancel:${nonce}`)]]);
  }
  if(action==='searchresults') {
    const session=await workspaceSession(db,actor,message);
    const screen=await searchScreen(bot,env,session?.search_query||'');
    return show(screen.text,screen.replyMarkup.inline_keyboard);
  }
  if(action==='resume') {
    const drafts=await dbAll(db,"SELECT bot_id,field FROM bot_message_drafts WHERE owner_id=? ORDER BY updated_at DESC LIMIT 8",actor);
    const rows=drafts.results.filter(d=>registry.some(c=>c.id===d.bot_id)).map(d=>[b((registry.find(c=>c.id===d.bot_id)?.displayName||d.bot_id)+' · '+messageFieldLabel(bot,d.field),`um:m:restore:${managementBotKey(registry,d.bot_id)}:${d.field==='welcome_text'?'w':'a'}`)]);
    const messageFlow=await dbOne(db,'SELECT bot_id,field FROM bot_message_flows WHERE owner_id=?',actor);
    if(messageFlow&&registry.some(c=>c.id===messageFlow.bot_id)&&!drafts.results.some(d=>d.bot_id===messageFlow.bot_id&&d.field===messageFlow.field))rows.push([b((({ru:'Продолжить ввод: ',en:'Resume input: ',es:'Continuar entrada: ',zh:'继续输入：'})[bot.locale]||'Resume input: ')+messageFieldLabel(bot,messageFlow.field),`um:m:edit:${managementBotKey(registry,messageFlow.bot_id)}:${messageFlow.field==='welcome_text'?'w':'a'}`)]);
    const pending=await dbOne(db,'SELECT * FROM operator_pending_actions WHERE operator_id=?',actor);
    if(pending) rows.push([b(({ru:'Продолжить модерацию',en:'Resume moderation',es:'Continuar moderación',zh:'继续审核'})[bot.locale]||'Resume moderation','um:w:resumepending')]);
    const team=await dbOne(db,'SELECT * FROM support_operator_flows WHERE owner_id=?',actor);
    if(team) rows.push([b(({ru:'Продолжить добавление оператора',en:'Resume adding operator',es:'Continuar añadiendo operador',zh:'继续添加客服人员'})[bot.locale]||'Resume adding operator','um:w:resumeteam')]);
    const note=await dbOne(db,"SELECT * FROM operator_work_inputs WHERE operator_id=? AND user_id>0",actor);
    if(note) rows.push([b(({ru:'Продолжить передачу',en:'Resume handoff',es:'Continuar transferencia',zh:'继续转交'})[bot.locale]||'Resume handoff','um:w:resumenote')]);
    const notes=await dbAll(db,'SELECT d.bot_id,d.user_id,c.first_name,c.last_name,c.username FROM operator_note_drafts d LEFT JOIN conversations c USING(bot_id,user_id) WHERE d.operator_id=? ORDER BY d.updated_at DESC LIMIT 8',actor);
    for(const draft of notes.results.filter(d=>registry.some(c=>c.id===d.bot_id)))rows.push([b((({ru:'Заметка: ',en:'Note: ',es:'Nota: ',zh:'备注：'})[bot.locale]||'Note: ')+profileDisplayName(draft)+' · '+(registry.find(c=>c.id===draft.bot_id)?.displayName||draft.bot_id),`um:w:restorenote:${managementBotKey(registry,draft.bot_id)}:${draft.user_id}`)]);
    return show(({ru:'Сохранённый ввод. Откройте нужный черновик; обычная переписка не считается вводом, пока он отложен.',en:'Saved input. Open a draft; ordinary messages are not input while it is paused.',es:'Entrada guardada. Abre un borrador; los mensajes habituales no se consideran entrada mientras esté pausada.',zh:'已保存的输入。请打开草稿；暂存期间，普通消息不会被当作输入。'})[bot.locale]||'Saved input. Open a draft; ordinary messages are not input while it is paused.',rows);
  }
  if(action==='resumepending') {
    const p=await dbOne(db,'SELECT * FROM operator_pending_actions WHERE operator_id=?',actor);
    if(!p) return show(t(bot,'staleAction'));
    const profile=p.user_id?await managedProfile(db,p.target_bot_id,p.user_id):null;
    await dbRun(db,'UPDATE operator_pending_actions SET expires_at=?,expected_state_key=?,chat_id=?,thread_id=?,suspended=0 WHERE operator_id=?',isoAfter(OPERATOR_ACTION_TTL_MS),profile?managementStateKey(profile):null,message.chat.id,message.message_thread_id??null,actor);
    if(p.stage==='reason') return beginBanFlow(bot,resolveBot(env,p.target_bot_id),env,query.from,message,p.user_id);
    if(p.stage==='duration') return beginRestrictionFlow(bot,resolveBot(env,p.target_bot_id),env,query.from,message,p.user_id);
    return showPendingConfirmation(bot,env,message,{...p,expected_state_key:profile?managementStateKey(profile):null});
  }
  if(action==='resumeteam') {
    if(actor!==primaryOperatorId(env)||!isGeneralSource(message,env)) return showGeneralLocation(bot,env,message);
    await dbRun(db,'UPDATE support_operator_flows SET suspended=0,expires_at=? WHERE owner_id=?',isoAfter(OPERATOR_ACTION_TTL_MS),actor);
    const flow=await dbOne(db,'SELECT * FROM support_operator_flows WHERE owner_id=?',actor);
    if(!flow) return show(t(bot,'staleAction'));
    if(flow.stage==='confirm') {const screen=addOperatorConfirmation(bot,flow);return show(screen.text,screen.replyMarkup.inline_keyboard);}
    return show(({ru:'Ответьте на сообщение будущего оператора в General или отправьте его ID.',en:'Reply to the future operator in General or send their ID.',es:'Responde al mensaje del futuro operador en General o envía su ID.',zh:'请在 General 中回复未来客服人员的消息，或发送其 ID。'})[bot.locale]||'Reply to the future operator in General or send their ID.',[[b(say('Отмена','Cancel'),`um:o:cancel:${flow.flow_nonce}`)]]);
  }
  if(action==='queuebots')return show(flowText('queueBot'),[[b(flowText('allBots'),`um:w:queue:a:${WORK_FILTERS.includes(parts[3])?parts[3]:'needs'}:0`)],...registry.map(c=>[b(c.displayName,`um:w:queue:${managementBotKey(registry,c.id)}:${WORK_FILTERS.includes(parts[3])?parts[3]:'needs'}:0`)])]);
  if(action==='queue') {
    const key=parts[3]||'a',filter=WORK_FILTERS.includes(parts[4])?parts[4]:'needs';
    const selected=key==='a'?null:managementBotFromKey(registry,key);
    if(key!=='a'&&!selected) return show(t(bot,'staleAction'));
    const at=new Date(),options={botIds:registry.map(c=>c.id),botId:selected?.id||null,actor,at};
    const counts=await workCounts(db,options),total=counts[filter],lastPage=Math.max(0,Math.ceil(total/5)-1);
    const page=Math.min(lastPage,Math.max(0,Math.floor(Number(parts[5])||0)));
    const result=await workQueue(db,{...options,filter,page});
    const labels=flowCopy.queueLabels[bot.locale]||flowCopy.queueLabels.en;
    const summaries=result.rows.map(row=>`${profileDisplayName(row)} · ${registry.find(c=>c.id===row.bot_id)?.displayName||row.bot_id}\n${workStateLabel(row,bot.locale)} · ${workAge(row.last_inbound_at||row.updated_at,bot.locale,at)} · ${assigneeLabel(row,actor,primaryOperatorId(env),bot.locale)}`);
    const rows=result.rows.map((row,index)=>[b(`${index+1}. ${profileDisplayName(row)} · ${workAge(row.last_inbound_at||row.updated_at,bot.locale,at)}`,`um:w:card:${managementBotKey(registry,row.bot_id)}:${row.user_id}`)]);
    const pages=[];if(page)pages.push(b('←',`um:w:queue:${key}:${filter}:${page-1}`));pages.push(b(`${page+1} / ${lastPage+1}`,`um:w:queue:${key}:${filter}:${page}`));if(result.hasNext)pages.push(b('→',`um:w:queue:${key}:${filter}:${page+1}`));rows.push(pages);
    for(let i=0;i<WORK_FILTERS.length;i+=2)rows.push(WORK_FILTERS.slice(i,i+2).map(f=>b(`${f===filter?'✓ ':''}${labels[f]} · ${counts[f]}`,`um:w:queue:${key}:${f}:0`)));
    rows.push([b(({ru:'Выбрать бота',en:'Choose bot',es:'Elegir bot',zh:'选择机器人'})[bot.locale]||'Choose bot',`um:w:queuebots:${filter}`),b(({ru:'Поиск',en:'Search',es:'Buscar',zh:'搜索'})[bot.locale]||'Search','um:w:search')]);
    return operatorScreen(bot,{...env,OPERATOR_UI_ROUTE:`um:w:queue:${key}:${filter}:${page}`},message,`${labels[filter]} · ${selected?.displayName||({ru:'Все сервисы',en:'All services',es:'Todos los servicios',zh:'所有服务'})[bot.locale]||'All services'}\n${({ru:'Найдено',en:'Found',es:'Encontradas',zh:'找到'})[bot.locale]||'Found'}: ${total}\n\n${summaries.length?summaries.map((s,i)=>`${i+1}. ${s}`).join('\n\n'):({ru:'В этой очереди пока нет обращений.',en:'This queue has no conversations.',es:'No hay conversaciones en esta cola.',zh:'此队列中暂无会话。'})[bot.locale]||'This queue has no conversations.'}`,{inline_keyboard:rows});
  }
  if(['card','more','snooze'].includes(action))return workCard(bot,env,message,parts[3],Number(parts[4]),'',action);
  if(action==='next') {
    const session=await workspaceSession(db,actor,message),route=session?.list_route||'um:w:queue:a:needs:0';
    const p=route.split(':'),filter=p[1]==='w'&&p[2]==='queue'?p[4]:'needs';
    const selected=managementBotFromKey(registry,p[3]);
    const result=await workQueue(db,{botIds:registry.map(c=>c.id),botId:selected?.id||null,filter,actor,page:Number(p[5])||0});
    const current=result.rows.findIndex(r=>r.user_id===Number(parts[4])&&managementBotKey(registry,r.bot_id)===parts[3]);
    let next=result.rows[current+1];
    if(!next&&result.hasNext) {
      const nextPage=(Number(p[5])||0)+1,more=await workQueue(db,{botIds:registry.map(c=>c.id),botId:selected?.id||null,filter,actor,page:nextPage});next=more.rows[0];
      await dbRun(db,'UPDATE operator_ui_sessions SET list_route=? WHERE operator_id=? AND chat_id=? AND thread_id=?',`um:w:queue:${p[3]||'a'}:${filter}:${nextPage}`,actor,message.chat.id,Number(message.message_thread_id||1));
    }
    return next?workCard(bot,env,message,managementBotKey(registry,next.bot_id),next.user_id):show(flowText('noMore'),[[b(flowText('backQueue'),route)]]);
  }
  if(action==='act') {
    const selected=managementBotFromKey(registry,parts[4]),userId=Number(parts[5]),revision=Number(parts[6]);
    if(!selected||!Number.isSafeInteger(userId)||!Number.isSafeInteger(revision))return show(t(bot,'staleAction'));
    const name=parts[3];if(!['take','release','waiting','resolve','needs','hour','tomorrow'].includes(name))return show(t(bot,'staleAction'));
    const until=name==='hour'?isoAfter(3600000):name==='tomorrow'?tomorrowMorning():null;
    const result=await withAuthorizedOperatorExecution(bot,env,actor,async renew=>{
      await renew();return changeWork(db,{botId:selected.id,userId,actor,revision,action:until?'snooze':name,until,audit:{actorName:operatorName(query.from),action:'work_'+name}});
    });
    return workCard(bot,env,message,parts[4],userId,result?'':({ru:'Состояние изменилось или обращение уже занято. Показаны свежие данные.\n\n',en:'The state changed or another operator took this conversation. Refreshed below.\n\n',es:'El estado cambió o otro operador tomó esta conversación. Se muestran los datos actualizados.\n\n',zh:'状态已更改或其他客服已接手此会话。以下为最新信息。\n\n'})[bot.locale]||'The state changed or another operator took this conversation. Refreshed below.\n\n');
  }
  if(action==='transfer') {
    const selected=managementBotFromKey(registry,parts[3]);
    if(!selected)return show(t(bot,'staleAction'));
    const nonce=teamFlowNonce();
    await dbRun(db,`INSERT INTO operator_work_inputs(operator_id,bot_id,user_id,nonce,expected_revision,chat_id,thread_id,expires_at,suspended) VALUES(?,?,?,?,?,?,?,?,1)
      ON CONFLICT(operator_id) DO UPDATE SET bot_id=excluded.bot_id,user_id=excluded.user_id,nonce=excluded.nonce,expected_revision=excluded.expected_revision,chat_id=excluded.chat_id,thread_id=excluded.thread_id,expires_at=excluded.expires_at,suspended=1,draft=NULL,target_operator=NULL`,actor,selected.id,Number(parts[4]),nonce,Number(parts[5]),message.chat.id,Number(message.message_thread_id||1),isoAfter(OPERATOR_ACTION_TTL_MS));
    const operators=await dbAll(db,'SELECT user_id,first_name,username FROM support_operators WHERE active=1 ORDER BY user_id');
    return show(flowText('handoff'),
      [{user_id:primaryOperatorId(env),first_name:flowText('primary')},...operators.results].map(o=>[b(o.first_name||o.username||String(o.user_id),`um:w:to:${nonce}:${o.user_id}`)]));
  }
  if(action==='to'||action==='resumenote'||action==='restorenote') {
    let flow;
    if(action==='restorenote') {
      const selected=managementBotFromKey(registry,parts[3]);
      const draft=selected&&await dbOne(db,'SELECT d.*,w.revision FROM operator_note_drafts d JOIN conversation_work w USING(bot_id,user_id) WHERE d.operator_id=? AND d.bot_id=? AND d.user_id=?',actor,selected.id,Number(parts[4]));
      if(!draft)return show(t(bot,'staleAction'));
      await dbRun(db,`INSERT INTO operator_work_inputs(operator_id,bot_id,user_id,target_operator,nonce,expected_revision,chat_id,thread_id,expires_at,draft,suspended) VALUES(?,?,?,?,?,?,?,?,?,?,0)
        ON CONFLICT(operator_id) DO UPDATE SET bot_id=excluded.bot_id,user_id=excluded.user_id,target_operator=excluded.target_operator,nonce=excluded.nonce,expected_revision=excluded.expected_revision,chat_id=excluded.chat_id,thread_id=excluded.thread_id,expires_at=excluded.expires_at,draft=excluded.draft,suspended=0`,actor,draft.bot_id,draft.user_id,draft.target_operator,teamFlowNonce(),draft.revision,message.chat.id,Number(message.message_thread_id||1),isoAfter(OPERATOR_ACTION_TTL_MS),draft.draft);
    } else if(action==='to') {
      const selected=Number(parts[4]);
      if(!Number.isSafeInteger(selected)||selected<=0)return show(t(bot,'staleAction'));
      const changed=await dbRun(db,'UPDATE operator_work_inputs SET target_operator=?,suspended=0 WHERE operator_id=? AND nonce=? AND expires_at>?',selected,actor,parts[3],nowIso());
      if(!changed.meta?.changes)return show(t(bot,'staleAction'));
    } else await dbRun(db,'UPDATE operator_work_inputs SET suspended=0,expires_at=?,chat_id=?,thread_id=?,expected_revision=(SELECT revision FROM conversation_work WHERE bot_id=operator_work_inputs.bot_id AND user_id=operator_work_inputs.user_id) WHERE operator_id=? AND user_id>0 AND EXISTS(SELECT 1 FROM conversation_work WHERE bot_id=operator_work_inputs.bot_id AND user_id=operator_work_inputs.user_id)',isoAfter(OPERATOR_ACTION_TTL_MS),message.chat.id,Number(message.message_thread_id||1),actor);
    flow=await dbOne(db,"SELECT i.*,o.first_name operator_first_name,o.last_name operator_last_name,o.username operator_username FROM operator_work_inputs i LEFT JOIN support_operators o ON o.user_id=i.target_operator WHERE i.operator_id=?",actor);
    if(!flow)return show(t(bot,'staleAction'));
    if(flow.draft)return show((({ru:'Передать оператору ',en:'Transfer to operator ',es:'Transferir a ',zh:'转交给 '})[bot.locale]||'Transfer to operator ')+assigneeLabel({...flow,assigned_to:flow.target_operator},actor,primaryOperatorId(env),bot.locale)+'\n\n'+flow.draft,[[b(({ru:'Передать',en:'Transfer',es:'Transferir',zh:'转交'})[bot.locale]||'Transfer',`um:w:noteconfirm:${flow.nonce}`),b(say('Отмена','Cancel'),`um:w:notecancel:${flow.nonce}`)]]);
    return show(({ru:'Ответьте на это сообщение внутренней заметкой для коллеги (до 500 символов). Клиент её не получит.',en:'Reply to this message with an internal handoff note (up to 500 characters). It is not sent to the customer.',es:'Responde a este mensaje con una nota interna para el equipo (hasta 500 caracteres). El cliente no la recibirá.',zh:'请回复此消息并填写内部交接备注（最多 500 个字符）。客户不会收到。'})[bot.locale]||'Reply to this message with an internal handoff note (up to 500 characters). It is not sent to the customer.',[[b(say('Отмена','Cancel'),`um:w:notecancel:${flow.nonce}`)]]);
  }
  if(action==='notecancel'||action==='noteconfirm') {
    const flow=await dbOne(db,'SELECT * FROM operator_work_inputs WHERE operator_id=? AND nonce=?',actor,parts[3]);
    if(!flow)return show(t(bot,'staleAction'));
    if(action==='noteconfirm') {
      if(!flow.draft||!isFuture(flow.expires_at)||flow.suspended)return show(t(bot,'staleAction'));
      const result=await withAuthorizedOperatorExecution(bot,env,actor,async renew=>{
        await renew();if(flow.target_operator!==primaryOperatorId(env)&&!await isAdmin(bot,env,flow.target_operator))return null;
        return changeWork(db,{botId:flow.bot_id,userId:flow.user_id,actor,revision:flow.expected_revision,primaryId:primaryOperatorId(env),action:'transfer',target:flow.target_operator,note:flow.draft,audit:{actorName:operatorName(query.from),action:'work_transfer'}});
      });
      const current=result?null:await readWork(db,flow.bot_id,flow.user_id);
      const committed=Boolean(result || current?.revision===flow.expected_revision+1
        && Number(current.assigned_to)===Number(flow.target_operator) && current.note===flow.draft);
      if(!committed)return show(({ru:'Назначение изменилось или оператор недоступен. Откройте обращение заново; заметка сохранена.',en:'Assignment changed or the operator is unavailable. Reopen the conversation; the note is retained.',es:'La asignación cambió o el operador no está disponible. Vuelve a abrir la conversación; la nota se conserva.',zh:'分配已更改或客服人员不可用。请重新打开会话；备注已保留。'})[bot.locale]||'Assignment changed or the operator is unavailable. Reopen the conversation; the note is retained.');
      if(env.MANAGER_BOT_TOKEN){
        const route=await dbOne(db,'SELECT support_group_id,thread_id FROM conversations WHERE bot_id=? AND user_id=?',flow.bot_id,flow.user_id);
        if(route)await queueTransferNotice(db,{botId:flow.bot_id,userId:flow.user_id,groupId:route.support_group_id,threadId:route.thread_id,note:flow.draft});
      }
      await dbRun(db,'DELETE FROM operator_note_drafts WHERE operator_id=? AND bot_id=? AND user_id=? AND draft=?',actor,flow.bot_id,flow.user_id,flow.draft);
    }
    await dbRun(db,'DELETE FROM operator_work_inputs WHERE operator_id=? AND nonce=?',actor,flow.nonce);
    return flow.user_id?workCard(bot,env,message,managementBotKey(registry,flow.bot_id),flow.user_id):show(t(bot,'actionCancelled'));
  }
  if(action==='problems')return deliveryProblemsScreen(bot,env,query,parts);
  if(action==='ready')return readinessScreen(bot,env,query,parts[3],parts[4]==='details');
  if(action==='test') {
    const selected=managementBotFromKey(registry,parts[3]);
    if(!selected||actor!==primaryOperatorId(env)||!isGeneralSource(message,env))return show(t(bot,'unauthorized'));
    if(!selected.username)return show(({ru:'Для ссылки нужен username бота.',en:'The bot needs a username for the test link.',es:'El bot necesita un nombre de usuario para crear el enlace de prueba.',zh:'机器人需要设置用户名才能生成测试链接。'})[bot.locale]||'The bot needs a username for the test link.');
    const nonce=await deliveryChecks(env).start(selected.id,actor);
    return show(({ru:'Проверка создаст отдельную тестовую тему и отправит ответ только вам. Откройте бота и нажмите Старт; затем выполните шаг в тестовой теме. Срок — 20 минут.',en:'The check creates a separate test topic and replies only to you. Open the bot, press Start, then follow the test topic step. Expires in 20 minutes.',es:'La comprobación crea un tema de prueba independiente y solo te responderá a ti. Abre el bot, pulsa Iniciar y sigue el paso indicado en el tema. Caduca en 20 minutos.',zh:'检查会创建一个独立的测试话题，并只向你发送回复。打开机器人并点击“开始”，然后按测试话题中的步骤操作。有效期为 20 分钟。'})[bot.locale]||'The check creates a separate test topic and replies only to you. Open the bot, press Start, then follow the test topic step. Expires in 20 minutes.',[[{text:({ru:'Начать проверку',en:'Start check',es:'Iniciar comprobación',zh:'开始检查'})[bot.locale]||'Start check',url:`https://t.me/${selected.username}?start=qc_${nonce}`}]]);
  }
  return show(t(bot,'staleAction'));
}

async function routeWorkspace(bot,env,query,route) {
  const parts=route.split(':');
  if(parts[1]==='w')return handleWorkspaceCallback(bot,env,query,parts);
  if(parts[1]==='n')return handleNavigationCallback(bot,env,query,parts);
  if(parts[1]==='g')return handleGeneralManagementCallback(bot,env,query,parts);
  if(parts[1]==='tp')return handleTopicPanelCallback(bot,env,query,parts);
  if(parts[1]==='m')return messageSettingsScreen(bot,env,query.from,query.message,parts[2],parts[3],parts[4],true);
  if(parts[1]==='o')return handleOperatorManagementCallback(bot,env,query,parts);
  if(parts[1]==='r')return handleReactionManagementCallback(bot,env,query,parts);
  if(parts[1]==='s')return handleTopicStyle(bot,env,query.from,query.message,parts[2],parts[3],parts[4],true);
  if(parts[1]==='d')return handleCloudflarePlan(bot,env,query.from,query.message,['um','d','home'],true);
  if(parts[1]==='dl')return manualDeliveryScreen(bot,env,query,['um','dl','home',parts[3]||'a']);
  return showManagementHome(bot,env,query.message);
}

async function handleWorkspaceText(bot,env,message,command) {
  if(command && command!=='/cancel')return false;
  const db=requireDb(env),flow=await dbOne(db,"SELECT i.*,o.first_name operator_first_name,o.last_name operator_last_name,o.username operator_username FROM operator_work_inputs i LEFT JOIN support_operators o ON o.user_id=i.target_operator WHERE i.operator_id=? AND i.chat_id=? AND i.thread_id=?",message.from.id,message.chat.id,Number(message.message_thread_id||1));
  if(!flow)return false;
  if(command==='/cancel') {await dbRun(db,'DELETE FROM operator_work_inputs WHERE operator_id=?',message.from.id);await operatorScreen(bot,env,message,t(bot,'actionCancelled'),{inline_keyboard:[]});return true;}
  if(flow.suspended)return false;
  const b=(text,data)=>({text,callback_data:data}),ru=bot.locale==='ru';
  if(!isFuture(flow.expires_at)) {await operatorScreen(bot,env,message,({ru:'Ввод истёк. Текст не отправлен клиенту. Продолжите через «Черновики» или /cancel.',en:'Input expired. Text was not sent to the customer. Resume from Drafts or /cancel.',es:'La entrada ha caducado. El texto no se envió al cliente. Continúa desde «Borradores» o usa /cancel.',zh:'输入已过期，文本未发送给客户。请从“草稿”继续，或使用 /cancel。'})[bot.locale]||'Input expired. Text was not sent to the customer. Resume from Drafts or /cancel.',{inline_keyboard:[]});return true;}
  if(flow.user_id===0) {
    const value=String(message.text||'').trim();
    const screen=await searchScreen(bot,env,value);
    await operatorScreen(bot,{...env,OPERATOR_UI_ROUTE:'um:w:searchresults:a'},message,screen.text,screen.replyMarkup);
    await dbRun(db,'UPDATE operator_ui_sessions SET search_query=? WHERE operator_id=? AND chat_id=? AND thread_id=?',value,message.from.id,message.chat.id,Number(message.message_thread_id||1));
    await dbRun(db,'DELETE FROM operator_work_inputs WHERE operator_id=?',message.from.id);
    return true;
  }
  const draft=validateManagementReason(message.text);
  if(!draft){await operatorScreen(bot,env,message,({ru:'Нужна заметка: 3–500 символов.',en:'Enter a note of 3–500 characters.',es:'Escribe una nota de 3 a 500 caracteres.',zh:'请输入 3–500 个字符的备注。'})[bot.locale]||'Enter a note of 3–500 characters.',{inline_keyboard:[[b(({ru:'Отмена',en:'Cancel',es:'Cancelar',zh:'取消'})[bot.locale]||'Cancel',`um:w:notecancel:${flow.nonce}`)]]});return true;}
  await dbRun(db,'UPDATE operator_work_inputs SET draft=? WHERE operator_id=? AND nonce=?',draft,message.from.id,flow.nonce);
  await operatorScreen(bot,env,message,(({ru:'Передать оператору ',en:'Transfer to operator ',es:'Transferir a ',zh:'转交给 '})[bot.locale]||'Transfer to operator ')+assigneeLabel({...flow,assigned_to:flow.target_operator},message.from.id,primaryOperatorId(env),bot.locale)+'\n\n'+draft,{inline_keyboard:[[b(({ru:'Передать',en:'Transfer',es:'Transferir',zh:'转交'})[bot.locale]||'Transfer',`um:w:noteconfirm:${flow.nonce}`),b(({ru:'Отмена',en:'Cancel',es:'Cancelar',zh:'取消'})[bot.locale]||'Cancel',`um:w:notecancel:${flow.nonce}`)]]});
  return true;
}

async function reactionScreen(bot, env, botKey = "a", viewerId = null) {
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const selected = managementBotFromKey(registry, botKey);
  const words = ({
    ru: {title:"Реакции", all:"Все боты", on:"вкл.", verified:"проверено"},
    en: {title:"Reactions", all:"All bots", on:"on", verified:"verified"},
    es: {title:"Reacciones", all:"Todos los bots", on:"activadas", verified:"verificadas"},
    zh: {title:"表情反应", all:"所有机器人", on:"已启用", verified:"已验证"},
  })[bot.locale] || {title:"Reactions", all:"All bots", on:"on", verified:"verified"};
  const lines = [`${words.title} · ${selected?.displayName || words.all}`];
  const keyboard = [];
  const stored = selected ? null : await dbAll(requireDb(env), 'SELECT * FROM reaction_settings');
  const states = new Map((stored?.results || []).map(state => [state.bot_id, state]));
  for (const config of selected ? [selected] : registry) {
    const state = selected ? await ensureReactionSettings(requireDb(env), config.id) : states.get(config.id);
    const values = REACTION_DIRECTIONS.map(direction => reactionDirection(state, direction));
    lines.push(selected ? reactionSummary(state, bot.locale) : `${config.displayName.slice(0, 24)}: ${values.filter(s => s.verified && s.enabled).length}/2 ${words.on}; ${values.filter(s => s.verified).length}/2 ${words.verified}`);
    if (selected) {
      for (const [index, direction] of REACTION_DIRECTIONS.entries()) {
        const status = reactionDirection(state, direction);
        if (status.verified || status.enabled) keyboard.push([{
          text: (status.enabled ? ({ru:'🔴 Выкл: ',en:'🔴 Disable: ',es:'🔴 Desactivar: ',zh:'🔴 停用：'}[bot.locale]||'🔴 Disable: ') : ({ru:'🟢 Вкл: ',en:'🟢 Enable: ',es:'🟢 Activar: ',zh:'🟢 启用：'}[bot.locale]||'🟢 Enable: ')) + reactionDirectionLabel(direction, bot.locale),
          callback_data: `um:r:set:${botKey}:${status.enabled ? 'off' : 'on'}:${index}`,
        }]);
      }
      if (Number(viewerId) === primaryOperatorId(env)) keyboard.push([{ text: ({ru:'🧪 Проверить в Telegram',en:'🧪 Check in Telegram',es:'🧪 Comprobar en Telegram',zh:'🧪 在 Telegram 中检查'})[bot.locale]||'🧪 Check in Telegram', callback_data: `um:r:test:${botKey}` }]);
      lines.push(({ru:'Каждое направление включается после своей проверки. Проверку запускает главный администратор в General.',en:'Each direction can be enabled after its own check. The primary administrator starts checks in General.',es:'Cada dirección se activa después de su propia comprobación. El administrador principal inicia las pruebas en General.',zh:'每个方向都需单独检查后才能启用。主管理员在 General 中启动检查。'})[bot.locale]||'Each direction can be enabled after its own check. The primary administrator starts checks in General.');
    }
  }
  keyboard.push([{ text: ({ru:'🤖 Выбрать бота',en:'🤖 Select bot',es:'🤖 Elegir bot',zh:'🤖 选择机器人'})[bot.locale]||'🤖 Select bot', callback_data: "um:r:bots" }]);
  keyboard.push([{ text: ({ru:'← Пользователи',en:'← Users',es:'← Usuarios',zh:'← 用户'})[bot.locale]||'← Users', callback_data: `um:g:home:${botKey}` }]);
  return { text: lines.join('\n\n'), replyMarkup: { inline_keyboard: keyboard } };
}

async function reactionCheckScreen(bot, env, query, parts) {
  if (!isGeneralSource(query.message, env) || query.from.id !== primaryOperatorId(env)) {
    return operatorScreen(bot, env, query.message, ({ru:'Проверку запускает только главный администратор в General.',en:'Only the primary administrator can run checks in General.',es:'Solo el administrador principal puede iniciar comprobaciones en General.',zh:'只有主管理员可以在 General 中启动检查。'})[bot.locale]||'Only the primary administrator can run checks in General.', { inline_keyboard: [] }, true);
  }
  const selected = managementBotFromKey(parseBotRegistry(env.BOT_REGISTRY), parts[3]);
  if (!selected?.enabled) return;
  const checks = reactionChecks(env);
  let row;
  if (parts[2] === 'test') {
    const lock = await claimReactionSettingsLock(requireDb(env));
    if (!lock) throw retryableReactionError('Reaction settings are busy');
    try {
      const persisted = await dbOne(requireDb(env), 'SELECT enabled FROM bots WHERE id = ?', selected.id);
      if (persisted && Number(persisted.enabled) === 0) throw new Error('The selected bot is disabled');
      await ensureReactionSettings(requireDb(env), selected.id);
      row = await checks.start(selected.id);
    } finally { await releaseReactionSettingsLock(requireDb(env), lock); }
  } else {
    row = await checks.read(selected.id);
    if (!row || row.nonce !== parts[4]) return;
    if (parts[2] === 'stop') { await checks.stop(selected.id, row.nonce); row = await checks.read(selected.id); }
  }
  const screen = checks.screen(row);
  // This management panel belongs to the command owner, while the actual
  // probe messages belong to the selected bot. Never mix their callback IDs.
  const keyboard = screen.reply_markup.inline_keyboard.map(line => line.filter(button => button.url)).filter(line => line.length);
  if (checks.active(row) || row.state === 'failed') keyboard.push([
    { text: ({ru:'Обновить результат',en:'Refresh result',es:'Actualizar resultado',zh:'刷新结果'})[bot.locale]||'Refresh result', callback_data: `um:r:check:${parts[3]}:${row.nonce}` },
    { text: ({ru:'Закрыть проверку',en:'Close check',es:'Cerrar comprobación',zh:'关闭检查'})[bot.locale]||'Close check', callback_data: `um:r:stop:${parts[3]}:${row.nonce}` },
  ]);
  keyboard.push([{ text: ({ru:'← Настройки реакций',en:'← Reaction settings',es:'← Ajustes de reacciones',zh:'← 表情反应设置'})[bot.locale]||'← Reaction settings', callback_data: `um:r:home:${parts[3]}` }]);
  // On the management panel direct the user to the actual probe, not this panel.
  const text = row.state === 'ready' && row.group_message_id
    ? ({ru:'Проверка создана. Перейдите к тестовым сообщениям по кнопкам ниже.\n\n',en:'Check created. Open the test messages below.\n\n',es:'Se creó la comprobación. Abre los mensajes de prueba con los botones de abajo.\n\n',zh:'检查已创建。请点击下方按钮打开测试消息。\n\n'})[bot.locale] + reactionSummary(await ensureReactionSettings(requireDb(env), selected.id), bot.locale)
    : screen.text;
  if (row.group_message_id) keyboard.unshift([{ text: ({ru:'Тест в General',en:'General test',es:'Prueba en General',zh:'General 测试'})[bot.locale]||'General test', url: `https://t.me/c/${String(row.group_id).replace(/^-100/, '')}/${row.group_message_id}` }]);
  return operatorScreen(bot, env, query.message, text, { inline_keyboard: keyboard }, true);
}

async function claimReactionSettingsLock(db) {
  const ownerToken = crypto.randomUUID();
  const leaseExpiresAt = isoAfter(REACTION_SETTINGS_LEASE_MS);
  const inserted = await dbRun(
    db,
    "INSERT INTO reaction_settings_lock (id, owner_token, lease_expires_at, created_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    ownerToken,
    leaseExpiresAt,
    nowIso(),
  );
  if (inserted.meta?.changes === 1) return ownerToken;
  const current = await dbOne(db, "SELECT owner_token, lease_expires_at FROM reaction_settings_lock WHERE id = 1");
  if (!current?.lease_expires_at || Date.parse(current.lease_expires_at) > Date.now()) return null;
  const reclaimed = await dbRun(
    db,
    "UPDATE reaction_settings_lock SET owner_token = ?, lease_expires_at = ?, created_at = ? WHERE id = 1 AND owner_token = ? AND lease_expires_at <= ?",
    ownerToken,
    leaseExpiresAt,
    nowIso(),
    current.owner_token,
    nowIso(),
  );
  return reclaimed.meta?.changes === 1 ? ownerToken : null;
}

async function releaseReactionSettingsLock(db, ownerToken) {
  await dbRun(db, "DELETE FROM reaction_settings_lock WHERE id = 1 AND owner_token = ?", ownerToken);
}

async function renewReactionSettingsLock(db, ownerToken) {
  const renewed = await dbRun(
    db,
    "UPDATE reaction_settings_lock SET lease_expires_at = ? WHERE id = 1 AND owner_token = ? AND lease_expires_at > ?",
    isoAfter(REACTION_SETTINGS_LEASE_MS),
    ownerToken,
    nowIso(),
  );
  return renewed.meta?.changes === 1;
}

async function setReactionSetting(managementBot, env, actor, targetBotId, enabled, direction = null) {
  try {
    return await withAuthorizedOperatorExecution(managementBot, env, actor.id, async (renewOperatorFence) => {
      const db = requireDb(env);
      let ownerToken;
      try {
        ownerToken = await claimReactionSettingsLock(db);
      } catch (error) {
        log(managementBot, "error", "reaction_settings_lock_failed", { target_bot_id: targetBotId, message: error.message });
        return { ok: false, changed: false, text: t(managementBot, "reactionsSaveFailed") };
      }
      if (!ownerToken) return { ok: false, changed: false, text: t(managementBot, "reactionsBusy") };
      try {
        if (!await isAdmin(managementBot, env, actor.id)) throw operatorRevokedError();
        return await setReactionSettingLocked(managementBot, env, actor, targetBotId, enabled, ownerToken, renewOperatorFence, direction);
      } finally {
        try { await releaseReactionSettingsLock(db, ownerToken); }
        catch (error) { log(managementBot, "error", "reaction_settings_lock_release_failed", { target_bot_id: targetBotId, message: error.message }); }
      }
    });
  } catch (error) {
    if (error?.operatorRevoked) return { ok: false, changed: false, text: t(managementBot, "unauthorized") };
    throw error;
  }
}

async function setReactionSettingLocked(managementBot, env, actor, targetBotId, enabled, settingsOwnerToken, renewOperatorFence, direction) {
  const db = requireDb(env);
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const targetConfig = registry.find((config) => config.id === targetBotId && config.enabled);
  if (!targetConfig) return { ok: false, text: ({ru:"Неизвестный или отключённый support-бот.",en:"Unknown or disabled support bot.",es:"Bot de soporte desconocido o desactivado.",zh:"未知或已停用的支持机器人。"})[managementBot.locale] || "Unknown or disabled support bot." };
  let persistedBot;
  let before;
  let states;
  try {
    persistedBot = await dbOne(db, "SELECT enabled FROM bots WHERE id = ?", targetConfig.id);
    before = await ensureReactionSettings(db, targetConfig.id);
    states = await reactionStateMap(db);
  } catch (error) {
    log(managementBot, "error", "reaction_setting_lookup_failed", { target_bot_id: targetConfig.id, message: error.message });
    return { ok: false, changed: false, text: t(managementBot, "reactionsSaveFailed") };
  }
  if (enabled && persistedBot && Number(persistedBot.enabled) === 0) {
    return { ok: false, changed: false, text: ({ru:"Support-бот отключён аварийным выключателем D1.",en:"The support bot is disabled by the D1 emergency switch.",es:"El bot de soporte está desactivado por el interruptor de emergencia de D1.",zh:"支持机器人已被 D1 紧急开关停用。"})[managementBot.locale] || "The support bot is disabled by the D1 emergency switch." };
  }
  if (direction !== null && !REACTION_DIRECTIONS.includes(direction)) throw new Error('Unknown reaction direction');
  const selectedDirections = direction ? [direction] : REACTION_DIRECTIONS;
  if (enabled && !selectedDirections.some(value => reactionDirection(before, value).verified)) return { ok: false, text: t(managementBot, "reactionsUnavailable") };
  const afterState = { ...before };
  for (const value of selectedDirections) afterState[value + '_enabled'] = enabled && reactionDirection(before, value).verified ? 1 : 0;
  const stateChanged = selectedDirections.some(value => reactionDirection(before, value).enabled !== reactionDirection(afterState, value).enabled);
  const effectiveOwner = await effectiveGroupCommandOwner(db, registry, env);
  const subscriptionsBefore = desiredReactionSubscriptions(registry, states, effectiveOwner?.id || null);
  states.set(targetConfig.id, { ...states.get(targetConfig.id), enabled: REACTION_DIRECTIONS.some(value => { const s = reactionDirection(afterState, value); return s.enabled && s.verified; }), verified: true });
  const subscriptionsAfter = desiredReactionSubscriptions(registry, states, effectiveOwner?.id || null);
  const reconcileIds = new Set([targetConfig.id, effectiveOwner?.id]);
  const changedSubscriptions = registry.filter((config) => reconcileIds.has(config.id) || subscriptionsBefore.get(config.id) !== subscriptionsAfter.get(config.id));
  const externallyChanged = [];
  try {
    for (const config of changedSubscriptions) {
      if (!await renewReactionSettingsLock(db, settingsOwnerToken)) throw new Error("Reaction settings lease was lost");
      await renewOperatorFence();
      await setReactionWebhookSubscription(config, env, subscriptionsAfter.get(config.id));
      externallyChanged.push(config);
    }
  } catch (error) {
    for (const config of externallyChanged.reverse()) {
      try {
        if (!await renewReactionSettingsLock(db, settingsOwnerToken)) throw new Error("Reaction settings lease was lost during rollback");
        // Compensation restores the pre-operation external state. It must remain possible
        // after the initiating operator fence is lost, while the global reaction-settings
        // fence still proves this reconciler owns the rollback.
        await setReactionWebhookSubscription(config, env, subscriptionsBefore.get(config.id));
      }
      catch (rollbackError) { log(managementBot, "error", "reaction_webhook_rollback_failed", { target_bot_id: config.id, message: rollbackError.message }); }
    }
    log(managementBot, "error", "reaction_webhook_update_failed", { target_bot_id: targetConfig.id, message: error.message });
    return { ok: false, changed: false, text: t(managementBot, "reactionsSaveFailed") };
  }
  if (!stateChanged) {
    return { ok: true, changed: false, text: `${targetConfig.displayName}: ${enabled ? t(managementBot, "reactionsOn") : t(managementBot, "reactionsOff")}.` };
  }
  const now = nowIso();
  try {
    if (!await renewReactionSettingsLock(db, settingsOwnerToken)) throw new Error("Reaction settings lease was lost before save");
    await renewOperatorFence();
    await db.batch([
      db.prepare("UPDATE reaction_settings SET enabled = ?, support_to_user_enabled = ?, user_to_support_enabled = ?, updated_at = ? WHERE bot_id = ?").bind(
        REACTION_DIRECTIONS.some(value => reactionDirection(afterState, value).enabled) ? 1 : 0,
        reactionDirection(afterState, 'support_to_user').enabled ? 1 : 0, reactionDirection(afterState, 'user_to_support').enabled ? 1 : 0, now, targetConfig.id),
      operatorAuditStatement(db, targetConfig.id, null, actor, enabled ? "reactions_enable" : "reactions_disable", "success", { reason: `${direction ? direction + ": " : ""}${enabled ? "off → on" : "on → off"}` }),
    ]);
  } catch (error) {
    for (const config of externallyChanged.reverse()) {
      try {
        if (!await renewReactionSettingsLock(db, settingsOwnerToken)) throw new Error("Reaction settings lease was lost during rollback");
        // Compensation restores the pre-operation external state. It must remain possible
        // after the initiating operator fence is lost, while the global reaction-settings
        // fence still proves this reconciler owns the rollback.
        await setReactionWebhookSubscription(config, env, subscriptionsBefore.get(config.id));
      }
      catch (rollbackError) { log(managementBot, "error", "reaction_webhook_rollback_failed", { target_bot_id: config.id, message: rollbackError.message }); }
    }
    log(managementBot, "error", "reaction_setting_save_failed", { target_bot_id: targetConfig.id, message: error.message });
    return { ok: false, changed: false, text: t(managementBot, "reactionsSaveFailed") };
  }
  const normalMessagesNote = ({ru:" Обычные сообщения продолжат работать.",en:" Normal messages will continue to work.",es:" Los mensajes normales seguirán funcionando.",zh:" 普通消息仍会正常发送。"})[managementBot.locale] || " Normal messages will continue to work.";
  return { ok: true, changed: true, text: `${targetConfig.displayName}: ${enabled ? t(managementBot, "reactionsOn") : t(managementBot, "reactionsOff")}.${enabled ? "" : normalMessagesNote}` };
}

async function userListScreen(bot, env, botKey, filter, page) {
  const db = requireDb(env);
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const selected = managementBotFromKey(registry, botKey);
  if (botKey !== "a" && !selected) throw new Error("Unknown management service");
  const result = await listManagedProfiles(db, selected?.id || null, filter, page);
  const c={ru:['Все боты','Найдено','без username','обращение','Пользователи не найдены.','← Главная'],en:['All bots','Found','no username','conversation','No users found.','← Home'],es:['Todos los bots','Encontrados','sin nombre de usuario','conversación','No se encontraron usuarios.','← Inicio'],zh:['所有机器人','找到','无用户名','会话','未找到用户。','← 主页']}[bot.locale]||['All bots','Found','no username','conversation','No users found.','← Home'];
  const lines = [`${filterLabel(bot, filter)} · ${selected?.displayName || c[0]}`, `${c[1]}: ${result.count}`, ""];
  result.rows.forEach((profile, index) => {
    const service = registry.find((item) => item.id === profile.bot_id)?.displayName || profile.bot_id;
    const conversationStatus = profile.conversation_status === "closed" ? t(bot, "closedStatus") : t(bot, "openStatus");
    lines.push(`${result.page * MANAGEMENT_PAGE_SIZE + index + 1}. ${profileDisplayName(profile)} · ${profile.username ? `@${profile.username}` : c[2]} · ${profile.user_id}`);
    lines.push(`   ${service} · ${profilePrimaryStatus(profile, bot)} · ${c[3]}: ${conversationStatus}`);
  });
  if (!result.rows.length) lines.push(c[4]);
  const keyboard = result.rows.map((profile) => [{ text: `${profileDisplayName(profile).slice(0, 24)} · ${profile.user_id}`, callback_data: `um:g:card:${managementBotKey(registry, profile.bot_id)}:${profile.user_id}` }]);
  const pagination = [];
  if (result.page > 0) pagination.push({ text: "←", callback_data: `um:g:list:${botKey}:${filter}:${result.page - 1}` });
  pagination.push({ text: `${result.page + 1} / ${result.pages}`, callback_data: `um:g:list:${botKey}:${filter}:${result.page}` });
  if (result.page + 1 < result.pages) pagination.push({ text: "→", callback_data: `um:g:list:${botKey}:${filter}:${result.page + 1}` });
  keyboard.push(pagination, [{ text: c[5], callback_data: `um:g:home:${botKey}` }]);
  return { text: lines.join("\n"), replyMarkup: { inline_keyboard: keyboard } };
}

function userCardScreen(bot, env, profile) {
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const config = registry.find((item) => item.id === profile.bot_id);
  const key = managementBotKey(registry, profile.bot_id);
  const c={ru:['Последняя активность','Статус','Обращение','Доверие','да','нет','Риск','💬 Открыть переписку','Работа с обращением','Снять доверие','✅ Доверие и очередь…','Снять ручное ограничение','⏳ Ограничить','Разблокировать','🚫 Заблокировать','🧹 Риск, CAPTCHA и автомьют…','📜 История','🔄 Обновить','← Главная'],en:['Last activity','Status','Conversation','Trust','yes','no','Risk','💬 Open conversation','Conversation workflow','Untrust','✅ Trust and queue…','Remove manual restriction','⏳ Restrict','Unblock','🚫 Block','🧹 Risk, CAPTCHA and auto-mute…','📜 History','🔄 Refresh','← Home'],es:['Última actividad','Estado','Conversación','Confianza','sí','no','Riesgo','💬 Abrir conversación','Gestión de la conversación','Retirar confianza','✅ Confiar y liberar cola…','Retirar restricción manual','⏳ Restringir','Desbloquear','🚫 Bloquear','🧹 Riesgo, CAPTCHA y restricción automática…','📜 Historial','🔄 Actualizar','← Inicio'],zh:['最近活动','状态','会话','信任','是','否','风险','💬 打开会话','会话工作流','取消信任','✅ 设为可信并释放队列…','解除手动限制','⏳ 限制','解除封禁','🚫 封禁','🧹 风险、CAPTCHA 和自动限制…','📜 历史记录','🔄 刷新','← 主页']}[bot.locale]||['Last activity','Status','Conversation','Trust','yes','no','Risk','💬 Open conversation','Conversation workflow','Untrust','✅ Trust and queue…','Remove manual restriction','⏳ Restrict','Unblock','🚫 Block','🧹 Risk, CAPTCHA and auto-mute…','📜 History','🔄 Refresh','← Home'];
  const trusted = Number(profile.manual_trust) === 1 || isFuture(profile.trusted_until);
  const stateKey = managementStateKey(profile);
  const conversationStatus = profile.conversation_status === "closed" ? t(bot, "closedStatus") : t(bot, "openStatus");
  const lines = [
    profileDisplayName(profile), "",
    `Telegram ID: ${profile.user_id}`,
    `Username: ${profile.username ? `@${profile.username}` : "—"}`,
    `${c[0]}: ${formatOperatorDate(bot, profile.activity_at)}`, "",
    config?.displayName || profile.bot_id,
    `${c[1]}: ${profilePrimaryStatus(profile, bot)}`,
    `${c[2]}: ${conversationStatus}`,
    `${c[3]}: ${trusted ? c[4] : c[5]}`,
    `${c[6]}: ${Number(profile.risk_score || 0)}`,
    ...(Number(profile.thread_id) > 1 ? ['', messageDeletionWarning(bot.locale, config?.username)] : []),
  ];
  const keyboard = [
    ...(topicLink(supportGroupId(env),profile.thread_id)?[[{text:c[7],url:topicLink(supportGroupId(env),profile.thread_id)}]]:[]),
    [{text:c[8],callback_data:`um:w:card:${key}:${profile.user_id}`}],
    [{ text: Number(profile.manual_trust) === 1 ? c[9] : c[10], callback_data: `um:g:act:${Number(profile.manual_trust) === 1 ? "untrust" : "trust"}:${key}:${profile.user_id}:${stateKey}` }, { text: isManuallyRestricted(profile) ? c[11] : c[12], callback_data: `um:g:act:${isManuallyRestricted(profile) ? "unrestrict" : "restrict"}:${key}:${profile.user_id}:${stateKey}` }],
    [{ text: profile.banned_at ? c[13] : c[14], callback_data: `um:g:act:${profile.banned_at ? "unban" : "ban"}:${key}:${profile.user_id}:${stateKey}` }, { text: c[15], callback_data: `um:g:act:riskreset:${key}:${profile.user_id}:${stateKey}` }],
    [{ text: c[16], callback_data: `um:g:uaudit:${key}:${profile.user_id}:0` }, { text: c[17], callback_data: `um:g:card:${key}:${profile.user_id}` }],
    [{ text: c[18], callback_data: `um:g:home:${key}` }],
  ];
  return { text: lines.join("\n")+'\n\n'+accessSummary(bot,profile), replyMarkup: { inline_keyboard: keyboard } };
}

async function reconcilePrimaryOperator(db, env) {
  const primaryId = primaryOperatorId(env);
  const timestamp = nowIso();
  await dbRun(db, "INSERT INTO support_primary_operator_state (id, user_id, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING", primaryId, timestamp);
  const state = await dbOne(db, "SELECT user_id FROM support_primary_operator_state WHERE id = 1");
  if (Number(state?.user_id) !== primaryId) {
    await db.batch([
      db.prepare("UPDATE support_operators SET active = 0, removed_by = NULL, removed_by_name = ?, removed_at = COALESCE(removed_at, ?) WHERE active = 1 AND user_id IN (?, ?)").bind("System: primary operator changed", timestamp, Number(state?.user_id), primaryId),
      db.prepare("UPDATE support_primary_operator_state SET user_id = ?, updated_at = ? WHERE id = 1").bind(primaryId, timestamp),
    ]);
  } else {
    await dbRun(db, "UPDATE support_operators SET active = 0, removed_by = NULL, removed_by_name = ?, removed_at = COALESCE(removed_at, ?) WHERE active = 1 AND user_id = ?", "System: promoted to primary operator", timestamp, primaryId);
  }
  return primaryId;
}

async function operatorRole(bot, env, userId) {
  const primaryId = primaryOperatorId(env);
  const numericUserId = Number(userId);
  if (numericUserId === primaryId) return "primary";
  try {
    const db = requireDb(env);
    const primaryState = await dbOne(db, "SELECT user_id FROM support_primary_operator_state WHERE id = 1");
    if (!primaryState || Number(primaryState.user_id) !== primaryId) await reconcilePrimaryOperator(db, env);
    const row = await dbOne(db, "SELECT 1 FROM support_operators WHERE user_id = ? AND active = 1", numericUserId);
    return row ? "operator" : null;
  } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error;
    log(bot, "error", "operator_authorization_store_failed_closed", { user_id: numericUserId, message: error.message });
    return null;
  }
}

async function isAdmin(bot, env, userId) {
  return Boolean(await operatorRole(bot, env, userId));
}

function operatorRevokedError() {
  const error = new Error("Operator access was revoked");
  error.operatorRevoked = true;
  return error;
}

function operatorExecutionBusyError() {
  const error = new Error("Operator execution is busy; retry this update");
  error.operatorExecutionBusy = true;
  return error;
}

async function claimOperatorExecutionLock(db, operatorId) {
  const ownerToken = crypto.randomUUID();
  const timestamp = nowIso();
  const claimed = await dbRun(db,
    `INSERT INTO support_operator_execution_locks (operator_id, owner_token, lease_expires_at, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(operator_id) DO UPDATE SET
      owner_token = excluded.owner_token, lease_expires_at = excluded.lease_expires_at, created_at = excluded.created_at
      WHERE support_operator_execution_locks.lease_expires_at <= ?`,
    Number(operatorId), ownerToken, isoAfter(OPERATOR_EXECUTION_LEASE_MS), timestamp, timestamp);
  if (claimed.meta?.changes === 1) return ownerToken;
  throw operatorExecutionBusyError();
}

async function releaseOperatorExecutionLock(db, operatorId, ownerToken) {
  await dbRun(db, "DELETE FROM support_operator_execution_locks WHERE operator_id = ? AND owner_token = ?", Number(operatorId), ownerToken);
}

async function renewOperatorExecutionLock(db, operatorId, ownerToken, background = false) {
  const renewed = await (background ? backgroundDbRun : dbRun)(db,
    "UPDATE support_operator_execution_locks SET lease_expires_at = ? WHERE operator_id = ? AND owner_token = ? AND lease_expires_at > ?",
    isoAfter(OPERATOR_EXECUTION_LEASE_MS), Number(operatorId), ownerToken, nowIso());
  return renewed === null ? null : renewed.meta?.changes === 1;
}

async function withAuthorizedOperatorExecution(bot, env, operatorId, callback) {
  const db = requireDb(env);
  const ownerToken = await claimOperatorExecutionLock(db, operatorId);
  const configuredRenewMs = asPositiveInteger(env.OPERATOR_EXECUTION_RENEW_MS, Math.floor(OPERATOR_EXECUTION_LEASE_MS / 3));
  const renewEveryMs = Math.max(20, Math.min(configuredRenewMs, Math.floor(OPERATOR_EXECUTION_LEASE_MS / 3)));
  let stopped = false;
  let leaseLost = false;
  let renewal = Promise.resolve();
  const renewFence = async () => {
    await renewal;
    if (leaseLost || stopped) throw operatorExecutionBusyError();
    if (!await renewOperatorExecutionLock(db, operatorId, ownerToken)) {
      leaseLost = true;
      throw operatorExecutionBusyError();
    }
  };
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (stopped || leaseLost) return;
      try {
        if (await renewOperatorExecutionLock(db, operatorId, ownerToken, true) === false) leaseLost = true;
      } catch (error) {
        leaseLost = true;
        log(bot, "error", "operator_execution_lock_renew_failed", { operator_id: Number(operatorId), message: error.message });
      }
    });
  }, renewEveryMs);
  try {
    if (!await isAdmin(bot, env, operatorId)) throw operatorRevokedError();
    return await callback(renewFence);
  } finally {
    stopped = true;
    clearInterval(timer);
    try { await renewal; }
    finally {
      try { await releaseOperatorExecutionLock(db, operatorId, ownerToken); }
      catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error; log(bot, "error", "operator_execution_lock_release_failed", { operator_id: Number(operatorId), message: error.message }); }
    }
  }
}

function operatorAuditStatement(db, targetBotId, userId, actor, action, result = "success", options = {}) {
  if (options.deduplicate) {
    // One atomic statement: a webhook retry must not duplicate a known outcome.
    return db.prepare(`INSERT INTO operator_audit (bot_id, user_id, actor_type, operator_id, operator_name, action, duration_seconds, reason, result, created_at)
      SELECT ?, ?, 'operator', ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM operator_audit WHERE bot_id=? AND user_id=? AND operator_id=? AND action=? AND reason=? AND result=?)`)
      .bind(targetBotId, userId, actor.id, operatorName(actor), action, options.durationSeconds ?? null,
        options.reason, result, nowIso(), targetBotId, userId, actor.id, action, options.reason, result);
  }
  return db.prepare("INSERT INTO operator_audit (bot_id, user_id, actor_type, operator_id, operator_name, action, duration_seconds, reason, result, created_at) VALUES (?, ?, 'operator', ?, ?, ?, ?, ?, ?, ?)")
    .bind(targetBotId, userId ?? null, actor.id, operatorName(actor), action, options.durationSeconds ?? null, options.reason ?? null, result, nowIso());
}
function systemAuditStatement(db, targetBotId, userId, action, result = "success") {
  return db.prepare("INSERT INTO operator_audit (bot_id, user_id, actor_type, action, result, created_at) VALUES (?, ?, 'system', ?, ?, ?)")
    .bind(targetBotId, userId ?? null, action, result, nowIso());
}
function operatorFlowCompletionStatement(db, nonce, actor, action) {
  return db.prepare("INSERT OR IGNORE INTO operator_completed_flows (flow_nonce, operator_id, action, completed_at) SELECT ?, ?, ?, ? WHERE ? IS NOT NULL")
    .bind(nonce ?? null, actor.id, action, nowIso(), nonce ?? null);
}

function queuedUserMediaCleanupStatements(db, botId, userId) {
  return [
    db.prepare(`DELETE FROM media_group_items
      WHERE EXISTS (
        SELECT 1 FROM media_groups AS g
         WHERE g.bot_id = media_group_items.bot_id
           AND g.direction = media_group_items.direction
           AND g.media_group_id = media_group_items.media_group_id
           AND g.source_chat_id = media_group_items.source_chat_id
           AND g.bot_id = ? AND g.user_id = ? AND g.direction = 'user_to_support'
      )`).bind(botId, userId),
    db.prepare("DELETE FROM media_groups WHERE bot_id = ? AND user_id = ? AND direction = 'user_to_support'").bind(botId, userId),
  ];
}

async function notifyRestrictedUser(bot, env, userId, restrictedUntil) {
  const db = requireDb(env);
  const current = await dbOne(db, "SELECT manual_restriction_notice_at FROM user_abuse_state WHERE bot_id = ? AND user_id = ? AND manual_restricted_until = ?", bot.id, userId, restrictedUntil);
  if (current?.manual_restriction_notice_at) return "sent";
  const result = await telegram(bot, "sendMessage", {
    chat_id: userId,
    text: `${t(bot, "restrictedUntil")} ${formatOperatorDate(bot, restrictedUntil)}.`,
  }, env);
  if (!result.ok) {
    if (isRetryableTelegramFailure(result) || isDeliveryOutcomeUncertain(result)) {
      log(bot, "warn", "manual_restriction_notice_failed", { user_id: userId, description: result.description, delivery_uncertain: isDeliveryOutcomeUncertain(result) });
      return "retry";
    }
    await dbRun(db, "UPDATE user_abuse_state SET manual_restriction_notice_at = COALESCE(manual_restriction_notice_at, ?) WHERE bot_id = ? AND user_id = ? AND manual_restricted_until = ?", nowIso(), bot.id, userId, restrictedUntil);
    log(bot, "warn", "manual_restriction_notice_permanent_failure", { user_id: userId, description: result.description });
    return "terminal";
  }
  await dbRun(db, "UPDATE user_abuse_state SET manual_restriction_notice_at = COALESCE(manual_restriction_notice_at, ?) WHERE bot_id = ? AND user_id = ? AND manual_restricted_until = ?", nowIso(), bot.id, userId, restrictedUntil);
  return "sent";
}

async function notifyBannedUser(bot, env, userId, bannedAt) {
  const db = requireDb(env);
  const current = await dbOne(db, "SELECT notified_at FROM banned_users WHERE bot_id = ? AND user_id = ? AND banned_at = ?", bot.id, userId, bannedAt);
  if (current?.notified_at) return "sent";
  const result = await telegram(bot, "sendMessage", { chat_id: userId, text: t(bot, "bannedNotice") }, env);
  if (!result.ok) {
    if (isRetryableTelegramFailure(result) || isDeliveryOutcomeUncertain(result)) {
      log(bot, "warn", "manual_ban_notice_failed", { user_id: userId, description: result.description, delivery_uncertain: isDeliveryOutcomeUncertain(result) });
      return "retry";
    }
    await dbRun(db, "UPDATE banned_users SET notified_at = COALESCE(notified_at, ?) WHERE bot_id = ? AND user_id = ? AND banned_at = ?", nowIso(), bot.id, userId, bannedAt);
    log(bot, "warn", "manual_ban_notice_permanent_failure", { user_id: userId, description: result.description });
    return "terminal";
  }
  await dbRun(db, "UPDATE banned_users SET notified_at = COALESCE(notified_at, ?) WHERE bot_id = ? AND user_id = ? AND banned_at = ?", nowIso(), bot.id, userId, bannedAt);
  return "sent";
}

async function latestProcessedUpdateId(db, botId) {
  const row = await dbOne(db, "SELECT MAX(update_id) AS update_id FROM processed_updates WHERE bot_id = ?", botId);
  return Number.isSafeInteger(Number(row?.update_id)) ? Number(row.update_id) : null;
}

async function applyManagementAction(bot, env, actor, action, userId, options = {}) {
  const db = requireDb(env);
  let currentProfile = null;
  if (!["attack_on", "attack_off", "attack_auto"].includes(action)) {
    currentProfile = await managedProfile(db, bot.id, userId);
    if (!currentProfile) return { changed: false, text: localizedWorkerSay(bot.locale, "Пользователь не найден.", "User not found.") };
  }
  const ru = bot.locale === "ru";
  const words = {
    reason: ["Причина должна содержать от 3 до 500 символов и не включать секреты.", "Reason must be 3–500 characters and contain no secrets.", "El motivo debe tener entre 3 y 500 caracteres y no incluir secretos.", "原因须为 3–500 个字符，且不能包含机密信息。"],
    alreadyBanned: ["Пользователь уже заблокирован.", "User is already blocked.", "El usuario ya está bloqueado.", "用户已被封禁。"],
    blockedNotified: ["Пользователь заблокирован и уведомлён.", "User blocked and notified.", "Usuario bloqueado y notificado.", "用户已封禁并通知。"],
    blockedRetry: ["Пользователь заблокирован; уведомление будет повторено позже.", "User blocked; notification will be retried later.", "Usuario bloqueado; se volverá a intentar enviar la notificación más tarde.", "用户已封禁；稍后将重试发送通知。"],
    blockedNoDelivery: ["Пользователь заблокирован; Telegram не позволяет доставить уведомление.", "User blocked; Telegram cannot deliver the notification.", "Usuario bloqueado; Telegram no puede entregar la notificación.", "用户已封禁；Telegram 无法送达通知。"],
    notBanned: ["Пользователь не заблокирован.", "User is not blocked.", "El usuario no está bloqueado.", "用户未被封禁。"],
    unblocked: ["Пользователь разблокирован.", "User unblocked.", "Usuario desbloqueado.", "用户已解除封禁。"],
    duration: ["Срок должен быть от 5 минут до 30 дней.", "Duration must be between 5 minutes and 30 days.", "La duración debe ser de entre 5 minutos y 30 días.", "时长须为 5 分钟至 30 天。"],
    unblockFirst: ["Сначала разблокируйте пользователя.", "Unblock the user first.", "Desbloquea primero al usuario.", "请先解除用户封禁。"],
    retrySuffix: ["; уведомление будет повторено позже.", "; notification will be retried later.", "; se volverá a intentar enviar la notificación más tarde.", "；稍后将重试发送通知。"],
    noDeliverySuffix: ["; Telegram не позволяет доставить уведомление.", "; Telegram cannot deliver the notification.", "; Telegram no puede entregar la notificación.", "；Telegram 无法送达通知。"],
    restricted: ["Пользователь ограничен до", "User restricted until", "Usuario restringido hasta", "用户受限至"],
    noRestriction: ["Ручного ограничения нет.", "No manual restriction is active.", "No hay ninguna restricción manual activa.", "当前没有手动限制。"],
    restrictionRemoved: ["Ручное ограничение снято. Автоматическое состояние не изменено.", "Manual restriction removed. Automatic state was not changed.", "Se quitó la restricción manual. El estado automático no cambió.", "已解除手动限制。自动状态未更改。"],
    alreadyTrusted: ["Пользователь уже доверенный.", "User is already trusted.", "El usuario ya es de confianza.", "用户已设为可信。"],
    noManualTrust: ["Ручного доверия нет.", "Manual trust is not active.", "La confianza manual no está activa.", "手动信任未启用。"],
    noTopic: ["Тема пользователя ещё не создана.", "The user has no topic yet.", "Aún no se ha creado un tema para el usuario.", "尚未为该用户创建话题。"],
    topicCurrent: ["Состояние темы уже актуально.", "Topic state is already current.", "El estado del tema ya está actualizado.", "话题状态已是最新。"],
    recreated: ["Тема была удалена и создана заново", "Topic was deleted and recreated", "El tema se eliminó y se creó de nuevo", "话题已删除并重新创建"],
    topicClosed: ["Тема закрыта.", "Topic closed.", "Tema cerrado.", "话题已关闭。"],
    topicOpened: ["Тема открыта.", "Topic reopened.", "Tema reabierto.", "话题已重新打开。"],
    attackDuration: [" · на 1 час, затем AUTO", " · for 1 hour, then AUTO", " · durante 1 hora y luego AUTO", " · 持续 1 小时，然后切换为 AUTO"],
    unknown: ["Неизвестное действие.", "Unknown action.", "Acción desconocida.", "未知操作。"],
  };
  const word = (key) => words[key][({ ru: 0, en: 1, es: 2, zh: 3 })[bot.locale] ?? 1];
  if (action === "ban") {
    const reason = validateManagementReason(options.reason);
    if (!reason) return { changed: false, text: word("reason") };
    if (currentProfile.banned_at) return { changed: false, text: word("alreadyBanned") };
    const timestamp = nowIso();
    await ensureAbuseState(db, bot.id, userId);
    const [inserted] = await db.batch([
      db.prepare("INSERT INTO banned_users (bot_id, user_id, reason, banned_at, banned_by, banned_by_name, notified_at) VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(bot_id, user_id) DO NOTHING").bind(bot.id, userId, reason, timestamp, actor.id, operatorName(actor)),
      db.prepare("UPDATE verification_challenges SET status = 'failed', failed_at = ? WHERE bot_id = ? AND user_id = ? AND (status = 'pending' OR (status = 'passed' AND flushed_at IS NULL))").bind(timestamp, bot.id, userId),
      db.prepare("DELETE FROM pending_flush_locks WHERE bot_id = ? AND user_id = ?").bind(bot.id, userId),
      db.prepare("DELETE FROM pending_messages WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL").bind(bot.id, userId),
      db.prepare("DELETE FROM reopen_business_messages WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL").bind(bot.id, userId),
      db.prepare("UPDATE conversation_reopen_effects SET cancelled_at = COALESCE(cancelled_at, ?), cancellation_reason = COALESCE(cancellation_reason, 'banned'), completed_at = COALESCE(completed_at, ?), recovery_owner_token = NULL, recovery_lease_expires_at = NULL WHERE bot_id = ? AND user_id = ? AND completed_at IS NULL").bind(timestamp, timestamp, bot.id, userId),
      ...queuedUserMediaCleanupStatements(db, bot.id, userId),
      db.prepare("UPDATE user_abuse_state SET verification_required = 0, pending_release_required = 0, updated_at = ? WHERE bot_id = ? AND user_id = ?").bind(timestamp, bot.id, userId),
      operatorAuditStatement(db, bot.id, userId, actor, "manual_ban", "success", { reason }),
      operatorFlowCompletionStatement(db, options.flowNonce, actor, "ban"),
    ]);
    if (!(inserted.meta?.changes > 0)) return { changed: false, text: word("alreadyBanned") };
    await recordAbuseEvent(db, bot.id, userId, `manual-ban:${timestamp}:${actor.id}`, "manual_ban");
    await options.renewOperatorFence?.();
    const notification = await notifyBannedUser(bot, env, userId, timestamp);
    const text = notification === "sent"
      ? word("blockedNotified")
      : notification === "retry"
        ? word("blockedRetry")
        : word("blockedNoDelivery");
    return { changed: true, text };
  }
  if (action === "unban") {
    if (!currentProfile.banned_at) return { changed: false, text: word("notBanned") };
    const [removed] = await db.batch([
      db.prepare("DELETE FROM banned_users WHERE bot_id = ? AND user_id = ?").bind(bot.id, userId),
      operatorAuditStatement(db, bot.id, userId, actor, "manual_unban"),
    ]);
    if (!(removed.meta?.changes > 0)) return { changed: false, text: word("notBanned") };
    return { changed: true, text: word("unblocked") };
  }
  if (action === "restrict") {
    const durationMs = Number(options.durationMs);
    if (!Number.isSafeInteger(durationMs) || durationMs < MIN_RESTRICTION_MS || durationMs > MAX_RESTRICTION_MS) return { changed: false, text: word("duration") };
    if (currentProfile.banned_at) return { changed: false, text: word("unblockFirst") };
    await ensureAbuseState(db, bot.id, userId);
    const timestamp = nowIso();
    const restrictedUntil = new Date(Date.now() + durationMs).toISOString();
    await db.batch([
      db.prepare("UPDATE user_abuse_state SET manual_restricted_until = ?, manual_restriction_reason = ?, manual_restriction_notice_at = NULL, verification_required = 0, pending_release_required = 0, updated_at = ? WHERE bot_id = ? AND user_id = ?").bind(restrictedUntil, options.reason || null, timestamp, bot.id, userId),
      db.prepare("UPDATE verification_challenges SET status = 'expired', failed_at = COALESCE(failed_at, ?) WHERE bot_id = ? AND user_id = ? AND (status = 'pending' OR (status = 'passed' AND flushed_at IS NULL))").bind(timestamp, bot.id, userId),
      db.prepare("DELETE FROM pending_flush_locks WHERE bot_id = ? AND user_id = ?").bind(bot.id, userId),
      db.prepare("DELETE FROM pending_messages WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL").bind(bot.id, userId),
      db.prepare("DELETE FROM reopen_business_messages WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL").bind(bot.id, userId),
      db.prepare("UPDATE conversation_reopen_effects SET cancelled_at = COALESCE(cancelled_at, ?), cancellation_reason = COALESCE(cancellation_reason, 'manual_restriction'), completed_at = COALESCE(completed_at, ?), recovery_owner_token = NULL, recovery_lease_expires_at = NULL WHERE bot_id = ? AND user_id = ? AND completed_at IS NULL").bind(timestamp, timestamp, bot.id, userId),
      operatorAuditStatement(db, bot.id, userId, actor, "manual_restrict", "success", { durationSeconds: Math.floor(durationMs / 1000), reason: options.reason || null }),
      operatorFlowCompletionStatement(db, options.flowNonce, actor, "restrict"),
    ]);
    await options.renewOperatorFence?.();
    const notification = await notifyRestrictedUser(bot, env, userId, restrictedUntil);
    const suffix = notification === "sent" ? "." : notification === "retry"
      ? word("retrySuffix")
      : word("noDeliverySuffix");
    return { changed: true, text: `${word("restricted")} ${formatOperatorDate(bot, restrictedUntil)}${suffix}` };
  }
  if (action === "unrestrict") {
    await ensureAbuseState(db, bot.id, userId);
    if (!currentProfile.manual_restricted_until) return { changed: false, text: word("noRestriction") };
    const [changed] = await db.batch([
      db.prepare("UPDATE user_abuse_state SET manual_restricted_until = NULL, manual_restriction_reason = NULL, manual_restriction_notice_at = NULL, updated_at = ? WHERE bot_id = ? AND user_id = ? AND manual_restricted_until IS NOT NULL").bind(nowIso(), bot.id, userId),
      operatorAuditStatement(db, bot.id, userId, actor, "manual_unrestrict"),
    ]);
    if (!(changed.meta?.changes > 0)) return { changed: false, text: word("noRestriction") };
    return { changed: true, text: word("restrictionRemoved") };
  }
  if (action === "trust") {
    await ensureAbuseState(db, bot.id, userId);
    const state = await dbOne(db, "SELECT manual_trust, manual_restricted_until, pending_release_required FROM user_abuse_state WHERE bot_id = ? AND user_id = ?", bot.id, userId);
    if (Number(state?.manual_trust) === 1) {
      if (Number(state.pending_release_required) === 1 && !currentProfile.banned_at && !isFuture(state.manual_restricted_until)) {
        await options.renewOperatorFence?.();
    const released = await flushReleasedPendingMessages(bot, env, userId, options.decisionLocked === true);
        if (released.status === "busy") throw new Error("Pending release is already in progress");
        return { changed: true, text: t(bot, "trusted") };
      }
      return { changed: false, text: word("alreadyTrusted") };
    }
    await db.batch([
      db.prepare("UPDATE user_abuse_state SET manual_trust = 1, trusted_until = ?, verification_required = 0, pending_release_required = 1, updated_at = ? WHERE bot_id = ? AND user_id = ?").bind(isoAfter(bot.trustedDays * 86_400_000), nowIso(), bot.id, userId),
      db.prepare("UPDATE verification_challenges SET status = 'expired' WHERE bot_id = ? AND user_id = ? AND status = 'pending'").bind(bot.id, userId),
      operatorAuditStatement(db, bot.id, userId, actor, "manual_trust"),
    ]);
    if (!currentProfile.banned_at && !isFuture(state?.manual_restricted_until)) {
      await options.renewOperatorFence?.();
    const released = await flushReleasedPendingMessages(bot, env, userId, options.decisionLocked === true);
      if (released.status === "busy") throw new Error("Pending release is already in progress");
    }
    return { changed: true, text: t(bot, "trusted") };
  }
  if (action === "untrust") {
    await ensureAbuseState(db, bot.id, userId);
    if (Number(currentProfile.manual_trust) !== 1 && !currentProfile.trusted_until) return { changed: false, text: word("noManualTrust") };
    const [changed] = await db.batch([
      db.prepare("UPDATE user_abuse_state SET manual_trust = 0, trusted_until = NULL, updated_at = ? WHERE bot_id = ? AND user_id = ? AND (manual_trust = 1 OR trusted_until IS NOT NULL)").bind(nowIso(), bot.id, userId),
      operatorAuditStatement(db, bot.id, userId, actor, "manual_untrust"),
    ]);
    if (changed.meta?.changes !== 1) return { changed: false, text: word("noManualTrust") };
    return { changed: true, text: t(bot, "untrusted") };
  }
  if (action === "riskreset") {
    await ensureAbuseState(db, bot.id, userId);
    if (Number(currentProfile.risk_score) === 0 && !isFuture(currentProfile.muted_until) && Number(currentProfile.verification_required) === 0 && Number(currentProfile.pending_release_required) === 1 && !currentProfile.banned_at && !isFuture(currentProfile.manual_restricted_until)) {
      await options.renewOperatorFence?.();
    const released = await flushReleasedPendingMessages(bot, env, userId, options.decisionLocked === true);
      if (released.status === "busy") throw new Error("Pending release is already in progress");
      return { changed: true, text: t(bot, "riskReset") };
    }
    await db.batch([
      db.prepare("UPDATE user_abuse_state SET risk_score = 0, last_risk_at = ?, muted_until = NULL, verification_required = 0, pending_release_required = CASE WHEN manual_restricted_until IS NULL OR manual_restricted_until <= ? THEN 1 ELSE 0 END, updated_at = ? WHERE bot_id = ? AND user_id = ?").bind(nowIso(), nowIso(), nowIso(), bot.id, userId),
      db.prepare("UPDATE verification_challenges SET status = 'expired' WHERE bot_id = ? AND user_id = ? AND status = 'pending'").bind(bot.id, userId),
      operatorAuditStatement(db, bot.id, userId, actor, "risk_reset"),
    ]);
    const state = await dbOne(db, "SELECT manual_restricted_until FROM user_abuse_state WHERE bot_id = ? AND user_id = ?", bot.id, userId);
    if (!currentProfile.banned_at && !isFuture(state?.manual_restricted_until)) {
      await options.renewOperatorFence?.();
    const released = await flushReleasedPendingMessages(bot, env, userId, options.decisionLocked === true);
      if (released.status === "busy") throw new Error("Pending release is already in progress");
    }
    return { changed: true, text: t(bot, "riskReset") };
  }
  if (action === "close" || action === "open") {
    const conversation = await findConversation(db, bot.id, userId);
    if (!conversation) return { changed: false, text: word("noTopic") };
    const nextStatus = action === "close" ? "closed" : "open";
    if (conversation.status === nextStatus) return { changed: false, text: word("topicCurrent") };
    const method = action === "close" ? "closeForumTopic" : "reopenForumTopic";
    await options.renewOperatorFence?.();
    const changed = await telegram(bot, method, { chat_id: supportGroupId(env), message_thread_id: conversation.thread_id }, env);
    if (!changed.ok && action === "open" && isMissingTopicError(changed.description)) {
      await invalidateConversationTopic(db, bot.id, userId, conversation.thread_id, true);
      await options.renewOperatorFence?.();
    const recreated = await provisionConversation(bot, env, {
        id: userId,
        username: currentProfile.username || null,
        first_name: currentProfile.first_name || "User",
        last_name: currentProfile.last_name || null,
      });
      await operatorAuditStatement(db, bot.id, userId, actor, "conversation_open_recreated").run();
      return { changed: true, text: `${word("recreated")}: ${recreated.thread_id}` };
    }
    if (!changed.ok && !isAlreadyTopicState(changed.description, nextStatus)) throw new Error(`${method} failed: ${changed.description}`);
    const updateFloor = await latestProcessedUpdateId(db, bot.id);
    if (nextStatus === "closed") await db.batch([
      db.prepare("UPDATE conversations SET status = 'closed', reply_epoch = reply_epoch + CASE WHEN status <> 'closed' THEN 1 ELSE 0 END, topic_state_update_id = CASE WHEN ? IS NULL THEN topic_state_update_id WHEN topic_state_update_id IS NULL OR topic_state_update_id < ? THEN ? ELSE topic_state_update_id END WHERE id = ?").bind(updateFloor, updateFloor, updateFloor, conversation.id),
      operatorAuditStatement(db, bot.id, userId, actor, `conversation_${action}`),
    ]);
    else await db.batch([
      db.prepare("UPDATE conversations SET status = 'open', topic_state_update_id = CASE WHEN ? IS NULL THEN topic_state_update_id WHEN topic_state_update_id IS NULL OR topic_state_update_id < ? THEN ? ELSE topic_state_update_id END WHERE id = ?").bind(updateFloor, updateFloor, updateFloor, conversation.id),
      operatorAuditStatement(db, bot.id, userId, actor, `conversation_${action}`),
    ]);
    return { changed: true, text: action === "close" ? word("topicClosed") : word("topicOpened") };
  }
  if (["attack_on", "attack_off", "attack_auto"].includes(action)) {
    const override = action === "attack_auto" ? null : action === "attack_on" ? "on" : "off";
    const mode = override === "on" ? "attack" : "normal";
    await db.batch([
      db.prepare("INSERT INTO service_attack_state (bot_id, mode, manual_override, updated_at,override_until,manual_controlled) VALUES (?, ?, ?, ?,?,1) ON CONFLICT(bot_id) DO UPDATE SET mode = excluded.mode, manual_override = excluded.manual_override, override_until=excluded.override_until,manual_controlled=1, anomaly_seen_at = CASE WHEN excluded.manual_override IS NULL THEN service_attack_state.anomaly_seen_at ELSE NULL END, updated_at = excluded.updated_at").bind(bot.id, mode, override, nowIso(),override?isoAfter(3600000):null),
      operatorAuditStatement(db, bot.id, null, actor, `attack_control_${override || "auto"}`),
      operatorFlowCompletionStatement(db, options.flowNonce, actor, `attack_${override || "auto"}`),
    ]);
    return { changed: true, text: `${bot.displayName} · ${t(bot, "attack")}: ${(override || "auto").toUpperCase()}${override ? word("attackDuration") : ""}` };
  }
  return { changed: false, text: word("unknown") };
}

async function applyLockedManagementAction(bot, env, actor, action, userId, options = {}) {
  try {
    return await withAuthorizedOperatorExecution(bot, env, actor.id, async (renewOperatorFence) => {
      await renewOperatorFence();
      if (["attack_on", "attack_off", "attack_auto"].includes(action)) return applyManagementAction(bot, env, actor, action, userId, { ...options, renewOperatorFence });
      const db = requireDb(env);
      const owner = await claimAbuseDecisionLock(db, bot.id, userId);
      try {
        if (!await isAdmin(bot, env, actor.id)) throw operatorRevokedError();
        if (options.expectedStateKey) {
          const currentProfile = await managedProfile(db, bot.id, userId);
          if (!currentProfile || managementStateKey(currentProfile) !== options.expectedStateKey) {
            return { changed: false, stale: true, text: t(bot, "staleAction") };
          }
        }
        const result = await applyManagementAction(bot, env, actor, action, userId, { ...options, decisionLocked: true, renewOperatorFence });
        const conversation = await findConversation(db, bot.id, userId);
        if (conversation) {
          try { await renewOperatorFence(); await refreshTopicPanel(bot, env, conversation); }
          catch (error) { log(bot, "error", "topic_panel_refresh_failed", { user_id: userId, message: error.message }); }
        }
        return result;
      } finally {
        try { await releaseAbuseDecisionLock(db, bot.id, userId, owner); }
        catch (error) { log(bot, "error", "management_lock_release_failed", { user_id: userId, message: error.message }); }
      }
    });
  } catch (error) {
    if (error?.operatorRevoked) return { changed: false, unauthorized: true, text: t(bot, "unauthorized") };
    throw error;
  }
}

// The dedicated manager UI reuses the service bot's profile projection and
// fenced moderation path. Keeping these calls here prevents a second, weaker
// implementation of queue cleanup, notification, and operator authorization.
export async function managerUserAccess(env, operation, args = {}) {
  const db = requireDb(env);
  if (operation === 'counts') return managementCounts(db, args.botId || null);
  if (operation === 'list') return listManagedProfiles(db, args.botId || null, args.filter, args.page);
  if (operation === 'search') return searchManagedProfiles(db, args.query);
  if (operation === 'profile') return managedProfile(db, args.botId, args.userId);
  if (operation === 'stateKey') return managementStateKey(args.profile);
  if (operation === 'apply') {
    const bot = resolveBot(env, args.botId);
    return applyLockedManagementAction(bot, env, args.actor, args.action, args.userId, args.options || {});
  }
  throw new Error('Unknown manager user access operation');
}

async function savePendingAction(db, managementBot, actor, sourceMessage, values) {
  const controlPlane = db?.[CONTROL_PLANE_CONTEXT] || null;
  const managementBotId = controlPlane?.managementUiBotId || managementBot.id;
  const nonceParams = [actor.id, operatorName(actor), managementBotId, values.targetBotId ?? null, values.userId ?? null, values.action];
  let flowNonce;
  if (controlPlane?.stableSeed) {
    flowNonce = stablePendingNonce(controlPlane.stableSeed, nonceParams);
    const existing = await dbOne(db, "SELECT flow_nonce, expires_at FROM operator_pending_actions WHERE operator_id = ?", actor.id);
    if (existing?.flow_nonce === flowNonce && isFuture(existing.expires_at)) return;
  } else {
    const nonceBytes = crypto.getRandomValues(new Uint8Array(8));
    flowNonce = btoa(String.fromCharCode(...nonceBytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }
  await dbRun(
    db,
    `INSERT INTO operator_pending_actions (operator_id, operator_name, management_bot_id, target_bot_id, user_id, action, stage, duration_seconds, reason, chat_id, thread_id, flow_nonce, expected_state_key, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(operator_id) DO UPDATE SET operator_name = excluded.operator_name, management_bot_id = excluded.management_bot_id, target_bot_id = excluded.target_bot_id, user_id = excluded.user_id, action = excluded.action, stage = excluded.stage, duration_seconds = excluded.duration_seconds, reason = excluded.reason, chat_id = excluded.chat_id, thread_id = excluded.thread_id, flow_nonce = excluded.flow_nonce, expected_state_key = excluded.expected_state_key, created_at = excluded.created_at, expires_at = excluded.expires_at, suspended=0`,
    actor.id,
    operatorName(actor),
    managementBotId,
    values.targetBotId ?? null,
    values.userId ?? null,
    values.action,
    values.stage,
    values.durationMs ? Math.floor(values.durationMs / 1000) : null,
    values.reason ?? null,
    sourceMessage.chat.id,
    sourceMessage.message_thread_id !== undefined && sourceMessage.message_thread_id !== null && Number(sourceMessage.message_thread_id) !== 1 ? Number(sourceMessage.message_thread_id) : null,
    flowNonce,
    values.expectedStateKey ?? null,
    nowIso(),
    isoAfter(OPERATOR_ACTION_TTL_MS),
  );
}

async function pendingAction(db, operatorId) {
  const pending = await dbOne(db, "SELECT * FROM operator_pending_actions WHERE operator_id = ?", operatorId);
  if (!pending || !isFuture(pending.expires_at)) {
    return null;
  }
  return pending;
}

function pendingMatchesMessage(pending, message) {
  const pendingThread = pending.thread_id === null || pending.thread_id === undefined || Number(pending.thread_id) === 1 ? null : Number(pending.thread_id);
  const messageThread = message.message_thread_id === null || message.message_thread_id === undefined || Number(message.message_thread_id) === 1 ? null : Number(message.message_thread_id);
  return String(pending.chat_id) === String(message.chat?.id) && pendingThread === messageThread;
}

function pendingCallback(pending, verb, extra = null) {
  return `um:pa:${verb}${extra === null ? "" : `:${extra}`}:${pending.flow_nonce}`;
}

function confirmationText(bot, env, pending) {
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const target = registry.find((item) => item.id === pending.target_bot_id);
  const c={ru:['Заблокировать навсегда','Временно ограничить','Сбросить риск, CAPTCHA и автомьют','Доверять и освободить очередь CAPTCHA','Отключить автоматическую защиту на 1 час, затем AUTO','Сервис','Срок','Причина','CAPTCHA будет снята. Ожидающие сообщения будут доставлены при отсутствии других блокировок. Ручные блокировка и ограничение сохраняются.','Автомьют также будет снят; счёт риска станет 0.','Автоограничение также будет снято; будет включено ручное доверие.','Недоставленные сообщения пользователя будут удалены из очередей CAPTCHA, возобновления и альбомов. После снятия ограничения их потребуется отправить заново. Бот отправит нейтральное уведомление без внутренней причины.'],en:['Block permanently','Temporarily restrict','Reset risk, CAPTCHA and auto-mute','Trust and release CAPTCHA queue','Disable automatic protection for 1 hour, then AUTO','Service','Duration','Reason','CAPTCHA will be cleared. Pending messages will be delivered when no other block remains. Manual ban and restriction stay in place.','Auto-mute will also be cleared; risk score becomes 0.','The automatic restriction will also be cleared and manual trust enabled.','Undelivered customer messages will be removed from CAPTCHA, reopen and album queues. They must be resent after the restriction is lifted. The bot sends a neutral notice without the internal reason.'],es:['Bloquear permanentemente','Restringir temporalmente','Restablecer riesgo, CAPTCHA y restricción automática','Marcar como de confianza y liberar la cola CAPTCHA','Desactivar la protección automática durante 1 hora y volver a AUTO','Servicio','Duración','Motivo','Se borrará el CAPTCHA. Los mensajes pendientes se entregarán cuando no haya otro bloqueo. Se mantienen los bloqueos y restricciones manuales.','También se retirará la restricción automática; el riesgo pasará a 0.','También se retirará la restricción automática y se activará la confianza manual.','Los mensajes sin entregar se eliminarán de las colas de CAPTCHA, reapertura y álbumes. El usuario tendrá que enviarlos de nuevo cuando se retire la restricción. El bot enviará un aviso neutral sin incluir el motivo interno.'],zh:['永久封禁','临时限制','重置风险、CAPTCHA 和自动限制','设为可信并释放 CAPTCHA 队列','关闭自动防护 1 小时，然后恢复为 AUTO','服务','时长','原因','CAPTCHA 将被清除。没有其他封禁时，待处理消息会送达。手动封禁和限制会保留。','自动限制也会被清除；风险分数将变为 0。','自动限制也会被清除，并启用手动信任。','未送达的用户消息将从 CAPTCHA、重新开启和相册队列中删除。解除限制后，用户需要重新发送。机器人会发送不包含内部原因的中性通知。']}[bot.locale]||['Block permanently','Temporarily restrict','Reset risk, CAPTCHA and auto-mute','Trust and release CAPTCHA queue','Disable automatic protection for 1 hour, then AUTO','Service','Duration','Reason','CAPTCHA will be cleared. Pending messages will be delivered when no other block remains. Manual ban and restriction stay in place.','Auto-mute will also be cleared; risk score becomes 0.','The automatic restriction will also be cleared and manual trust enabled.','Undelivered customer messages will be removed from CAPTCHA, reopen and album queues. They must be resent after the restriction is lifted. The bot sends a neutral notice without the internal reason.'];
  const index={ban:0,restrict:1,riskreset:2,trust:3,attack_off:4}[pending.action]??4;
  const lines = [c[index], "", `${c[5]}: ${target?.displayName || pending.target_bot_id}`];
  if (pending.user_id !== null) lines.push(`Telegram ID: ${pending.user_id}`);
  if (pending.duration_seconds) lines.push(`${c[6]}: ${pending.duration_seconds / 60} min`);
  if(['trust','riskreset'].includes(pending.action))lines.push(c[8]);
  if(pending.action==='riskreset')lines.push(c[9]);
  if(pending.action==='trust')lines.push(c[10]);
  if(['ban','restrict'].includes(pending.action))lines.push(c[11]);
  if (pending.reason) lines.push(`${c[7]}: ${pending.reason}`);
  return lines.join("\n");
}

async function showPendingConfirmation(bot, env, sourceMessage, pending) {
  const c={ru:['Подтвердить','Отмена','Изменить'],en:['Confirm','Cancel','Edit'],es:['Confirmar','Cancelar','Editar'],zh:['确认','取消','修改']}[bot.locale]||['Confirm','Cancel','Edit'];
  const profile=['trust','riskreset'].includes(pending.action)?await managedProfile(requireDb(env),pending.target_bot_id,pending.user_id):null;
  return operatorScreen(bot, env, sourceMessage, confirmationText(bot, env, pending)+(profile?'\n\n'+accessSummary(bot,profile):''), { inline_keyboard: [[
    { text: c[0], callback_data: pendingCallback(pending, "confirm") },
    { text: c[1], callback_data: pendingCallback(pending, "cancel") },
  ],...(['ban','restrict'].includes(pending.action)?[[{text:c[2],callback_data:pendingCallback(pending,'revise')}]]:[])] });
}

export function auditActionLabel(bot, action) {
  if (action === 'message_delete') return messageDeletionText(bot.locale, 'audit');
  const labels = {
    ru: {
        conversation_reopened_by_user: "Обращение возобновлено пользователем",
        conversation_topic_restored: "Тема восстановлена после удаления",
        operator_added: "Оператор добавлен",
        operator_removed: "Оператор удалён",
        cloudflare_plan: "План Cloudflare изменён",
    },
    en: {
        conversation_reopened_by_user: "Conversation reopened by user",
        conversation_topic_restored: "Topic restored after deletion",
        operator_added: "Operator added",
        operator_removed: "Operator removed",
        cloudflare_plan: "Cloudflare plan changed",
    },
    es: { conversation_reopened_by_user: "Conversación reabierta por el usuario", conversation_topic_restored: "Tema restaurado tras su eliminación", operator_added: "Operador añadido", operator_removed: "Operador eliminado", cloudflare_plan: "Plan de Cloudflare cambiado" },
    zh: { conversation_reopened_by_user: "用户重新开启了会话", conversation_topic_restored: "已恢复被删除的话题", operator_added: "已添加客服人员", operator_removed: "已移除客服人员", cloudflare_plan: "Cloudflare 套餐已更改" },
  }[bot.locale] || {};
  const common={
  "manual_ban": [
    "Пользователь заблокирован",
    "User banned"
  ],
  "manual_unban": [
    "Блокировка снята",
    "Ban removed"
  ],
  "manual_restrict": [
    "Ручное ограничение включено",
    "Manual restriction enabled"
  ],
  "manual_unrestrict": [
    "Ручное ограничение снято",
    "Manual restriction removed"
  ],
  "manual_trust": [
    "Ручное доверие включено",
    "Manual trust enabled"
  ],
  "manual_untrust": [
    "Ручное доверие снято",
    "Manual trust removed"
  ],
  "risk_reset": [
    "Риск и проверка сброшены",
    "Risk and verification reset"
  ],
  "conversation_close": [
    "Тема закрыта",
    "Topic closed"
  ],
  "conversation_open": [
    "Тема открыта",
    "Topic opened"
  ],
  "conversation_open_recreated": [
    "Удалённая тема восстановлена",
    "Deleted topic restored"
  ],
  "attack_control_auto": [
    "Защита возвращена в AUTO",
    "Protection returned to AUTO"
  ],
  "attack_control_on": [
    "Усиленная защита на час",
    "Elevated protection for one hour"
  ],
  "attack_control_off": [
    "Защита выключена на час",
    "Protection disabled for one hour"
  ],
  "attack_mode_enter": [
    "Усиленная защита включена автоматически",
    "Elevated protection enabled automatically"
  ],
  "attack_mode_exit": [
    "Усиленная защита завершена автоматически",
    "Elevated protection ended automatically"
  ],
  "reactions_enable": [
    "Реакции включены",
    "Reactions enabled"
  ],
  "reactions_disable": [
    "Реакции выключены",
    "Reactions disabled"
  ],
  "temporary_mute": [
    "Временное автоограничение",
    "Temporary automatic restriction"
  ],
  "work_take": [
    "Обращение взято в работу",
    "Conversation assigned"
  ],
  "work_release": [
    "Назначение снято",
    "Assignment removed"
  ],
  "work_waiting": [
    "Ожидаем клиента",
    "Waiting for customer"
  ],
  "work_resolve": [
    "Обращение решено",
    "Conversation resolved"
  ],
  "work_needs": [
    "Обращению нужен ответ",
    "Conversation needs reply"
  ],
  "work_hour": [
    "Возврат через час",
    "Return in one hour"
  ],
  "work_tomorrow": [
    "Возврат завтра",
    "Return tomorrow"
  ],
  "work_handoff": [
    "Передача обращения",
    "Conversation handed off"
  ],
  "bot_message_welcome_text": [
    "Приветствие изменено",
    "Welcome changed"
  ],
  "bot_message_auto_reply_text": [
    "Автоответ изменён",
    "Auto-reply changed"
  ],
  "message_w_enable": [
    "Приветствие включено",
    "Welcome enabled"
  ],
  "message_w_disable": [
    "Приветствие выключено",
    "Welcome disabled"
  ],
  "message_a_enable": [
    "Автоответ включён",
    "Auto-reply enabled"
  ],
  "message_a_disable": [
    "Автоответ выключен",
    "Auto-reply disabled"
  ]
};
  const localeIndex = ({ru:0,en:1,es:2,zh:3})[bot.locale] ?? 1;
  const extended = {
    manual_ban:['Usuario bloqueado','已封禁用户'],manual_unban:['Bloqueo retirado','已解除封禁'],
    manual_restrict:['Restricción manual activada','已启用手动限制'],manual_unrestrict:['Restricción manual retirada','已解除手动限制'],
    manual_trust:['Confianza manual activada','已启用手动信任'],manual_untrust:['Confianza manual retirada','已取消手动信任'],
    risk_reset:['Riesgo y verificación restablecidos','风险和验证状态已重置'],conversation_close:['Tema cerrado','话题已关闭'],conversation_open:['Tema abierto','话题已开启'],
    conversation_open_recreated:['Tema eliminado restaurado','已恢复被删除的话题'],attack_control_auto:['Protección restablecida en AUTO','防护已恢复为 AUTO'],
    attack_control_on:['Protección reforzada durante una hora','强化防护一小时'],attack_control_off:['Protección desactivada durante una hora','防护已关闭一小时'],
    attack_mode_enter:['Protección reforzada activada automáticamente','已自动启用强化防护'],attack_mode_exit:['Protección reforzada desactivada automáticamente','已自动结束强化防护'],
    reactions_enable:['Reacciones activadas','已启用表情反应'],reactions_disable:['Reacciones desactivadas','已停用表情反应'],temporary_mute:['Restricción automática temporal','临时自动限制'],
    work_take:['Conversación asignada','已接手会话'],work_release:['Asignación retirada','已取消分配'],work_waiting:['Esperando al cliente','等待客户'],work_resolve:['Conversación resuelta','会话已解决'],work_needs:['La conversación necesita respuesta','会话待回复'],
    work_hour:['Se devolverá en una hora','一小时后返回队列'],work_tomorrow:['Se devolverá mañana','明天返回队列'],work_handoff:['Conversación transferida','会话已转交'],
    bot_message_welcome_text:['Mensaje de bienvenida actualizado','欢迎消息已更新'],bot_message_auto_reply_text:['Respuesta automática actualizada','自动回复已更新'],
    message_w_enable:['Mensaje de bienvenida activado','已启用欢迎消息'],message_w_disable:['Mensaje de bienvenida desactivado','已停用欢迎消息'],message_a_enable:['Respuesta automática activada','已启用自动回复'],message_a_disable:['Respuesta automática desactivada','已停用自动回复'],
  };
  const translated = bot.locale === 'es' ? extended[action]?.[0]
    : bot.locale === 'zh' ? extended[action]?.[1] : null;
  return labels[action] || common[action]?.[localeIndex] || translated || action;
}

async function auditScreen(bot, env, botId = null, userId = null, page = 0, details = false) {
  const db = requireDb(env);
  const safePage = Math.max(0, Number(page) || 0);
  const params = [botId, botId, userId, userId, botId, botId, userId, userId, botId, userId, 8, safePage * 8];
  const rows = await dbAll(
    db,
    `SELECT * FROM (
       SELECT created_at, bot_id, user_id, operator_name AS actor_name, action, duration_seconds, reason, result
         FROM operator_audit
        WHERE (? IS NULL OR bot_id = ?) AND (? IS NULL OR user_id = ?)
       UNION ALL
       SELECT created_at, bot_id, user_id, 'System' AS actor_name, event_type AS action, NULL AS duration_seconds, NULL AS reason, 'success' AS result
         FROM abuse_events
        WHERE event_type IN ('temporary_mute', 'attack_mode_enter', 'attack_mode_exit')
           AND event_key NOT LIKE 'manual-%'
           AND (? IS NULL OR bot_id = ?) AND (? IS NULL OR user_id = ?)
       UNION ALL
       SELECT created_at, NULL AS bot_id, NULL AS user_id, actor_name, action, NULL AS duration_seconds,
              ('operator=' || target_operator_id || '; name=' || target_name || CASE WHEN target_username IS NULL THEN '' ELSE '; username=@' || target_username END) AS reason,
              result
         FROM support_operator_audit
        WHERE ? IS NULL AND ? IS NULL
      ) ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...params,
  );
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const uiLocale = managerConfigured(env)
    ? await getManagerLanguage(db, Number(env.OPERATOR_UI_ACTOR))
    : bot.locale;
  const ru = uiLocale === "ru";
  const labels={ru:["📜 История действий","Записей нет.","Скрыть коды","Технические коды","выполнено"],en:["📜 Action history","No entries.","Hide codes","Technical codes","completed"],es:["📜 Historial de acciones","No hay registros.","Ocultar códigos","Códigos técnicos","completado"],zh:["📜 操作记录","暂无记录。","隐藏代码","技术代码","已完成"]}[uiLocale]||["📜 Action history","No entries.","Hide codes","Technical codes","completed"];
  const lines = [labels[0], ""];
  for (const row of rows.results || []) {
    const service = row.bot_id ? (registry.find((item) => item.id === row.bot_id)?.displayName || row.bot_id) : "Freeflare Desk";
    lines.push(`${formatOperatorDate(bot, row.created_at)} · ${row.actor_name || "System"} — ${auditActionLabel({...bot,locale:uiLocale}, row.action)}${row.user_id ? ` · ${row.user_id}` : ""} · ${service}${row.duration_seconds ? ` · ${Math.ceil(row.duration_seconds / 60)} min` : ""}${row.reason ? ` · ${String(row.reason).slice(0, 120)}` : ""} · ${row.result==='success'?labels[4]:row.result}${details?` [${row.action}]`:""}`);
  }
  if (!(rows.results || []).length) lines.push(labels[1]);
  const key = managementBotKey(registry, botId);
  const keyboard = [];
  const auditRoute=page=>userId?`um:g:uaudit:${key}:${userId}:${page}`:`um:g:audit:${key}:${page}`;
  if (safePage > 0) keyboard.push({ text: "←", callback_data: auditRoute(safePage-1)+(details?':d':'') });
  if ((rows.results || []).length === 8) keyboard.push({ text: "→", callback_data: auditRoute(safePage+1)+(details?':d':'') });
  return { text: lines.join("\n"), replyMarkup: { inline_keyboard: [...(keyboard.length ? [keyboard] : []),[{text:details?labels[2]:labels[3],callback_data:auditRoute(safePage)+(details?"":":d")}]] } };
}

function commandOf(message) { return message.text?.startsWith("/") ? message.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase() : null; }

function restrictionMenu(bot, context) {
  const labels = ({ru:["15 минут","1 час","24 часа","Другой срок","Отмена"],en:["15 minutes","1 hour","24 hours","Custom","Cancel"],es:["15 minutos","1 hora","24 horas","Otro plazo","Cancelar"],zh:["15 分钟","1 小时","24 小时","自定义时长","取消"]})[bot.locale] || ["15 minutes","1 hour","24 hours","Custom","Cancel"];
  const callback = (duration) => context.kind === "topic"
    ? `um:tp:r${duration}:${context.stateKey}`
    : `um:g:r${duration}:${context.botKey}:${context.userId}:${context.stateKey}`;
  return { inline_keyboard: [
    [{ text: labels[0], callback_data: callback("15") }, { text: labels[1], callback_data: callback("1h") }],
    [{ text: labels[2], callback_data: callback("24h") }, { text: labels[3], callback_data: callback("custom") }],
    [{ text: labels[4], callback_data: context.kind === "topic" ? "um:tp:refresh" : `um:g:card:${context.botKey}:${context.userId}` }],
  ] };
}

async function beginBanFlow(managementBot, targetBot, env, actor, sourceMessage, userId, reason = null, expectedStateKey = null) {
  const db = requireDb(env);
  const validReason = reason ? validateManagementReason(reason) : null;
  if (reason && !validReason) {
    await operatorScreen(managementBot, env, sourceMessage, localizedWorkerSay(managementBot.locale,"Причина должна содержать от 3 до 500 символов и не включать секреты.","Reason must be 3–500 characters and contain no secrets."), { inline_keyboard: [] });
    return;
  }
  const profile = await managedProfile(db, targetBot.id, userId);
  const stateKey = expectedStateKey || (profile ? managementStateKey(profile) : null);
  await savePendingAction(db, managementBot, actor, sourceMessage, { targetBotId: targetBot.id, userId, action: "ban", stage: validReason ? "confirm" : "reason", reason: validReason, expectedStateKey: stateKey });
  const pending = await pendingAction(db, actor.id);
  if (validReason) return showPendingConfirmation(managementBot, env, sourceMessage, pending);
  const c={ru:['Укажите внутреннюю причину блокировки','Причина не будет показана пользователю.','Отмена'],en:['Enter the internal block reason','The reason will not be shown to the user.','Cancel'],es:['Indica el motivo interno del bloqueo','El usuario no verá el motivo.','Cancelar'],zh:['请输入封禁的内部原因','此原因不会显示给用户。','取消']}[managementBot.locale]||['Enter the internal block reason','The reason will not be shown to the user.','Cancel'];
  return operatorScreen(managementBot, env, sourceMessage, `${c[0]} · ${targetBot.displayName} · ${userId}\n${c[1]}`, { inline_keyboard: [[{ text: c[2], callback_data: pendingCallback(pending, "cancel") }]] });
}

async function beginRestrictionFlow(managementBot, targetBot, env, actor, sourceMessage, userId, durationMs = null, expectedStateKey = null) {
  const db = requireDb(env);
  const profile = await managedProfile(db, targetBot.id, userId);
  const stateKey = expectedStateKey || (profile ? managementStateKey(profile) : null);
  if (durationMs === null) {
    await savePendingAction(db, managementBot, actor, sourceMessage, { targetBotId: targetBot.id, userId, action: "restrict", stage: "duration", expectedStateKey: stateKey });
    const pending = await pendingAction(db, actor.id);
    const c={ru:['Укажите срок от 5 минут до 30 дней','например','Отмена'],en:['Enter a duration between 5 minutes and 30 days','for example','Cancel'],es:['Indica una duración de entre 5 minutos y 30 días','por ejemplo','Cancelar'],zh:['请输入 5 分钟至 30 天的时长','例如','取消']}[managementBot.locale]||['Enter a duration between 5 minutes and 30 days','for example','Cancel'];
    return operatorScreen(managementBot, env, sourceMessage, `${c[0]} (${c[1]}: 45m, 6h, 7d).`, { inline_keyboard: [[{ text: c[2], callback_data: pendingCallback(pending, "cancel") }]] });
  }
  await savePendingAction(db, managementBot, actor, sourceMessage, { targetBotId: targetBot.id, userId, action: "restrict", stage: "confirm", durationMs, expectedStateKey: stateKey });
  return showPendingConfirmation(managementBot, env, sourceMessage, await pendingAction(db, actor.id));
}

async function beginAttackOffFlow(managementBot, targetBot, env, actor, sourceMessage) {
  const db = requireDb(env);
  await savePendingAction(db, managementBot, actor, sourceMessage, { targetBotId: targetBot.id, action: "attack_off", stage: "confirm" });
  return showPendingConfirmation(managementBot, env, sourceMessage, await pendingAction(db, actor.id));
}

async function handlePendingOperatorText(bot, env, message, command) {
  if (command && command !== '/cancel') return false;
  const db = requireDb(env);
  // Expiry invalidates the action, not the internal meaning of its text input.
  const pending = await dbOne(db, `SELECT p.*, g.active AS input_guard FROM operator_input_guards g
    LEFT JOIN operator_pending_actions p ON p.operator_id=g.operator_id
    WHERE g.operator_id=? AND g.chat_id=? AND COALESCE(g.thread_id,1)=?`, message.from.id,message.chat.id,Number(message.message_thread_id||1));
  if (command === '/cancel') await dbRun(db,'UPDATE operator_input_guards SET active=0 WHERE operator_id=?',message.from.id);
  if (pending?.input_guard && !pending.operator_id && !command) {
    await operatorScreen(bot,env,message,({ru:'Внутреннее действие истекло. Текст не отправлен клиенту. Откройте действие заново или /cancel.',en:'The internal action expired. Text was not sent to the customer. Start again or /cancel.',es:'La acción interna ha caducado. El texto no se envió al cliente. Inicia la acción de nuevo o usa /cancel.',zh:'内部操作已过期。文本未发送给客户。请重新开始操作或使用 /cancel。'})[bot.locale]||'The internal action expired. Text was not sent to the customer. Start again or /cancel.',{inline_keyboard:[]});
    return true;
  }
  if (!pending?.operator_id || pending.suspended || pending.management_bot_id !== bot.id || !pendingMatchesMessage(pending, message)) return false;
  if (command === "/cancel") {
    await dbRun(db, "DELETE FROM operator_pending_actions WHERE operator_id = ?", message.from.id);
    await operatorScreen(bot, env, message, t(bot, "actionCancelled"), { inline_keyboard: [] });
    return true;
  }
  if (command) return false;
  if (!isFuture(pending.expires_at)) {
    await operatorScreen(bot, env, message, ({ru:'Срок действия истёк. Внутренний текст не отправлен клиенту. Откройте новое действие или /cancel для обычной переписки.',en:'This action expired. Internal text was not sent to the customer. Start a new action or /cancel to resume replies.',es:'La acción ha caducado. El texto interno no se envió al cliente. Inicia una acción nueva o usa /cancel para reanudar las respuestas.',zh:'此操作已过期。内部文本未发送给客户。请开始新操作，或使用 /cancel 恢复回复。'})[bot.locale]||'This action expired. Internal text was not sent to the customer. Start a new action or /cancel to resume replies.', {inline_keyboard:[]});
    return true;
  }
  if (!["reason", "duration"].includes(pending.stage)) {
    await showPendingConfirmation(bot, env, message, pending);
    return true;
  }
  if (pending.stage === "reason") {
    const reason = validateManagementReason(message.text);
    if (!reason) {
      await operatorScreen(bot, env, message, ({ru:'Некорректная причина. Нужно 3–500 символов без секретов.',en:'Invalid reason. Use 3–500 characters and no secrets.',es:'El motivo no es válido. Usa entre 3 y 500 caracteres y no incluyas secretos.',zh:'原因无效。请输入 3–500 个字符，且不要包含机密信息。'})[bot.locale]||'Invalid reason. Use 3–500 characters and no secrets.', { inline_keyboard: [[{ text: ({ru:'Отмена',en:'Cancel',es:'Cancelar',zh:'取消'})[bot.locale]||'Cancel', callback_data: pendingCallback(pending, "cancel") }]] });
      return true;
    }
    await dbRun(db, "UPDATE operator_pending_actions SET stage = 'confirm', reason = ?, expires_at = ? WHERE operator_id = ? AND stage = 'reason'", reason, isoAfter(OPERATOR_ACTION_TTL_MS), message.from.id);
  } else {
    const durationMs = parseRestrictionDuration(message.text);
    if (!durationMs) {
      await operatorScreen(bot, env, message, ({ru:'Некорректный срок. Используйте формат 45m, 6h или 7d; допустимо от 5 минут до 30 дней.',en:'Invalid duration. Use 45m, 6h, or 7d; allowed range is 5 minutes to 30 days.',es:'La duración no es válida. Usa el formato 45m, 6h o 7d; el intervalo permitido es de 5 minutos a 30 días.',zh:'时长无效。请使用 45m、6h 或 7d 格式；允许范围为 5 分钟至 30 天。'})[bot.locale]||'Invalid duration. Use 45m, 6h, or 7d; allowed range is 5 minutes to 30 days.', { inline_keyboard: [[{ text: ({ru:'Отмена',en:'Cancel',es:'Cancelar',zh:'取消'})[bot.locale]||'Cancel', callback_data: pendingCallback(pending, "cancel") }]] });
      return true;
    }
    await dbRun(db, "UPDATE operator_pending_actions SET stage = 'confirm', duration_seconds = ?, expires_at = ? WHERE operator_id = ? AND stage = 'duration'", Math.floor(durationMs / 1000), isoAfter(OPERATOR_ACTION_TTL_MS), message.from.id);
  }
  await showPendingConfirmation(bot, env, message, await pendingAction(db, message.from.id));
  return true;
}

const TOPIC_STYLE_COLORS = [
  [7322096, "🔵", "Голубой", "Blue"], [16766590, "🟡", "Жёлтый", "Yellow"],
  [13338331, "🟣", "Фиолетовый", "Purple"], [9367192, "🟢", "Зелёный", "Green"],
  [16749490, "🩷", "Розовый", "Pink"], [16478047, "🔴", "Красный", "Red"],
];
const TOPIC_STYLE_PAGE_SIZE = 24;
const TOPIC_STYLE_COLUMNS = 6;

async function topicStyleCatalogue(bot, env) {
  const result = await telegram(managementUiBot(bot, env), "getForumTopicIconStickers", {}, env);
  if (!result.ok || !Array.isArray(result.result)) return null;
  const seen = new Set();
  return result.result.filter((sticker) => {
    const id = sticker?.custom_emoji_id;
    if (typeof id !== "string" || !/^[0-9]{1,20}$/.test(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function saveTopicStyle(bot, env, actor, targetId, action, value, emoji) {
  return withAuthorizedOperatorExecution(bot, env, actor.id, async (renewFence) => {
    if (Number(actor.id) !== primaryOperatorId(env)) throw operatorRevokedError();
    const db = requireDb(env);
    const current = await dbOne(db, "SELECT * FROM topic_style_settings WHERE bot_id = ?", targetId);
    const color = action === "reset" ? null : action === "color" ? value : current?.icon_color ?? null;
    const icon = action === "reset" ? null : action === "icon" ? value : current?.icon_custom_emoji_id ?? null;
    const label = icon ? (action === "icon" ? emoji : current?.icon_emoji ?? null) : null;
    if ((current?.icon_color ?? null) === color && (current?.icon_custom_emoji_id ?? null) === icon) return false;
    await renewFence();
    await db.batch([
      db.prepare(`INSERT INTO topic_style_settings (bot_id, icon_color, icon_custom_emoji_id, icon_emoji, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(bot_id) DO UPDATE SET icon_color = excluded.icon_color,
        icon_custom_emoji_id = excluded.icon_custom_emoji_id, icon_emoji = excluded.icon_emoji,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by`).bind(targetId, color, icon, label, nowIso(), actor.id),
      operatorAuditStatement(db, targetId, null, actor, "topic_style_" + action, "success", {
        reason: JSON.stringify({ icon_color: color, icon_custom_emoji_id: icon }),
      }),
    ]);
    return true;
  });
}

async function handleTopicStyle(bot, env, actor, message, action, requested, value, edit, command = false) {
  const ru = bot.locale === "ru";
  const say = (r, e) => localizedWorkerSay(bot.locale, r, e);
  const button = (text, data) => ({ text, callback_data: data });
  const general = message?.message_thread_id == null || Number(message.message_thread_id) === 1;
  // This shared panel is visible to the team; every entry point enforces ownership.
  if (String(message?.chat?.id) !== String(supportGroupId(env)) || !general || Number(actor.id) !== primaryOperatorId(env)) {
    if (!general) return operatorScreen(bot, env, message, say("Оформление топиков доступно главному оператору в General.", "Topic appearance is available to the primary operator in General."), { inline_keyboard: [] });
    return operatorScreen(bot, env, message, say("Только главный оператор может менять оформление топиков.", "Only the primary operator can change topic appearance."), { inline_keyboard: [] }, edit);
  }
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const candidate = command ? registry.find(item => item.id === requested) : managementBotFromKey(registry, requested);
  const target = candidate && (command || managementBotKey(registry, candidate.id) === requested) ? candidate : null;
  const show = (text, rows) => operatorScreen(bot, env, message, text, { inline_keyboard: rows }, edit);
  const choose = [[button(say("← Пользователи", "← Users"), "um:g:home:a")]];
  if (!target) {
    if (action !== "home" || (requested && requested !== "a")) return show(t(bot, "staleAction"), choose);
    return show(say("Выберите бота для оформления новых топиков.", "Choose a bot to style its new topics."), [
      ...registry.map(item => [button(item.displayName, "um:s:home:" + managementBotKey(registry, item.id))]), ...choose,
    ]);
  }
  const key = managementBotKey(registry, target.id);
  const back = [button(say("← Назад", "← Back"), "um:s:home:" + key)];
  const invalid = () => show(t(bot, "staleAction"), [back]);
  if (!["home", "colors", "icons", "color", "icon", "reset"].includes(action)) return invalid();
  if (["home", "colors", "reset"].includes(action) && value != null) return invalid();
  if (action === "colors") return show(target.displayName + " · " + say("Цвет стандартной иконки", "Standard icon color")
    + "\n\n" + say("Это все 6 цветов, которые Telegram разрешает ботам. Выбранная эмодзи-иконка отображается вместо цветной стандартной.", "These are all 6 colors Telegram allows bots to use. A selected emoji icon replaces the standard colored icon."), [
    ...TOPIC_STYLE_COLORS.map(([color, symbol, r, e]) => [button(symbol + " " + say(r, e), "um:s:color:" + key + ":" + color)]),
    [button(say("По умолчанию", "Default"), "um:s:color:" + key + ":default")], back,
  ]);
  let selectedEmoji = null;
  if (action === "icons" || (action === "icon" && value !== "default")) {
    if (action === "icons" ? !/^[0-9]{1,6}$/.test(String(value)) : !/^[0-9]{1,20}$/.test(String(value))) return invalid();
    const catalogue = await topicStyleCatalogue(bot, env);
    if (!catalogue?.length) return show(say("Не удалось загрузить иконки. Оформление не изменено.", "Could not load icons. Appearance was not changed."), [
      [button(say("Повторить загрузку", "Retry loading"), "um:s:icons:" + key + ":" + (action === "icons" ? value : "0"))], back,
    ]);
    if (action === "icons") {
      const pages = Math.ceil(catalogue.length / TOPIC_STYLE_PAGE_SIZE);
      const page = Math.min(Number(value), pages - 1);
      const start = page * TOPIC_STYLE_PAGE_SIZE, end = Math.min(start + TOPIC_STYLE_PAGE_SIZE, catalogue.length);
      const buttons = catalogue.slice(start, end).map((item, index) => button(
        (item.emoji || "◻️") + " " + (start + index + 1), "um:s:icon:" + key + ":" + item.custom_emoji_id));
      const rows = [];
      for (let i = 0; i < buttons.length; i += TOPIC_STYLE_COLUMNS) rows.push(buttons.slice(i, i + TOPIC_STYLE_COLUMNS));
      const navigation = [];
      if (page > 0) navigation.push(button("←", "um:s:icons:" + key + ":" + (page - 1)));
      navigation.push(button((page + 1) + " / " + pages, "um:s:icons:" + key + ":" + page));
      if (page + 1 < pages) navigation.push(button("→", "um:s:icons:" + key + ":" + (page + 1)));
      return show(target.displayName + " · " + say("Выберите иконку", "Choose an icon") + "\n\n"
        + ({ ru: `Иконки ${start + 1}–${end} из ${catalogue.length}.`, en: `Icons ${start + 1}–${end} of ${catalogue.length}.`,
          es: `Iconos ${start + 1}–${end} de ${catalogue.length}.`, zh: `图标 ${start + 1}–${end}，共 ${catalogue.length} 个。` })[bot.locale] + "\n"
        + say("Полный набор, доступный ботам в Telegram. Следующие варианты — кнопкой →.", "The full set available to bots in Telegram. Use → for more icons."), [...rows, navigation,
        [button(say("Стандартная иконка", "Standard icon"), "um:s:icon:" + key + ":default")], back]);
    }
    const selected = catalogue.find(item => item.custom_emoji_id === value);
    if (!selected) return invalid();
    selectedEmoji = selected.emoji || "◻️";
  }
  if (action === "color" && value !== "default" && !TOPIC_STYLE_COLORS.some(([color]) => String(color) === value)) return invalid();
  if (["color", "icon", "reset"].includes(action)) {
    const savedValue = value === "default" || action === "reset" ? null : action === "color" ? Number(value) : value;
    await saveTopicStyle(bot, env, actor, target.id, action, savedValue, selectedEmoji);
  }
  const style = await dbOne(requireDb(env), "SELECT * FROM topic_style_settings WHERE bot_id = ?", target.id);
  const color = TOPIC_STYLE_COLORS.find(([color]) => color === style?.icon_color);
  const colorText = color ? color[1] + " " + say(color[2], color[3]) : say("По умолчанию", "Default");
  const iconText = style?.icon_custom_emoji_id ? (style.icon_emoji || "◻️") : say("Стандартная", "Standard");
  return show(target.displayName + " · " + say("Оформление топиков", "Topic appearance") + "\n\n"
    + say("Цвет: ", "Color: ") + colorText + "\n" + say("Иконка: ", "Icon: ") + iconText + "\n\n"
    + say("Пример: ","Preview: ")+(style?.icon_emoji||color?.[1]||"💬")+" "+(target.topicPrefix||target.displayName)+" · "+({ru:'Анна',en:'Anna',es:'Ana',zh:'安娜'})[bot.locale]+" (42)\n\n"
    + say("Применяется к новым топикам. Эмодзи заменяет стандартную цветную иконку.", "Applies to new topics. An emoji replaces the standard colored icon."), [
    [button(say("Цвет", "Color"), "um:s:colors:" + key), button(say("Иконка", "Icon"), "um:s:icons:" + key + ":0")],
    [button(say("Сбросить оформление", "Reset appearance"), "um:s:reset:" + key)],
    [button(say("← Назад", "← Back"), "um:g:home:" + key)],
  ]);
}

async function handleCloudflarePlan(bot, env, actor, message, parts = ["um", "d", "home"], edit = false) {
  const ru = bot.locale === "ru";
  const say = (r, e) => localizedWorkerSay(bot.locale, r, e);
  const button = (text, data) => ({ text, callback_data: data });
  const back = [button(say("← План", "← Plan"), "um:d:home")];
  const show = (text, rows) => operatorScreen(bot, env, message, text, { inline_keyboard: rows }, edit);
  const general = message?.message_thread_id == null || Number(message.message_thread_id) === 1;
  if (String(message?.chat?.id) !== String(supportGroupId(env)) || !general || Number(actor.id) !== primaryOperatorId(env)) {
    return show(say("План доступен только главному администратору в General.", "Only the primary administrator can manage the plan in General."), []);
  }
  const db = requireDb(env);
  let state = db.cloudflarePlan || await readCloudflarePlan(db, env);
  const action = parts[2];
  const stale = () => show(t(bot, "staleAction"), [back]);
  if (new TextEncoder().encode(parts.join(":")).length > 64) return stale();
  if (action !== "home") {
    const [, , , target, expectedPlan, revision, dayText] = parts;
    if (!["choose", "set", "billing"].includes(action) || parts.length < 6 || parts.length > 7
      || !["free", "paid", "auto"].includes(target) || expectedPlan !== state.plan || revision !== state.revision
      || (dayText !== undefined && !/^(?:[1-9]|[12][0-9]|3[01])$/.test(dayText))) return stale();
    const effective = target === "auto" ? state.configuredPlan : target;
    const day = dayText === undefined ? state.billingDay : Number(dayText);
    const callback = (nextAction, selectedDay = day) => `um:d:${nextAction}:${target}:${state.plan}:${state.revision}${selectedDay == null ? "" : ":" + selectedDay}`;
    if (action === "billing" || (effective === "paid" && day == null)) {
      const rows = [];
      for (let first = 1; first <= 31; first += 7) rows.push(Array.from({ length: Math.min(7, 32 - first) }, (_, offset) => {
        const number = first + offset;
        return button(String(number), callback("choose", number));
      }));
      return show(say("Укажите день ежемесячного продления Workers Paid из Cloudflare Billing (UTC). В коротком месяце используется его последний день.", "Select the monthly Workers Paid renewal day from Cloudflare Billing (UTC). Short months use their last day."), [...rows, back]);
    }
    if (action === "choose") {
      return show(say("Применить ", "Apply ") + effective.toUpperCase() + say(" ко всем ботам и монитору?", " to all bots and the monitor?") + "\n\n"
        + (effective === "paid"
          ? ({ ru: `D1: до 1000 запросов за запуск. Монитор: расчётный месяц, день продления ${day}.\nСначала подключите Workers Paid в Cloudflare.`, en: `D1: up to 1000 queries per invocation. Monitor: billing month, renewal day ${day}.\nEnable Workers Paid in Cloudflare first.`,
            es: `D1: hasta 1000 consultas por ejecución. Monitor: mes de facturación, día de renovación ${day}.\nActive primero Workers Paid en Cloudflare.`, zh: `D1：每次运行最多 1000 次查询。监控：计费月份，续订日为 ${day} 日。\n请先在 Cloudflare 中启用 Workers Paid。` })[bot.locale]
          : say("D1: до 50 запросов за запуск. Монитор: суточные квоты Free.", "D1: up to 50 queries per invocation. Monitor: daily Free quotas."))
        + "\n\n" + say("Эта кнопка меняет настройки приложения, а не подписку Cloudflare.", "This button changes application settings, not your Cloudflare subscription."), [
        [button(effective === "paid" ? say("Workers Paid подключён — применить", "Workers Paid is active — apply") : say("Применить Free", "Apply Free"), callback("set"))], back,
      ]);
    }
    if (action !== "set") return stale();
    const changed = await withAuthorizedOperatorExecution(bot, env, actor.id, async (renewFence) => {
      if (Number(actor.id) !== primaryOperatorId(env)) throw operatorRevokedError();
      await renewFence();
      const nextRevision = crypto.randomUUID();
      const timestamp = nowIso();
      const plan = target === "auto" ? null : target;
      const result = await db.batch([
        db.prepare(`UPDATE cloudflare_plan_settings SET plan = ?, billing_day = ?, revision = ?, updated_at = ?, updated_by = ?
          WHERE id = 1 AND revision = ?`).bind(plan, day, nextRevision, timestamp, actor.id, revision),
        db.prepare(`INSERT INTO operator_audit (bot_id, user_id, actor_type, operator_id, operator_name, action, reason, result, created_at)
          SELECT ?, NULL, 'operator', ?, ?, 'cloudflare_plan', ?, 'success', ? FROM cloudflare_plan_settings WHERE id = 1 AND revision = ?`)
          .bind(bot.id, actor.id, operatorName(actor), JSON.stringify({ scope: "all_bots_and_monitor", plan: target, billing_day: day }), timestamp, nextRevision),
      ]);
      return result[0].meta?.changes === 1;
    });
    if (!changed) return stale();
    state = await readCloudflarePlan(db, env);
  } else if (parts.length !== 3) return stale();
  const choose = (target) => `um:d:choose:${target}:${state.plan}:${state.revision}`;
  const rows = [[button("Free · 50", choose("free")), button("Paid · 1000", choose("paid"))]];
  if (state.plan === "paid") rows.push([button(say("День продления", "Renewal day"), `um:d:billing:${state.source === "config" ? "auto" : state.plan}:${state.plan}:${state.revision}`)]);
  if (state.source !== "config") rows.push([button(say("Использовать конфиг", "Use deployment config"), choose("auto"))]);
  rows.push([button(say("← Пользователи", "← Users"), "um:g:home:a")]);
  return show("☁️ Cloudflare · " + state.plan.toUpperCase() + "\n\n"
    + say("Источник: ", "Source: ") + (state.source === "general" ? "General" : "RECOVERY_D1_PLAN") + "\n"
    + (state.plan === "paid"
      ? ({ ru: `D1: 1000 запросов за запуск.\nМонитор: месяц от дня продления (${state.billingDay ?? "не задан"}).`, en: `D1: 1000 queries per invocation.\nMonitor: month from renewal day (${state.billingDay ?? "not set"}).`,
        es: `D1: 1000 consultas por ejecución.\nMonitor: mes desde el día de renovación (${state.billingDay ?? "sin definir"}).`, zh: `D1：每次运行 1000 次查询。\n监控：从续订日（${state.billingDay ?? "未设置"}）开始的月份。` })[bot.locale]
      : say("D1: 50 запросов за запуск.\nМонитор: сутки, сброс в 00:00 UTC.", "D1: 50 queries per invocation.\nMonitor: daily, reset at 00:00 UTC."))
    + "\n\n" + say("Выбор сохраняется для всех ботов. Действует со следующего запроса и проверки монитора. Тариф в Cloudflare меняется отдельно.", "Saved for all bots. Applies to the next request and monitor check. Change your Cloudflare subscription separately."), rows);
}

async function botChooserScreen(bot, env) {
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const labels=({ru:["Все боты","Выберите support-бота. В режиме «Все боты» изменения не применяются массово."],en:["All bots","Select a support bot. All-bots mode never applies bulk changes."],es:["Todos los bots","Elige un bot de soporte. El modo «Todos los bots» no aplica cambios masivos."],zh:["所有机器人","请选择支持机器人。“所有机器人”模式不会批量应用更改。"]})[bot.locale]||["All bots","Select a support bot. All-bots mode never applies bulk changes."];
  const keyboard = [[{ text: labels[0], callback_data: "um:g:bot:a" }]];
  for (const config of registry) keyboard.push([{ text: `${config.enabled ? "🟢" : "⚪"} ${config.displayName}`, callback_data: `um:g:bot:${managementBotKey(registry, config.id)}` }]);
  return { text: labels[1], replyMarkup: { inline_keyboard: keyboard } };
}

async function searchScreen(bot, env, query) {
  const rows = await searchManagedProfiles(requireDb(env), query);
  const c=({ru:["Пользователь не найден.","Поиск","Найдено профилей","Выберите точного пользователя и сервис.","Показаны первые 20. Уточните поиск по ID или username."],en:["User not found.","Search","Profiles found","Select the exact user and service.","First 20 shown. Refine by ID or username."],es:["No se encontró el usuario.","Buscar","Perfiles encontrados","Elige el usuario y el servicio exactos.","Se muestran los primeros 20. Concreta la búsqueda por ID o nombre de usuario."],zh:["未找到用户。","搜索","用户资料数","请选择准确的用户和服务。","仅显示前 20 项。请按 ID 或用户名缩小搜索范围。"]})[bot.locale]||["User not found.","Search","Profiles found","Select the exact user and service.","First 20 shown. Refine by ID or username."];
  if (!rows.length) return { text: c[0], replyMarkup: { inline_keyboard: [] } };
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const keyboard = rows.map((profile) => {
    const service = registry.find((item) => item.id === profile.bot_id)?.displayName || profile.bot_id;
    return [{ text: `${profileDisplayName(profile).slice(0, 18)} · ${profile.user_id} · ${service}`.slice(0, 60), callback_data: `um:g:card:${managementBotKey(registry, profile.bot_id)}:${profile.user_id}` }];
  });
  return { text: `${c[1]}: ${String(query).slice(0,100)}\n${c[2]}: ${rows.length}${rows.length===20?'+':''}\n${c[3]}`+(rows.length===20?'\n'+c[4] : ''), replyMarkup: { inline_keyboard: keyboard } };
}

async function chooseServiceForAction(bot, env, message, action, userId, profiles, options = {}) {
  const db = requireDb(env);
  await savePendingAction(db, bot, message.from, message, { userId, action, stage: "service", reason: options.reason || null, durationMs: options.durationMs || null });
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const pending = await pendingAction(db, message.from.id);
  const keyboard = profiles.map((profile) => {
    const config = registry.find((item) => item.id === profile.bot_id);
    return [{ text: config?.displayName || profile.bot_id, callback_data: pendingCallback(pending, "service", managementBotKey(registry, profile.bot_id)) }];
  });
  const c=({ru:["Отмена","Пользователь найден в нескольких ботах. Выберите конкретный сервис."],en:["Cancel","The user exists in multiple bots. Select one service."],es:["Cancelar","El usuario existe en varios bots. Elige un servicio concreto."],zh:["取消","此用户存在于多个机器人中，请选择一项服务。"]})[bot.locale]||["Cancel","The user exists in multiple bots. Select one service."];
  keyboard.push([{ text: c[0], callback_data: pendingCallback(pending, "cancel") }]);
  await operatorScreen(bot, env, message, c[1], { inline_keyboard: keyboard });
}

async function beginAccessFlow(managementBot,targetBot,env,actor,message,action,userId,stateKey=null) {
  const profile=await managedProfile(requireDb(env),targetBot.id,userId);
  if(!profile)return operatorScreen(managementBot,env,message,t(managementBot,'staleAction'),{inline_keyboard:[]});
  await savePendingAction(requireDb(env),managementBot,actor,message,{targetBotId:targetBot.id,userId,action,stage:'confirm',expectedStateKey:stateKey||managementStateKey(profile)});
  return showPendingConfirmation(managementBot,env,message,await pendingAction(requireDb(env),actor.id));
}
async function executeDirectUserAction(managementBot, targetBot, env, message, action, userId, options = {}) {
  if(['trust','riskreset'].includes(action))return beginAccessFlow(managementBot,targetBot,env,message.from,message,action,userId);
  if (action === "ban") return beginBanFlow(managementBot, targetBot, env, message.from, message, userId, options.reason || null);
  if (action === "restrict") return beginRestrictionFlow(managementBot, targetBot, env, message.from, message, userId, options.durationMs ?? null);
  const result = await applyLockedManagementAction(targetBot, env, message.from, action, userId, options);
  return operatorScreen(managementBot, env, message, result.text, { inline_keyboard: [] });
}


async function sendConfiguredWelcome(bot, env, message, updateId) {
  const db = requireDb(env);
  const settings = await dbOne(db, "SELECT welcome_text FROM effective_bot_messages WHERE bot_id = ?", bot.id);
  if (!settings?.welcome_text) return;
  const denied = await dbOne(db, "SELECT 1 FROM banned_users WHERE bot_id = ? AND user_id = ? UNION ALL SELECT 1 FROM user_abuse_state WHERE bot_id = ? AND user_id = ? AND (muted_until > ? OR manual_restricted_until > ?) LIMIT 1",
    bot.id, message.from.id, bot.id, message.from.id, nowIso(), nowIso());
  if (denied || !(await checkAbsoluteLimit(bot, env, message.from.id)).allowed) return;
  assertTelegramReady(db, bot);
  recoveryCheckpoint(db, 4);
  const gate = telegramRequestGate(db, bot);
  const claim = await dbRun(db, "INSERT INTO bot_welcome_attempts(bot_id, update_id, created_at) SELECT ?, ?, ? WHERE 1 = 1" + gate.sql + " ON CONFLICT DO NOTHING", bot.id, updateId, nowIso(), ...gate.params);
  if (claim.meta?.changes !== 1) return;
  // Persist before sending: an ambiguous network result must not repeat a greeting.
  const result = await telegram(bot, "sendMessage", { chat_id: message.from.id, text: settings.welcome_text }, env);
  if (!result.ok && !isDeliveryOutcomeUncertain(result) && isRetryableTelegramFailure(result)) {
    await dbRun(db, "DELETE FROM bot_welcome_attempts WHERE bot_id = ? AND update_id = ?", bot.id, updateId);
    throw new Error("Welcome sending deferred");
  }
}

async function sendPendingAutoReply(bot, env, userId = null) {
  const db = requireDb(env);
  assertTelegramReady(db, bot);
  recoveryCheckpoint(db, 4);
  const token = crypto.randomUUID();
  const gate = telegramRequestGate(db, bot);
  const row = await dbOne(db, "UPDATE conversation_auto_replies SET state = 'started', claim_token = ?, claimed_at = ? WHERE rowid = (" +
    "SELECT r.rowid FROM conversation_auto_replies r JOIN conversations c ON c.bot_id = r.bot_id AND c.user_id = r.user_id " +
    "WHERE r.bot_id = ? AND r.state = 'ready' AND c.status = 'open' AND (? IS NULL OR r.user_id = ?) " +
    "AND NOT EXISTS(SELECT 1 FROM banned_users b WHERE b.bot_id = r.bot_id AND b.user_id = r.user_id) ORDER BY r.source_message_id LIMIT 1) AND state = 'ready'" + gate.sql + " RETURNING *",
    token, nowIso(), bot.id, userId, userId, ...gate.params);
  if (!row) return;
  const result = await telegram(bot, "sendMessage", { chat_id: row.user_id, text: row.text }, env);
  const state = result.ok ? "sent" : isDeliveryOutcomeUncertain(result) ? "started" : isRetryableTelegramFailure(result) ? "ready" : "failed";
  await dbRun(db, "UPDATE conversation_auto_replies SET state = ?, sent_at = ?, text = CASE WHEN ? = 'sent' THEN '' ELSE text END WHERE bot_id = ? AND user_id = ? AND claim_token = ? AND cycle = ?",
    state, result.ok ? nowIso() : null, state, bot.id, row.user_id, token, row.cycle);
  if (!result.ok) log(bot, "warn", "auto_reply_not_confirmed", { user_id: row.user_id, state });
}
async function tryAutoReply(bot, env, userId) {
  try { await sendPendingAutoReply(bot, env, userId); }
  catch (error) {
    if (!(error instanceof RecoveryBudgetExhausted) && !(error instanceof TelegramCooldownError)) {
      log(bot, "warn", "auto_reply_deferred", { user_id: userId, message: error.message });
    }
  }
}

function messageField(value) {
  return value === "w" ? "welcome_text" : value === "a" ? "auto_reply_text" : null;
}
function messageFieldLabel(bot, field) {
  const c=({ru:['Приветствие','Автоответ на обращение'],en:['Welcome','Conversation auto-reply'],es:['Bienvenida','Respuesta automática a la conversación'],zh:['欢迎消息','会话自动回复']})[bot.locale]||['Welcome','Conversation auto-reply'];
  return field === "welcome_text" ? c[0] : c[1];
}
function isGeneralSource(message, env) {
  return String(message?.chat?.id) === String(supportGroupId(env))
    && (message.message_thread_id == null || Number(message.message_thread_id) === 1);
}
async function managerMenuLink(db, env) {
  if (!managerConfigured(env)) return null;
  const username = String(env.MANAGER_BOT_USERNAME).replace(/^@/, '');
  const menu = await dbOne(db, `SELECT 1 FROM support_groups
    WHERE group_id=? AND menu_state='ready' AND menu_message_id IS NOT NULL`, supportGroupId(env));
  return menu ? `https://t.me/${username}?start=menu` : null;
}
function managerConfigured(env) {
  return Boolean(env.MANAGER_BOT_TOKEN)
    && /^[A-Za-z0-9_]{5,32}$/.test(String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, ''));
}
function navigationBack(bot) {
  return [{ text: ({ru:"← Главное меню",en:"← Main menu",es:"← Menú principal",zh:"← 主菜单"})[bot.locale] || "← Main menu", callback_data: "um:n:home" }];
}
async function messageSettingsScreen(bot, env, actor, message, action, requested = "a", value = null, edit = false, command = false) {
  const ru = bot.locale === "ru";
  const say = (r, e) => localizedWorkerSay(bot.locale, r, e);
  const show = (text, rows) => operatorScreen(bot, env, message, text, { inline_keyboard: rows }, edit);
  if (!isGeneralSource(message, env)) return showGeneralLocation(bot, env, message);
  if (Number(actor.id) !== primaryOperatorId(env)) return show(say("Тексты меняет только главный администратор.", "Only the primary administrator can edit these messages."), [navigationBack(bot)]);
  const db = requireDb(env);
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  if (["save", "cancel", "revise"].includes(action)) {
    const flow = await dbOne(db, "SELECT * FROM bot_message_flows WHERE owner_id = ? AND nonce = ? AND chat_id = ? AND expires_at > ?", actor.id, requested, message.chat.id, nowIso());
    if (!flow || !registry.some(item => item.id === flow.bot_id)) return show(t(bot, "staleAction"), [navigationBack(bot)]);
    if (action === "cancel") {
      await dbRun(db, "DELETE FROM bot_message_flows WHERE owner_id = ? AND nonce = ?", actor.id, flow.nonce);
      return messageSettingsScreen(bot, env, actor, message, "home", managementBotKey(registry, flow.bot_id), null, edit);
    }
    if (action === "revise") {
      await dbRun(db, "UPDATE bot_message_flows SET stage = 'text', expires_at = ? WHERE owner_id = ? AND nonce = ?", isoAfter(OPERATOR_ACTION_TTL_MS), actor.id, flow.nonce);
      return show(say("Отправьте новый текст одним сообщением (до 3500 символов).", "Send the new text in one message (up to 3500 characters)."), [[{ text: say("Отмена", "Cancel"), callback_data: "um:m:cancel:" + flow.nonce }]]);
    }
    if (flow.stage !== "confirm") return show(t(bot, "staleAction"), [navigationBack(bot)]);
    const changed = await withAuthorizedOperatorExecution(bot, env, actor.id, async (renewFence) => {
      if (Number(actor.id) !== primaryOperatorId(env)) throw operatorRevokedError();
      await renewFence();
      const current = await dbOne(db, "SELECT * FROM bot_message_settings WHERE bot_id = ?", flow.bot_id);
      if ((current?.revision || "") !== flow.expected_revision) return false;
      const welcome = flow.field === "welcome_text" ? flow.draft : current?.welcome_text || "";
      const auto = flow.field === "auto_reply_text" ? flow.draft : current?.auto_reply_text || "";
      // The flow and revision predicates fence stale previews, including concurrent saves.
      const saved = await dbRun(db, "INSERT INTO bot_message_settings(bot_id, welcome_text, auto_reply_text, revision, updated_by, updated_at) " +
        "SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM bot_message_flows WHERE owner_id = ? AND nonce = ? AND stage = 'confirm' AND expires_at > ?) " +
        "ON CONFLICT(bot_id) DO UPDATE SET welcome_text = excluded.welcome_text, auto_reply_text = excluded.auto_reply_text, revision = excluded.revision, updated_by = excluded.updated_by, updated_at = excluded.updated_at WHERE bot_message_settings.revision = ?",
        flow.bot_id, welcome, auto, flow.nonce, actor.id, nowIso(), actor.id, flow.nonce, nowIso(), flow.expected_revision);
      if (!(saved.meta?.changes > 0)) return false;
      await operatorAuditStatement(db, flow.bot_id, null, actor, "bot_message_" + flow.field, "success").run();
      await dbRun(db,"DELETE FROM bot_message_drafts WHERE owner_id=? AND bot_id=? AND field=?",actor.id,flow.bot_id,flow.field);
      await dbRun(db, "DELETE FROM bot_message_flows WHERE owner_id = ? AND nonce = ?", actor.id, flow.nonce);
      return true;
    });
    if (!changed) return show(say("Настройки уже изменились. Откройте сообщения бота заново.", "Settings have changed. Reopen the bot messages."), [navigationBack(bot)]);
    return messageSettingsScreen(bot, env, actor, message, "home", managementBotKey(registry, flow.bot_id), null, edit);
  }
  const target = command ? registry.find(item => item.id === requested) : managementBotFromKey(registry, requested);
  if (!target) {
    if (action !== "home" || requested !== "a") return show(t(bot, "staleAction"), [navigationBack(bot)]);
    return show(say("Выберите бота для настройки сообщений.", "Choose a bot to configure messages."), [
      ...registry.map(item => [{ text: item.displayName, callback_data: "um:m:home:" + managementBotKey(registry, item.id) }]), navigationBack(bot),
    ]);
  }
  const key = managementBotKey(registry, target.id);
  const settings = await dbOne(db, "SELECT s.*,p.welcome_reviewed,p.auto_reply_reviewed,COALESCE(p.welcome_enabled,1) welcome_enabled,COALESCE(p.auto_reply_enabled,1) auto_reply_enabled FROM (SELECT ? bot_id) b LEFT JOIN bot_message_settings s USING(bot_id) LEFT JOIN bot_message_preferences p USING(bot_id)", target.id);
  const field = messageField(value);
  if (action === "home") return show(target.displayName + "\n\n" +
    say("Приветствие: ", "Welcome: ") + (settings?.welcome_text && settings.welcome_enabled ? say("включено", "on") : settings?.welcome_text||settings?.welcome_reviewed?say("выключено", "off"):say("не настроено","not configured")) + "\n" +
    say("Автоответ: ", "Auto-reply: ") + (settings?.auto_reply_text && settings.auto_reply_enabled ? say("включён", "on") : settings?.auto_reply_text||settings?.auto_reply_reviewed?say("выключен", "off"):say("не настроено","not configured")) + "\n\n" +
    say("Текст сохраняется при выключении. Откройте сообщение, чтобы проверить текст и включить или выключить отправку.", "Text is retained when disabled. Open a message to review its text and delivery switch."), [
      [{ text: say("Приветствие", "Welcome"), callback_data: "um:m:view:" + key + ":w" }],
      [{ text: say("Автоответ на обращение", "Conversation auto-reply"), callback_data: "um:m:view:" + key + ":a" }],
      [{ text: say("← Бот", "← Bot"), callback_data: "um:n:bot:" + key }], navigationBack(bot),
    ]);
  if (!field) return show(t(bot, "staleAction"), [navigationBack(bot)]);
  if (['enable','disable'].includes(action)) {
    const column=field==='welcome_text'?'welcome_enabled':'auto_reply_enabled', reviewed=field==='welcome_text'?'welcome_reviewed':'auto_reply_reviewed';
    if(action==='enable'&&!settings?.[field]) return show(say('Сначала сохраните текст.','Save text first.'),[[{text:say('Изменить','Edit'),callback_data:`um:m:edit:${key}:${value}`}]]);
    await withAuthorizedOperatorExecution(bot,env,actor.id,async renew=>{await renew();
      await dbRun(db,`INSERT INTO bot_message_preferences(bot_id,${column},${reviewed}) VALUES(?,?,1) ON CONFLICT(bot_id) DO UPDATE SET ${column}=excluded.${column},${reviewed}=1`,target.id,action==='enable'?1:0);
      await operatorAuditStatement(db,target.id,null,actor,`message_${value}_${action}`,'success').run();});
    return messageSettingsScreen(bot,env,actor,message,'home',key,null,edit);
  }
  if (action === "view") return show(target.displayName + " · " + messageFieldLabel(bot, field) + "\n\n" +
    (settings?.[field] || say("Выключено. Текст не задан.", "Off. No text configured.")), [
      [{text:say("Включить отправку","Enable delivery"),callback_data:`um:m:enable:${key}:${value}`},{text:say("Выключить, сохранив текст","Disable, keep text"),callback_data:`um:m:disable:${key}:${value}`}],
      [{ text: say("Изменить", "Edit"), callback_data: "um:m:edit:" + key + ":" + value },
       { text: say("Очистить и выключить", "Clear and disable"), callback_data: "um:m:clear:" + key + ":" + value }],
      [{ text: say("← Назад", "← Back"), callback_data: "um:m:home:" + key }], navigationBack(bot),
    ]);
  if (!["edit", "clear", "restore"].includes(action)) return show(t(bot, "staleAction"), [navigationBack(bot)]);
  const savedDraft=action==='restore'?await dbOne(db,'SELECT * FROM bot_message_drafts WHERE owner_id=? AND bot_id=? AND field=?',actor.id,target.id,field):null;
  if(action==='restore'&&!savedDraft)return show(t(bot,'staleAction'),[navigationBack(bot)]);
  const nonce = teamFlowNonce();
  await dbRun(db, "INSERT INTO bot_message_flows(owner_id, bot_id, field, stage, draft, expected_revision, nonce, chat_id, expires_at) VALUES(?, ?, ?, ?, '', ?, ?, ?, ?) " +
    "ON CONFLICT(owner_id) DO UPDATE SET bot_id = excluded.bot_id, field = excluded.field, stage = excluded.stage, draft = '', expected_revision = excluded.expected_revision, nonce = excluded.nonce, chat_id = excluded.chat_id, expires_at = excluded.expires_at, suspended=0",
    actor.id, target.id, field, action === "clear" ? "confirm" : "text", settings?.revision || "", nonce, message.chat.id, isoAfter(OPERATOR_ACTION_TTL_MS));
  // Starting this editor replaces other text-input flows for the same administrator.
  await dbRun(db, "UPDATE operator_pending_actions SET suspended=1 WHERE operator_id = ?", actor.id);
  await dbRun(db, "UPDATE support_operator_flows SET suspended=1 WHERE owner_id = ?", actor.id);
  if(savedDraft) {
    await dbRun(db,"UPDATE bot_message_flows SET draft=?,stage='confirm',suspended=0 WHERE owner_id=? AND nonce=?",savedDraft.draft,actor.id,nonce);
    return showMessageDraft(bot,env,message,{...savedDraft,nonce},edit);
  }
  if (action === "clear") return showMessageDraft(bot, env, message, { bot_id: target.id, field, draft: "", nonce }, edit);
  return show(target.displayName + " · " + messageFieldLabel(bot, field) + "\n\n" +
    say("Отправьте текст одним сообщением (до 3500 символов). Затем проверьте его и нажмите «Сохранить». Текст отправляется без форматирования.", "Send the text in one message (up to 3500 characters), then preview and save. Messages use plain text."),
    [[{ text: say("Отмена", "Cancel"), callback_data: "um:m:cancel:" + nonce }]]);
}
async function showMessageDraft(bot, env, message, flow, edit = false) {
  const c={ru:['Предпросмотр:\n\n','Текст будет очищен. Это сообщение перестанет отправляться.','Сохранить','Изменить','Отмена'],en:['Preview:\n\n','The text will be cleared. This message will no longer be sent.','Save','Edit','Cancel'],es:['Vista previa:\n\n','Se borrará el texto. Este mensaje dejará de enviarse.','Guardar','Editar','Cancelar'],zh:['预览：\n\n','文本将被清除，此消息将停止发送。','保存','编辑','取消']}[bot.locale]||['Preview:\n\n','The text will be cleared. This message will no longer be sent.','Save','Edit','Cancel'];
  const target = parseBotRegistry(env.BOT_REGISTRY).find(item => item.id === flow.bot_id);
  return operatorScreen(bot, env, message, (target?.displayName || flow.bot_id) + " · " + messageFieldLabel(bot, flow.field) + "\n\n" +
    (flow.draft ? c[0] + flow.draft : c[1]),
    { inline_keyboard: [
      [{ text: c[2], callback_data: "um:m:save:" + flow.nonce }, { text: c[3], callback_data: "um:m:revise:" + flow.nonce }],
      [{ text: c[4], callback_data: "um:m:cancel:" + flow.nonce }],
    ] }, edit);
}
async function handleMessageSettingsText(bot, env, message, command) {
  if (command && command !== '/cancel') return false;
  if (!isGeneralSource(message, env) || Number(message.from.id) !== primaryOperatorId(env)) return false;
  const db = requireDb(env);
  const flow = await dbOne(db, "SELECT * FROM bot_message_flows WHERE owner_id = ? AND chat_id = ? AND expires_at > ?", message.from.id, message.chat.id, nowIso());
  if (!flow || flow.suspended) return false;
  if (command) {
    if (command === "/cancel") {
      await dbRun(db, "DELETE FROM bot_message_flows WHERE owner_id = ? AND nonce = ?", message.from.id, flow.nonce);
      await messageSettingsScreen(bot, env, message.from, message, "home", managementBotKey(parseBotRegistry(env.BOT_REGISTRY), flow.bot_id));
      return true;
    }
    await dbRun(db,'UPDATE bot_message_flows SET suspended=1 WHERE owner_id=? AND nonce=?',message.from.id,flow.nonce);
    return false;
  }
  if (flow.stage !== "text") {
    await showMessageDraft(bot, env, message, flow);
    return true;
  }
  const draft = typeof message.text === "string" ? message.text.trim() : "";
  if (!draft || draft.length > 3500) {
    await operatorScreen(bot, env, message, localizedWorkerSay(bot.locale,"Нужен текст от 1 до 3500 символов. Для отключения используйте «Очистить и выключить».","Enter 1–3500 characters. Use Clear and disable to turn the message off."),
      { inline_keyboard: [[{ text: localizedWorkerSay(bot.locale,"Отмена","Cancel"), callback_data: "um:m:cancel:" + flow.nonce }]] });
    return true;
  }
  await dbRun(db, "UPDATE bot_message_flows SET draft = ?, stage = 'confirm', expires_at = ? WHERE owner_id = ? AND nonce = ? AND stage = 'text'", draft, isoAfter(OPERATOR_ACTION_TTL_MS), message.from.id, flow.nonce);
  await showMessageDraft(bot, env, message, { ...flow, draft });
  return true;
}


function managementHomeKeyboard(bot, primary = false, counts = null, drafts = null) {
  const copy=({ru:['📥 Нужен ответ','👤 Мои','🔎 Найти пользователя','📝 Черновики','👥 Пользователи','🤖 Сервисы','👥 Команда','🛠 Система','❓ Помощь'],en:['📥 Needs reply','👤 Mine','🔎 Find user','📝 Drafts','👥 Users','🤖 Services','👥 Team','🛠 System','❓ Help'],es:['📥 Pendientes de respuesta','👤 Mías','🔎 Buscar usuario','📝 Borradores','👥 Usuarios','🤖 Servicios','👥 Equipo','🛠 Sistema','❓ Ayuda'],zh:['📥 待回复','👤 我的','🔎 查找用户','📝 草稿','👥 用户','🤖 服务','👥 团队','🛠 系统','❓ 帮助']})[bot.locale]||['📥 Needs reply','👤 Mine','🔎 Find user','📝 Drafts','👥 Users','🤖 Services','👥 Team','🛠 System','❓ Help'];
  const count=key=>counts?` · ${counts[key]}`:'';
  return { inline_keyboard: [
    [{text:copy[0]+count('needs'),callback_data:'um:w:queue:a:needs:0'},{text:copy[1]+count('mine'),callback_data:'um:w:queue:a:mine:0'}],
    [{text:copy[2],callback_data:'um:w:search'},{text:copy[3]+(drafts===null?'':` · ${drafts}`),callback_data:'um:w:resume'}],
    [{ text: copy[4], callback_data: "um:g:home:a" }],
    ...(primary?[[{text:copy[5],callback_data:'um:n:bots'},{text:copy[6],callback_data:'um:o:home:0'}],[{text:copy[7],callback_data:'um:n:system'}]]:[]),
    [{ text: copy[8], callback_data: "um:n:help" }],
  ] };
}
async function personalManagementHome(bot,env,message) {
  const actor=env.OPERATOR_UI_ACTOR||message.from?.id,db=requireDb(env),registry=parseBotRegistry(env.BOT_REGISTRY);
  const counts=await workCounts(db,{actor,botIds:registry.map(c=>c.id)});
  // D1 permits at most five terms per compound SELECT. Deduplicate within each
  // draft kind and add their counts in one statement, preserving the Free budget.
  const drafts=await dbOne(db,`SELECT
    (SELECT COUNT(*) FROM (
      SELECT bot_id,field FROM bot_message_drafts WHERE owner_id=?1 AND bot_id IN (SELECT value FROM json_each(?2))
      UNION SELECT bot_id,field FROM bot_message_flows WHERE owner_id=?1 AND bot_id IN (SELECT value FROM json_each(?2))
    )) + EXISTS(SELECT 1 FROM operator_pending_actions WHERE operator_id=?1)
       + EXISTS(SELECT 1 FROM support_operator_flows WHERE owner_id=?1)
       + (SELECT COUNT(*) FROM (
      SELECT bot_id,user_id FROM operator_note_drafts WHERE operator_id=?1 AND bot_id IN (SELECT value FROM json_each(?2))
      UNION SELECT bot_id,user_id FROM operator_work_inputs WHERE operator_id=?1 AND user_id>0 AND bot_id IN (SELECT value FROM json_each(?2))
    )) AS n`,actor,JSON.stringify(registry.map(c=>c.id)));
  return operatorScreen(bot,{...env,OPERATOR_UI_ROUTE:'um:n:home'},message,localizedWorkerSay(bot.locale,'Управление поддержкой\n\nВыберите обращение или действие.','Support management\n\nChoose a conversation or action.'),managementHomeKeyboard(bot,Number(actor)===primaryOperatorId(env),counts,drafts.n));
}
function generalUrl(env) {
  return "https://t.me/c/" + String(supportGroupId(env)).replace(/^-100/, "") + "/1";
}
async function showGeneralLocation(bot, env, message, inPlace=false) {
  return operatorScreen(bot, env, inPlace?message:{...message,message_thread_id:1}, localizedWorkerSay(bot.locale,"Это действие доступно только в General. Откройте здесь /menu.","This action is available only in General. Open /menu here."),
    { inline_keyboard: [[{ text: "General", url: generalUrl(env) }]] });
}
async function showManagementHome(bot, env, message = null, automatic = false) {
  const uiBot = managementUiBot(bot, env);
  const db = requireDb(env);
  const state = await dbOne(db, "SELECT * FROM bot_ui_state WHERE bot_id = ?", uiBot.id);
  if (automatic && state?.dashboard_revision === "4" && state.dashboard_message_id) return;
  if (automatic && state?.dashboard_started_at && !state.dashboard_message_id) return;
  if (!state?.dashboard_message_id && state?.dashboard_started_at && Date.now() - Date.parse(state.dashboard_started_at) < 30_000) return;
  const body = { chat_id: supportGroupId(env),
    text: localizedWorkerSay(bot.locale,"Управление поддержкой\n\nВыберите действие кнопкой. Введите / для списка команд с описаниями.\nВ топике пользователя /menu открывает карточку обращения.","Support management\n\nChoose an action below. Type / to see commands and descriptions.\nInside a user's topic, /menu opens the conversation panel."),
    reply_markup: {inline_keyboard:[[{text:localizedWorkerSay(bot.locale,'Открыть моё меню','Open my menu'),callback_data:'um:n:home'}]]} };
  let sent;
  let claimToken = null;
  if (state?.dashboard_message_id) {
    sent = await telegram(uiBot, "editMessageText", { ...body, message_id: state.dashboard_message_id }, env);
    if (sent.ok || isMessageNotModifiedError(sent.description)) sent = { ok: true, result: { message_id: state.dashboard_message_id } };
    else if (isRetryableTelegramFailure(sent)) throw new Error("Dashboard refresh deferred");
  }
  if (!sent?.ok) {
    claimToken = crypto.randomUUID();
    const claimed = await dbRun(db, "INSERT INTO bot_ui_state(bot_id, dashboard_started_at, dashboard_claim_token) VALUES(?, ?, ?) " +
      "ON CONFLICT(bot_id) DO UPDATE SET dashboard_started_at = excluded.dashboard_started_at, dashboard_claim_token = excluded.dashboard_claim_token, dashboard_message_id = NULL " +
      "WHERE bot_ui_state.dashboard_claim_token IS ? AND bot_ui_state.dashboard_message_id IS ?", uiBot.id, nowIso(), claimToken, state?.dashboard_claim_token ?? null, state?.dashboard_message_id ?? null);
    if (claimed.meta?.changes !== 1) return;
    sent = await telegram(uiBot, "sendMessage", body, env);
    if (!sent.ok) {
      if (!isDeliveryOutcomeUncertain(sent)) await dbRun(db, "UPDATE bot_ui_state SET dashboard_started_at = NULL WHERE bot_id = ? AND dashboard_claim_token = ?", uiBot.id, claimToken);
      throw new Error("Dashboard delivery not confirmed");
    }
  }
  const id = Number(sent.result?.message_id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Dashboard has no message id");
  if (claimToken) {
    const saved = await dbRun(db, "UPDATE bot_ui_state SET dashboard_message_id = ? WHERE bot_id = ? AND dashboard_claim_token = ?", id, uiBot.id, claimToken);
    if (saved.meta?.changes !== 1) return;
  }
  const pin = await telegram(uiBot, "pinChatMessage", { chat_id: supportGroupId(env), message_id: id, disable_notification: true }, env);
  if (pin.ok) await dbRun(db, "UPDATE bot_ui_state SET dashboard_revision = '4' WHERE bot_id = ?", uiBot.id);
  else log(bot, "warn", "dashboard_pin_failed", { description: pin.description });
  if (!automatic && message) await personalManagementHome(bot,env,message);
}
async function showSupportBots(bot, env, message, edit = false) {
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const uiBot = managementUiBot(bot, env);
  return operatorScreen(bot, env, message, await commandBots(bot, env), { inline_keyboard: [
    ...registry.map(item => [{ text: item.displayName, callback_data: "um:n:bot:" + managementBotKey(registry, item.id) }]),
    ...(uiBot.username && Number(env.OPERATOR_UI_ACTOR||message.from?.id)===primaryOperatorId(env) ? [[{ text: localizedWorkerSay(bot.locale,'➕ Добавить сервис','➕ Add service'), url: `https://t.me/${uiBot.username}?start=addbot` }]] : []),
    navigationBack(bot),
  ] }, edit);
}

function manualDeliveryKeyboard(bot, env, selected = null) {
  const labels=({ru:['▶️ Повторить сейчас','Обновить результат','Сообщения и причины','Все боты'],en:['▶️ Retry now','Refresh result','Messages and reasons','All bots'],es:['▶️ Reintentar ahora','Actualizar resultado','Mensajes y motivos','Todos los bots'],zh:['▶️ 立即重试','刷新结果','消息和原因','所有机器人']})[bot.locale]||['▶️ Retry now','Refresh result','Messages and reasons','All bots'];
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const key = managementBotKey(registry, selected);
  return { inline_keyboard: [
    [{ text: labels[0], callback_data: 'um:dl:run:' + key }],
    [{ text: labels[1], callback_data: 'um:dl:home:' + key }],
    [{text:labels[2],callback_data:`um:w:problems:${key}:0:0`}],
    ...(selected ? [[{ text: labels[3], callback_data: 'um:dl:home:a' }]]
      : registry.filter(item => item.enabled).map(item => [{ text: item.displayName, callback_data: 'um:dl:home:' + managementBotKey(registry, item.id) }])),
    navigationBack(bot),
  ] };
}

async function manualDeliveryScreen(bot, env, query, parts) {
  const ru = bot.locale === 'ru';
  if (!isGeneralSource(query.message, env) || Number(query.from.id) !== primaryOperatorId(env)) {
    return operatorScreen(bot, env, query.message, localizedWorkerSay(bot.locale,'Повторную доставку запускает только главный администратор в General.','Only the primary administrator in General can retry delivery.'), { inline_keyboard: [] });
  }
  if (parts.length !== 4 || !['home', 'run'].includes(parts[2])) return;
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const selected = parts[3] === 'a' ? null : managementBotFromKey(registry, parts[3]);
  if (parts[3] !== 'a' && !selected) return operatorScreen(bot, env, query.message, t(bot, 'staleAction'), { inline_keyboard: [navigationBack(bot)] }, true);
  const service = env.MANUAL_DELIVERY_SERVICE;
  if (!service) return operatorScreen(bot, env, query.message, localizedWorkerSay(bot.locale,'Сервис повторной доставки недоступен. Проверьте публикацию обновления.','Delivery recovery service unavailable. Check the deployment.'), { inline_keyboard: [navigationBack(bot)] }, true);
  const options = { actorId: Number(query.from.id), groupId: supportGroupId(env), threadId: query.message.message_thread_id,
    botId: selected?.id || null, uiBotId: managementUiBot(bot, env).id,
    messageId: (await workspaceSession(requireDb(env),query.from.id,query.message))?.message_id || query.message.message_id, requestKey: 'callback:' + query.id };
  if(parts[2]==='run') {
    const panel=await operatorScreen(bot,{...env,OPERATOR_UI_ROUTE:`um:dl:home:${parts[3]}`},query.message,({ru:'Подготовка безопасного повтора…',en:'Preparing safe delivery retry…',es:'Preparando el reintento seguro de entrega…',zh:'正在准备安全重试发送…'})[bot.locale]||'Preparing safe delivery retry…',manualDeliveryKeyboard(bot,env,selected?.id));
    options.messageId=panel.result.message_id;
  }
  let result;
  try {
    result = parts[2] === 'run' ? await service.start(options) : await service.status(options);
    if (result.started) return;
  } catch (error) {
    log(bot, 'error', 'manual_delivery_control_failed', { message: error.message });
    return operatorScreen(bot, env, query.message, ({ru:'Не удалось получить результат запуска. Нажмите «Обновить результат»: отсутствие ответа не означает, что сообщения не отправлялись.',en:'Could not read the run result. Refresh it; a missing reply does not mean messages were not sent.',es:'No se pudo leer el resultado. Actualízalo; la falta de respuesta no significa que los mensajes no se hayan enviado.',zh:'无法读取运行结果。请刷新；没有收到回复并不代表消息未发送。'})[bot.locale]||'Could not read the run result. Refresh it; a missing reply does not mean messages were not sent.', manualDeliveryKeyboard(bot, env, selected?.id), true);
  }
  return operatorScreen(bot, env, query.message, manualDeliveryText(result, bot.locale), manualDeliveryKeyboard(bot, env, selected?.id), true);
}

export async function publishManualDelivery(env, run) {
  if (Number(run.actor_id) !== primaryOperatorId(env) || String(run.group_id) !== String(supportGroupId(env))) return;
  const config = parseBotRegistry(env.BOT_REGISTRY).find(item => item.id === run.ui_bot_id && item.enabled);
  if (!config || !await persistedBotEnabled(requireDb(env), config.id)) return;
  const bot = resolveBot(env, config.id);
  // Edit only the run's own panel; never create repeated report messages on timeout.
  const result = await telegram(bot, 'editMessageText', { chat_id: run.group_id, message_id: run.message_id,
    text: manualDeliveryText({ run }, bot.locale), reply_markup: manualDeliveryKeyboard(bot, env, run.bot_id) }, env);
  if (!result.ok && !isMessageNotModifiedError(result.description)) throw new Error('Manual delivery report could not be displayed');
}
async function showSupportHelp(bot, env, message, topic = false, edit = false, section = '') {
  const screen=supportHelp(bot.locale,Number(env.OPERATOR_UI_ACTOR||message.from?.id)===primaryOperatorId(env),section,managerConfigured(env));
  if(topic)screen.inline_keyboard.push([{text:'General',url:generalUrl(env)}]);
  return operatorScreen(bot,{...env,OPERATOR_UI_ROUTE:'um:n:help'+(section?':'+section:'')},message,screen.text,{inline_keyboard:screen.inline_keyboard},edit);
}
async function handleNavigationCallback(bot, env, query, parts) {
  if (!isGeneralSource(query.message, env)) return parts[2]==='help'?showSupportHelp(bot,env,query.message,true,true,parts[3]):showGeneralLocation(bot, env, query.message);
  const ru = bot.locale === "ru";
  const action = parts[2];
  if (action === "home") return personalManagementHome(bot,env,query.message);
  if (action === "bots") return showSupportBots(bot, env, query.message, true);
  if (action === "help") return showSupportHelp(bot, env, query.message, false, true, parts[3]);
  if (action === "check") return readinessScreen(bot,env,query,"a");
  if (['system','settings'].includes(action)&&Number(query.from.id)!==primaryOperatorId(env))return personalManagementHome(bot,env,query.message);
  const copy={ru:{system:'Система\n\nПроверка работы, доставка и обслуживание поддержки.',health:'✅ Состояние системы',delivery:'📨 Проблемы доставки',storage:'💾 Хранилище',cloudflare:'☁️ Cloudflare',audit:'📜 Аудит',settings:'⚙️ Общие настройки',supportSettings:'Настройки поддержки',botMessages:'Сообщения ботов',topicStyle:'Оформление топиков',reactions:'Реакции',ready:'Готовность и проверка',queue:'📥 Очередь обращений',users:'Пользователи',messages:'Сообщения',backBots:'← Боты',protection:'Защита сервиса: ',returnAuto:'Возврат в AUTO: '},en:{system:'System\n\nSupport health, delivery and maintenance.',health:'✅ System health',delivery:'📨 Delivery issues',storage:'💾 Storage',cloudflare:'☁️ Cloudflare',audit:'📜 Audit',settings:'⚙️ General settings',supportSettings:'Support settings',botMessages:'Bot messages',topicStyle:'Topic appearance',reactions:'Reactions',ready:'Readiness and check',queue:'📥 Work queue',users:'Users',messages:'Messages',backBots:'← Bots',protection:'Service protection: ',returnAuto:'Return to AUTO: '},es:{system:'Sistema\n\nEstado, entrega y mantenimiento del soporte.',health:'✅ Estado del sistema',delivery:'📨 Problemas de entrega',storage:'💾 Almacenamiento',cloudflare:'☁️ Cloudflare',audit:'📜 Auditoría',settings:'⚙️ Ajustes generales',supportSettings:'Ajustes del soporte',botMessages:'Mensajes de los bots',topicStyle:'Apariencia de los temas',reactions:'Reacciones',ready:'Estado y comprobación',queue:'📥 Cola de conversaciones',users:'Usuarios',messages:'Mensajes',backBots:'← Bots',protection:'Protección del servicio: ',returnAuto:'Volver a AUTO: '},zh:{system:'系统\n\n支持服务状态、投递和维护。',health:'✅ 系统状态',delivery:'📨 投递问题',storage:'💾 存储',cloudflare:'☁️ Cloudflare',audit:'📜 审核记录',settings:'⚙️ 常规设置',supportSettings:'支持设置',botMessages:'机器人消息',topicStyle:'话题外观',reactions:'表情反应',ready:'就绪状态和检查',queue:'📥 会话队列',users:'用户',messages:'消息',backBots:'← 机器人',protection:'服务防护：',returnAuto:'恢复 AUTO：'}}[bot.locale]||{};
  if (action === 'system') return operatorScreen(bot,env,query.message,copy.system,{inline_keyboard:[
    [{text:copy.health,callback_data:'um:n:check'}],
    [{text:copy.delivery,callback_data:'um:w:problems:a:0:0'}],
    [{text:copy.storage,callback_data:'um:st:home'}],
    [{text:copy.cloudflare,callback_data:'um:d:home'}],
    [{text:copy.audit,callback_data:'um:g:audit:a:0'}],
    [{text:copy.settings,callback_data:'um:n:settings'}],
  ]});
  if (action === "settings") return operatorScreen(bot, env, query.message, copy.supportSettings, { inline_keyboard: [
    [{ text: copy.botMessages, callback_data: "um:m:home:a" }],
    [{ text: copy.topicStyle, callback_data: "um:s:home:a" }],
    [{ text: copy.reactions, callback_data: "um:r:home:a" }],
    navigationBack(bot),
  ] }, true);
  if (action === "bot") {
    const selected = managementBotFromKey(parseBotRegistry(env.BOT_REGISTRY), parts[3]);
    if (!selected) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [navigationBack(bot)] }, true);
    const rows = [
      [{text:copy.ready,callback_data:"um:w:ready:"+parts[3]}],
      [{ text: copy.queue, callback_data: `um:w:queue:${parts[3]}:needs:0` },{text:copy.users,callback_data:'um:g:home:'+parts[3]}],
      [{ text: copy.reactions, callback_data: "um:r:home:" + parts[3] }],
    ];
    if (Number(query.from.id) === primaryOperatorId(env)) rows.push(
      [{ text: copy.messages, callback_data: "um:m:home:" + parts[3] }],
      [{ text: copy.topicStyle, callback_data: "um:s:home:" + parts[3] }],
    );
    rows.push([{ text: copy.backBots, callback_data: "um:n:bots" }], navigationBack(bot));
    const attack=await dbOne(requireDb(env),'SELECT mode,manual_override,override_until,manual_controlled FROM service_attack_state WHERE bot_id=?',selected.id);
    rows.splice(rows.length-2,0,['auto','on','off'].map(mode=>({text:mode.toUpperCase(),callback_data:`um:g:attack:${mode}:${parts[3]}`})));
    const control=(attack?.manual_override||(attack?.manual_controlled?null:selected.attackModeManualOverride)||'auto').toUpperCase();
    return operatorScreen(bot, env, query.message, selected.displayName+'\n\n'+copy.protection+control+(attack?.override_until?'\n'+copy.returnAuto+formatOperatorDate(bot,attack.override_until):''), { inline_keyboard: rows }, true);
  }
}

export function supportCommandList(locale = "en", primary = false, owner = true, managerActive = false) {
  const language = ["ru","en","es","zh"].includes(locale) ? locale : "en";
  const ru = language === "ru";
  const entries = [
    ["menu", managerActive ? "Карточка текущей темы" : "Меню General или карточка текущей темы", managerActive ? "Current topic panel" : "General menu or current topic panel"],
    ["help", "Как пользоваться поддержкой", "How to use support"],
    ["panel", "Открыть карточку обращения в теме", "Open the conversation panel in a topic"],
    ["info", "Информация о пользователе в теме", "User information in a topic"],
    ["audit", "История действий", "Action history"],
    ["close", "Закрыть текущее обращение", "Close the current conversation"],
    ["open", "Открыть текущее обращение", "Reopen the current conversation"],
    ["delete", "Ответом на своё сообщение: удалить у клиента и в теме", "Reply to your own message: delete for customer and topic"],
    ["cancel", "Отменить текущий ввод", "Cancel current input"],
  ];
  if (owner) entries.push(
    ["bots", "General: выбрать бота", "General: choose a bot"],
    ["users", "General: пользователи и обращения", "General: users and conversations"],
    ["user", "General: поиск по ID, username или имени", "General: search by ID, username or name"],
    ["operators", "General: команда поддержки", "General: support team"],
    ["selfcheck", "General: проверить подключение", "General: check connection"],
    ["reactions", "General: настройки реакций", "General: reaction settings"],
  );
  if (owner && primary) entries.push(
    ["addbot", "General: подключить нового бота", "General: connect a new bot"],
    ["messages", "General: приветствия и автоответы ботов", "General: bot welcomes and auto-replies"],
    ["storage", "General: хранилище и очистка", "General: storage and cleanup"],
    ["topicstyle", "General: оформление топиков", "General: topic appearance"],
    ["plan", "General: план Cloudflare", "General: Cloudflare plan"],
  );
  const translations = {
    es: {menu:managerActive?'Tarjeta del tema actual':'Menú de General o tarjeta del tema actual',help:'Cómo usar el soporte',panel:'Abrir la ficha de conversación en un tema',info:'Información del usuario en el tema',audit:'Historial de acciones',close:'Cerrar la conversación actual',open:'Reabrir la conversación actual',cancel:'Cancelar la entrada actual',bots:'General: elegir un bot',users:'General: usuarios y conversaciones',user:'General: buscar por ID, nombre de usuario o nombre',operators:'General: equipo de soporte',selfcheck:'General: comprobar conexión',reactions:'General: ajustes de reacciones',addbot:'General: conectar un bot nuevo',messages:'General: bienvenidas y respuestas automáticas',storage:'General: almacenamiento y limpieza',topicstyle:'General: apariencia de temas',plan:'General: plan de Cloudflare'},
    zh: {menu:managerActive?'当前话题卡片':'General 菜单或当前话题卡片',help:'如何使用支持服务',panel:'打开话题中的会话卡片',info:'话题中的用户信息',audit:'操作记录',close:'关闭当前会话',open:'重新开启当前会话',cancel:'取消当前输入',bots:'General：选择机器人',users:'General：用户和会话',user:'General：按 ID、用户名或姓名搜索',operators:'General：支持团队',selfcheck:'General：检查连接',reactions:'General：表情反应设置',addbot:'General：连接新机器人',messages:'General：机器人欢迎消息和自动回复',storage:'General：存储和清理',topicstyle:'General：话题外观',plan:'General：Cloudflare 套餐'},
  };
  translations.es.delete = 'Responde a tu mensaje: borrar para el cliente y del tema';
  translations.zh.delete = '回复自己的消息：从客户聊天和话题中删除';
  return entries.map(([command, r, e]) => ({ command, description: language === 'ru' ? r : translations[language]?.[command] || e }));
}
export async function sendBotSetupReminder(bot, env) {
  const db = requireDb(env);
  const existing = await dbOne(db, "SELECT * FROM bot_setup_notices WHERE bot_id = ?", bot.id);
  if (existing && existing.state !== "pending") return;
  const settings = await dbOne(db, "SELECT s.welcome_text,s.auto_reply_text,p.welcome_reviewed,p.auto_reply_reviewed FROM (SELECT ? bot_id) b LEFT JOIN bot_message_settings s USING(bot_id) LEFT JOIN bot_message_preferences p USING(bot_id)", bot.id);
  if ((settings?.welcome_text||settings?.welcome_reviewed) && (settings?.auto_reply_text||settings?.auto_reply_reviewed)) {
    await dbRun(db, "INSERT INTO bot_setup_notices(bot_id, state, completed_at) VALUES(?, 'skipped', ?) ON CONFLICT(bot_id) DO UPDATE SET state = 'skipped', completed_at = excluded.completed_at WHERE bot_setup_notices.state = 'pending'", bot.id, nowIso());
    return;
  }
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const owner = await effectiveGroupCommandOwner(db, registry, env);
  if (!owner) return;
  const sender = resolveBot(env, owner.id);
  assertTelegramReady(db, sender);
  const gate = telegramRequestGate(db, sender);
  recoveryCheckpoint(db, 4);
  const token = crypto.randomUUID();
  const claimed = await dbRun(db, "INSERT INTO bot_setup_notices(bot_id, state, claim_token, started_at) SELECT ?, 'started', ?, ? WHERE 1 = 1" + gate.sql +
    " ON CONFLICT(bot_id) DO UPDATE SET state = 'started', claim_token = excluded.claim_token, started_at = excluded.started_at WHERE bot_setup_notices.state = 'pending'",
    bot.id, token, nowIso(), ...gate.params);
  if (claimed.meta?.changes !== 1) return;
  const locale=bot.locale||sender.locale||'en';
  const words={ru:['приветствие на /start','подтверждение получения обращения',' и ','⚙️ Настройте сообщения бота ','Главный администратор, задайте ','Пока текст не задан, соответствующее сообщение пользователю не отправляется. При необходимости его можно оставить выключенным.','Настроить сообщения','Проверить готовность'],en:['the /start welcome','the conversation acknowledgement',' and ','⚙️ Configure messages for ','Primary administrator, configure ','Until a text is configured, that message is not sent to users. You can leave it disabled if desired.','Configure messages','Check readiness'],es:['el mensaje de bienvenida de /start','el acuse de recibo de la conversación',' y ','⚙️ Configura los mensajes del bot ','Administrador principal, configura ','Hasta que se configure un texto, no se enviará ese mensaje al usuario. Si lo prefieres, puedes dejarlo desactivado.','Configurar mensajes','Comprobar preparación'],zh:['/start 欢迎消息','会话确认消息','和','⚙️ 配置机器人消息：','主管理员，请配置','未设置文本时，不会向用户发送相应消息。如有需要，可以保持停用。','配置消息','检查就绪状态']}[locale]||['the /start welcome','the conversation acknowledgement',' and ','⚙️ Configure messages for ','Primary administrator, configure ','Until a text is configured, that message is not sent to users. You can leave it disabled if desired.','Configure messages','Check readiness'];
  const missing = [!(settings?.welcome_text||settings?.welcome_reviewed) && words[0],
    !(settings?.auto_reply_text||settings?.auto_reply_reviewed) && words[1]].filter(Boolean);
  const sent = await telegram(sender, "sendMessage", {
    chat_id: supportGroupId(env),
    text: words[3] + bot.displayName + (bot.username ? ` (@${bot.username})` : "") + "\n\n" +
      words[4] + missing.join(words[2]) + ".\n" + words[5],
    reply_markup: { inline_keyboard: [[{ text: words[6], callback_data: "um:m:home:" + managementBotKey(registry, bot.id) }],[{text:words[7],callback_data:"um:w:ready:"+managementBotKey(registry,bot.id)}]] },
  }, env);
  if (sent.ok) {
    await dbRun(db, "UPDATE bot_setup_notices SET state = 'sent', message_id = ?, completed_at = ? WHERE bot_id = ? AND claim_token = ?", sent.result?.message_id ?? null, nowIso(), bot.id, token);
  } else {
    // A definite rejection can be retried; an uncertain send must not spam General.
    if (!isDeliveryOutcomeUncertain(sent)) await dbRun(db, "UPDATE bot_setup_notices SET state = 'pending' WHERE bot_id = ? AND claim_token = ?", bot.id, token);
    log(bot, "warn", "bot_setup_reminder_unconfirmed", { description: sent.description });
  }
}

const managerCommandCopy = {
  en: { start:'Open Adminushka menu', menu:'Support menu', mine:'My conversations', urgent:'My overdue conversations', users:'Users and search', operators:'Support team', reactions:'Service reactions', audit:'Activity log', available:'Accept new conversations', unavailable:'Stop accepting new conversations', help:'Help', cancel:'Cancel current input', addbot:'Connect a support bot', all:'All team conversations', urgentall:'All overdue conversations', metrics:'Waiting-time monitor', health:'System health', storage:'Storage', alerts:'Alerts', case:'Conversation card in topic', close:'Close conversation in topic', open:'Reopen conversation in topic', status:'Check reply delivery', publicStart:'Open Adminushka chat' },
  ru: { start:'Открыть меню Админушки', menu:'Меню поддержки', mine:'Мои обращения', urgent:'Мои просроченные обращения', users:'Пользователи и поиск', operators:'Команда поддержки', reactions:'Реакции сервисов', audit:'Журнал действий', available:'Принимать новые обращения', unavailable:'Не принимать новые обращения', help:'Помощь', cancel:'Отменить текущий ввод', addbot:'Подключить сервисного бота', all:'Все обращения команды', urgentall:'Все просроченные обращения', metrics:'Контроль ожидания', health:'Здоровье системы', storage:'Хранилище', alerts:'Алерты', case:'Карточка обращения в теме', close:'Закрыть обращение в теме', open:'Открыть обращение в теме', status:'Проверить доставку ответа', publicStart:'Открыть чат с Админушкой' },
  es: { start:'Abrir el menú de Adminushka', menu:'Menú de soporte', mine:'Mis conversaciones', urgent:'Mis conversaciones vencidas', users:'Usuarios y búsqueda', operators:'Equipo de soporte', reactions:'Reacciones de servicios', audit:'Registro de actividad', available:'Aceptar conversaciones nuevas', unavailable:'Dejar de aceptar conversaciones', help:'Ayuda', cancel:'Cancelar la entrada actual', addbot:'Conectar un bot de soporte', all:'Todas las conversaciones del equipo', urgentall:'Todas las conversaciones vencidas', metrics:'Control del tiempo de espera', health:'Estado del sistema', storage:'Almacenamiento', alerts:'Alertas', case:'Ficha de conversación en el tema', close:'Cerrar la conversación del tema', open:'Reabrir la conversación del tema', status:'Comprobar entrega de respuesta', publicStart:'Abrir el chat de Adminushka' },
  zh: { start:'打开管理机器人菜单', menu:'支持菜单', mine:'我的会话', urgent:'我的超时会话', users:'用户和搜索', operators:'支持团队', reactions:'服务表情反应', audit:'操作日志', available:'接收新会话', unavailable:'暂停接收新会话', help:'帮助', cancel:'取消当前输入', addbot:'连接支持机器人', all:'团队全部会话', urgentall:'全部超时会话', metrics:'等待时间监控', health:'系统状态', storage:'存储', alerts:'提醒', case:'话题中的会话卡片', close:'关闭话题中的会话', open:'重新开启话题中的会话', status:'检查回复送达状态', publicStart:'打开管理机器人聊天' },
};
const managerSharedNames = ['start','menu','mine','urgent','users','operators','reactions','audit','available','unavailable','help','cancel'];
const managerPrimaryNames = ['addbot','all','urgentall','metrics','health','storage','alerts'];
export function managerCommandList(locale = 'en', primary = false) {
  const copy = managerCommandCopy[supportedLanguage(locale) ? locale : DEFAULT_LANGUAGE];
  return [...managerSharedNames, ...(primary ? managerPrimaryNames : [])].map(command => ({ command, description: copy[command] }));
}

async function syncManagerNavigation(env) {
  if (!managerConfigured(env)) return;
  const db = requireDb(env);
  const groups = await dbAll(db, `SELECT DISTINCT r.group_id FROM service_group_routes r
    JOIN support_groups g ON g.group_id=r.group_id WHERE g.menu_state='ready' ORDER BY r.group_id`);
  const operators = await dbAll(db, 'SELECT user_id FROM support_operators WHERE active=1 ORDER BY user_id');
  const preferences = await dbAll(db, 'SELECT operator_id,language FROM manager_operator_preferences');
  const personalLanguages = new Map((preferences.results || []).map(row => [Number(row.operator_id), row.language]));
  const personalCommands = (id, primary = false) => managerCommandList(personalLanguages.get(Number(id)) || DEFAULT_LANGUAGE, primary);
  const commands = ['menu','case','close','open','status'].map(command => ({ command, description: managerCommandCopy.en[command] }));
  const tasks = [
    ...(groups.results || []).map(row => ({ scope: { type: 'chat', chat_id: Number(row.group_id) }, commands })),
    { scope: { type: 'all_private_chats' }, commands: [{ command: 'start', description: managerCommandCopy.en.publicStart }] },
    { scope: { type: 'chat', chat_id: primaryOperatorId(env) }, commands: personalCommands(primaryOperatorId(env), true) },
    ...(operators.results || []).filter(row => Number(row.user_id) !== primaryOperatorId(env))
      .map(row => ({ scope: { type: 'chat', chat_id: Number(row.user_id) }, commands: personalCommands(row.user_id) })),
  ];
  const oldRows = await dbAll(db, "SELECT scope_json,revision FROM bot_command_scopes WHERE bot_id='__manager__'");
  const old = new Map((oldRows.results || []).map(row => [row.scope_json, row]));
  const desired = new Set(tasks.map(task => JSON.stringify(task.scope)));
  for (const row of oldRows.results || []) if (!desired.has(row.scope_json))
    tasks.push({ scope: JSON.parse(row.scope_json), commands: [], remove: true });
  let completed = 0;
  for (const task of tasks) {
    const scope = JSON.stringify(task.scope), revision = JSON.stringify(task.commands);
    if (!task.remove && old.get(scope)?.revision === revision) continue;
    if (completed++ >= 2) break;
    recoveryCheckpoint(db, 5);
    for (const language_code of ['ru', 'en', 'es', 'zh']) {
      const cleared = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'deleteMyCommands',
        body: { scope: task.scope, language_code } });
      if (!cleared.ok) throw new Error('Manager command language reset deferred');
    }
    if (task.remove) {
      const cleared = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'deleteMyCommands',
        body: { scope: task.scope } });
      if (!cleared.ok) throw new Error('Manager command menu removal deferred');
      await dbRun(db, "DELETE FROM bot_command_scopes WHERE bot_id='__manager__' AND scope_json=?", scope);
    } else {
      const set = await requestTelegram({ token: env.MANAGER_BOT_TOKEN, method: 'setMyCommands',
        body: { scope: task.scope, commands: task.commands } });
      if (!set.ok) throw new Error('Manager command menu update deferred');
      await dbRun(db, `INSERT INTO bot_command_scopes(bot_id,scope_json,revision) VALUES('__manager__',?,?)
        ON CONFLICT(bot_id,scope_json) DO UPDATE SET revision=excluded.revision`, scope, revision);
    }
  }
}

async function syncSupportNavigation(bot, env) {
  const db = requireDb(env);
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const owner = await effectiveGroupCommandOwner(db, registry, env);
  const managerActive = managerConfigured(env);
  const operators = await dbAll(db, "SELECT user_id FROM support_operators WHERE active = 1 ORDER BY user_id");
  const ids = [...new Set([primaryOperatorId(env), ...(operators.results || []).map(row => Number(row.user_id))])];
  const group = supportGroupId(env);
  // Empty public/private scopes keep management commands out of customers' chats.
  const tasks = [
    ...ids.map(userId => ({ scope: { type: "chat_member", chat_id: group, user_id: userId }, commands: managerActive ? supportCommandList(bot.locale).filter(entry => entry.command === 'delete')
      : supportCommandList(bot.locale, userId === primaryOperatorId(env), owner?.id === bot.id, false) })),
    { scope: { type: 'chat', chat_id: primaryOperatorId(env) }, commands: managerActive ? [] : [
      { command: 'addbot', description: ({ru:'Подключить бота поддержки',en:'Connect a support bot',es:'Conectar un bot de soporte',zh:'连接支持机器人'})[bot.locale] || 'Connect a support bot' },
      { command: 'cancel', description: ({ru:'Закрыть мастер подключения',en:'Close bot setup',es:'Cerrar el asistente de conexión',zh:'关闭机器人设置向导'})[bot.locale] || 'Close bot setup' },
    ] },
    { scope: { type: "default" }, commands: [] },
    { scope: { type: "all_private_chats" }, commands: [] },
    { scope: { type: "chat", chat_id: group }, commands: [] },
  ];
  const rows = await dbAll(db, "SELECT * FROM bot_command_scopes WHERE bot_id = ?", bot.id);
  const old = new Map((rows.results || []).map(row => [row.scope_json, row]));
  const desired = new Set(tasks.map(task => JSON.stringify(task.scope)));
  for (const row of rows.results || []) if (!desired.has(row.scope_json)) tasks.push({ scope: JSON.parse(row.scope_json), commands: [], remove: true });
  let completed = 0;
  for (const task of tasks) {
    const scope = JSON.stringify(task.scope);
    const revision = JSON.stringify(task.commands);
    if (!task.remove && old.get(scope)?.revision === revision) continue;
    if (completed++ >= 3) break;
    recoveryCheckpoint(db, 5);
    // Clear language overrides used by this application, then write the configured fallback.
    for (const language_code of ["ru", "en", "es", "zh"]) {
      const cleared = await telegram(bot, "deleteMyCommands", { scope: task.scope, language_code }, env);
      if (!cleared.ok) throw new Error("Command language reset deferred");
    }
    const result = await telegram(bot, "setMyCommands", { commands: task.commands, scope: task.scope }, env);
    if (!result.ok) throw new Error("Command menu update deferred");
    if (task.remove) await dbRun(db, "DELETE FROM bot_command_scopes WHERE bot_id = ? AND scope_json = ?", bot.id, scope);
    else await dbRun(db, "INSERT INTO bot_command_scopes(bot_id, scope_json, revision) VALUES(?, ?, ?) ON CONFLICT(bot_id, scope_json) DO UPDATE SET revision = excluded.revision", bot.id, scope, revision);
  }
  if (!managerActive && owner?.id === bot.id) await showManagementHome(bot, env, null, true);
}

async function handleManagementCommand(bot, env, message, conversation, command) {
  const ru = bot.locale === "ru";
  const parts = String(message.text || "").trim().split(/\s+/);
  const args = parts.slice(1);
  const isGeneral = !conversation;
  const registry=parseBotRegistry(env.BOT_REGISTRY),selected=registry.find(c=>c.id===(command==='/reactions'&&['on','off'].includes(args[0])?args[1]:args[0]));
  const key=selected?managementBotKey(registry,selected.id):'a';
  const routes={'/users':'um:g:home:a','/user':'um:w:searchresults:a','/operators':'um:o:home:0','/bots':'um:n:bots','/messages':`um:m:home:${key}`,'/plan':'um:d:home','/topicstyle':`um:s:home:${key}`,'/reactions':`um:r:home:${key}`,'/help':'um:n:help','/audit':conversation?`um:g:uaudit:${managementBotKey(registry,conversation.bot_id)}:${conversation.user_id}:0`:'um:g:audit:a:0'};
  if(routes[command])env={...env,OPERATOR_UI_ROUTE:routes[command]};
  if (command === "/cancel") {
    await operatorScreen(bot, env, message, t(bot, "actionCancelled"), { inline_keyboard: isGeneral ? [navigationBack(bot)] : [[{ text: localizedWorkerSay(bot.locale,"К обращению","Conversation"), callback_data: "um:tp:refresh" }]] });
    return true;
  }
  if (isGeneral && ["/close", "/open", "/info", "/risk", "/antispam"].includes(command)) {
    await operatorScreen(bot, env, message, localizedWorkerSay(bot.locale,"Откройте топик нужного пользователя и выберите действие в /menu.","Open the user's topic and choose an action in /menu."),
      { inline_keyboard: [[{ text: localizedWorkerSay(bot.locale,"Обращения","Conversations"), callback_data: "um:g:home:a" }], navigationBack(bot)] });
    return true;
  }
  if (conversation && ["/bots", "/addbot", "/messages", "/users", "/user", "/operators", "/selfcheck", "/topicstyle", "/plan", "/reactions"].includes(command)) {
    await showGeneralLocation(bot, env, message);
    return true;
  }
  if (command === '/addbot') {
    if (Number(message.from.id) !== primaryOperatorId(env)) {
      await operatorScreen(bot, env, message, localizedWorkerSay(bot.locale,'Подключение ботов доступно только главному администратору.','Only the primary administrator can connect bots.'), { inline_keyboard: [] });
    } else {
      const sender = managementUiBot(bot, env);
      await operatorScreen(bot, env, message, localizedWorkerSay(bot.locale,'Продолжите подключение в личном чате. Токен сюда отправлять не нужно.','Continue setup in the private chat. Do not send the token here.'), { inline_keyboard: sender.username
        ? [[{ text: localizedWorkerSay(bot.locale,'➕ Добавить бота','➕ Add bot'), url: `https://t.me/${sender.username}?start=addbot` }]] : [] });
    }
    return true;
  }
  if (["/menu","/panel","/help"].includes(command)) {
    if (conversation && command !== "/help") await refreshTopicPanel(bot, env, conversation);
    else if (command === "/help") await showSupportHelp(bot, env, message, Boolean(conversation));
    else {
      await showManagementHome(bot, env, message);
      try { await syncSupportNavigation(bot, env); }
      catch (error) { log(bot, "warn", "command_menu_sync_deferred", { message: error.message }); }
    }
    return true;
  }
  if (command === "/messages") {
    await messageSettingsScreen(bot, env, message.from, message, "home", args[0] || "a", null, false, true);
    return true;
  }
  if (command === '/selfcheck') {
    await readinessScreen(bot,env,{from:message.from,message},key);
    return true;
  }
  if (command === "/bots") {
    if (!isGeneral) await showGeneralLocation(bot, env, message);
    else await showSupportBots(bot, env, message);
    return true;
  }
  if (command === "/plan") {
    await handleCloudflarePlan(bot, env, message.from, message);
    return true;
  }
  if (command === "/topicstyle") {
    await handleTopicStyle(bot, env, message.from, message, "home", args[0] || null, null, false, true);
    return true;
  }
  if (command === "/operators" && !isGeneral) {
    await operatorScreen(bot, env, message, localizedWorkerSay(bot.locale,"Управление операторами доступно только в General.","Operator management is available only in General."), { inline_keyboard: [] });
    return true;
  }
  if (command === "/operators" && isGeneral) {
    const screen = await operatorsScreen(bot, env, message.from.id, 0);
    await operatorScreen(bot, env, message, screen.text, screen.replyMarkup);
    return true;
  }
  if (command === "/reactions" && !isGeneral) {
    await operatorScreen(bot, env, message, localizedWorkerSay(bot.locale,"Управляйте реакциями в теме General.","Manage reactions in the General topic."), { inline_keyboard: [] });
    return true;
  }
  if (command === "/reactions" && isGeneral) {
    const requested = String(args[1] || args[0] || "").toLowerCase();
    const mode = ["on", "off"].includes(args[0]?.toLowerCase()) ? args[0].toLowerCase() : null;
    const requestedBotId = mode ? (args[1] || null) : (requested && requested !== "on" && requested !== "off" ? requested : null);
    const registry = parseBotRegistry(env.BOT_REGISTRY);
    const target = requestedBotId ? registry.find((item) => item.id === requestedBotId) : (mode && registry.length === 1 ? registry[0] : null);
    if (requestedBotId && !target) {
      await operatorScreen(bot, env, message, localizedWorkerSay(bot.locale,"Неизвестный support-бот.","Unknown support bot."), { inline_keyboard: [] });
      return true;
    }
    if (mode && target) {
      const result = await setReactionSetting(bot, env, message.from, target.id, mode === "on");
      await operatorScreen(bot, env, message, result.text, { inline_keyboard: [] });
      return true;
    }
    if (mode && registry.length > 1) {
      await operatorScreen(bot, env, message, localizedWorkerSay(bot.locale,"Выберите конкретный support-бот.","Select a specific support bot."), { inline_keyboard: registry.map((item) => [{ text: item.displayName, callback_data: `um:r:choose:${managementBotKey(registry, item.id)}:${mode}` }]) });
      return true;
    }
    const screen = await reactionScreen(bot, env, target ? managementBotKey(registry, target.id) : (registry.length === 1 ? managementBotKey(registry, registry[0].id) : "a"), message.from.id);
    await operatorScreen(bot, env, message, screen.text, screen.replyMarkup);
    return true;
  }
  if (command === "/users" && isGeneral) {
    const screen = await usersHomeScreen(bot, env, null, message.from.id);
    await operatorScreen(bot, env, message, screen.text, screen.replyMarkup);
    return true;
  }
  if (command === "/user" && isGeneral) {
    if (!args.length) { await handleWorkspaceCallback(bot,env,{from:message.from,message},['um','w','search']); return true; }
    const screen = await searchScreen(bot, env, args.join(" "));
    await operatorScreen(bot, {...env,OPERATOR_UI_ROUTE:"um:w:searchresults:a"}, message, screen.text, screen.replyMarkup);
    await dbRun(requireDb(env),"UPDATE operator_ui_sessions SET search_query=? WHERE operator_id=? AND chat_id=? AND thread_id=1",args.join(" "),message.from.id,message.chat.id);
    return true;
  }
  if (command === "/audit") {
    const screen = await auditScreen(bot, env, conversation?.bot_id || null, conversation?.user_id || null, 0);
    await operatorScreen(bot, env, message, screen.text, screen.replyMarkup);
    return true;
  }
  if (conversation && ['/info','/risk','/antispam'].includes(command)) {
    const targetKey=managementBotKey(registry,conversation.bot_id);
    const details=await executeCommand(bot,env,message,conversation,command);
    const profile=await managedProfile(requireDb(env),conversation.bot_id,conversation.user_id);
    const markup=command==='/antispam'?{inline_keyboard:[[{text:({ru:'Защита этого бота',en:'Protection for this bot',es:'Protección de este bot',zh:'此机器人的防护设置'})[bot.locale]||'Protection for this bot',callback_data:`um:g:home:${targetKey}`}]]}:userCardScreen(bot,env,profile).replyMarkup;
    await operatorScreen(bot,{...env,OPERATOR_UI_ROUTE:command==='/antispam'?`um:g:home:${targetKey}`:command==='/info'?'um:tp:info':'um:tp:risk'},message,details+(command==='/antispam'?'':'\n\n'+accessSummary(bot,profile)),markup);
    return true;
  }
  if (command === "/attack") {
    const value = String(args[0] || "").toLowerCase();
    if (!["on", "off", "auto"].includes(value)) return false;
    if (value === "off") await beginAttackOffFlow(bot, bot, env, message.from, message);
    else {
      const result = await applyLockedManagementAction(bot, env, message.from, `attack_${value}`, null);
      await operatorScreen(bot, env, message, result.text, { inline_keyboard: [] });
    }
    return true;
  }
  const actionByCommand = { "/ban": "ban", "/unban": "unban", "/restrict": "restrict", "/unrestrict": "unrestrict", "/trust": "trust", "/untrust": "untrust", "/riskreset": "riskreset", "/close": "close", "/open": "open" };
  const action = actionByCommand[command];
  if (!action) return false;
  if (conversation) {
    const options = {};
    if (action === "ban") options.reason = args.join(" ") || null;
    if (action === "restrict") options.durationMs = parseRestrictionDuration(args[0]);
    await executeDirectUserAction(bot, bot, env, message, action, conversation.user_id, options);
    return true;
  }
  const userId = Number(args[0]);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    await operatorScreen(bot, env, message, localizedWorkerSay(bot.locale,"Укажите точный Telegram ID пользователя.","Provide an exact Telegram user ID."), { inline_keyboard: [] });
    return true;
  }
  const profiles = (await managedProfilesForUser(requireDb(env), userId)).results || [];
  if (!profiles.length) {
    await operatorScreen(bot, env, message, ({ru:"Пользователь не найден.",en:"User not found.",es:"No se encontró al usuario.",zh:"未找到用户。"})[bot.locale]||"User not found.", { inline_keyboard: [] });
    return true;
  }
  const options = {};
  if (action === "ban") options.reason = args.slice(1).join(" ") || null;
  if (action === "restrict") options.durationMs = parseRestrictionDuration(args[1]);
  if (profiles.length > 1) {
    await chooseServiceForAction(bot, env, message, action, userId, profiles, options);
    return true;
  }
  const targetBot = resolveBot(env, profiles[0].bot_id);
  await executeDirectUserAction(bot, targetBot, env, message, action, userId, options);
  return true;
}

async function answerManagementCallback(bot, env, query, text = "", showAlert = false) {
  const result = await telegram(bot, "answerCallbackQuery", { callback_query_id: query.id, text: String(text).slice(0, 190), show_alert: showAlert }, env);
  if (!result.ok) log(bot, "warn", "callback_answer_failed", { description: result.description });
}

async function handlePendingCallback(bot, env, query, parts) {
  const db = requireDb(env);
  const verb = parts[2];
  const pending = verb === "cancel" ? await dbOne(db,"SELECT * FROM operator_pending_actions WHERE operator_id=?",query.from.id) : await pendingAction(db, query.from.id);
  const suppliedNonce = verb === "service" ? parts[4] : parts[3];
  if (suppliedNonce && await dbOne(db, "SELECT 1 FROM operator_completed_flows WHERE flow_nonce = ? AND operator_id = ?", suppliedNonce, query.from.id)) {
    await dbRun(db, "DELETE FROM operator_pending_actions WHERE operator_id = ? AND flow_nonce = ?", query.from.id, suppliedNonce);
    await operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    return;
  }
  if (!pending || pending.suspended && verb !== "cancel" || pending.management_bot_id !== bot.id || !pendingMatchesMessage(pending, query.message) || suppliedNonce !== pending.flow_nonce) {
    await operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    return;
  }
  if (verb === "cancel") {
    await dbRun(db,"UPDATE operator_input_guards SET active=0 WHERE operator_id=? AND nonce=?",query.from.id,pending.flow_nonce);
    await dbRun(db, "DELETE FROM operator_pending_actions WHERE operator_id = ?", query.from.id);
    await operatorScreen(bot, env, query.message, t(bot, "actionCancelled"), { inline_keyboard: [] }, true);
    const conversation = pending.user_id && pending.target_bot_id ? await findConversation(db, pending.target_bot_id, pending.user_id) : null;
    if (conversation) {
      try { await refreshTopicPanel(resolveBot(env, pending.target_bot_id), env, conversation); }
      catch (error) { log({ id: pending.target_bot_id }, "error", "topic_panel_refresh_failed", { user_id: pending.user_id, message: error.message }); }
    }
    return;
  }
  if(verb==='revise' && ['ban','restrict'].includes(pending.action) && pending.stage==='confirm') {
    await dbRun(db,"UPDATE operator_pending_actions SET stage=?,expires_at=? WHERE operator_id=? AND flow_nonce=?",pending.action==='ban'?'reason':'duration',isoAfter(OPERATOR_ACTION_TTL_MS),query.from.id,pending.flow_nonce);
    return operatorScreen(bot,env,query.message,pending.action==='ban'?({ru:'Укажите новую внутреннюю причину.',en:'Enter the revised internal reason.',es:'Indica el nuevo motivo interno.',zh:'请输入新的内部原因。'})[bot.locale]:({ru:'Укажите новый срок: 45m, 6h или 7d.',en:'Enter a new duration: 45m, 6h or 7d.',es:'Indica un nuevo plazo: 45m, 6h o 7d.',zh:'请输入新的时长：45m、6h 或 7d。'})[bot.locale],{inline_keyboard:[[{text:({ru:'Отмена',en:'Cancel',es:'Cancelar',zh:'取消'})[bot.locale]||'Cancel',callback_data:pendingCallback(pending,'cancel')}]]});
  }
  if (verb === "service") {
    if (pending.stage !== "service") return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    const registry = parseBotRegistry(env.BOT_REGISTRY);
    const selected = managementBotFromKey(registry, parts[3]);
    if (!selected) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    const profile = await managedProfile(db, selected.id, pending.user_id);
    if (!profile) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    const expectedStateKey = managementStateKey(profile);
    const targetBot = resolveBot(env, selected.id);
    if (pending.action === "ban" && !pending.reason) {
      await dbRun(db, "UPDATE operator_pending_actions SET target_bot_id = ?, expected_state_key = ?, stage = 'reason', expires_at = ? WHERE operator_id = ? AND stage = 'service'", selected.id, expectedStateKey, isoAfter(OPERATOR_ACTION_TTL_MS), query.from.id);
      return operatorScreen(bot, env, query.message, `${({ru:"Укажите внутреннюю причину блокировки",en:"Enter the internal block reason",es:"Indica el motivo interno del bloqueo",zh:"请输入封禁的内部原因"})[bot.locale]||"Enter the internal block reason"} · ${selected.displayName} · ${pending.user_id}`, { inline_keyboard: [[{ text: ({ru:"Отмена",en:"Cancel",es:"Cancelar",zh:"取消"})[bot.locale]||"Cancel", callback_data: pendingCallback(pending, "cancel") }]] }, true);
    }
    if (pending.action === "restrict" && !pending.duration_seconds) {
      await dbRun(db, "UPDATE operator_pending_actions SET target_bot_id = ?, expected_state_key = ?, stage = 'duration', expires_at = ? WHERE operator_id = ? AND stage = 'service'", selected.id, expectedStateKey, isoAfter(OPERATOR_ACTION_TTL_MS), query.from.id);
      return operatorScreen(bot, env, query.message, ({ru:"Укажите срок: 45m, 6h или 7d.",en:"Enter a duration: 45m, 6h, or 7d.",es:"Indica un plazo: 45m, 6h o 7d.",zh:"请输入时长：45m、6h 或 7d。"})[bot.locale]||"Enter a duration: 45m, 6h, or 7d.", { inline_keyboard: [[{ text: ({ru:"Отмена",en:"Cancel",es:"Cancelar",zh:"取消"})[bot.locale]||"Cancel", callback_data: pendingCallback(pending, "cancel") }]] }, true);
    }
    if (["ban", "restrict", "trust", "riskreset"].includes(pending.action)) {
      await dbRun(db, "UPDATE operator_pending_actions SET target_bot_id = ?, expected_state_key = ?, stage = 'confirm', expires_at = ? WHERE operator_id = ? AND stage = 'service'", selected.id, expectedStateKey, isoAfter(OPERATOR_ACTION_TTL_MS), query.from.id);
      return showPendingConfirmation(bot, env, query.message, await pendingAction(db, query.from.id));
    }
    const claimed = await dbRun(db, "UPDATE operator_pending_actions SET target_bot_id = ?, stage = 'executing' WHERE operator_id = ? AND stage = 'service' AND expires_at > ?", selected.id, query.from.id, nowIso());
    if (!(claimed.meta?.changes > 0)) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    try {
      const result = await applyLockedManagementAction(targetBot, env, query.from, pending.action, pending.user_id, { expectedStateKey });
      await dbRun(db, "DELETE FROM operator_pending_actions WHERE operator_id = ?", query.from.id);
      return operatorScreen(bot, env, query.message, result.text, { inline_keyboard: [] }, true);
    } catch (error) {
      await dbRun(db, "UPDATE operator_pending_actions SET stage = 'service' WHERE operator_id = ? AND stage = 'executing'", query.from.id);
      throw error;
    }
  }
  if (verb !== "confirm" || pending.stage !== "confirm") return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
  if (pending.user_id !== null && pending.target_bot_id) {
    const profile = await managedProfile(db, pending.target_bot_id, pending.user_id);
    if (!pending.expected_state_key || !profile || managementStateKey(profile) !== pending.expected_state_key) {
      await dbRun(db, "DELETE FROM operator_pending_actions WHERE operator_id = ? AND flow_nonce = ?", query.from.id, pending.flow_nonce);
      return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    }
  }
  const claimed = await dbRun(db, "UPDATE operator_pending_actions SET stage = 'executing' WHERE operator_id = ? AND stage = 'confirm' AND expires_at > ?", query.from.id, nowIso());
  if (!(claimed.meta?.changes > 0)) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
  try {
    const targetBot = resolveBot(env, pending.target_bot_id);
    const result = await applyLockedManagementAction(targetBot, env, query.from, pending.action, pending.user_id, { reason: pending.reason, durationMs: pending.duration_seconds ? Number(pending.duration_seconds) * 1000 : null, flowNonce: pending.flow_nonce, expectedStateKey: pending.expected_state_key });
    await dbRun(db, "DELETE FROM operator_pending_actions WHERE operator_id = ?", query.from.id);
    await operatorScreen(bot, env, query.message, result.text, { inline_keyboard: [] }, true);
  } catch (error) {
    await dbRun(db, "UPDATE operator_pending_actions SET stage = 'confirm' WHERE operator_id = ? AND stage = 'executing'", query.from.id);
    throw error;
  }
}

async function handleTopicPanelCallback(bot, env, query, parts) {
  const db = requireDb(env);
  const threadId = query.message?.message_thread_id;
  const conversation = threadId ? await dbOne(db, "SELECT * FROM conversations WHERE support_group_id = ? AND thread_id = ?", supportGroupId(env), threadId) : null;
  if (!conversation && threadId) {
    const historical = await findTopicByGroup(db, supportGroupId(env), threadId);
    if (historical?.historical && isOwnedByBot(historical, bot.id))
      return operatorScreen(bot, env, query.message, historicalTopicNotice(bot, historical), { inline_keyboard: [] }, true);
  }
  if (!conversation || !isOwnedByBot(conversation, bot.id)) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
  const action = parts[2];
  if (managerConfigured(env) && ['close', 'open'].includes(action)) {
    const managerName = String(env.MANAGER_BOT_USERNAME).replace(/^@/, '');
    return operatorScreen(bot, env, query.message,
      ({ru:'Управление темой перенесено в Админушку. Откройте карточку обращения.',en:'Topic management has moved to Adminushka. Open the conversation panel.',es:'La gestión del tema se trasladó a Adminushka. Abre la ficha de la conversación.',zh:'话题管理已迁移到 Adminushka。请打开会话卡片。'})[bot.locale] || 'Topic management has moved to Adminushka. Open the conversation panel.',
      { inline_keyboard: [[{ text: localizedWorkerSay(bot.locale,'Открыть обращение','Open conversation'),
        url: `https://t.me/${managerName}?start=case_${stableManagementBotKey(bot.id)}_${conversation.user_id}` }]] }, true);
  }
  if (action === "manage") {
    const profile = await managedProfile(db, bot.id, conversation.user_id);
    const stateKey = managementStateKey(profile);
    const ru = bot.locale === "ru";
    return operatorScreen(bot, env, query.message, topicPanelText(bot, profile), { inline_keyboard: [
      [{ text: localizedWorkerSay(bot.locale,Number(profile.manual_trust) === 1 ? "Снять доверие" : "Доверять",Number(profile.manual_trust) === 1 ? "Untrust" : "Trust"), callback_data: `um:tp:${Number(profile.manual_trust) === 1 ? "untrust" : "trust"}:${stateKey}` },
       { text: localizedWorkerSay(bot.locale,isManuallyRestricted(profile) ? "Снять ручное ограничение" : "Ограничить",isManuallyRestricted(profile) ? "Remove manual restriction" : "Restrict"), callback_data: `um:tp:${isManuallyRestricted(profile) ? "unrestrict" : "restrict"}:${stateKey}` }],
      [{ text: localizedWorkerSay(bot.locale,profile.banned_at ? "Разблокировать" : "Заблокировать",profile.banned_at ? "Unblock" : "Block"), callback_data: `um:tp:${profile.banned_at ? "unban" : "ban"}:${stateKey}` },
       { text: localizedWorkerSay(bot.locale,"Риск, CAPTCHA и автомьют…","Risk, CAPTCHA and auto-mute…"), callback_data: `um:tp:riskreset:${stateKey}` }],
      [{ text: localizedWorkerSay(bot.locale,"← Назад","← Back"), callback_data: "um:tp:refresh" }],
    ] }, true);
  }
  if (["refresh", "info", "risk"].includes(action)) {
    const profile=await managedProfile(db,bot.id,conversation.user_id);
    await operatorScreen(bot,env,query.message,action==='info'?formatInfo(conversation,bot)+'\n\n'+accessSummary(bot,profile):topicPanelText(bot,profile),topicPanelKeyboard(bot,profile,env),true);
    return;
  }
  if (action === "audit") {
    const screen = await auditScreen(bot, env, bot.id, conversation.user_id, 0);
    return operatorScreen(bot, env, query.message, screen.text, screen.replyMarkup);
  }
  const expectedStateKey = parts[3] || null;
  const profile = await managedProfile(db, bot.id, conversation.user_id);
  if (!profile || !expectedStateKey || managementStateKey(profile) !== expectedStateKey) {
    return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
  }
  if (action === "restrict") {
    return operatorScreen(bot, env, query.message, topicPanelText(bot, profile), restrictionMenu(bot, { kind: "topic", stateKey: expectedStateKey }), true);
  }
  if (["r15", "r1h", "r24h", "rcustom"].includes(action)) {
    const durations = { r15: 15 * 60_000, r1h: 60 * 60_000, r24h: 24 * 60 * 60_000 };
    return beginRestrictionFlow(bot, bot, env, query.from, query.message, conversation.user_id, durations[action] ?? null, expectedStateKey);
  }
  if (["trust","riskreset"].includes(action))return beginAccessFlow(bot,bot,env,query.from,query.message,action,conversation.user_id,expectedStateKey);
  if (action === "ban") return beginBanFlow(bot, bot, env, query.from, query.message, conversation.user_id, null, expectedStateKey);
  if (["trust", "untrust", "unrestrict", "unban", "riskreset", "close", "open"].includes(action)) {
    const result = await applyLockedManagementAction(bot, env, query.from, action, conversation.user_id, { expectedStateKey });
    if (!result.changed) await operatorScreen(bot, env, query.message, result.text, { inline_keyboard: [[{ text: localizedWorkerSay(bot.locale, "Обновить панель", "Refresh panel"), callback_data: "um:tp:refresh" }]] });
    return;
  }
  return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
}

async function handleGeneralManagementCallback(bot, env, query, parts) {
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const section = parts[2];
  let screen;
  if (section === "home") {
    const selected = managementBotFromKey(registry, parts[3]);
    if (parts[3] !== "a" && !selected) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    screen = await usersHomeScreen(bot, env, selected?.id || null, query.from.id);
  } else if (section === "bots") {
    screen = await botChooserScreen(bot, env);
  } else if (section === "bot") {
    const selected = managementBotFromKey(registry, parts[3]);
    if (parts[3] !== "a" && !selected) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    screen = await usersHomeScreen(bot, env, selected?.id || null, query.from.id);
  } else if (section === "list") {
    screen = await userListScreen(bot, env, parts[3], parts[4], Number(parts[5]));
  } else if (section === "card") {
    const selected = managementBotFromKey(registry, parts[3]);
    const userId = Number(parts[4]);
    const profile = selected && Number.isSafeInteger(userId) ? await managedProfile(requireDb(env), selected.id, userId) : null;
    if (!profile) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    screen = userCardScreen(bot, env, profile);
  } else if (section === "audit" || section === "uaudit") {
    const selected = managementBotFromKey(registry, parts[3]);
    const userId = section === "uaudit" ? Number(parts[4]) : null;
    const page = Number(parts[section === "uaudit" ? 5 : 4]);
    screen = await auditScreen(bot, env, selected?.id || null, Number.isSafeInteger(userId) ? userId : null, page, parts.at(-1)==='d');
  } else if (section === "attack") {
    const mode = parts[3];
    const selected = managementBotFromKey(registry, parts[4]);
    if (!selected || !["auto", "on", "off"].includes(mode)) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    const targetBot = resolveBot(env, selected.id);
    if (mode === "off") return beginAttackOffFlow(bot, targetBot, env, query.from, query.message);
    await applyLockedManagementAction(targetBot, env, query.from, `attack_${mode}`, null);
    return handleNavigationCallback(bot,{...env,OPERATOR_UI_ROUTE:`um:n:bot:${parts[4]}`},query,['um','n','bot',parts[4]]);
  } else if (section === "act") {
    const action = parts[3];
    const selected = managementBotFromKey(registry, parts[4]);
    const userId = Number(parts[5]);
    const expectedStateKey = parts[6] || null;
    const profile = selected && Number.isSafeInteger(userId) ? await managedProfile(requireDb(env), selected.id, userId) : null;
    if (!profile || !expectedStateKey || managementStateKey(profile) !== expectedStateKey) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    const targetBot = resolveBot(env, selected.id);
    if (action === "restrict") return operatorScreen(bot, env, query.message, userCardScreen(bot, env, profile).text, restrictionMenu(bot, { kind: "general", botKey: parts[4], userId, stateKey: expectedStateKey }), true);
    if (["trust","riskreset"].includes(action))return beginAccessFlow(bot,targetBot,env,query.from,query.message,action,userId,expectedStateKey);
    if (action === "ban") return beginBanFlow(bot, targetBot, env, query.from, query.message, userId, null, expectedStateKey);
    if (!["trust", "untrust", "unrestrict", "unban", "riskreset"].includes(action)) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    await applyLockedManagementAction(targetBot, env, query.from, action, userId, { expectedStateKey });
    const refreshed = await managedProfile(requireDb(env), selected.id, userId);
    screen = userCardScreen(bot, env, refreshed);
  } else if (["r15", "r1h", "r24h", "rcustom"].includes(section)) {
    const selected = managementBotFromKey(registry, parts[3]);
    const userId = Number(parts[4]);
    const expectedStateKey = parts[5] || null;
    const profile = selected && Number.isSafeInteger(userId) ? await managedProfile(requireDb(env), selected.id, userId) : null;
    if (!profile || !expectedStateKey || managementStateKey(profile) !== expectedStateKey) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    const durations = { r15: 15 * 60_000, r1h: 60 * 60_000, r24h: 24 * 60 * 60_000 };
    return beginRestrictionFlow(bot, resolveBot(env, selected.id), env, query.from, query.message, userId, durations[section] ?? null, expectedStateKey);
  } else {
    return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
  }
  return operatorScreen(bot, env, query.message, screen.text, screen.replyMarkup, true);
}

async function handleReactionManagementCallback(bot, env, query, parts) {
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const section = parts[2];
  if (["test", "check", "stop"].includes(section)) return reactionCheckScreen(bot, env, query, parts);
  if (!isGeneralSource(query.message, env)) return;
  if (section === "bots") {
    const screenCopy=({ru:['Все боты','Выберите support-бота. Режим «Все боты» доступен только для просмотра.'],en:['All bots','Select a support bot. All-bots mode is read-only.'],es:['Todos los bots','Elige un bot de soporte. El modo «Todos los bots» es solo de lectura.'],zh:['所有机器人','请选择支持机器人。“所有机器人”模式仅供查看。']})[bot.locale]||['All bots','Select a support bot. All-bots mode is read-only.'];
    const keyboard = [[{ text: screenCopy[0], callback_data: "um:r:home:a" }], ...registry.map((item) => [{ text: item.displayName, callback_data: `um:r:home:${managementBotKey(registry, item.id)}` }])];
    const screen = { text: screenCopy[1], replyMarkup: { inline_keyboard: keyboard } };
    return operatorScreen(bot, env, query.message, screen.text, screen.replyMarkup, true);
  }
  if (section === "choose") {
    const selected = managementBotFromKey(registry, parts[3]);
    const mode = parts[4];
    if (!selected || !["on", "off"].includes(mode)) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    const result = await setReactionSetting(bot, env, query.from, selected.id, mode === "on");
    return operatorScreen(bot, env, query.message, result.text, { inline_keyboard: [] }, true);
  }
  if (section === "set") {
    const selected = managementBotFromKey(registry, parts[3]);
    const mode = parts[4];
    if (!selected || !["on", "off"].includes(mode)) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    if (parts[5] !== undefined && !["0", "1"].includes(parts[5])) return;
    const direction = parts[5] === undefined ? null : REACTION_DIRECTIONS[Number(parts[5])];
    const result = await setReactionSetting(bot, env, query.from, selected.id, mode === "on", direction);
    const screen = await reactionScreen(bot, env, parts[3], query.from.id);
    return operatorScreen(bot, env, query.message, `${result.text}\n\n${screen.text}`, screen.replyMarkup, true);
  }
  if (section === "home") {
    const key = parts[3] || "a";
    const screen = await reactionScreen(bot, env, key, query.from.id);
    return operatorScreen(bot, env, query.message, screen.text, screen.replyMarkup, true);
  }
  return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
}

async function handleOperatorManagementCallback(bot, env, query, parts) {
  const db = requireDb(env);
  const section = parts[2];
  const role = await operatorRole(bot, env, query.from.id);
  if (!role) return;
  const callbackThread = query.message?.message_thread_id;
  if (callbackThread !== undefined && callbackThread !== null && Number(callbackThread) !== 1) {
    return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
  }
  const ru = bot.locale === "ru";
  const denyOwnerOnly = async () => operatorScreen(bot, env, query.message, localizedWorkerSay(bot.locale,"Только главный оператор может изменять команду поддержки.","Only the primary operator can change the support team."), { inline_keyboard: [[{ text: localizedWorkerSay(bot.locale,"← К списку","← Back to list"), callback_data: "um:o:home:0" }]] }, true);
  if (section === "home") {
    const screen = await operatorsScreen(bot, env, query.from.id, Number(parts[3]));
    return operatorScreen(bot, env, query.message, screen.text, screen.replyMarkup, true);
  }
  if (section === "primary") {
    const primary = await primaryOperatorIdentity(bot, env);
    const page = Math.max(0, Number(parts[3]) || 0);
    const labels=({ru:{username:'Имя пользователя',id:'Telegram ID'},en:{username:'Username',id:'Telegram ID'},es:{username:'Nombre de usuario',id:'ID de Telegram'},zh:{username:'用户名',id:'Telegram ID'}})[bot.locale]||{username:'Username',id:'Telegram ID'};
    const text = `👑 ${operatorName(primary)}\n\n${labels.username}: ${primary.username ? `@${primary.username}` : "—"}\n${labels.id}: ${primary.id}\n${localizedWorkerSay(bot.locale,"Роль: главный оператор","Role: primary operator")}\n\n${localizedWorkerSay(bot.locale,"Главный оператор задаётся при первоначальной настройке и не может быть удалён здесь.","The primary operator is configured during initial setup and cannot be removed here.")}`;
    return operatorScreen(bot, env, query.message, text, { inline_keyboard: [[{ text: localizedWorkerSay(bot.locale,"← К списку","← Back to list"), callback_data: `um:o:home:${page}` }]] }, true);
  }
  if (section === "card") {
    const userId = Number(parts[3]);
    const page = Math.max(0, Number(parts[4]) || 0);
    const row = Number.isSafeInteger(userId) ? await dbOne(db, "SELECT * FROM support_operators WHERE user_id = ? AND active = 1", userId) : null;
    if (!row) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    const screen = operatorCardScreen(bot, role, row, page);
    return operatorScreen(bot, env, query.message, screen.text, screen.replyMarkup, true);
  }
  if (section === "add") {
    if (role !== "primary") return denyOwnerOnly();
    const flow = await saveTeamFlow(db, query.from, query.message, "add", null, 0, "candidate");
    const text = localizedWorkerSay(bot.locale,"Ответьте на сообщение будущего оператора в этой группе или отправьте его числовой Telegram ID.","Reply to the future operator's message in this group or send their numeric Telegram ID.");
    return operatorScreen(bot, env, query.message, text, { inline_keyboard: [[{ text: localizedWorkerSay(bot.locale,"Отмена","Cancel"), callback_data: `um:o:cancel:${flow.flow_nonce}` }]] }, true);
  }
  if (section === "rm") {
    if (role !== "primary") return denyOwnerOnly();
    const userId = Number(parts[3]);
    const page = Math.max(0, Number(parts[4]) || 0);
    if (!Number.isSafeInteger(userId) || userId === primaryOperatorId(env)) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    const row = await dbOne(db, "SELECT * FROM support_operators WHERE user_id = ? AND active = 1", userId);
    if (!row) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
    const flow = await saveTeamFlow(db, query.from, query.message, "remove", { id: row.user_id, first_name: row.first_name, last_name: row.last_name, username: row.username }, page, "confirm");
    const screen = removeOperatorConfirmation(bot, flow);
    return operatorScreen(bot, env, query.message, screen.text, screen.replyMarkup, true);
  }
  if (section === "cancel") {
    const nonce = parts[3];
    await dbRun(db, "DELETE FROM support_operator_flows WHERE owner_id = ? AND flow_nonce = ?", query.from.id, nonce);
    return operatorScreen(bot, env, query.message, t(bot, "actionCancelled"), { inline_keyboard: [[{ text: localizedWorkerSay(bot.locale,"← К списку","← Back to list"), callback_data: "um:o:home:0" }]] }, true);
  }
  if (section !== "confirm") return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
  if (role !== "primary") return denyOwnerOnly();
  const nonce = parts[3];
  if (await dbOne(db, "SELECT 1 FROM support_operator_completed_flows WHERE flow_nonce = ? AND owner_id = ?", nonce, query.from.id)) {
    return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
  }
  const flow = await dbOne(db, "SELECT * FROM support_operator_flows WHERE owner_id = ? AND flow_nonce = ? AND stage = 'confirm' AND expires_at > ?", query.from.id, nonce, nowIso());
  if (!flow || String(flow.chat_id) !== String(supportGroupId(env)) || (flow.thread_id !== null && Number(flow.thread_id) !== 1)) {
    return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
  }
  if (await operatorRole(bot, env, query.from.id) !== "primary") return denyOwnerOnly();
  const claimed = await dbRun(db, "UPDATE support_operator_flows SET stage = 'executing' WHERE owner_id = ? AND flow_nonce = ? AND stage = 'confirm' AND expires_at > ?", query.from.id, nonce, nowIso());
  if (claimed.meta?.changes !== 1) return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
  try {
    const timestamp = nowIso();
    if (flow.action === "add") {
      const checked = await validateOperatorCandidate(bot, env, flow.candidate_id);
      if (!checked.ok) {
        await dbRun(db, "DELETE FROM support_operator_flows WHERE owner_id = ? AND flow_nonce = ?", query.from.id, nonce);
        return operatorScreen(bot, env, query.message, candidateErrorText(bot, checked.code), { inline_keyboard: [] }, true);
      }
      const candidate = checked.user;
      await db.batch([
        db.prepare(`INSERT INTO support_operators (user_id, first_name, last_name, username, active, added_by, added_by_name, added_at, removed_by, removed_by_name, removed_at)
          VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, NULL)
          ON CONFLICT(user_id) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, username=excluded.username, active=1, added_by=excluded.added_by, added_by_name=excluded.added_by_name, added_at=excluded.added_at, removed_by=NULL, removed_by_name=NULL, removed_at=NULL WHERE support_operators.active = 0`).bind(candidate.id, candidate.first_name, candidate.last_name, candidate.username, query.from.id, operatorName(query.from), timestamp),
        db.prepare("INSERT INTO support_operator_audit (actor_id, actor_name, target_operator_id, target_name, target_username, action, result, created_at) VALUES (?, ?, ?, ?, ?, 'operator_added', 'success', ?)").bind(query.from.id, operatorName(query.from), candidate.id, operatorName(candidate), candidate.username, timestamp),
        db.prepare("INSERT INTO support_operator_completed_flows (flow_nonce, owner_id, action, completed_at) VALUES (?, ?, 'add', ?)").bind(nonce, query.from.id, timestamp),
        db.prepare("DELETE FROM support_operator_flows WHERE owner_id = ? AND flow_nonce = ? AND stage = 'executing'").bind(query.from.id, nonce),
      ]);
      const screen = await operatorsScreen(bot, env, query.from.id, flow.list_page);
      return operatorScreen(bot, env, query.message, `${localizedWorkerSay(bot.locale,"✅ Оператор добавлен.","✅ Operator added.")}\n\n${screen.text}`, screen.replyMarkup, true);
    }
    if (Number(flow.candidate_id) === primaryOperatorId(env)) throw new Error("The primary operator cannot be removed");
    let targetExecutionOwner = null;
    try {
      targetExecutionOwner = await claimOperatorExecutionLock(db, Number(flow.candidate_id));
      const current = await dbOne(db, "SELECT * FROM support_operators WHERE user_id = ? AND active = 1", flow.candidate_id);
      if (!current) {
        await dbRun(db, "DELETE FROM support_operator_flows WHERE owner_id = ? AND flow_nonce = ?", query.from.id, nonce);
        return operatorScreen(bot, env, query.message, t(bot, "staleAction"), { inline_keyboard: [] }, true);
      }
      await db.batch([
        db.prepare("UPDATE support_operators SET active = 0, removed_by = ?, removed_by_name = ?, removed_at = ? WHERE user_id = ? AND active = 1").bind(query.from.id, operatorName(query.from), timestamp, current.user_id),
        db.prepare("DELETE FROM operator_pending_actions WHERE operator_id = ?").bind(current.user_id),
        db.prepare("DELETE FROM support_operator_flows WHERE owner_id = ?").bind(current.user_id),
        db.prepare("INSERT INTO support_operator_audit (actor_id, actor_name, target_operator_id, target_name, target_username, action, result, created_at) VALUES (?, ?, ?, ?, ?, 'operator_removed', 'success', ?)").bind(query.from.id, operatorName(query.from), current.user_id, operatorName({ id: current.user_id, first_name: current.first_name, last_name: current.last_name, username: current.username }), current.username, timestamp),
        db.prepare("INSERT INTO support_operator_completed_flows (flow_nonce, owner_id, action, completed_at) VALUES (?, ?, 'remove', ?)").bind(nonce, query.from.id, timestamp),
        db.prepare("DELETE FROM support_operator_flows WHERE owner_id = ? AND flow_nonce = ? AND stage = 'executing'").bind(query.from.id, nonce),
      ]);
    } finally {
      if (targetExecutionOwner) await releaseOperatorExecutionLock(db, Number(flow.candidate_id), targetExecutionOwner);
    }
    const screen = await operatorsScreen(bot, env, query.from.id, flow.list_page);
    return operatorScreen(bot, env, query.message, `${localizedWorkerSay(bot.locale,"✅ Оператор удалён.","✅ Operator removed.")}\n\n${screen.text}`, screen.replyMarkup, true);
  } catch (error) {
    try { await dbRun(db, "UPDATE support_operator_flows SET stage = 'confirm' WHERE owner_id = ? AND flow_nonce = ? AND stage = 'executing'", query.from.id, nonce); } catch {}
    throw error;
  }
}

async function handleCallbackQuery(bot, env, query) {
  if (!query?.id || !query.from?.id || String(query.message?.chat?.id) !== String(supportGroupId(env))) return;
  if (!await isAdmin(bot, env, query.from.id)) {
    log(bot, "warn", "operator_callback_unauthorized", { user_id: query.from.id });
    await answerManagementCallback(bot, env, query, t(bot, "unauthorized"), true);
    return;
  }
  if (env.SERVICE_ACTIVE_GROUP_ID != null && Number(env.SERVICE_ACTIVE_GROUP_ID) !== supportGroupId(env)) {
    await answerManagementCallback(bot, env, query);
    const historical = query.message?.message_thread_id
      ? await redirectHistoricalTopic(bot, env, query.message.message_thread_id) : null;
    if (historical) return operatorScreen(bot, env, query.message,
      historicalTopicNotice(bot, historical), { inline_keyboard: [] }, true);
    return;
  }
  const managerLink = isGeneralSource(query.message, env) && await managerMenuLink(requireDb(env), env);
  if (managerLink || isGeneralSource(query.message, env) && managerConfigured(env)) {
    await answerManagementCallback(bot, env, query);
    return operatorScreen(bot, env, query.message,
      ({ru:'Управление поддержкой перенесено в отдельный бот. Откройте актуальное меню.',en:'Support management has moved to a separate bot. Open the current menu.',es:'La gestión del soporte se trasladó a otro bot. Abre el menú actual.',zh:'支持管理已迁移到单独的机器人。请打开当前菜单。'})[bot.locale] || 'Support management has moved to a separate bot. Open the current menu.',
      { inline_keyboard: [[{ text: ({ru:'Открыть меню',en:'Open menu',es:'Abrir menú',zh:'打开菜单'})[bot.locale] || 'Open menu', url: managerLink
        || `https://t.me/${String(env.MANAGER_BOT_USERNAME).replace(/^@/, '')}?start=menu` }]] }, true);
  }
  const data = String(query.data || "");
  if (!data.startsWith("um:")) {
    await answerManagementCallback(bot, env, query, t(bot, "callback"));
    return;
  }
  await answerManagementCallback(bot, env, query);
  const parts = data.split(":");
  env = { ...env, OPERATOR_UI_ACTOR: query.from.id, OPERATOR_UI_ROUTE: data };
  const keepInput = (parts[1]==='pa' || parts[1]==='o' && ['confirm','cancel','candidate'].includes(parts[2]) || parts[1]==='m' && ['save','cancel','revise'].includes(parts[2]) || parts[1]==='w' && ['noteconfirm','notecancel'].includes(parts[2])) ? parts[1] : '';
  await dbRun(requireDb(env), 'INSERT INTO operator_input_navigation(operator_id,keep_kind) VALUES(?,?) ON CONFLICT(operator_id) DO UPDATE SET keep_kind=excluded.keep_kind',query.from.id,keepInput);
  if (parts[1] === 'w') return handleWorkspaceCallback(bot, env, query, parts);
  if (parts[1] === "m") return messageSettingsScreen(bot, env, query.from, query.message, parts[2], parts[3], parts[4], true);
  if (parts[1] === "dl") return manualDeliveryScreen(bot, env, query, parts);
  if (parts[1] === "n") return handleNavigationCallback(bot, env, query, parts);
  if (parts[1] === "d") return handleCloudflarePlan(bot, env, query.from, query.message, parts, true);
  if (parts[1] === "s") {
    if (parts.length < 4 || parts.length > 5 || new TextEncoder().encode(data).length > 64) return;
    return handleTopicStyle(bot, env, query.from, query.message, parts[2], parts[3], parts[4], true);
  }
  if (parts[1] === "pa") return handlePendingCallback(bot, env, query, parts);
  if (parts[1] === "tp") return handleTopicPanelCallback(bot, env, query, parts);
  if (parts[1] === "g") return handleGeneralManagementCallback(bot, env, query, parts);
  if (parts[1] === "r") return handleReactionManagementCallback(bot, env, query, parts);
  if (parts[1] === "o") return handleOperatorManagementCallback(bot, env, query, parts);
}

async function claimGeneralMessage(db, env, messageId, botId) {
  const ownerToken = crypto.randomUUID();
  const groupId = supportGroupId(env);
  const expiresAt = isoAfter(GENERAL_CONTROL_LEASE_MS);
  let claimed = await dbOne(db, "INSERT INTO general_message_claims (support_group_id, message_id, handler_bot_id, owner_token, lease_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(support_group_id, message_id) DO NOTHING RETURNING owner_token", groupId, Number(messageId), botId, ownerToken, expiresAt, nowIso());
  if (claimed?.owner_token) return { status: "acquired", ownerToken };
  const current = await dbOne(db, "SELECT * FROM general_message_claims WHERE support_group_id = ? AND message_id = ?", groupId, Number(messageId));
  if (current?.completed_at) return { status: "completed" };
  if (current?.lease_expires_at && Date.parse(current.lease_expires_at) <= Date.now()) {
    claimed = await dbOne(db, "UPDATE general_message_claims SET handler_bot_id = ?, owner_token = ?, lease_expires_at = ? WHERE support_group_id = ? AND message_id = ? AND completed_at IS NULL AND owner_token = ? AND lease_expires_at <= ? RETURNING owner_token", botId, ownerToken, expiresAt, groupId, Number(messageId), current.owner_token, nowIso());
    if (claimed?.owner_token) return { status: "acquired", ownerToken };
  }
  return { status: "busy" };
}

async function completeGeneralMessageClaim(db, env, messageId, ownerToken) {
  const completed = await dbRun(db, "UPDATE general_message_claims SET completed_at = COALESCE(completed_at, ?), lease_expires_at = ? WHERE support_group_id = ? AND message_id = ? AND owner_token = ? AND completed_at IS NULL", nowIso(), nowIso(), supportGroupId(env), Number(messageId), ownerToken);
  if (completed.meta?.changes !== 1) throw new Error("General control-plane claim could not be completed");
}

async function releaseGeneralMessageClaim(db, env, messageId, ownerToken) {
  await dbRun(db, "DELETE FROM general_message_claims WHERE support_group_id = ? AND message_id = ? AND owner_token = ? AND completed_at IS NULL", supportGroupId(env), Number(messageId), ownerToken);
}

async function commandBots(bot, env) {
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const rows = await requireDb(env).prepare("SELECT bot_id, COUNT(*) AS users FROM conversations GROUP BY bot_id").all();
  const counts = new Map((rows.results || []).map((row) => [row.bot_id, row.users]));
  return [t(bot, "supportBots"), "", ...registry.map((item) => `${item.enabled ? "🟢" : "⚪"} ${item.displayName}${item.username ? ` (@${item.username})` : ""}\n${t(bot, "users")}: ${counts.get(item.id) || 0}`)].join("\n\n");
}

async function effectiveGroupCommandOwner(db, registry, env) {
  if (managerConfigured(env)) return null;
  const persisted = await dbAll(db, "SELECT id, enabled FROM bots");
  const enabledById = new Map((persisted.results || []).map((row) => [row.id, Number(row.enabled) !== 0]));
  const isEnabled = (config) => config.enabled && enabledById.get(config.id) !== false;
  if (!registry.some((config) => config.groupCommandOwner)) return null;
  return registry.find((config) => isEnabled(config) && config.groupCommandOwner)
    || registry.find(isEnabled) || null;
}

async function deleteOperatorMessage(bot, env, message, conversation) {
  const reply = message.reply_to_message;
  if (!reply || !Number.isSafeInteger(Number(reply.message_id)) || Number(reply.message_id) <= 0)
    return messageDeletionText(bot.locale, 'reply');
  if (reply.from?.is_bot || reply.sender_chat || Number(reply.from?.id) !== Number(message.from.id)
    || (reply.message_thread_id != null && Number(reply.message_thread_id) !== Number(conversation.thread_id)))
    return messageDeletionText(bot.locale, 'own');
  const db = requireDb(env);
  try {
    return await withAuthorizedOperatorExecution(bot, env, message.from.id, async renewFence => {
      const mapping = await dbOne(db, `SELECT m.user_message_id FROM message_mappings m
        JOIN conversations c ON c.bot_id=m.bot_id AND c.user_id=m.user_id
          AND c.support_group_id=m.support_group_id AND c.thread_id=m.thread_id
        WHERE m.bot_id=? AND m.user_id=? AND m.support_group_id=? AND m.thread_id=?
          AND m.support_message_id=? AND m.user_message_id IS NOT NULL AND c.id=?
        ORDER BY m.id DESC LIMIT 1`, bot.id, conversation.user_id, supportGroupId(env),
      conversation.thread_id, reply.message_id, conversation.id);
      if (!mapping) return messageDeletionText(bot.locale, 'missing');
      // Retain the mapping so deletion can be retried after a lost response.
      // Confirm customer deletion before removing the operator's original.
      // Keep retries under the operator fence, outside generic background cleanup.
      recoveryCheckpoint(db, 12);
      await renewFence();
      const customer = await telegram(bot, 'deleteMessage', {
        chat_id: conversation.user_id, message_id: mapping.user_message_id,
      }, env, fetch, { durableCleanup: false });
      if (!isConfirmedMessageDeletion(customer)) return messageDeletionText(bot.locale, 'failed');
      await renewFence();
      const original = await telegram(bot, 'deleteMessage', {
        chat_id: supportGroupId(env), message_id: reply.message_id,
      }, env, fetch, { durableCleanup: false });
      const complete = isConfirmedMessageDeletion(original);
      await operatorAuditStatement(db, bot.id, conversation.user_id, message.from,
        'message_delete', complete ? 'success' : 'partial', {
          reason: `group_id=${supportGroupId(env)}; support_message_id=${reply.message_id}; user_message_id=${mapping.user_message_id}`,
          deduplicate: true,
        }).run();
      return messageDeletionText(bot.locale, complete ? 'done' : 'partial');
    });
  } catch (error) {
    if (error?.operatorRevoked) return t(bot, 'unauthorized');
    throw error;
  }
}

async function executeCommand(bot, env, message, conversation, command) {
  const db = requireDb(env); const userId = conversation?.user_id;
  if (command === "/bots") return commandBots(bot, env);
  if (command === "/attack") {
    // Mutations are routed through the same fenced UI contract above.
    const state = await attackState(db, bot, env);
    return `${bot.displayName} · ${t(bot, "attack")}: ${state?.mode || "normal"}${state?.manual_override ? ` (manual ${state.manual_override})` : ' (AUTO)'}${state?.override_until ? '\nAUTO: '+formatOperatorDate(bot,state.override_until) : ''}\n/attack on · /attack off · /attack auto`;
  }
  if (!conversation) return t(bot, "useInTopic");
  if (command === '/delete') return deleteOperatorMessage(bot, env, message, conversation);
  if (command === "/info") return formatInfo(conversation, bot);
  if (command === "/ban") {
    await db.batch([
      db.prepare("INSERT INTO banned_users (bot_id, user_id, reason, banned_at) VALUES (?, ?, ?, ?) ON CONFLICT(bot_id, user_id) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at").bind(bot.id, userId, `by ${message.from.id}`, nowIso()),
      db.prepare("UPDATE verification_challenges SET status = 'failed', failed_at = ? WHERE bot_id = ? AND user_id = ? AND (status = 'pending' OR (status = 'passed' AND flushed_at IS NULL))").bind(nowIso(), bot.id, userId),
      db.prepare("DELETE FROM pending_flush_locks WHERE bot_id = ? AND user_id = ?").bind(bot.id, userId),
      db.prepare("DELETE FROM pending_messages WHERE bot_id = ? AND user_id = ? AND delivered_at IS NULL").bind(bot.id, userId),
      db.prepare("UPDATE user_abuse_state SET verification_required = 0, pending_release_required = 0, updated_at = ? WHERE bot_id = ? AND user_id = ?").bind(nowIso(), bot.id, userId),
    ]);
    await recordAbuseEvent(db, bot.id, userId, `manual-ban:${message.message_id}`, "manual_ban");
    return t(bot, "banned");
  }
  if (command === "/unban") { await dbRun(db, "DELETE FROM banned_users WHERE bot_id = ? AND user_id = ?", bot.id, userId); return t(bot, "unbanned"); }
  if (command === "/trust") {
    await ensureAbuseState(db, bot.id, userId);
    await db.batch([
      db.prepare("UPDATE user_abuse_state SET manual_trust = 1, trusted_until = ?, verification_required = 0, pending_release_required = 1, updated_at = ? WHERE bot_id = ? AND user_id = ?").bind(isoAfter(bot.trustedDays * 86_400_000), nowIso(), bot.id, userId),
      db.prepare("UPDATE verification_challenges SET status = 'expired' WHERE bot_id = ? AND user_id = ? AND status = 'pending'").bind(bot.id, userId),
    ]);
    await recordAbuseEvent(db, bot.id, userId, `manual-trust:${message.message_id}`, "manual_trust");
    const released = await flushReleasedPendingMessages(bot, env, userId, true);
    if (released.status === "busy") throw new Error("Pending release is already in progress; retry this command");
    return t(bot, "trusted");
  }
  if (command === "/untrust") {
    await ensureAbuseState(db, bot.id, userId);
    await dbRun(db, "UPDATE user_abuse_state SET manual_trust = 0, trusted_until = NULL, updated_at = ? WHERE bot_id = ? AND user_id = ?", nowIso(), bot.id, userId);
    return t(bot, "untrusted");
  }
  if (command === "/risk") {
    const state = await decayRisk(db, bot, userId);
    return `${t(bot, "risk")}: ${state.risk_score}; trusted=${Number(state.manual_trust) === 1 || isFuture(state.trusted_until) ? "yes" : "no"}; muted=${isFuture(state.muted_until) ? state.muted_until : "no"}`;
  }
  if (command === "/riskreset") {
    await ensureAbuseState(db, bot.id, userId);
    await db.batch([
      db.prepare("UPDATE user_abuse_state SET risk_score = 0, last_risk_at = ?, muted_until = NULL, verification_required = 0, pending_release_required = 1, updated_at = ? WHERE bot_id = ? AND user_id = ?").bind(nowIso(), nowIso(), bot.id, userId),
      db.prepare("UPDATE verification_challenges SET status = 'expired' WHERE bot_id = ? AND user_id = ? AND status = 'pending'").bind(bot.id, userId),
    ]);
    const released = await flushReleasedPendingMessages(bot, env, userId, true);
    if (released.status === "busy") throw new Error("Pending release is already in progress; retry this command");
    return t(bot, "riskReset");
  }
  if (command === "/antispam") {
    const attack = await attackState(db, bot, env);
    const metrics = await serviceMetrics(db, bot.id);
    return `service=${bot.displayName}; enabled=${bot.antispamEnabled}; mode=${attack?.mode || "normal"}; verification=${bot.verificationMode}; burst=${bot.burstLimit}; minute=${bot.minuteLimit}; absolute=${bot.absoluteLimit}; turnstile=${bot.riskTurnstileThreshold}; mute=${bot.riskMuteThreshold}; new_users/min=${metrics.newUsers}; rate_limited/min=${metrics.rateLimited}; challenges/min=${metrics.challenges}; mutes/min=${metrics.mutes}`;
  }
  if (command === "/close") {
    const closed = await telegram(bot, "closeForumTopic", { chat_id: supportGroupId(env), message_thread_id: conversation.thread_id }, env);
    if (!closed.ok && !isAlreadyTopicState(closed.description, "closed")) throw new Error(`closeForumTopic failed: ${closed.description}`);
    const updateFloor = await latestProcessedUpdateId(db, bot.id);
    await dbRun(db, "UPDATE conversations SET status = 'closed', reply_epoch = reply_epoch + CASE WHEN status <> 'closed' THEN 1 ELSE 0 END, topic_state_update_id = CASE WHEN ? IS NULL THEN topic_state_update_id WHEN topic_state_update_id IS NULL OR topic_state_update_id < ? THEN ? ELSE topic_state_update_id END WHERE id = ?", updateFloor, updateFloor, updateFloor, conversation.id);
    return null;
  }
  if (command === "/open") {
    const opened = await telegram(bot, "reopenForumTopic", { chat_id: supportGroupId(env), message_thread_id: conversation.thread_id }, env);
    if (!opened.ok && !isAlreadyTopicState(opened.description, "open")) throw new Error(`reopenForumTopic failed: ${opened.description}`);
    const updateFloor = await latestProcessedUpdateId(db, bot.id);
    await dbRun(db, "UPDATE conversations SET status = 'open', topic_state_update_id = CASE WHEN ? IS NULL THEN topic_state_update_id WHEN topic_state_update_id IS NULL OR topic_state_update_id < ? THEN ? ELSE topic_state_update_id END WHERE id = ?", updateFloor, updateFloor, updateFloor, conversation.id);
    return t(bot, "opened");
  }
  return null;
}

async function runCommand(bot, env, message, conversation, command) {
  const userStateCommands = new Set(["/ban", "/unban", "/trust", "/untrust", "/riskreset"]);
  if (!conversation || !userStateCommands.has(command)) return executeCommand(bot, env, message, conversation, command);
  const db = requireDb(env);
  const ownerToken = await claimAbuseDecisionLock(db, bot.id, conversation.user_id);
  try {
    return await executeCommand(bot, env, message, conversation, command);
  } finally {
    try { await releaseAbuseDecisionLock(db, bot.id, conversation.user_id, ownerToken); }
    catch (error) { log(bot, "error", "command_decision_lock_release_failed", { user_id: conversation.user_id, message: error.message }); }
  }
}

async function handleGroupMessage(bot, env, message, updateId = null) {
  if (String(message.chat?.id) !== String(supportGroupId(env)) || !message.from?.id) return;
  const threadId = message.message_thread_id; const db = requireDb(env);
  if (threadId && env.SERVICE_ACTIVE_GROUP_ID != null
    && Number(env.SERVICE_ACTIVE_GROUP_ID) !== supportGroupId(env)) {
    if (message.from.is_bot || !await isAdmin(bot, env, message.from.id)) return;
    const historical = await redirectHistoricalTopic(bot, env, threadId);
    if (historical) await sendTopic(bot, env, threadId, historicalTopicNotice(bot, historical));
    return;
  }
  const conversation = threadId ? await dbOne(db, "SELECT * FROM conversations WHERE support_group_id = ? AND thread_id = ?", supportGroupId(env), threadId) : null;
  if (!conversation && threadId && Number(threadId) !== 1) {
    const historical = await findTopicByGroup(db, supportGroupId(env), threadId);
    if (historical?.historical && isOwnedByBot(historical, bot.id) && !message.from.is_bot) {
      await sendTopic(bot, env, threadId, historicalTopicNotice(bot, historical));
    }
    return;
  }
  const addressedTo = String(message.text || "").split(/\s+/, 1)[0].split("@")[1];
  const generalSource = threadId == null || Number(threadId) === 1;
  const addressedSupportBot = addressedTo && generalSource && parseBotRegistry(env.BOT_REGISTRY).some(item => item.username?.toLowerCase() === addressedTo.toLowerCase());
  if (addressedTo && bot.username && addressedTo.toLowerCase() !== bot.username.toLowerCase() && !addressedSupportBot) return;
  if (conversation && addressedTo && bot.username && addressedTo.toLowerCase() !== bot.username.toLowerCase()) return;
  if (conversation && !isOwnedByBot(conversation, bot.id)) {
    if (addressedTo?.toLowerCase() === bot.username?.toLowerCase() && commandOf(message)
      && ["/menu", "/panel", "/help", "/info", "/audit", "/open"].includes(commandOf(message))) {
      return handleGroupMessage(resolveBot(env, conversation.bot_id), { ...env, MANAGEMENT_UI_BOT_ID: null },
        { ...message, text: message.text.replace(/^([/\w]+)@\w+/, "$1") }, null);
    }
    return;
  }
  const command = commandOf(message);
  if (conversation && managerConfigured(env) && command === '/close') {
    if (addressedTo?.toLowerCase() === bot.username?.toLowerCase()) await sendTopic(bot, env, threadId,
      `Закрытие темы перенесено в Админушку. Используйте /close@${String(env.MANAGER_BOT_USERNAME).replace(/^@/, '')} в этой теме.`);
    return;
  }
  env = { ...env, OPERATOR_UI_ACTOR: message.from.id };
  let generalClaim = null;
  let generalFailed = false;
  if (!conversation) {
    const isGeneral = threadId === undefined || threadId === null || Number(threadId) === 1;
    if (!isGeneral) return;
    if (managerConfigured(env)) {
      if (command && addressedTo?.toLowerCase() === bot.username?.toLowerCase()) {
        const link = await managerMenuLink(db, env);
        if (link) await sendTopic(bot, env, threadId,
          `Управление поддержкой перенесено в отдельный бот. Откройте актуальное меню: ${link}`);
      }
      return;
    }
    let pending = await pendingAction(db, message.from.id);
    const teamPending = command ? null : await dbOne(db, `SELECT 1 FROM support_operator_flows WHERE owner_id=?1 AND suspended=0
      UNION ALL SELECT 1 FROM bot_message_flows WHERE owner_id=?1 AND suspended=0
      UNION ALL SELECT 1 FROM operator_work_inputs WHERE operator_id=?1 AND suspended=0
      UNION ALL SELECT 1 FROM operator_input_guards WHERE operator_id=?1 AND active=1
      UNION ALL SELECT 1 FROM operator_input_prompts WHERE chat_id=?2 AND message_id=?3`,message.from.id,message.chat.id,message.reply_to_message?.message_id||0);
    if ((!command && !pending && !teamPending) || (command && !isGeneralCommand(command))) return;
    const controlPlane = db?.[CONTROL_PLANE_CONTEXT] || null;
    if (controlPlane?.generalOwnerToken) {
      generalClaim = { status: "delegated", ownerToken: controlPlane.generalOwnerToken };
    } else {
      let effectiveOwner = await effectiveGroupCommandOwner(db, parseBotRegistry(env.BOT_REGISTRY), env);
      if (!effectiveOwner) return;
      let preferredOwner = effectiveOwner.id === bot.id;
      if (!preferredOwner) {
        const graceMs = Math.min(asNonNegativeInteger(env.GENERAL_OWNER_GRACE_MS, DEFAULT_GENERAL_OWNER_GRACE_MS), MAX_GENERAL_OWNER_GRACE_MS);
        if (graceMs > 0) await sleep(graceMs);
        effectiveOwner = await effectiveGroupCommandOwner(db, parseBotRegistry(env.BOT_REGISTRY), env);
        if (!effectiveOwner) return;
        preferredOwner = effectiveOwner.id === bot.id;
      }
      generalClaim = await claimGeneralMessage(db, env, message.message_id, bot.id);
      if (generalClaim.status === "completed") return;
      if (generalClaim.status !== "acquired") {
        // A secondary bot that arrived during the preferred owner's grace period should
        // ACK quietly once that owner has claimed the shared General message.
        if (!preferredOwner) return;
        throw new Error("General control-plane message is being handled by another bot; retry this update");
      }
    }
    const managementUiBotId = controlPlane?.managementUiBotId || bot.id;
    if (pending && pending.management_bot_id !== managementUiBotId) {
      await dbRun(db, "UPDATE operator_pending_actions SET management_bot_id = ? WHERE operator_id = ? AND flow_nonce = ? AND expires_at > ?", managementUiBotId, message.from.id, pending.flow_nonce, nowIso());
      pending = await pendingAction(db, message.from.id);
    }
  }
  try {
  if (conversation && (message.forum_topic_closed || message.forum_topic_reopened)) {
    const status = message.forum_topic_closed ? "closed" : "open";
    const applied = await dbRun(db, "UPDATE conversations SET reply_epoch = reply_epoch + CASE WHEN ? = 'closed' AND status <> 'closed' THEN 1 ELSE 0 END, status = ?, topic_state_update_id = ? WHERE id = ? AND (? IS NULL OR topic_state_update_id IS NULL OR topic_state_update_id < ?)", status, status, updateId, conversation.id, updateId, updateId);
    if (!(applied.meta?.changes > 0)) return;
    if (await isAdmin(bot, env, message.from.id)) {
      await operatorAuditStatement(db, bot.id, conversation.user_id, message.from, status === "closed" ? "conversation_close" : "conversation_open").run();
    } else {
      log(bot, "warn", "native_topic_state_changed_outside_allowlist", { user_id: conversation.user_id, actor_id: message.from.id, status });
    }
    try { await refreshTopicPanel(bot, env, conversation); }
    catch (error) { log(bot, "error", "topic_panel_refresh_failed", { user_id: conversation.user_id, message: error.message }); }
    return;
  }
  if (!await isAdmin(bot, env, message.from.id)) {
    log(bot, "warn", command === "/operators" ? "operator_management_unauthorized" : "operator_unauthorized", { user_id: message.from.id, thread_id: threadId });
    await sendTopic(bot, env, threadId, t(bot, "unauthorized"));
    return;
  }
  const managerLink = !conversation && await managerMenuLink(db, env);
  if (managerLink) {
    await sendTopic(bot, env, threadId,
      `${({ru:'Управление поддержкой перенесено в отдельный бот. Откройте актуальное меню:',en:'Support management has moved to a separate bot. Open the current menu:',es:'La gestión del soporte se ha trasladado a otro bot. Abre el menú actual:',zh:'支持管理已迁移到单独的机器人。请打开当前菜单：'})[bot.locale] || 'Support management has moved to a separate bot. Open the current menu:'} ${managerLink}`);
    return;
  }
  const internalReply = command ? null : await repliedInternalPrompt(db, message);
  if (internalReply) {
    const active = await dbOne(db, `SELECT flow_nonce nonce, expires_at, suspended FROM operator_pending_actions WHERE operator_id=? AND ?='pa'
      UNION ALL SELECT nonce, expires_at, suspended FROM bot_message_flows WHERE owner_id=? AND ?='m'
      UNION ALL SELECT flow_nonce, expires_at, suspended FROM support_operator_flows WHERE owner_id=? AND ?='o'
      UNION ALL SELECT nonce, expires_at, suspended FROM operator_work_inputs WHERE operator_id=? AND ?='w'`, message.from.id, internalReply.kind, message.from.id, internalReply.kind, message.from.id, internalReply.kind, message.from.id, internalReply.kind);
    if (internalReply.operator_id !== message.from.id || !active || active.nonce !== internalReply.nonce || !isFuture(active.expires_at) || active.suspended) {
      await operatorScreen(bot, env, message, ({ru:'Это ответ на внутренний запрос. Он не отправлен клиенту. Продолжите черновик или откройте новое действие.',en:'This replies to an internal prompt and was not sent to the customer. Resume the draft or start a new action.',es:'Esta respuesta corresponde a una solicitud interna y no se envió al cliente. Continúa el borrador o inicia una nueva acción.',zh:'此消息回复的是内部提示，未发送给客户。请继续草稿或开始新的操作。'})[bot.locale] || 'This replies to an internal prompt and was not sent to the customer. Resume the draft or start a new action.', {inline_keyboard:[[{text:({ru:'Продолжить ввод',en:'Resume input',es:'Continuar entrada',zh:'继续输入'})[bot.locale]||'Resume input',callback_data:'um:w:resume'}]]});
      return;
    }
  }
  if (await handleWorkspaceText(bot, env, message, command)) return;
  if (await handleMessageSettingsText(bot, env, message, command)) return;
  if (await handlePendingTeamOperatorText(bot, env, message, command)) return;
  if (await handlePendingOperatorText(bot, env, message, command)) return;
  if (internalReply) return;
  if (command) {
    if(command!=='/cancel') await dbRun(db,"INSERT INTO operator_input_navigation(operator_id,keep_kind) VALUES(?,'') ON CONFLICT(operator_id) DO UPDATE SET keep_kind=''",message.from.id);
    if (await handleManagementCommand(bot, env, message, conversation, command)) return;
    const notice = await runCommand(bot, env, message, conversation, command);
    if (notice) await sendTopic((!conversation && (threadId === undefined || threadId === null || Number(threadId) === 1)) ? managementUiBot(bot, env) : bot, env, threadId, notice);
    return;
  }
  if (!conversation) return;
  if (!await isAdmin(bot, env, message.from.id)) {
    log(bot, "warn", "operator_access_revoked_before_reply", { user_id: message.from.id, thread_id: threadId });
    await sendTopic(bot, env, threadId, t(bot, "unauthorized"));
    return;
  }
  await touchStorageTopic(env, bot.id, conversation.thread_id, conversation.user_id);
  const album = message.media_group_id
    ? await queueMediaGroup(bot, env, message, conversation, "support_to_user")
    : false;
  if (album === "operator_access_revoked") return;
  if (!album) {
    const body = { chat_id: conversation.user_id, from_chat_id: supportGroupId(env), message_id: message.message_id };
    const replyParameters = await mappedReplyParameters(
      db,
      bot.id,
      conversation.user_id,
      conversation.thread_id,
      message.reply_to_message?.message_id,
      "support_to_user",
      conversation.support_group_id,
    );
    if (replyParameters) body.reply_parameters = replyParameters;
    const details = {
      direction: "support_to_user",
      sourceChatId: supportGroupId(env),
      sourceMessageId: Number(message.message_id),
      sourceCreatedAt: sourceCreatedAt(message),
      userId: Number(conversation.user_id),
      threadId: Number(conversation.thread_id),
      targetChatId: Number(conversation.user_id),
      method: "copyMessage",
    };
    let attempt;
    try {
      attempt = await withAuthorizedOperatorExecution(bot, env, message.from.id,
        (renewOperatorFence) => runMessageDeliveryAttempt(bot, env, details, async () => {
          await renewOperatorFence();
          return telegram(bot, "copyMessage", body, env);
        }));
    } catch (error) {
      if (error?.operatorRevoked) {
        log(bot, "warn", "operator_access_revoked_before_delivery", { user_id: message.from.id, thread_id: conversation.thread_id });
        return;
      }
      throw error;
    }
    const result = attempt.result;
    if (!result.ok) {
      if (result.accessRevoked) return;
      log(bot, "warn", "operator_delivery_failed", { user_id: conversation.user_id, thread_id: conversation.thread_id, description: result.description, delivery_uncertain: isDeliveryOutcomeUncertain(result) });
      if (isDeliveryOutcomeUncertain(result)) return;
      if (isRetryableTelegramFailure(result)) throw new Error(`operator-to-user delivery failed: ${result.description}`);
      await sendTopic(bot, env, conversation.thread_id, `${t(bot, "operatorDeliveryFailed")}: ${result.description}`);
      return;
    }
    await persistSingleDeliveryBookkeeping(bot, db, details, attempt.startedAt, result.result?.message_id, {
      botId: bot.id,
      userId: conversation.user_id,
      threadId: conversation.thread_id,
      userMessageId: result.result?.message_id,
      supportMessageId: message.message_id,
    });
  }
  log(bot, "info", "operator_reply_delivered", { user_id: conversation.user_id, thread_id: conversation.thread_id, album: Boolean(album) });
  } catch (error) {
    generalFailed = true;
    throw error;
  } finally {
    if (generalClaim?.status === "acquired") {
      try {
        if (generalFailed) await releaseGeneralMessageClaim(db, env, message.message_id, generalClaim.ownerToken);
        else await completeGeneralMessageClaim(db, env, message.message_id, generalClaim.ownerToken);
      } catch (claimError) {
        log(bot, "error", "general_control_claim_finalize_failed", { message_id: message.message_id, message: claimError.message });
        if (!generalFailed) throw claimError;
      }
    }
  }
}

async function dispatchUpdate(bot, env, update) {
  if(update.message && await deliveryChecks(env).message(bot.id,update.message))return;
  if(String(update.callback_query?.data||'').startsWith('qc:'))return deliveryChecks(env).callback(bot.id,update.callback_query);
  const probeStart = update.message?.chat?.type === 'private' && /^\/start(?:@\w+)?\s+rx_([a-f0-9]{32})$/.exec(String(update.message.text || '').trim());
  if (probeStart) return reactionChecks(env).open(bot.id, update.message, probeStart[1]);
  if (String(update.callback_query?.data || '').startsWith('rx:')) return reactionChecks(env).callback(bot.id, update.callback_query);
  if (update.message_reaction) {
    try { return await handleReactionUpdate(bot, env, update); }
    catch (error) {
      log(bot, "error", "reaction_processing_failed", { message: error.message });
      if (error?.retryableReaction) throw error;
      return;
    }
  }
  if (update.callback_query) {
    return handleCallbackQuery(bot, env, update.callback_query);
  }
  const message = update.message; if (!message) return;
  if (message.chat?.type === "private") return handlePrivateMessage(bot, env, message, update.update_id);
  return handleGroupMessage(bot, env, message, update.update_id);
}

export default {
  async fetch(request, env, ctx) {
    if (ctx?.exports?.DeliveryRecovery) env = { ...env, MANUAL_DELIVERY_SERVICE: ctx.exports.DeliveryRecovery };
    if (ctx?.exports?.VerificationStatus) env = { ...env, VERIFICATION_STATUS_SERVICE: ctx.exports.VerificationStatus };
    const url = new URL(request.url);
    const verifyParts = url.pathname.split("/").filter(Boolean);
    if (verifyParts.length === 2 && verifyParts[0] === "verify") {
      try { return await handleVerification(request, env, verifyParts[1]); }
      catch (error) { log(null, "error", "verification_failed", { message: error.message }); return reply(503, "Verification is temporarily unavailable"); }
    }
    if (request.method !== "POST") return reply(404, "Not found");
    const id = getWebhookBotId(url); if (!id) return reply(404, "Not found");
    let config;
    try { config = resolveBot(env, id, false); } catch (error) { log({ id }, "error", "configuration_error", { message: error.message }); return reply(500, "Configuration error"); }
    if (!config) return reply(404, "Not found");
    if (!config.enabled) return reply(200, "OK");
    env = { ...env, HEALTH_BOT_ID: config.id };
    let bot;
    try { bot = resolveBot(env, id); } catch (error) { log(config, "error", "configuration_error", { message: error.message }); return reply(500, "Configuration error"); }
    if (!timingSafeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", bot.webhookSecret)) { log(bot, "warn", "webhook_rejected"); return reply(403, "Forbidden"); }
    if (!(request.headers.get("content-type") || "").toLowerCase().includes("application/json")) return reply(415, "Expected application/json");
    let update; try { update = await request.json(); } catch { return reply(400, "Invalid JSON"); }
    if (!update || typeof update !== "object" || !Number.isSafeInteger(update.update_id)) return reply(400, "Invalid Telegram update");
    if (isIgnoredTelegramServiceMessage(update.message)) return reply(200, "OK");
    if (ignoreReactionBeforeDatabase(bot, null, update)) return reply(200, "OK");
    if (!await allowReactionIngress(bot, env, update)) return reply(200, "OK");
    let db; try { env = await webhookEnvironment(env); db = requireDb(env); } catch (error) { log(bot, "error", "configuration_error", { message: error.message }); return reply(500, "Configuration error"); }
    if (db.storageMode === 'reset') {
      if (managerConfigured(env) && storageCandidate(update)) {
        if (update.callback_query) await telegram(bot, 'answerCallbackQuery', { callback_query_id: update.callback_query.id,
          text: ({ru:'Хранилище открывается в личке Админушки.',en:'Open storage in the Adminushka private chat.',es:'Abre el almacenamiento en el chat privado de Adminushka.',zh:'请在 Adminushka 私聊中打开存储管理。'})[bot.locale] || 'Open storage in the Adminushka private chat.', show_alert: true }, env);
        return reply(200, 'OK');
      }
      try { if (!managerConfigured(env) && await handleStorageUpdate(bot, env, update, (method, body) => telegram(bot, method, body, env))) return reply(200, 'OK'); }
      catch (error) { log(bot, 'error', 'storage_control_failed', { message: error.message }); }
      return reply(503, 'Storage maintenance; retry later');
    }
    if (managerConfigured(env) && storageCandidate(update)) {
      if (update.callback_query) await telegram(bot, 'answerCallbackQuery', { callback_query_id: update.callback_query.id,
        text: ({ru:'Хранилище открывается в личке Админушки.',en:'Open storage in the Adminushka private chat.',es:'Abre el almacenamiento en el chat privado de Adminushka.',zh:'请在 Adminushka 私聊中打开存储管理。'})[bot.locale] || 'Open storage in the Adminushka private chat.', show_alert: true }, env);
      return reply(200, 'OK');
    }
    let persisted;
    try { persisted = await ensureBotMetadata(db, bot); }
    catch (error) {
      log(bot, "error", "bot_state_lookup_failed", { message: error.message });
      await recordOperationalSignal(env, bot.id, "database_failed");
      return reply(500, "Database error");
    }
    if (persisted && Number(persisted.enabled) === 0) return reply(200, "OK");
    try {
      const activeGroupId = Number(persisted?.group_id ?? supportGroupId(env));
      const chat = update.message?.chat || update.callback_query?.message?.chat || update.message_reaction?.chat;
      if (chat?.type === 'private') {
        if (activeGroupId == null) return reply(503, 'Support group is not configured');
        env = { ...env, SUPPORT_GROUP_ID: String(activeGroupId), SERVICE_ACTIVE_GROUP_ID: activeGroupId };
      } else if (chat?.id != null) {
        const eventGroupId = Number(chat.id);
        if (eventGroupId !== activeGroupId) {
          const threadId = update.message?.message_thread_id || update.callback_query?.message?.message_thread_id;
          const historical = threadId ? await findTopicByGroup(db, eventGroupId, threadId) : null;
          const historicalReaction = update.message_reaction
            ? await dbOne(db, `SELECT 1 FROM message_mappings WHERE bot_id=? AND support_group_id=?
                AND support_message_id=? LIMIT 1`, bot.id, eventGroupId, update.message_reaction.message_id)
            : null;
          if ((!historical || !isOwnedByBot(historical, bot.id)) && !historicalReaction)
            return reply(200, 'OK');
        }
        env = { ...env, SUPPORT_GROUP_ID: String(eventGroupId), SERVICE_ACTIVE_GROUP_ID: activeGroupId };
      }
    } catch (error) {
      log(bot, 'error', 'support_group_route_failed', { message: error.message });
      return reply(503, 'Support group routing temporarily unavailable');
    }
    if (ignoreReactionBeforeDatabase(bot, env, update)) return reply(200, "OK");
    try {
      if (!managerConfigured(env) && await handleStorageUpdate(bot, env, update, (method, body) => telegram(bot, method, body, env))) return reply(200, 'OK');
    } catch (error) {
      log(bot, 'error', 'storage_control_failed', { message: error.message });
      return reply(503, 'Storage control temporarily unavailable');
    }
    const updateId = update.update_id;
    let claim;
    let dispatched = false;
    try {
      claim = await claimUpdate(db, bot.id, updateId);
      if (claim.status === "completed") return reply(200, "OK");
      if (claim.status === "busy") return reply(503, "Update busy");
      assertTelegramReady(db, bot);
      await dispatchUpdate(bot, env, update);
      dispatched = true;
      let dispatchMarked = false;
      for (let attempt = 0; attempt < 3 && !dispatchMarked; attempt++) {
        try { await markDispatchSucceeded(db, bot.id, updateId, claim.ownerToken); dispatchMarked = true; }
        catch (markerError) {
          log(bot, "error", "update_dispatch_marker_failed", { update_id: updateId, attempt: attempt + 1, message: markerError.message });
          if (attempt < 2) await sleep(25 * (attempt + 1));
        }
      }
      let completionMarked = false;
      try {
        await completeUpdate(db, bot.id, updateId, claim.ownerToken);
        completionMarked = true;
      } catch (error) {
        log(bot, "error", "update_completion_marker_failed_after_dispatch", { update_id: updateId, message: error.message });
        try { await completeUpdate(db, bot.id, updateId, claim.ownerToken); completionMarked = true; }
        catch (retryError) { log(bot, "error", "update_completion_marker_retry_failed", { update_id: updateId, message: retryError.message }); }
      }
      if (!dispatchMarked && !completionMarked) {
        throw new Error("No durable post-dispatch marker could be saved; retry this update without replaying fenced external effects");
      }
      if (update.message?.chat?.type === "private" && !/^\/start(?:@\w+)?(?:\s|$)/i.test(update.message.text || "")) {
        await tryAutoReply(bot, env, update.message.from?.id);
      }
      return reply(200, "OK");
    } catch (error) {
      if (error?.terminalDispatch && claim?.status === "acquired") {
        try { await markDispatchSucceeded(db, bot.id, updateId, claim.ownerToken); } catch {}
        try { await completeUpdate(db, bot.id, updateId, claim.ownerToken); } catch {}
        log(bot, "error", "update_quarantined_after_uncertain_external_effect", { update_id: updateId, message: error.message });
        return reply(200, "OK");
      }
      if (!dispatched && claim?.status === "acquired") {
        try {
          await releaseUpdate(db, bot.id, updateId, claim.ownerToken);
        } catch (releaseError) {
          log(bot, "error", "update_release_failed", { update_id: updateId, message: releaseError.message });
        }
      }
      if (error instanceof TelegramCooldownError) return reply(503, "Telegram sending paused; retry later");
      if (error instanceof RecoveryBudgetExhausted) {
        log(bot, "info", "update_deferred_by_budget", { update_id: updateId, queries: db.used, limit: db.limit, plan: db.plan });
        return reply(503, "Update deferred; retry with a fresh invocation budget");
      }
      log(bot, "error", "update_failed", { update_id: updateId, message: error.message });
      await recordOperationalSignal(env, bot.id, "update_failed");
      return reply(500, "Retry later");
    }
  },

  async scheduled(_event, env, ctx) {
    const cleanup = async () => {
      // The cursor is advanced atomically before work, so a failing queue cannot
      // starve another bot or maintenance. All nested helpers share this binding.
      const budget = await resolveInvocationDatabase(requireDb(env), env, "recovery");
      env = { ...env, SUPPORT_DB: budget };
      const db = budget;
      if (db.storageMode === 'reset') {
        while (budget.used < 27) {
          const result = await runFullReset(env);
          if (!result || result.completed || result.cancelled) break;
        }
        return;
      }
      // Services disabled since a claim was taken are absent from the per-bot queues.
      if (env.MANAGER_BOT_TOKEN) await markExpiredClaimsUncertain(db);
      const configs = parseBotRegistry(env.BOT_REGISTRY).filter((config) => config.enabled);
      if (managerConfigured(env)) try { await syncManagerNavigation(env); }
      catch (error) {
        if (!(error instanceof RecoveryBudgetExhausted) && !(error instanceof TelegramCooldownError))
          log(null, 'error', 'manager_command_sync_failed', { message: error.message });
      }
      if (managerConfigured(env)) {
        for (const config of configs) {
          if (budget.used >= budget.startLimit) break;
          try {
            const stale = await dbOne(db, `SELECT 1 FROM bot_command_scopes
              WHERE bot_id=? AND revision<>'[]' LIMIT 1`, config.id);
            if (!stale) continue;
            if (!await persistedBotEnabled(db, config.id)) continue;
            const route = await dbOne(db, 'SELECT group_id FROM service_group_routes WHERE bot_id=?', config.id);
            const scopedEnv = route ? { ...env, SUPPORT_GROUP_ID: String(route.group_id) } : env;
            await syncSupportNavigation(resolveBot(scopedEnv, config.id), scopedEnv);
          } catch (error) {
            if (error instanceof RecoveryBudgetExhausted) break;
            if (!(error instanceof TelegramCooldownError)) log(config, 'error', 'manager_command_sync_failed', { message: error.message });
          }
        }
      }
      const queues = [
        async (config, bot) => { await sendPendingAutoReply(bot, env); },
        async (config, bot) => { await sendBotSetupReminder(bot, env); },
        async (config, bot) => { await syncSupportNavigation(bot, env); },
        async (config, bot) => {
          const recoverable = await dbAll(db, "SELECT bot_id, direction, media_group_id, source_chat_id FROM media_groups WHERE bot_id = ? AND operator_identity_unknown_at IS NULL AND last_received_at < ? AND (delivery_started_at IS NULL OR delivery_completed_at IS NOT NULL OR COALESCE(claimed_at, 0) <= ?) ORDER BY last_received_at LIMIT 1", config.id, Date.now() - asPositiveInteger(env.ALBUM_SETTLE_MS, DEFAULT_ALBUM_SETTLE_MS), Date.now() - LOCK_STALE_MS);
          for (const group of recoverable.results || []) try { await flushMediaGroup(bot, env, [group.bot_id, group.direction, group.media_group_id, Number(group.source_chat_id)], 0); } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error; log(config, "error", "album_recovery_failed", { media_group_id: group.media_group_id, message: error.message }); }
        },
        async (config, bot) => {
          const pendingMappings = await dbAll(db, "SELECT * FROM pending_messages WHERE bot_id = ? AND delivery_completed_at IS NOT NULL AND target_message_id IS NOT NULL AND mapping_synced_at IS NULL ORDER BY delivery_completed_at LIMIT 50", config.id);
          for (const row of pendingMappings.results || []) {
            try {
              if (!Number.isSafeInteger(Number(row.target_thread_id))) throw new Error("Pending mapping repair has no durable target Topic id");
              const mappingSaved = await recordMapping(bot, db, { botId: row.bot_id, userId: Number(row.user_id), threadId: Number(row.target_thread_id), groupId: row.target_chat_id, userMessageId: Number(row.source_message_id), supportMessageId: Number(row.target_message_id) });
              if (mappingSaved) await dbRun(db, "UPDATE pending_messages SET mapping_synced_at = COALESCE(mapping_synced_at, ?) WHERE id = ?", nowIso(), row.id);
            } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error; log(config, "error", "pending_mapping_repair_failed", { pending_id: row.id, message: error.message }); }
          }
        },
        async (config, bot) => {
          const deliveryMappings = await dbAll(db, "SELECT * FROM message_delivery_attempts WHERE bot_id = ? AND completed_at IS NOT NULL AND target_message_id IS NOT NULL AND mapping_synced_at IS NULL ORDER BY completed_at LIMIT 50", config.id);
          for (const row of deliveryMappings.results || []) {
            try {
              const mappingSaved = await recordMapping(bot, db, {
                botId: row.bot_id, userId: Number(row.user_id), threadId: Number(row.thread_id),
                groupId: row.direction === 'user_to_support' ? row.target_chat_id : row.source_chat_id,
                userMessageId: row.direction === "user_to_support" ? Number(row.source_message_id) : Number(row.target_message_id),
                supportMessageId: row.direction === "user_to_support" ? Number(row.target_message_id) : Number(row.source_message_id),
              });
              if (mappingSaved) await dbRun(db, "UPDATE message_delivery_attempts SET mapping_synced_at = COALESCE(mapping_synced_at, ?) WHERE bot_id = ? AND direction = ? AND source_chat_id = ? AND source_message_id = ?", nowIso(), row.bot_id, row.direction, row.source_chat_id, row.source_message_id);
            } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error; log(config, "error", "delivery_mapping_repair_failed", { direction: row.direction, source_message_id: row.source_message_id, message: error.message }); }
          }
        },
        async (config, bot) => {
          const uncertainDeliveries = await dbAll(db, `SELECT * FROM message_delivery_attempts WHERE bot_id = ? AND alerted_at IS NULL
            AND (failure_code = 'telegram_delivery_outcome_unknown' OR (completed_at IS NULL AND request_started_at <= ?))
            ORDER BY started_at LIMIT 50`, config.id, new Date(Date.now() - UPDATE_LEASE_MS).toISOString());
          for (const row of uncertainDeliveries.results || []) {
            if (!row.failure_code) await markMessageDeliveryUncertain(db, bot, {
              direction: row.direction, sourceChatId: row.source_chat_id, sourceMessageId: row.source_message_id,
            }, row.started_at, "Interrupted message delivery has no confirmed result");
            const alert = await telegram(bot, "sendMessage", { chat_id: supportGroupId(env), text: `⚠️ Delivery outcome unknown; automatic replay suppressed. service=${bot.displayName}; direction=${row.direction}; user=${row.user_id}; source_message=${row.source_message_id}` }, env);
            if (alert.ok) await dbRun(db, "UPDATE message_delivery_attempts SET alerted_at = ? WHERE bot_id = ? AND direction = ? AND source_chat_id = ? AND source_message_id = ? AND alerted_at IS NULL", nowIso(), row.bot_id, row.direction, row.source_chat_id, row.source_message_id);
          }
        },
        async (config, bot) => {
          const uncertainTopics = await dbAll(db, `SELECT * FROM conversation_provision_attempts WHERE bot_id = ? AND alerted_at IS NULL
            AND (failure_code = 'telegram_topic_create_outcome_unknown' OR (completed_at IS NULL AND request_started_at <= ?))
            ORDER BY started_at LIMIT 50`, config.id, new Date(Date.now() - UPDATE_LEASE_MS).toISOString());
          for (const row of uncertainTopics.results || []) {
            if (!row.failure_code) await markConversationProvisionUncertain(db, bot, { id: row.user_id }, "Interrupted Topic creation has no confirmed result");
            const alert = await telegram(bot, "sendMessage", { chat_id: supportGroupId(env), text: `⚠️ Topic creation outcome unknown; automatic recreate suppressed. service=${bot.displayName}; user=${row.user_id}` }, env);
            if (alert.ok) await dbRun(db, "UPDATE conversation_provision_attempts SET alerted_at = ? WHERE bot_id = ? AND user_id = ? AND alerted_at IS NULL", nowIso(), row.bot_id, row.user_id);
          }
        },
        async (config, bot) => {
          const uncertainPending = await dbAll(db, "SELECT * FROM pending_messages WHERE bot_id = ? AND failure_code = 'telegram_delivery_outcome_unknown' AND failed_at IS NOT NULL AND failure_alerted_at IS NULL ORDER BY failed_at LIMIT 50", config.id);
          for (const row of uncertainPending.results || []) {
            const alert = await telegram(bot, "sendMessage", { chat_id: supportGroupId(env), text: `⚠️ Pending delivery outcome unknown; automatic replay suppressed. service=${bot.displayName}; user=${row.user_id}; source_message=${row.source_message_id}` }, env);
            if (alert.ok) await dbRun(db, "UPDATE pending_messages SET failure_alerted_at = ? WHERE id = ? AND failure_alerted_at IS NULL", nowIso(), row.id);
          }
        },
        async (config, bot) => {
          const uncertainAlbums = await dbAll(db, `SELECT DISTINCT g.* FROM media_groups g
            JOIN media_group_items i ON i.bot_id = g.bot_id AND i.direction = g.direction AND i.media_group_id = g.media_group_id AND i.source_chat_id = g.source_chat_id
           WHERE g.bot_id = ? AND i.delivery_uncertain_at IS NOT NULL AND g.delivery_alerted_at IS NULL
           ORDER BY g.last_received_at LIMIT 50`, config.id);
          for (const row of uncertainAlbums.results || []) {
            const alert = await telegram(bot, "sendMessage", { chat_id: supportGroupId(env), text: `⚠️ Album delivery outcome unknown for one attempted generation; later parts remain recoverable. service=${bot.displayName}; direction=${row.direction}; user=${row.user_id}; media_group=${row.media_group_id}` }, env);
            if (alert.ok) await dbRun(db, "UPDATE media_groups SET delivery_alerted_at = ?, delivery_uncertain_at = COALESCE(delivery_uncertain_at, ?) WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", nowIso(), nowIso(), row.bot_id, row.direction, row.media_group_id, row.source_chat_id);
          }
        },
        async (config, bot) => {
          const effects = await dbAll(db, `SELECT challenge.id, challenge.bot_id, challenge.user_id, attempt.response_hash FROM verification_attempts attempt JOIN verification_challenges challenge ON challenge.id = attempt.challenge_id WHERE challenge.bot_id = ? AND attempt.status = 'failed' AND attempt.effects_applied = 0 ORDER BY attempt.created_at LIMIT 50`, config.id);
          for (const a of effects.results || []) try { await applyFailedVerificationEffects(db, config, a, a.response_hash); } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error; log(config, "error", "verification_attempt_recovery_failed", { challenge_id: a.id, message: error.message }); }
        },
        async (config, bot) => {
          const passed = await dbAll(db, "SELECT * FROM verification_challenges WHERE bot_id = ? AND status = 'passed' AND flushed_at IS NULL ORDER BY verified_at LIMIT 1", config.id);
          for (const ch of passed.results || []) try { await finishPassedChallenge(env, ch); } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error; log(config, "error", "passed_challenge_recovery_failed", { challenge_id: ch.id, message: error.message }); }
        },
        async (config, bot) => {
          // Notice repair is independent of queue completion: it must also run
          // after flushed_at was persisted or when delivery remains busy.
          const notices = await dbAll(db, `SELECT id FROM verification_challenges WHERE bot_id=? AND status='passed'
            AND notice_message_id IS NOT NULL AND notice_resolved_at IS NULL AND notice_resolution_started_at IS NULL
            AND (notice_retry_at IS NULL OR notice_retry_at<=?) ORDER BY COALESCE(notice_retry_at,verified_at) LIMIT 1`, config.id, nowIso());
          for (const notice of notices.results || []) await syncVerificationNotice(env, notice.id);
        },
        async (config, bot) => {
          const reopenEffects = await dbAll(db, `SELECT e.*, c.id AS conversation_id, c.thread_id, c.status, c.username, c.first_name, c.last_name, c.support_group_id, c.panel_message_id, c.topic_state_update_id
            FROM conversation_reopen_effects e
            LEFT JOIN conversations c ON c.bot_id = e.bot_id AND c.user_id = e.user_id
           WHERE e.bot_id = ? AND e.completed_at IS NULL
           ORDER BY e.created_at LIMIT 1`, config.id);
          for (const effect of reopenEffects.results || []) {
            try { await recoverReopenQueueEntry(bot, env, effect); }
            catch (error) {
              if (error instanceof RecoveryBudgetExhausted) throw error;
              log(config, "error", "conversation_reopen_effect_recovery_failed", { user_id: effect.user_id, message: error.message });
            }
          }
        },
        async (config, bot) => {
          const reopenBusinessAlerts = await dbAll(db, `SELECT b.*, c.thread_id
            FROM reopen_business_messages b
            LEFT JOIN conversations c ON c.bot_id = b.bot_id AND c.user_id = b.user_id
           WHERE b.bot_id = ? AND b.delivered_at IS NULL AND b.failure_alerted_at IS NULL
             AND (b.failure_code IS NOT NULL OR c.id IS NULL)
           ORDER BY b.created_at LIMIT 50`, config.id);
          for (const row of reopenBusinessAlerts.results || []) {
            const reason = row.failure_code || "conversation Topic reconciliation is required";
            const alert = await telegram(bot, "sendMessage", { chat_id: supportGroupId(env), text: `⚠️ Reopen message is preserved but requires attention. service=${bot.displayName}; user=${row.user_id}; source_message=${row.source_message_id}; reason=${reason}` }, env);
            if (alert.ok) await dbRun(db, "UPDATE reopen_business_messages SET failure_alerted_at = COALESCE(failure_alerted_at, ?) WHERE id = ?", nowIso(), row.id);
          }
        },
        async (config, bot) => {
          const legacyOperatorAlbums = await dbAll(db, "SELECT * FROM media_groups WHERE bot_id = ? AND direction = 'support_to_user' AND operator_identity_unknown_at IS NOT NULL AND operator_identity_alerted_at IS NULL ORDER BY last_received_at LIMIT 50", config.id);
          for (const row of legacyOperatorAlbums.results || []) {
            const alert = await telegram(bot, "sendMessage", { chat_id: supportGroupId(env), text: `⚠️ Legacy operator album quarantined after upgrade. service=${bot.displayName}; user=${row.user_id}; media_group=${row.media_group_id}; automatic send suppressed because the original operator identity is unknown.` }, env);
            if (alert.ok) await dbRun(db, "UPDATE media_groups SET operator_identity_alerted_at = COALESCE(operator_identity_alerted_at, ?) WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ?", nowIso(), row.bot_id, row.direction, row.media_group_id, row.source_chat_id);
          }
        },
        async (config, bot) => {
          const releases = await dbAll(db, "SELECT user_id FROM user_abuse_state WHERE bot_id = ? AND pending_release_required = 1 AND verification_required = 0 AND (muted_until IS NULL OR muted_until <= ?) AND (manual_restricted_until IS NULL OR manual_restricted_until <= ?) LIMIT 1", config.id, nowIso(), nowIso());
          for (const row of releases.results || []) try { await flushReleasedPendingMessages(bot, env, row.user_id); } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error; log(config, "error", "pending_release_recovery_failed", { user_id: row.user_id, message: error.message }); }
          const rows = await dbAll(db, `SELECT p.id, p.user_id, p.source_message_id, p.failure_alerted_at,
              COALESCE(a.verification_required, 0) AS verification_required,
              a.muted_until, a.manual_restricted_until
            FROM pending_messages p LEFT JOIN user_abuse_state a ON a.bot_id = p.bot_id AND a.user_id = p.user_id
            WHERE p.bot_id = ? AND p.failure_code = 'support_group_unavailable'
              AND p.delivered_at IS NULL AND p.failed_at IS NULL
            ORDER BY p.id LIMIT 1`, config.id);
          for (const row of rows.results || []) {
            if (!row.failure_alerted_at) try { await alertUnavailableInbound(bot, env, row); }
              catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error; log(config, "error", "group_unavailable_alert_failed", { user_id: row.user_id, message: error.message }); }
            if (Number(row.verification_required) || isFuture(row.muted_until) || isFuture(row.manual_restricted_until)) continue;
            try {
              await dbRun(db, "UPDATE user_abuse_state SET pending_release_required = 1, updated_at = ? WHERE bot_id = ? AND user_id = ? AND verification_required = 0 AND pending_release_required = 0", nowIso(), bot.id, row.user_id);
              await deliverPendingMessages(bot, env, row.user_id);
            }
            catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error; log(config, "error", "group_unavailable_delivery_deferred", { user_id: row.user_id, message: error.message }); }
          }
        },
        async (config, bot) => {
          const bans = await dbAll(db, "SELECT bot_id, user_id, banned_at FROM banned_users WHERE bot_id = ? AND notified_at IS NULL ORDER BY banned_at LIMIT 50", config.id);
          for (const n of bans.results || []) try { await notifyBannedUser(bot, env, n.user_id, n.banned_at); } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error; log(config, "error", "manual_ban_notice_recovery_failed", { user_id: n.user_id, message: error.message }); }
        },
        async (config, bot) => {
          const restrictions = await dbAll(db, "SELECT bot_id, user_id, manual_restricted_until FROM user_abuse_state WHERE bot_id = ? AND manual_restricted_until > ? AND manual_restriction_notice_at IS NULL ORDER BY updated_at LIMIT 50", config.id, nowIso());
          for (const n of restrictions.results || []) try { await notifyRestrictedUser(bot, env, n.user_id, n.manual_restricted_until); } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error; log(config, "error", "manual_restriction_notice_recovery_failed", { user_id: n.user_id, message: error.message }); }
        },
        async (config, bot) => {
          try { await attackState(db, bot, env); } catch (error) { if (error instanceof RecoveryBudgetExhausted) throw error; log(config, "error", "attack_mode_recheck_failed", { message: error.message }); }
        },
        async (config, bot) => {
          if (!env.MANAGER_BOT_TOKEN) return;
          await syncNextSentNoticeLink(db,{botId:bot.id,edit:row=>requestTelegram({
            token:env.MANAGER_BOT_TOKEN,method:'editMessageReplyMarkup',
            body:{chat_id:Number(row.recipient_id),message_id:Number(row.telegram_message_id),
              reply_markup:{inline_keyboard:[[{text:({ru:'Открыть тему',en:'Open topic',es:'Abrir tema',zh:'打开话题'})[supportedLanguage(row.recipient_locale)?row.recipient_locale:DEFAULT_LANGUAGE],url:topicLink(row.group_id,row.thread_id)}]]}},
            timeoutMs:10000,
          })});
          await stageDueNotices(db,{adminId:primaryOperatorId(env),botId:bot.id,limit:2});
          await sendNextServiceNotice(bot,env);
        },
      ];
      if (env.TELEGRAM_COOLDOWN_ENABLED === 'true') queues.push(async (config, bot) => {
        const rows = await dbAll(db, 'SELECT chat_id, message_id FROM telegram_cleanup_jobs WHERE bot_id = ? AND completed_at IS NULL ORDER BY created_at LIMIT 1', config.id);
        for (const row of rows.results || []) await telegram(bot, 'deleteMessage', { chat_id: row.chat_id, message_id: row.message_id }, env);
      });
      const statements = [
        db.prepare("DELETE FROM statistics_facts WHERE rowid IN (SELECT rowid FROM statistics_facts WHERE occurred_at < ? OR (SELECT facts_count>=capacity-100 FROM statistics_control WHERE id=1) ORDER BY occurred_at LIMIT 100)").bind(new Date(Date.now()-400*86400000).toISOString()),
        maintenanceStatement(db,'DELETE FROM statistics_report_cache WHERE expires_at < ?').bind(new Date(Date.now()-7*86400000).toISOString()),
        maintenanceStatement(db, "DELETE FROM bot_welcome_attempts WHERE created_at < ?").bind(new Date(Date.now() - 7 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM bot_message_flows WHERE expires_at < ?").bind(nowIso()),
        maintenanceStatement(db, "DELETE FROM processed_updates WHERE processed_at < ?").bind(new Date(Date.now() - 7 * 86_400_000).toISOString()),
        maintenanceStatement(db, `DELETE FROM manager_message_sends WHERE rowid IN
          (SELECT rowid FROM manager_message_sends WHERE claimed_at < ? ORDER BY claimed_at LIMIT 100)`)
          .bind(new Date(Date.now() - 7 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM manager_home_screens WHERE requested_at < ? AND (claim_token IS NULL OR lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
          .bind(new Date(Date.now() - 7 * 86_400_000).toISOString()),
        terminalNoticePruneStatement(db),
        maintenanceStatement(db, "DELETE FROM message_delivery_attempts WHERE completed_at IS NOT NULL AND mapping_synced_at IS NOT NULL AND completed_at < ?").bind(new Date(Date.now() - 7 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM message_delivery_attempts WHERE failure_code IS NOT NULL AND alerted_at IS NOT NULL AND started_at < ?").bind(new Date(Date.now() - 30 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM conversation_provision_attempts WHERE completed_at IS NOT NULL AND completed_at < ?").bind(new Date(Date.now() - 7 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM conversation_reopen_effects WHERE completed_at IS NOT NULL AND completed_at < ?").bind(new Date(Date.now() - 30 * 86_400_000).toISOString()),
        maintenanceStatement(db, `DELETE FROM media_group_items WHERE received_at < ? AND delivery_uncertain_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM media_groups g WHERE g.bot_id = media_group_items.bot_id AND g.direction = media_group_items.direction AND g.media_group_id = media_group_items.media_group_id AND g.source_chat_id = media_group_items.source_chat_id AND (g.operator_identity_unknown_at IS NOT NULL OR (g.delivery_started_at IS NOT NULL AND g.delivery_completed_at IS NULL))
        )`).bind(Date.now() - 86_400_000),
        maintenanceStatement(db, `DELETE FROM media_group_items WHERE delivery_uncertain_at IS NOT NULL AND received_at < ? AND EXISTS (
          SELECT 1 FROM media_groups g WHERE g.bot_id = media_group_items.bot_id AND g.direction = media_group_items.direction AND g.media_group_id = media_group_items.media_group_id AND g.source_chat_id = media_group_items.source_chat_id AND g.delivery_alerted_at IS NOT NULL
        )`).bind(Date.now() - 30 * 86_400_000),
        maintenanceStatement(db, "DELETE FROM media_groups WHERE operator_identity_unknown_at IS NULL AND (((delivery_started_at IS NULL OR delivery_completed_at IS NOT NULL) AND last_received_at < ?) OR (delivery_started_at IS NOT NULL AND delivery_completed_at IS NULL AND delivery_alerted_at IS NOT NULL AND last_received_at < ?))").bind(Date.now() - 86_400_000, Date.now() - 30 * 86_400_000),
        maintenanceStatement(db, "DELETE FROM media_group_items WHERE EXISTS (SELECT 1 FROM media_groups g WHERE g.bot_id = media_group_items.bot_id AND g.direction = media_group_items.direction AND g.media_group_id = media_group_items.media_group_id AND g.source_chat_id = media_group_items.source_chat_id AND g.operator_identity_unknown_at IS NOT NULL AND g.operator_identity_alerted_at IS NOT NULL AND g.last_received_at < ?)").bind(Date.now() - 30 * 86_400_000),
        maintenanceStatement(db, "DELETE FROM media_groups WHERE operator_identity_unknown_at IS NOT NULL AND operator_identity_alerted_at IS NOT NULL AND last_received_at < ?").bind(Date.now() - 30 * 86_400_000),
        maintenanceStatement(db, "DELETE FROM conversation_locks WHERE lease_expires_at < ?").bind(nowIso()),
        maintenanceStatement(db, "UPDATE verification_challenges SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").bind(nowIso()),
        maintenanceStatement(db, "DELETE FROM pending_messages WHERE created_at < ? AND NOT (failure_code = 'support_group_unavailable' AND delivered_at IS NULL AND failed_at IS NULL)").bind(new Date(Date.now() - 7 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM verification_challenges WHERE created_at < ?").bind(new Date(Date.now() - 7 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM abuse_events WHERE created_at < ?").bind(new Date(Date.now() - 90 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM logical_message_guards WHERE created_at < ?").bind(new Date(Date.now() - 24 * 60 * 60_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM pending_flush_locks WHERE lease_expires_at < ?").bind(nowIso()),
        maintenanceStatement(db, "DELETE FROM abuse_decision_locks WHERE lease_expires_at < ?").bind(nowIso()),
        maintenanceStatement(db, "DELETE FROM reaction_sync_locks WHERE lease_expires_at <= ?").bind(nowIso()),
        maintenanceStatement(db, "DELETE FROM reaction_settings_lock WHERE lease_expires_at <= ?").bind(nowIso()),
        maintenanceStatement(db, "DELETE FROM operator_pending_actions WHERE expires_at <= ?").bind(isoAfter(-30*86400000)),
        maintenanceStatement(db, "DELETE FROM support_operator_flows WHERE expires_at <= ?").bind(isoAfter(-30*86400000)),
        maintenanceStatement(db, "DELETE FROM operator_audit WHERE created_at < ?").bind(new Date(Date.now() - 180 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM support_operator_audit WHERE created_at < ?").bind(new Date(Date.now() - 180 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM operator_completed_flows WHERE completed_at < ?").bind(new Date(Date.now() - 30 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM support_operator_completed_flows WHERE completed_at < ?").bind(new Date(Date.now() - 30 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM support_operator_execution_locks WHERE lease_expires_at <= ?").bind(nowIso()),
        maintenanceStatement(db, "DELETE FROM reopen_business_messages WHERE delivered_at IS NOT NULL AND delivered_at < ?").bind(new Date(Date.now() - 7 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM reopen_business_messages WHERE failure_code IS NOT NULL AND failure_alerted_at IS NOT NULL AND created_at < ?").bind(new Date(Date.now() - 30 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM general_message_claims WHERE (completed_at IS NOT NULL AND completed_at < ?) OR (completed_at IS NULL AND lease_expires_at < ? AND created_at < ?)").bind(new Date(Date.now() - 7 * 86_400_000).toISOString(), nowIso(), new Date(Date.now() - 7 * 86_400_000).toISOString()),
        maintenanceStatement(db, "DELETE FROM general_callback_recoveries WHERE (completed_at IS NOT NULL AND completed_at < ?) OR (delivery_uncertain_at IS NOT NULL AND delivery_uncertain_at < ?) OR (completed_at IS NULL AND delivery_uncertain_at IS NULL AND lease_expires_at < ? AND created_at < ?)").bind(new Date(Date.now() - 7 * 86_400_000).toISOString(), new Date(Date.now() - 7 * 86_400_000).toISOString(), nowIso(), new Date(Date.now() - 7 * 86_400_000).toISOString()),
      ];
      if (env.TELEGRAM_COOLDOWN_ENABLED === 'true') statements.push(
        maintenanceStatement(db, 'DELETE FROM telegram_cleanup_jobs WHERE completed_at < ?').bind(new Date(Date.now() - 30 * 86400000).toISOString()),
        db.prepare("UPDATE telegram_cleanup_jobs SET completed_at = ?, last_error = 'Cleanup expired; manual review required' WHERE rowid IN (SELECT rowid FROM telegram_cleanup_jobs WHERE completed_at IS NULL AND created_at < ? LIMIT 100)").bind(nowIso(), new Date(Date.now() - 7 * 86400000).toISOString()));
      const maintenanceChunks = Math.ceil(statements.length / 10);
      const storageQueues = env.RETENTION_ENABLED === 'true' ? [
        async () => {
          const owner = configs.find((item) => item.groupCommandOwner) || configs[0];
          const locale = managerConfigured(env) ? await getManagerLanguage(db, primaryOperatorId(env))
            : owner?.locale || DEFAULT_LANGUAGE;
          return storageMaintenance(env, async (text) => {
            if (managerConfigured(env)) return requestTelegram({ token: env.MANAGER_BOT_TOKEN,
              method: 'sendMessage', body: { chat_id: supportGroupId(env), text } });
            if (!owner) return { ok: false };
            return telegram(resolveBot(env, owner.id), 'sendMessage', { chat_id: supportGroupId(env), text }, env);
          }, new Date(), locale);
        },
        () => runStorageJob(env),
      ] : [];
      storageQueues.push(()=>runStatisticsSchedule(env,db));
      const storageOffset = configs.length * queues.length + maintenanceChunks;
      const jobCount = storageOffset + storageQueues.length;
      const recoveryBaseEnv = env;
      for (let visited = 0; visited < jobCount && budget.used < budget.startLimit; visited++) {
        const cursor = await dbOne(db, `INSERT INTO recovery_scheduler (id, next_job) VALUES (1, 1)
          ON CONFLICT(id) DO UPDATE SET next_job = recovery_scheduler.next_job + 1
          RETURNING (next_job - 1) % ? AS job, next_job AS ticket`, jobCount);
        const job = Number(cursor.job);
        try {
          if (job >= storageOffset) {
            await storageQueues[job - storageOffset]();
          } else if (job >= configs.length * queues.length) {
            const offset = (job - configs.length * queues.length) * 10;
            await db.batch(statements.slice(offset, offset + 10));
          } else {
            const config = configs[Math.floor(job / queues.length)];
            if (await persistedBotEnabled(db, config.id)) {
              const route = await dbOne(db, 'SELECT group_id FROM service_group_routes WHERE bot_id=?', config.id);
              env = route ? { ...recoveryBaseEnv, SUPPORT_GROUP_ID: String(route.group_id) } : recoveryBaseEnv;
              const bot = resolveBot(env, config.id);
              assertTelegramReady(db, bot);
              await queues[job % queues.length](config, bot);
            }
          }
        } catch (error) {
          if (error instanceof RecoveryBudgetExhausted) {
            // Retry once as the first job of a fresh invocation. The plan lookup
            // already spends budget before any job, so count visited jobs instead.
            // Never overwrite a cursor advanced by a concurrent invocation.
            if (visited > 0) await dbRun(db,
              "UPDATE recovery_scheduler SET next_job = next_job - 1 WHERE id = 1 AND next_job = ?", cursor.ticket);
            break;
          }
          if (!(error instanceof TelegramCooldownError)) log(null, "error", "scheduled_bot_recovery_failed", { job, message: error.message });
        }
        finally { env = recoveryBaseEnv; }
      }
      log(null, "info", "scheduled_recovery_budget", { queries: budget.used, limit: budget.limit, plan: budget.plan });
    };
    if (ctx?.waitUntil) ctx.waitUntil(cleanup());
    else await cleanup();
  },
};
