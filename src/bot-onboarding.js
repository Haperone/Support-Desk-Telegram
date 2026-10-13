import { managementBotKey, parseAdminIds, parseBotRegistry, sendBotSetupReminder, timingSafeEqual } from './worker.js';
import { requestTelegram } from './telegram-response.js';
import { BOT_UPDATES, MAX_REGISTERED_BOTS, openCredentials, registeredConfig, registrationEnabled, sealCredentials, validRegistryKey, webhookUrl, withBotRegistry } from './bot-registry.js';
import { commitGroupCutover, findTopicByGroup, registerSupportGroup, resolveActiveGroup } from './service-groups.js';
import { isGeneralCommand } from './control-plane-contract.js';
import { getManagerLanguage } from './manager-language.js';
import { languageOrDefault } from './language.js';
import { onboardingText } from './onboarding-copy.js';

const TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{20,150}$/;
const TOKEN_IN_TEXT = /\b\d{5,20}:[A-Za-z0-9_-]{20,150}\b/;
const now = () => new Date().toISOString();
const later = ms => new Date(Date.now() + ms).toISOString();
const nonce = () => crypto.randomUUID().replaceAll('-', '').slice(0, 20);
const ok = () => new Response('OK');
class SetupError extends Error {}
class SetupBusy extends Error {}
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const digest = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), n => n.toString(16).padStart(2, '0')).join('');
const safeLabel = (text, limit) => typeof text === 'string' && text.trim().length > 0 && text.trim().length <= limit && !/[\r\n\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(text);
const legacyMenuCopy = {
  en: { moved: 'Conversation moved. Current topic: ', oldGroup: 'Service moved to another group. Your reply in this topic was not sent to the customer.', oldTopic: 'This is an old topic. Open the current link in the card.', oldMenuAt: 'Old menu. Open @', disconnected: 'This group is no longer connected to the service.', currentTopic: 'Open current topic', menuMoved: 'The support menu has moved to the manager bot. Open the current menu below.', openMenu: 'Open support menu', oldMenu: 'This is an old menu. Open the manager bot menu.', tokenWarning: 'A bot token appears to have been posted here. It was not forwarded to the customer. If others could see it, rotate it in BotFather. To connect a bot, use /addbot in a private chat.' },
  ru: { moved: 'Обращение перенесено. Актуальная тема: ', oldGroup: 'Сервис перенесён в другую группу. Ответ в этой теме не отправлен клиенту.', oldTopic: 'Это старая тема. Откройте актуальную ссылку в карточке.', oldMenuAt: 'Старое меню. Откройте @', disconnected: 'Эта группа больше не подключена к сервису.', currentTopic: 'Открыть актуальную тему', menuMoved: 'Меню поддержки перенесено в управляющий бот. Откройте актуальное меню кнопкой ниже.', openMenu: 'Открыть меню поддержки', oldMenu: 'Это старое меню. Откройте меню управляющего бота.', tokenWarning: 'Похоже, сюда отправлен токен бота. Он не переслан пользователю. Если токен был виден другим участникам, перевыпустите его в BotFather. Для подключения используйте /addbot в личном чате.' },
  es: { moved: 'Conversación trasladada. Tema actual: ', oldGroup: 'El servicio se trasladó a otro grupo. Tu respuesta en este tema no se envió al cliente.', oldTopic: 'Este tema es antiguo. Abre el enlace actual en la ficha.', oldMenuAt: 'Menú antiguo. Abre @', disconnected: 'Este grupo ya no está conectado al servicio.', currentTopic: 'Abrir tema actual', menuMoved: 'El menú de soporte se trasladó al bot administrador. Abre el menú actual abajo.', openMenu: 'Abrir menú de soporte', oldMenu: 'Este menú es antiguo. Abre el menú del bot administrador.', tokenWarning: 'Parece que se envió aquí un token de bot. No se reenvió al cliente. Si otras personas pudieron verlo, renuévelo en BotFather. Para conectar un bot, use /addbot en un chat privado.' },
  zh: { moved: '会话已迁移。当前话题：', oldGroup: '服务已迁移到其他群组。此话题中的回复未发送给客户。', oldTopic: '这是旧话题。请在卡片中打开当前链接。', oldMenuAt: '这是旧菜单。请打开 @', disconnected: '此群组已不再连接该服务。', currentTopic: '打开当前话题', menuMoved: '支持菜单已迁移到管理机器人。请点击下方按钮打开当前菜单。', openMenu: '打开支持菜单', oldMenu: '这是旧菜单。请打开管理机器人菜单。', tokenWarning: '这里似乎发送了机器人令牌。该令牌未转发给客户。如果其他成员可能看到，请在 BotFather 中重置令牌。连接机器人请在私人聊天中使用 /addbot。' },
};

async function call(token, method, body, fetchImpl) {
  const reply = await requestTelegram({ token, method, body, fetchImpl, timeoutMs: 10000 });
  if (!reply.ok) {
    // Only fixed metadata is safe: Telegram descriptions can contain tokens or URLs.
    console.warn(JSON.stringify({ event: 'bot_onboarding_telegram_failed', method,
      http_status: reply.httpStatus || null, error_code: reply.errorCode || null,
      outcome_uncertain: reply.deliveryUncertain === true,
      retry_after_seconds: reply.retryAfterSeconds || null }));
    const reason = reply.rateLimited ? `Telegram временно ограничил запросы. Повторите через ${reply.retryAfterSeconds || 60} сек.`
      : method === 'getMe' ? 'Не удалось проверить токен. Проверьте его в BotFather и повторите.'
      : method === 'getChatMember' || method === 'getChat' ? 'Не удалось проверить группу. Добавьте бота администратором в группу поддержки и разрешите управление темами.'
      : method === 'setWebhook' ? 'Telegram не подтвердил установку адреса доставки. Повторите подключение; очередь сообщений не очищается.'
      : method === 'getWebhookInfo' ? 'Не удалось получить состояние адреса доставки у Telegram. Повторите проверку; очередь сообщений не очищается.'
      : 'Telegram не подтвердил действие. Повторите попытку кнопкой; очередь сообщений сохраняется.';
    // Never include the API description, request URL or token in logs / user replies.
    throw new SetupError(reason);
  }
  return reply.result;
}

export async function handleBotRegistrationUpdate(bot, env, update, fetchImpl = fetch, options = {}) {
  const db = env.SUPPORT_DB;
  const actor = Number([...parseAdminIds(env.ADMIN_IDS)][0]);
  const message = update.message;
  const query = update.callback_query;
  const managed = update.managed_bot || (message?.managed_bot_created && { user: message.from, bot: message.managed_bot_created.bot });
  const sender = managed?.user || query?.from || message?.from;
  const privateChat = (query?.message || message)?.chat;
  const text = String(message?.text || '').trim();
  const secretText = TOKEN_IN_TEXT.test(text) || TOKEN_IN_TEXT.test(String(message?.caption || ''));
  const start = /^\/(?:addbot(?:@\w+)?|start(?:@\w+)?\s+addbot)$/.test(text);
  const privateCallback = String(query?.data || '').startsWith('br:');
  const personalLanguageLoaded = bot.id === 'manager'
    && (managed || privateChat?.type === 'private' && (start || privateCallback || secretText));
  let language = personalLanguageLoaded
    ? await getManagerLanguage(db, actor) : languageOrDefault(bot.locale);
  const localize = value => onboardingText(language, value);
  const localizeMarkup = markup => markup?.inline_keyboard ? { ...markup,
    inline_keyboard: markup.inline_keyboard.map(row => row.map(item => ({ ...item, text: localize(item.text) }))) }
    : markup?.keyboard ? { ...markup,
      keyboard: markup.keyboard.map(row => row.map(item => ({ ...item, text: localize(item.text) }))) } : markup;
  const privateInput = privateChat?.type === 'private';
  const authorized = Number(sender?.id) === actor && !sender?.is_bot && (managed || privateInput && Number(privateChat.id) === actor);
  const send = (value, markup = { inline_keyboard: [] }) => privateInput
    && Array.isArray(markup.inline_keyboard) && options.renderScreen
    ? options.renderScreen(localize(value), localizeMarkup(markup))
    : call(bot.token, 'sendMessage', {
      chat_id: privateChat?.id || actor, text: localize(value), reply_markup: localizeMarkup(markup),
    }, fetchImpl);
  const eraseSecret = async () => {
    if (privateInput && secretText) await requestTelegram({ token: bot.token, method: 'deleteMessage',
      body: { chat_id: privateChat.id, message_id: message.message_id }, fetchImpl, timeoutMs: 10000 });
  };
  if (secretText && message && String(message.chat?.id) === String(env.SUPPORT_GROUP_ID)) {
    await requestTelegram({ token: bot.token, method: 'deleteMessage', body: { chat_id: message.chat.id, message_id: message.message_id }, fetchImpl, timeoutMs: 10000 });
    // A token pasted into a user's topic must never be copied to that user or
    // stored as a welcome-message draft. It may already have been seen in the group.
    if (Number(sender?.id) === actor) await call(bot.token, 'sendMessage', {
      chat_id: message.chat.id, ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      text: legacyMenuCopy[language].tokenWarning,
    }, fetchImpl);
    return true;
  }
  if (update.managed_bot && registrationEnabled(env) && validRegistryKey(env)) {
    const row = await first(db, 'SELECT * FROM registered_bots WHERE telegram_id = ? AND manager_bot_id = ?', managed.bot.id, bot.id);
    if (row && (row.managed_update_id == null || row.managed_update_id < update.update_id)) {
      if (Number(managed.user?.id) !== actor) {
        await run(db, "UPDATE registered_bots SET status = 'paused', managed_update_id = ?, updated_at = ? WHERE bot_id = ? AND (managed_update_id IS NULL OR managed_update_id < ?)", update.update_id, now(), row.bot_id, update.update_id);
        return true;
      }
      const pending = await first(db, 'SELECT * FROM bot_registration_flow WHERE owner_id = ? AND manager_bot_id = ?', actor, bot.id);
      const sameFlow = pending?.credentials && JSON.parse(pending.data_json).me?.id === row.telegram_id;
      if (sameFlow && pending.lease_until > now()) throw new SetupBusy();
      const token = await call(bot.token, 'getManagedBotToken', { user_id: managed.bot.id }, fetchImpl);
      const me = await call(token, 'getMe', {}, fetchImpl);
      if (me?.id !== row.telegram_id || !me.is_bot || !/^[a-z0-9_]{5,32}$/i.test(me.username || '')) throw new SetupError('Не удалось проверить обновление управляемого бота.');
      let previous;
      let credentialsRecovered = false;
      try { previous = await openCredentials(env, row.bot_id, row.credentials); }
      catch { previous = { webhookSecret: nonce() + nonce() }; credentialsRecovered = true; }
      const cipher = await sealCredentials(env, row.bot_id, { ...previous, token });
      // Token refresh alone never takes over a webhook changed by another system.
      const statements = [db.prepare(`UPDATE registered_bots SET credentials = ?, config_json = ?, status = CASE WHEN status = 'active' AND ? THEN 'paused' ELSE status END, managed_update_id = ?, updated_at = ?
        WHERE bot_id = ? AND credentials = ? AND (managed_update_id IS NULL OR managed_update_id < ?)
        AND NOT EXISTS(SELECT 1 FROM bot_registration_flow WHERE owner_id = ? AND nonce = ? AND lease_until > ?)`)
        .bind(cipher, JSON.stringify({ ...JSON.parse(row.config_json), username: me.username }), credentialsRecovered ? 1 : 0, update.update_id, now(), row.bot_id, row.credentials, update.update_id, actor, sameFlow ? pending.nonce : '', now())];
      if (sameFlow) statements.push(db.prepare(`UPDATE bot_registration_flow SET credentials = ? WHERE owner_id = ? AND nonce = ?
        AND EXISTS(SELECT 1 FROM registered_bots WHERE bot_id = ? AND credentials = ? AND managed_update_id = ?)`)
        .bind(await sealCredentials(env, 'flow:' + pending.nonce, { ...previous, token }), actor, pending.nonce, row.bot_id, cipher, update.update_id));
      const changed = await db.batch(statements);
      if (!(changed[0].meta?.changes > 0)) throw new SetupBusy();
      return true;
    }
    if (row) return true;
  }
  if (!authorized) {
    if (privateInput && (start || privateCallback || secretText)) {
      await eraseSecret();
      if (query) await requestTelegram({ token: bot.token, method: 'answerCallbackQuery', body: { callback_query_id: query.id, text: localize('Только для главного администратора.'), show_alert: true }, fetchImpl });
      else await send('Подключение ботов доступно только главному администратору. Токены не пересылаются в поддержку.');
      return true;
    }
    // Managed updates have no customer content and must never enter support delivery.
    return Boolean(managed || privateCallback);
  }
  if (!registrationEnabled(env) || !validRegistryKey(env)) {
    if (start || privateCallback || secretText || managed) {
      await eraseSecret();
      await send('Подключение через Telegram ещё не включено. Сначала выполните однократное обновление поддержки по инструкции установки.');
      return true;
    }
    return false;
  }
  if (!managed && !privateInput) return false;
  if (query && !privateCallback) return false;
  let flow = await first(db, 'SELECT * FROM bot_registration_flow WHERE owner_id = ?', actor);
  // Free-text wizard replies must follow the same personal language as buttons.
  // Read the preference only for an active flow, not for normal support messages.
  if (bot.id === 'manager' && flow && !personalLanguageLoaded) language = await getManagerLanguage(db, actor);
  if (flow && flow.expires_at <= now() && flow.stage !== 'connecting') {
    await run(db, 'DELETE FROM bot_registration_flow WHERE owner_id = ? AND nonce = ? AND (lease_until IS NULL OR lease_until <= ?)', actor, flow.nonce, now());
    flow = await first(db, 'SELECT * FROM bot_registration_flow WHERE owner_id = ?', actor);
  }
  if (!flow && start && env.MANAGER_BOT_TOKEN && bot.id !== 'manager') {
    const managerName = String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, '');
    await send(managerName
      ? `Добавление сервисных ботов теперь находится у @${managerName}. Откройте его личный чат и отправьте /addbot.`
      : 'Добавление сервисных ботов теперь находится в личном чате управляющего бота. Отправьте ему /addbot.');
    return true;
  }
  if (flow && flow.manager_bot_id !== bot.id) {
    if (secretText) await eraseSecret();
    if (start || privateCallback || secretText) {
      const manager = parseBotRegistry(env.BOT_REGISTRY).find(item => item.id === flow.manager_bot_id);
      await send('Настройка уже открыта в другом боте. Продолжите её там.', { inline_keyboard: manager?.username
        ? [[{ text: 'Продолжить настройку', url: `https://t.me/${manager.username}?start=addbot` }]] : [] });
      return true;
    }
    return Boolean(managed);
  }
  if (flow?.stage === 'done' && !start && !privateCallback && !managed && !secretText) {
    return flow.last_update_id != null && update.update_id <= flow.last_update_id;
  }
  // A bare token is never treated as a customer message, even after /cancel or expiry.
  if (secretText && (!flow || flow.stage !== 'token')) {
    await eraseSecret();
    await send('Токен не переслан в поддержку. Откройте /addbot и выберите «Подключить существующего».');
    return true;
  }
  if (!flow && !start && !managed && !privateCallback) return false;
  if (!flow && !start) {
    if (!managed) await send('Эта настройка завершена или устарела. Откройте /addbot.');
    return true;
  }
  if (!flow) {
    await run(db, "INSERT INTO bot_registration_flow(owner_id, manager_bot_id, nonce, stage, data_json, expires_at) VALUES(?, ?, ?, 'choose', ?, ?) ON CONFLICT(owner_id) DO NOTHING",
      actor, bot.id, nonce(), JSON.stringify(options.targetGroupId ? { groupId: Number(options.targetGroupId) } : {}), later(3600000));
    flow = await first(db, 'SELECT * FROM bot_registration_flow WHERE owner_id = ?', actor);
  }
  const owner = nonce();
  const locked = await first(db, 'UPDATE bot_registration_flow SET lease_token = ?, lease_until = ? WHERE owner_id = ? AND nonce = ? AND (lease_until IS NULL OR lease_until <= ?) RETURNING *',
    owner, later(120000), actor, flow.nonce, now());
  if (!locked) throw new SetupBusy();
  flow = locked;
  let data = JSON.parse(flow.data_json);
  const button = (label, action) => ({ text: label, callback_data: `br:${action}:${flow.nonce}:${flow.version}` });
  const keyboard = rows => ({ inline_keyboard: [...rows, [button(flow.stage === 'connecting' ? 'Закрыть мастер' : 'Отмена', 'cancel')]] });
  const save = async (stage, nextData = data, credentials = flow.credentials) => {
    const changed = await first(db, `UPDATE bot_registration_flow SET stage = ?, data_json = ?, credentials = ?, version = version + 1,
      last_update_id = ?, expires_at = ? WHERE owner_id = ? AND nonce = ? AND lease_token = ? AND lease_until > ? RETURNING *`,
      stage, JSON.stringify(nextData), credentials, update.update_id, later(3600000), actor, flow.nonce, owner, now());
    if (!changed) throw new SetupBusy();
    flow = changed; data = nextData;
  };
  const render = async (prefix = '') => {
    let body; let rows = [];
    switch (flow.stage) {
      case 'choose': body = 'Добавление бота поддержки\n\nВыберите способ подключения.';
        rows = [[button('Подключить существующего', 'existing')], [button('Создать нового', 'create')]]; break;
      case 'token': body = 'Отправьте одним сообщением полный токен нового бота из BotFather. Сообщение с токеном будет удалено по возможности, в поддержку оно не пересылается.'; break;
      case 'create': body = 'Создайте бота кнопкой ниже. После создания вернитесь в этот чат.';
        return send(prefix + body, { keyboard: [[{ text: 'Создать бота поддержки', request_managed_bot: { request_id: 1 } }], [{ text: '/cancel' }]], resize_keyboard: true, one_time_keyboard: true });
      case 'group': body = [
        `Найден @${data.me.username}.`,
        '',
        '1. Подготовьте бота в @BotFather.',
        `Откройте /mybots → @${data.me.username} → Bot Settings:`,
        '• Allow Groups — включить (Enable).',
        '• Group Privacy — выключить (Disable, рекомендуется).',
        '• Group Admin Rights → Manage Group — включить.',
        '',
        'Allow Groups также доступен через /setjoingroups, Group Privacy — через /setprivacy.',
        'Бот-администратор получает сообщения группы и при включённом Group Privacy. Group Admin Rights задаёт предлагаемые права при добавлении, а не выдаёт их в существующей группе.',
        '',
        bot.id === 'manager'
          ? '2. Добавьте сервисного бота в выбранную группу администратором с правом Manage Topics (управление темами). Закреплением меню занимается управляющий бот.'
          : '2. Нажмите «Добавить в группу», выберите «Поддержка» и назначьте бота администратором с правами Manage Topics (управление темами) и Pin Messages (закрепление сообщений). Если бот уже в группе, проверьте эти права в её настройках.',
        '',
        '3. Вернитесь сюда и нажмите «Проверить подключение». Мастер проверит фактические права бота в группе.',
      ].join('\n');
        rows = [[{ text: 'Открыть BotFather', url: 'https://t.me/BotFather' }], [{ text: 'Добавить в группу', url: `https://t.me/${data.me.username}?startgroup&admin=${bot.id === 'manager' ? 'manage_topics' : 'manage_topics+pin_messages'}` }], [button('Проверить подключение', 'check')]]; break;
      case 'name': body = 'Как называется сервис, который обслуживает этот бот? Отправьте название (до 64 символов), например «Мой магазин».';
        rows = [[button('Использовать имя бота', 'defaultname')]]; break;
      case 'prefix': body = `Сервис: ${data.displayName}\n\nОтправьте короткий префикс для названий топиков (до 24 символов), например SHOP.`;
        rows = [[button('Использовать название сервиса', 'defaultprefix')]]; break;
      case 'confirm': body = `Подключить @${data.me.username}?\n\nСервис: ${data.displayName}\nПрефикс топиков: ${data.topicPrefix}\nГруппа: ${data.groupTitle}\nПриветствие и подтверждение: ${data.existing ? 'сохраняются текущие настройки' : 'выключены, пока вы не зададите тексты'}.`;
        if (data.previousSet) body += `\n\n⚠️ Сейчас бот подключён к ${data.previousHost}. Подтверждение переключит его на эту поддержку. Старая система перестанет получать новые сообщения.`;
        rows = [[button(data.previousSet ? 'Переключить и подключить' : data.existing ? 'Обновить подключение' : 'Подключить', 'connect')],[button('Изменить название','editname'),button('Изменить префикс','editprefix')]]; break;
      case 'connecting': body = 'Подключение ещё не подтверждено. Повторите проверку: используется то же подключение, очередь Telegram не очищается.';
        rows = [[button('Повторить подключение', 'connect')], [button('Ввести обновлённый токен', 'retoken')]]; break;
      case 'done': {
        const key = managementBotKey([{ ...registeredConfig(data.me, data.displayName, data.topicPrefix), id: data.botId || `bot-${data.me.id}` }], data.botId || `bot-${data.me.id}`);
        const reactions = await first(db, `SELECT s.support_to_user_verified,s.user_to_support_verified,
          s.support_to_user_enabled,s.user_to_support_enabled,c.group_id,c.support_step,c.user_step
          FROM reaction_settings s LEFT JOIN reaction_checks c ON c.bot_id=s.bot_id WHERE s.bot_id=?`, `bot-${data.me.id}`);
        const checked = Number(reactions?.support_to_user_verified) === 1 && Number(reactions?.user_to_support_verified) === 1
          && Number(reactions?.support_to_user_enabled) === 1 && Number(reactions?.user_to_support_enabled) === 1
          && Number(reactions?.group_id) === Number(data.groupId || env.SUPPORT_GROUP_ID)
          && Number(reactions?.support_step) === 3 && Number(reactions?.user_step) === 3;
        body = `@${data.me.username} подключён.\n\n${checked ? '✅ Реакции проверены и включены.'
          : 'Следующий обязательный шаг — проверка реакций в обоих направлениях. После её успешного завершения реакции включатся автоматически.'}`
          + '\n\nЗадайте приветствие и подтверждение получения обращения или скопируйте их с другого бота, затем запустите «Контрольный обмен». ';
        rows = bot.id === 'manager'
          ? [[{ text: '🧪 Проверить реакции', callback_data: `mg:rxtest:${key}` }],
            [{ text: '📋 Скопировать сообщения', callback_data: `mg:copymsg:${key}` }],
            [{ text: '⚙️ Настройки сервиса', callback_data: `mg:settings:${key}` }],
            [{ text: 'Контрольный обмен', callback_data: `mg:test:${key}` }],
            ...(checked ? [[button('Добавить ещё бота', 'another')]] : [])]
          : [...(data.settingsMessageId ? [[{ text: 'Настроить сообщения бота', url: 'https://t.me/c/' + String(env.SUPPORT_GROUP_ID).replace(/^-100/, '') + '/' + data.settingsMessageId }]] : []),
            [{ text: 'Открыть General', url: 'https://t.me/c/' + String(env.SUPPORT_GROUP_ID).replace(/^-100/, '') + '/1' }],
            [button('Добавить ещё бота', 'another')]];
        break;
      }
      default: throw new Error('Unknown registration stage');
    }
    await send(prefix + body, keyboard(rows));
  };
  const acceptToken = async (token, managerId = null) => {
    if (!TOKEN.test(token)) throw new SetupError('Нужен полный токен из BotFather, содержащий двоеточие.');
    const me = await call(token, 'getMe', {}, fetchImpl);
    if (!me?.is_bot || !Number.isSafeInteger(me.id) || me.id <= 0 || !/^[a-z0-9_]{5,32}$/i.test(me.username || '') || String(me.id) !== token.split(':')[0]) throw new SetupError('Telegram вернул некорректные сведения о боте.');
    if (data.reconnectId && data.reconnectId !== me.id) throw new SetupError('Для возобновления нужен токен того же бота. Для другого бота сначала закройте мастер.');
    const registry = parseBotRegistry(env.BOT_REGISTRY);
    const fixed = registry.find(item => !Object.hasOwn(env.DYNAMIC_BOT_STATES || {}, item.id) &&
      (String(env[item.tokenBinding] || '').split(':')[0] === String(me.id) || item.username.toLowerCase() === me.username.toLowerCase()));
    if (fixed) throw new SetupError(`@${me.username} уже подключён через файл настроек. Повторное добавление не требуется.`);
    const existing = await first(db, 'SELECT * FROM registered_bots WHERE telegram_id = ?', me.id);
    const adopted = await first(db, 'SELECT bot_id,config_json FROM adopted_static_bots WHERE telegram_id = ?', me.id);
    const count = await first(db, 'SELECT COUNT(*) AS n FROM registered_bots');
    if (!existing && count.n >= MAX_REGISTERED_BOTS) throw new SetupError(`Достигнут предел: ${MAX_REGISTERED_BOTS} ботов, добавленных через меню.`);
    const config = existing ? JSON.parse(existing.config_json) : adopted && JSON.parse(adopted.config_json);
    let webhookSecret = nonce() + nonce();
    if (existing) {
      try { webhookSecret = (await openCredentials(env, existing.bot_id, existing.credentials)).webhookSecret; }
      catch { /* Reconnect with a new secret; setWebhook replaces the old one after verification. */ }
    }
    const credentials = { token, webhookSecret };
    await save('group', { me: { id: me.id, username: me.username, first_name: String(me.first_name || me.username).slice(0, 64) },
      groupId: data.groupId || options.targetGroupId || Number(env.SUPPORT_GROUP_ID),
      managerId: managerId || existing?.manager_bot_id || null, existing: Boolean(existing),
      ...(config ? { botId: config.id, displayName: config.displayName, topicPrefix: config.topicPrefix } : {}) },
      await sealCredentials(env, 'flow:' + flow.nonce, credentials));
  };
  const checkGroup = async credentials => {
    const group = await call(credentials.token, 'getChat', { chat_id: Number(env.SUPPORT_GROUP_ID) }, fetchImpl);
    if (String(group?.id) !== String(env.SUPPORT_GROUP_ID) || group.type !== 'supergroup' || !group.is_forum) throw new SetupError('Нужна настроенная группа поддержки с включёнными темами.');
    if (bot.id === 'manager') {
      const managerMe = await call(bot.token, 'getMe', {}, fetchImpl);
      const managerRights = await call(bot.token, 'getChatMember', { chat_id: Number(env.SUPPORT_GROUP_ID), user_id: managerMe.id }, fetchImpl);
      if (managerRights?.status !== 'administrator' || !managerRights.can_pin_messages) {
        throw new SetupError('Добавьте управляющего бота администратором этой группы с правом закреплять сообщения.');
      }
    }
    const member = await call(credentials.token, 'getChatMember', { chat_id: Number(env.SUPPORT_GROUP_ID), user_id: data.me.id }, fetchImpl);
    if (member?.status !== 'administrator' || !member.can_manage_topics || (bot.id !== 'manager' && !member.can_pin_messages)) {
      throw new SetupError(bot.id === 'manager'
        ? 'Выдайте сервисному боту право администратора на управление темами. Затем повторите проверку.'
        : 'Выдайте боту права администратора: управление темами и закрепление сообщений. Затем повторите проверку.');
    }
    return String(group.title || ({en:'Support',ru:'Поддержка',es:'Soporte',zh:'支持'}[language])).slice(0, 128);
  };
  const preview = async prefix => {
    const credentials = await openCredentials(env, 'flow:' + flow.nonce, flow.credentials);
    const info = await call(credentials.token, 'getWebhookInfo', {}, fetchImpl);
    if (typeof info?.url !== 'string') throw new SetupError('Не удалось проверить текущее подключение бота.');
    const target = webhookUrl(env, data.botId || 'bot-' + data.me.id);
    const other = Boolean(info.url && info.url !== target);
    let host = ({en:'another system',ru:'другой системе',es:'otro sistema',zh:'其他系统'}[language]);
    if (other) { try { host = new URL(info.url).hostname; } catch {} }
    await save('confirm', { ...data, topicPrefix: prefix, previousHash: await digest(info.url), previousSet: other, previousHost: host });
  };
  try {
    if (query) await requestTelegram({ token: bot.token, method: 'answerCallbackQuery', body: { callback_query_id: query.id }, fetchImpl, timeoutMs: 5000 });
    if (managed) {
      if (flow.stage !== 'create') return true;
      const token = await call(bot.token, 'getManagedBotToken', { user_id: managed.bot.id }, fetchImpl);
      await acceptToken(token, bot.id);
      await send('Бот создан. Продолжим настройку.', { remove_keyboard: true });
    } else if (start) {
      // Reopening the wizard resumes a partially completed connection.
    } else if (query) {
      const [, action, session, version] = String(query.data).split(':');
      if (session !== flow.nonce || String(flow.version) !== version) return true;
      if (action === 'another' && flow.stage === 'done') {
        await save('choose', data.groupId ? { groupId: data.groupId } : {}, null);
        await render();
        return true;
      }
      if (action === 'cancel') {
        await run(db, 'DELETE FROM bot_registration_flow WHERE owner_id = ? AND nonce = ? AND lease_token = ?', actor, flow.nonce, owner);
        await send(flow.stage === 'connecting'
          ? 'Мастер закрыт. Начатое подключение сохранено. Для продолжения откройте /addbot и введите токен того же бота. До завершения проверки сообщения могут оставаться в очереди Telegram.'
          : 'Настройка отменена. Сохранённые подключения не удалены.', { remove_keyboard: true });
        return true;
      }
      if (action === 'existing' && flow.stage === 'choose') await save('token');
      else if (action === 'retoken' && flow.stage === 'connecting') await save('token', { reconnectId: data.me.id });
      else if (action === 'create' && ['choose', 'create'].includes(flow.stage)) {
        const me = await call(bot.token, 'getMe', {}, fetchImpl);
        if (!me.can_manage_bots) throw new SetupError(`Откройте настройки @${me.username} в мини-приложении BotFather и включите Bot Management Mode. Затем снова нажмите «Создать нового». Можно также подключить бота по токену.`);
        const info = await call(bot.token, 'getWebhookInfo', {}, fetchImpl);
        if (info.url !== webhookUrl(env, bot.id)) throw new SetupError('Сначала восстановите подключение текущего бота к этой поддержке.');
        await call(bot.token, 'setWebhook', { url: info.url, secret_token: bot.webhookSecret, allowed_updates: [...new Set([...(info.allowed_updates || []), ...BOT_UPDATES])], drop_pending_updates: false }, fetchImpl);
        await save('create');
      } else if (action === 'check' && flow.stage === 'group') {
        const credentials = await openCredentials(env, 'flow:' + flow.nonce, flow.credentials);
        const groupTitle = await checkGroup(credentials);
        await save('name', { ...data, groupTitle });
      } else if(action==='editname' && flow.stage==='confirm')await save('name',data);
      else if(action==='editprefix' && flow.stage==='confirm')await save('prefix',data);
      else if (action === 'defaultname' && flow.stage === 'name') await save('prefix', { ...data, displayName: data.displayName || data.me.first_name });
      else if (action === 'defaultprefix' && flow.stage === 'prefix') await preview(data.topicPrefix || data.displayName.slice(0, 24));
      else if (action === 'connect' && ['confirm', 'connecting'].includes(flow.stage)) {
        const credentials = await openCredentials(env, 'flow:' + flow.nonce, flow.credentials);
        await checkGroup(credentials);
        const generated = registeredConfig(data.me, data.displayName, data.topicPrefix);
        const adopted = data.botId && await first(db, 'SELECT config_json FROM adopted_static_bots WHERE bot_id=? AND telegram_id=?', data.botId, data.me.id);
        const config = adopted ? { ...JSON.parse(adopted.config_json), displayName: data.displayName,
          topicPrefix: data.topicPrefix, username: data.me.username, enabled: true } : generated;
        const target = webhookUrl(env, config.id);
        const before = await call(credentials.token, 'getWebhookInfo', {}, fetchImpl);
        if (typeof before?.url !== 'string') throw new SetupError('Telegram не подтвердил текущее подключение.');
        if (before.url !== target && await digest(before.url) !== data.previousHash) {
          await preview(data.topicPrefix);
          throw new SetupError('Подключение изменилось после проверки. Проверьте новый адрес и подтвердите переключение ещё раз.');
        }
        const cipher = await sealCredentials(env, config.id, credentials);
        const persisted = await first(db, `INSERT INTO registered_bots(bot_id, telegram_id, config_json, credentials, status, manager_bot_id, owner_id, created_at, updated_at)
          SELECT ?, ?, ?, ?, 'connecting', ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM registered_bots) < ? OR EXISTS(SELECT 1 FROM registered_bots WHERE telegram_id = ?)
          ON CONFLICT(telegram_id) DO UPDATE SET credentials = excluded.credentials, config_json = excluded.config_json,
            status = CASE WHEN registered_bots.status = 'paused' THEN 'connecting' ELSE registered_bots.status END, updated_at = excluded.updated_at
          RETURNING bot_id`, config.id, data.me.id, JSON.stringify(config), cipher, data.managerId, actor, now(), now(), MAX_REGISTERED_BOTS, data.me.id);
        if (!persisted || persisted.bot_id !== config.id) throw new SetupError('Не удалось сохранить подключение. Повторите попытку.');
        await save('connecting');
        if (data.managerId) {
          const manager = parseBotRegistry(env.BOT_REGISTRY).find(item => item.id === data.managerId);
          const managerToken = data.managerId === 'manager' ? env.MANAGER_BOT_TOKEN : manager && env[manager.tokenBinding];
          if (!managerToken) throw new SetupError('Не найден бот, управляющий этим подключением.');
          await call(managerToken, 'setManagedBotAccessSettings', { user_id: data.me.id, is_access_restricted: false }, fetchImpl);
        }
        if (bot.id === 'manager') {
          const groupId = Number(data.groupId);
          if (!Number.isSafeInteger(groupId) || groupId >= 0) throw new SetupError('Группа для сервиса не выбрана.');
          await registerSupportGroup(db, groupId, { title: data.groupTitle, forumVerifiedAt: now(), managerVerifiedAt: now(), serviceVerifiedAt: now() });
          const route = await first(db, 'SELECT group_id FROM service_group_routes WHERE bot_id=?', config.id);
          if (route && Number(route.group_id) !== groupId) throw new SetupError('Этот сервис уже привязан к другой группе. Сначала перенесите его через мастер подключения группы.');
          if (!route) await commitGroupCutover(db, config.id, groupId, null);
        }
        // Persist the route and stable secret before Telegram can deliver updates.
        // Until activation, that route returns 503 rather than acknowledging messages.
        if (await call(credentials.token, 'setWebhook', { url: target, secret_token: credentials.webhookSecret, allowed_updates: BOT_UPDATES, drop_pending_updates: false }, fetchImpl) !== true) throw new SetupError('Telegram не подтвердил подключение.');
        const verified = await call(credentials.token, 'getWebhookInfo', {}, fetchImpl);
        if (verified?.url !== target) throw new SetupError('Адрес после подключения отличается. Возможно, другая программа перенастраивает бота.');
        const activated = await run(db, "UPDATE registered_bots SET status = 'active', updated_at = ? WHERE bot_id = ? AND credentials = ? AND status IN ('connecting', 'active')", now(), config.id, cipher);
        if (!(activated.meta?.changes > 0)) throw new SetupError('Настройки изменились во время подключения. Повторите проверку.');
        await save('done', data, null);
        // Reuse the existing fenced General reminder; Cron retries definite failures.
        try {
          const configs = JSON.parse(env.BOT_REGISTRY).filter(item => item.id !== config.id);
          const noticeEnv = { ...env, BOT_REGISTRY: JSON.stringify([...configs, config]), [config.tokenBinding]: credentials.token, [config.webhookSecretBinding]: credentials.webhookSecret };
          if (bot.id !== 'manager') await sendBotSetupReminder({ ...config, ...credentials }, noticeEnv);
          const notice=await first(db,"SELECT message_id FROM bot_setup_notices WHERE bot_id=?",config.id);
          if(notice?.message_id)await save("done",{...data,settingsMessageId:notice.message_id},null);
        } catch { console.warn(JSON.stringify({ event: 'registered_bot_setup_notice_deferred', bot_id: config.id })); }
      }
    } else if (text === '/cancel') {
      await run(db, 'DELETE FROM bot_registration_flow WHERE owner_id = ? AND nonce = ? AND lease_token = ?', actor, flow.nonce, owner);
      await send(flow.stage === 'connecting' ? 'Мастер закрыт. Начатое подключение сохранено. Для продолжения откройте /addbot и введите токен того же бота. Сообщения могут оставаться в очереди Telegram.' : 'Настройка отменена. Сохранённые подключения не удалены.', { remove_keyboard: true }); return true;
    } else if (flow.last_update_id != null && update.update_id <= flow.last_update_id) return true;
    else if (text.startsWith('/')) {
      await render('Сейчас открыт мастер подключения. Завершите его кнопками или отправьте /cancel, чтобы вернуться к обычной переписке.\n\n');
      return true;
    }
    else if (flow.stage === 'token') {
      await eraseSecret();
      await acceptToken(text);
    } else if (flow.stage === 'name') {
      if (!safeLabel(text, 64)) throw new SetupError('Отправьте название одной строкой, от 1 до 64 символов.');
      await save('prefix', { ...data, displayName: text });
    } else if (flow.stage === 'prefix') {
      if (!safeLabel(text, 24)) throw new SetupError('Отправьте префикс одной строкой, от 1 до 24 символов.');
      await preview(text);
    }
    await render();
    return true;
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    await render(error.message + '\n\n');
    return true;
  } finally {
    await run(db, 'UPDATE bot_registration_flow SET lease_token = NULL, lease_until = NULL WHERE owner_id = ? AND nonce = ? AND lease_token = ?', actor, flow.nonce, owner);
  }
}

export function createRegistrationWorker(baseWorker, fetchImpl = fetch) {
  return {
    async fetch(request, originalEnv, ctx) {
      const path = new URL(request.url).pathname;
      const id = /^\/tg\/([a-z0-9-]+)$/.exec(path)?.[1];
      if (id && request.method === 'POST') {
        const fixed = parseBotRegistry(originalEnv.BOT_REGISTRY).find(item => item.id === id);
        if (!fixed && !registrationEnabled(originalEnv)) return new Response('Not found', { status: 404 });
      } else if (!path.startsWith('/verify/')) return baseWorker.fetch(request, originalEnv, ctx);
      let env;
      try { env = await withBotRegistry(originalEnv); }
      catch { return new Response('Bot registry temporarily unavailable', { status: 503 }); }
      if (id && request.method === 'POST') {
        const config = parseBotRegistry(env.BOT_REGISTRY).find(item => item.id === id);
        if (!config) return new Response('Not found', { status: 404 });
        if (env.DYNAMIC_BOT_STATES?.[id] === 'credentials_unavailable') return new Response('Bot credentials temporarily unavailable', { status: 503 });
        if (!timingSafeEqual(request.headers.get('x-telegram-bot-api-secret-token') || '', env[config.webhookSecretBinding])) return new Response('Forbidden', { status: 403 });
        if (env.DYNAMIC_BOT_STATES?.[id] && env.DYNAMIC_BOT_STATES[id] !== 'active') return new Response('Bot connection pending', { status: 503 });
        if (!(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) return new Response('Expected JSON', { status: 415 });
        let update;
        try { update = await request.clone().json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
        if (!update || !Number.isSafeInteger(update.update_id)) return new Response('Invalid update', { status: 400 });
        if (env.SUPPORT_DB?.storageMode !== 'reset') {
          try {
            if (await handleBotRegistrationUpdate({ ...config, token: env[config.tokenBinding], webhookSecret: env[config.webhookSecretBinding] }, env, update, fetchImpl)) return ok();
          } catch (error) {
            if (!(error instanceof SetupBusy)) console.warn(JSON.stringify({ event: 'bot_registration_retry', bot_id: id }));
            return new Response('Setup busy; retry later', { status: 503 });
          }
        }
      }
      if (id && env.MANAGER_BOT_TOKEN) {
        const config = parseBotRegistry(env.BOT_REGISTRY).find(item => item.id === id);
        const activeGroup = await resolveActiveGroup(env.SUPPORT_DB, id, originalEnv);
        if (!activeGroup) return new Response('Service group is not connected', { status: 503 });
        const copy = legacyMenuCopy[languageOrDefault(config.locale)];
        const update = await request.clone().json();
        const source = update.message || update.callback_query?.message;
        if (source?.chat?.type === 'supergroup') {
          const sourceGroup = Number(source.chat.id);
          const threadId = Number(source.message_thread_id || 1);
          if (sourceGroup !== activeGroup) {
            const historical = threadId > 1 ? await findTopicByGroup(env.SUPPORT_DB, sourceGroup, threadId) : null;
            let historicalText = null;
            let historicalTarget = null;
            if (historical?.bot_id === id && (update.message?.from?.id && !update.message.from.is_bot || update.callback_query?.from?.id)) {
              const current = await env.SUPPORT_DB.prepare('SELECT support_group_id,thread_id FROM conversations WHERE bot_id=? AND user_id=?')
                .bind(id,historical.user_id).first();
              historicalTarget = current ? `https://t.me/c/${String(current.support_group_id).replace(/^-100/,'')}/${current.thread_id}` : null;
              historicalText = historicalTarget ? `${copy.moved}${historicalTarget}` : copy.oldGroup;
              if (update.message) await requestTelegram({ token: env[config.tokenBinding], method: 'sendMessage', body: {
                chat_id: sourceGroup, message_thread_id: threadId, text: historicalText,
              }, fetchImpl, timeoutMs: 10000 });
            }
            if (update.callback_query?.id) {
              const managerName = String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, '');
              await requestTelegram({ token: env[config.tokenBinding], method: 'answerCallbackQuery', body: {
                callback_query_id: update.callback_query.id,
                text: historical?.bot_id === id ? copy.oldTopic
                  : managerName ? `${copy.oldMenuAt}${managerName}.` : copy.disconnected,
                show_alert: true,
              }, fetchImpl, timeoutMs: 5000 });
              if (historicalText) {
                const edited = await requestTelegram({ token: env[config.tokenBinding], method: 'editMessageText', body: {
                  chat_id: sourceGroup, message_id: update.callback_query.message.message_id, text: historicalText,
                  ...(historicalTarget ? { reply_markup: { inline_keyboard: [[{ text: copy.currentTopic, url: historicalTarget }]] } } : {}),
                }, fetchImpl, timeoutMs: 10000 });
                if (!edited.ok && !String(edited.description || '').toLowerCase().includes('message is not modified')) {
                  await requestTelegram({ token: env[config.tokenBinding], method: 'sendMessage', body: {
                    chat_id: sourceGroup, message_thread_id: threadId, text: historicalText,
                  }, fetchImpl, timeoutMs: 10000 });
                }
              } else if (threadId === 1 && managerName && String(update.callback_query.data || '').startsWith('um:')) {
                await requestTelegram({ token: env[config.tokenBinding], method: 'editMessageText', body: {
                  chat_id: sourceGroup, message_id: update.callback_query.message.message_id,
                  text: copy.menuMoved,
                  reply_markup: { inline_keyboard: [[{ text: copy.openMenu, url: `https://t.me/${managerName}?start=menu` }]] },
                }, fetchImpl, timeoutMs: 10000 });
              }
            }
            return ok();
          }
          if (threadId === 1 && update.message && isGeneralCommand(String(update.message.text || '').split(/\s+/,1)[0].split('@')[0].toLowerCase())) {
            return ok();
          }
          if (threadId === 1 && String(update.callback_query?.data || '').startsWith('um:')) {
            const managerName = String(env.MANAGER_BOT_USERNAME || '').replace(/^@/, '');
            const oldMenuId = Number(update.callback_query.message?.message_id);
            if (managerName && Number.isSafeInteger(oldMenuId) && oldMenuId > 0) {
              await requestTelegram({ token: env[config.tokenBinding], method: 'editMessageText', body: {
                chat_id: sourceGroup, message_id: oldMenuId,
                text: copy.menuMoved,
                reply_markup: { inline_keyboard: [[{ text: copy.openMenu, url: `https://t.me/${managerName}?start=menu` }]] },
              }, fetchImpl, timeoutMs: 10000 });
            }
            await requestTelegram({ token: env[config.tokenBinding], method: 'answerCallbackQuery', body: {
              callback_query_id: update.callback_query.id, text: copy.oldMenu, show_alert: true,
            }, fetchImpl, timeoutMs: 5000 });
            return ok();
          }
        }
        env = { ...env, SUPPORT_GROUP_ID: String(activeGroup) };
      }
      return baseWorker.fetch(request, env, ctx);
    },
    async scheduled(controller, env, ctx) {
      env = await withBotRegistry(env, 'recovery');
      if (registrationEnabled(env)) await run(env.SUPPORT_DB, "DELETE FROM bot_registration_flow WHERE expires_at <= ? AND stage != 'connecting' AND (lease_until IS NULL OR lease_until <= ?)", now(), now());
      return baseWorker.scheduled(controller, env, ctx);
    },
  };
}
