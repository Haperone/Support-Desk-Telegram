import { deliverySnapshot } from './manual-delivery.js';
import { managementBotKey, parseBotRegistry } from './worker.js';
import { requestTelegram } from './telegram-response.js';
import { resolveActiveGroup } from './service-groups.js';
import { customerName } from './user-display.js';
import { opaqueManagerText } from './manager-language.js';

const first = (db, sql, ...values) => db.prepare(sql).bind(...values).first();
const all = (db, sql, ...values) => db.prepare(sql).bind(...values).all();
const button = (text, callback_data) => ({ text, callback_data });
const primaryId = env => Number(String(env.ADMIN_IDS || '').split(',')[0].trim());
const safeText = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 160);
const formatTime = value => value ? String(value).replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'нет данных';

function authorize(env, actorId) {
  if (!Number.isSafeInteger(Number(actorId)) || Number(actorId) !== primaryId(env))
    throw new Error('Manager diagnostics are restricted to the primary administrator');
}

function knownServices(env, config = null) {
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  if (!config) return registry;
  const found = registry.find(item => item.id === config.id);
  if (!found) throw new Error('Service is not in the manager registry');
  return [found];
}

/** Call only after manager-bot has authorized the actor as an operator. */
export async function showManagerHelp(env, db, actorId, show, section = '') {
  void db;
  const topics = {
    reply: ['Как ответить?', 'Откройте «Очереди» или «Мои обращения», выберите карточку и перейдите в тему клиента. Сообщение или файл отправьте в этой теме. Команды и кнопки управления клиенту не пересылаются.'],
    transfer: ['Как передать обращение?', 'В карточке обращения нажмите «Передать», выберите оператора, добавьте внутреннюю заметку и подтвердите. Клиент заметку не получит. «Мои обращения» показывает назначенные вам обращения.'],
    access: ['Как ограничить пользователя?', 'Откройте «Пользователи» → «Поиск» или карточку обращения. В карточке пользователя выберите блокировку, ограничение или доверие и подтвердите действие.'],
    delivery: ['Почему сообщение задержалось?', 'Откройте «Проблемы доставки» или диагностику в карточке пользователя. При неясном исходе сначала проверьте переписку: повтор уже доставленного сообщения создаст дубль. Восстановление запускает главный администратор из карточки сервиса.'],
    drafts: ['Как продолжить черновик?', 'На главном экране откройте «Черновики» и выберите сохранённый ввод. Внутреннюю заметку отправьте следующим обычным сообщением. /cancel отменяет текущий ввод.'],
    commands: ['Команды', 'В личке Админушки: /start и /menu — меню; /mine и /urgent — свои обращения; /users — пользователи; /operators — команда; /reactions — реакции; /audit — журнал; /available и /unavailable — доступность; /help — помощь; /cancel — отмена ввода.'
      + (Number(actorId) === primaryId(env) ? '\n\nГлавному администратору также доступны /all, /urgentall, /metrics, /health, /storage, /alerts и /addbot.' : '')
      + '\n\nДля поиска нажмите «Поиск» и отправьте ID, @username или имя обычным сообщением. В теме клиента: /case — карточка, /close и /open — закрыть и открыть, /status — проверить доставку ответа.'],
  };
  if (topics[section]) return show(topics[section].join('\n\n'),
    [[button('К разделам помощи', 'mg:help')], [button('Меню', 'mg:home')]]);
  return show('Справка Админушки\n\n'
    + 'Сервисы: подключение групп, контрольный обмен, реакции и настройки сообщений.\n'
    + 'Обращения: «Очереди» показывают нуждающиеся в ответе, ожидающие, отложенные и решённые; «Пользователи» показывает профили, историю и модерацию.\n'
    + 'Черновики: сохранённые тексты ботов, заметки и незавершённые действия.\n'
    + 'Доставка: «Проблемы доставки» показывает незавершённые сообщения; неясную отправку сначала проверьте в Telegram.\n'
    + 'Готовность: в карточке сервиса доступны проверка связи с Telegram и технические детали.\n'
    + 'Здоровье системы: состояние групп и последние контрольные обмены.\n'
    + 'План Cloudflare и хранилище находятся в главном меню.\n\n'
      + 'Поиск: нажмите «Поиск» и отправьте ID, @username или имя без команды.\nКоманды: /start — меню, /users — профили пользователей, /operators — команда, /reactions — реакции, /audit — журнал.'
      + (Number(actorId) === primaryId(env) ? ' /storage — хранилище.' : ''),
  [...Object.entries(topics).map(([key, [label]]) => [button(label, `mg:help:${key}`)]),
    ...(Number(actorId) === primaryId(env) ? [[button('Здоровье системы', 'mg:health')]] : []),
    [button('Черновики', 'mg:drafts')], [button('Меню', 'mg:home')]]);
}

/** Read-only bounded system overview; optional config scopes it to one service. */
export async function showManagerSystemHealth(env, db, actorId, config, show, page = 0) {
  authorize(env, actorId);
  const services = knownServices(env, config);
  const selected = new Set(services.map(item => item.id));
  const [routes, checks, snapshot] = await Promise.all([
    all(db, `SELECT r.bot_id,r.group_id,g.title,g.menu_state,g.manager_verified_at,g.service_verified_at
      FROM service_group_routes r LEFT JOIN support_groups g USING(group_id)
      WHERE r.bot_id IN (${services.map(() => '?').join(',') || "'__none__'"}) ORDER BY r.bot_id`, ...services.map(item => item.id)),
    all(db, `SELECT bot_id,stage,expires_at FROM service_checks c
      WHERE c.rowid=(SELECT c2.rowid FROM service_checks c2 WHERE c2.bot_id=c.bot_id ORDER BY c2.rowid DESC LIMIT 1)
      AND bot_id IN (${services.map(() => '?').join(',') || "'__none__'"}) ORDER BY bot_id`, ...services.map(item => item.id)),
    deliverySnapshot(db, env, config?.id || null),
  ]);
  const routeByBot = new Map((routes.results || []).map(row => [row.bot_id, row]));
  const checkByBot = new Map((checks.results || []).map(row => [row.bot_id, row]));
  const pages = Math.max(1, Math.ceil(services.length / 12));
  const currentPage = Number.isSafeInteger(Number(page)) ? Math.min(Math.max(0, Number(page)), pages - 1) : 0;
  const lines = [`Здоровье системы · страница ${currentPage + 1}/${pages}`, ''];
  for (const item of services.slice(currentPage * 12, (currentPage + 1) * 12)) {
    const route = routeByBot.get(item.id), check = checkByBot.get(item.id);
    const groupState = !route ? 'группа не подключена'
      : route.menu_state === 'ready' ? `группа ${route.group_id}, меню готово`
        : `группа ${route.group_id}, меню ${route.menu_state || 'не подтверждено'}`;
    lines.push(`${opaqueManagerText(safeText(item.displayName || item.id))} · ${item.enabled ? 'включён' : 'выключен'}`);
    lines.push(`  ${groupState}; проверка: ${check ? `${safeText(check.stage)}, истекает ${formatTime(check.expires_at)}` : 'не проводилась'}`);
  }
  const backlog = (snapshot.rows || []).filter(row => !config || selected.has(row.bot_id));
  const uncertain = backlog.filter(row => row.reason === 'uncertain').length;
  const blocked = backlog.filter(row => row.reason && row.reason !== 'uncertain').length;
  lines.push('', `Незавершённые доставки: ${backlog.length}${snapshot.limited ? '+' : ''}`,
    `Неясный исход: ${uncertain}; заблокировано или ждёт действия: ${blocked}.`,
    db.storageMode === 'reset' ? 'База данных: выполняется обслуживание.' : 'База данных: доступна.');
  const bounded = lines.join('\n').slice(0, 3800);
  const navigation = [];
  if (currentPage) navigation.push(button('←', `mg:healthpage:${currentPage - 1}`));
  if (currentPage + 1 < pages) navigation.push(button('→', `mg:healthpage:${currentPage + 1}`));
  return show(bounded, [...(navigation.length ? [navigation] : []),
    [button('Проблемы доставки', `mg:problems:${config ? managementBotKey(parseBotRegistry(env.BOT_REGISTRY), config.id) : 'a'}:0`)],
    [button('Справка', 'mg:help')], [button('Меню', 'mg:home')]]);
}

/** Bounded cross-service drilldown for operators who do not know the user ID. */
export async function showManagerDeliveryProblems(env, db, actorId, key, page, show) {
  void actorId;
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const config = key === 'a' ? null : registry.find(item => managementBotKey(registry, item.id) === key);
  if (key !== 'a' && !config) return show('Сервис больше не подключён. Откройте меню заново.');
  const currentPage = Number.isSafeInteger(Number(page)) ? Math.max(0, Math.min(100, Number(page))) : 0;
  const snapshot = await deliverySnapshot(db, env, config?.id || null);
  const events = snapshot.rows || [], size = 5, pages = Math.max(1, Math.ceil(events.length / size));
  const safePage = Math.min(currentPage, pages - 1);
  const labels = { uncertain: 'исход неясен — сначала проверьте переписку', captcha: 'ожидает CAPTCHA',
    banned: 'пользователь заблокирован', restricted: 'ручное ограничение', muted: 'автоограничение',
    disabled: 'бот выключен', telegram: 'нужна проверка исходного сообщения' };
  const rows = [];
  const lines = [`Проблемы доставки · ${config ? opaqueManagerText(config.displayName) : 'все сервисы'}`,
    `Записей: ${events.length}${snapshot.limited ? '+' : ''} · страница ${safePage + 1}/${pages}`, ''];
  for (const event of events.slice(safePage * size, (safePage + 1) * size)) {
    const service = registry.find(item => item.id === event.bot_id);
    lines.push(`${opaqueManagerText(cleanService(service?.displayName || event.bot_id))} · ${opaqueManagerText(cleanService(event.first_name || event.user_id))} · ${event.user_id}`,
      `${event.direction === 'support_to_user' ? 'оператор → клиент' : 'клиент → поддержка'} · ${labels[event.reason] || 'готово к безопасному повтору'}`,
      `Сообщение ${event.source_chat_id}/${event.source_message_id}`, '');
    if (service) rows.push([button(`Открыть · ${opaqueManagerText(cleanService(service.displayName))} · ${event.user_id}`,
      `mg:diag:${managementBotKey(registry, service.id)}:${event.user_id}:0`)]);
    if (service && /^-100\d+$/.test(String(event.support_group_id)) && Number(event.thread_id) > 1) {
      const group = String(event.support_group_id).replace(/^-100/, '');
      const message = Number(event.source_chat_id) === Number(event.support_group_id)
        && Number(event.source_message_id) > 0 ? `/${event.source_message_id}` : '';
      rows.push([{ text: `Тема · ${event.user_id}`,
        url: `https://t.me/c/${group}/${event.thread_id}${message}` }]);
    }
  }
  if (!events.length) lines.push('Задержанных сообщений в выборке нет.');
  const nav = [];
  if (safePage) nav.push(button('←', `mg:problems:${key}:${safePage - 1}`));
  if (safePage + 1 < pages) nav.push(button('→', `mg:problems:${key}:${safePage + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button('Меню', 'mg:home')]);
  return show(lines.join('\n').slice(0, 3900), rows);
}

function cleanService(value) { return safeText(value).slice(0, 40); }

/** Live service connection check, available to every authorized operator. */
export async function showManagerReadiness(env, db, actorId, config, details, show, fetchImpl) {
  const [service] = knownServices(env, config);
  const token = env[service.tokenBinding], groupId = await resolveActiveGroup(db, service.id, env);
  const telegram = (method, body) => requestTelegram({ token, method, body, fetchImpl, timeoutMs: 10000 });
  const managerTelegram = (method, body) => requestTelegram({ token: env.MANAGER_BOT_TOKEN, method, body, fetchImpl, timeoutMs: 10000 });
  const [me, managerMe, webhook, evidence] = await Promise.all([
    telegram('getMe', {}), managerTelegram('getMe', {}), telegram('getWebhookInfo', {}),
    first(db, `SELECT (SELECT MAX(completed_at) FROM message_delivery_attempts
        WHERE bot_id=?1 AND direction='user_to_support' AND target_message_id IS NOT NULL) inbound,
      (SELECT MAX(completed_at) FROM message_delivery_attempts
        WHERE bot_id=?1 AND direction='support_to_user' AND target_message_id IS NOT NULL) outbound,
      (SELECT MAX(outbound_at) FROM service_checks WHERE bot_id=?1 AND stage='done') tested,
      (SELECT stage FROM service_checks WHERE bot_id=?1 ORDER BY expires_at DESC LIMIT 1) test_stage,
      b.enabled persisted_enabled,m.welcome_text,m.auto_reply_text,p.welcome_enabled,p.auto_reply_enabled,
      p.welcome_reviewed,p.auto_reply_reviewed,
      r.support_to_user_enabled,r.support_to_user_verified,r.user_to_support_enabled,r.user_to_support_verified
      FROM (SELECT ?1 id) source LEFT JOIN bots b USING(id)
      LEFT JOIN bot_message_settings m ON m.bot_id=source.id
      LEFT JOIN bot_message_preferences p ON p.bot_id=source.id
      LEFT JOIN reaction_settings r ON r.bot_id=source.id`, service.id),
  ]);
  const [member, managerMember, administrator] = await Promise.all([
    me.ok && groupId ? telegram('getChatMember', { chat_id: groupId, user_id: me.result.id }) : null,
    managerMe.ok && groupId ? managerTelegram('getChatMember', { chat_id: groupId, user_id: managerMe.result.id }) : null,
    groupId ? telegram('getChatMember', { chat_id: groupId, user_id: primaryId(env) }) : null,
  ]);
  const administratorPresent = administrator?.ok && ['creator', 'administrator', 'member'].includes(administrator.result?.status)
    || administrator?.ok && administrator.result?.status === 'restricted' && administrator.result?.is_member === true;
  const expectedWebhook = String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '') + '/tg/' + service.id;
  const topics = member?.ok && (member.result?.can_manage_topics || member.result?.status === 'creator');
  const managerTopics = managerMember?.ok && (managerMember.result?.can_manage_topics || managerMember.result?.status === 'creator');
  const managerPin = managerMember?.ok && (managerMember.result?.can_pin_messages || managerMember.result?.status === 'creator');
  const concerns = [];
  if (!service.enabled || Number(evidence?.persisted_enabled) === 0) concerns.push('Сервис выключен.');
  if (!groupId) concerns.push('Группа сервиса не подключена.');
  if (!me.ok) concerns.push('Связь с ботом не подтверждена.');
  if (!topics) concerns.push('Право сервисного бота управлять темами не подтверждено.');
  if (!managerTopics) concerns.push('Право Админушки управлять темами не подтверждено.');
  if (!managerPin) concerns.push('Право Админушки закреплять сообщения не подтверждено.');
  if (groupId && !administratorPresent) concerns.push('Присутствие главного администратора в группе не подтверждено.');
  if (!webhook.ok || webhook.result?.url !== expectedWebhook) concerns.push('Webhook требует проверки.');
  if (Number(webhook.result?.pending_update_count) > 0) concerns.push('В Telegram есть ожидающие обновления.');
  if ((!evidence?.inbound || !evidence?.outbound) && !evidence?.tested) concerns.push('Обмен сообщениями в обе стороны ещё не подтверждён.');
  const testStage = { waiting: 'ожидает открытия бота', creating: 'создание темы не подтверждено',
    reply: 'ожидает контрольного ответа', sending: 'ответ не подтверждён',
    unconfirmed: 'не подтверждён', done: 'завершён' }[evidence?.test_stage] || 'не проводился';
  if (evidence?.test_stage && evidence.test_stage !== 'done') concerns.push(`Контрольный обмен: ${testStage}.`);
  const key = managementBotKey(parseBotRegistry(env.BOT_REGISTRY), service.id);
  const lines = [`Готовность · ${opaqueManagerText(safeText(service.displayName))}`, '',
    concerns.length ? `⚠️ Требует проверки: ${concerns.length}\n${concerns.map(item => '• ' + item).join('\n')}`
      : '✅ Подключение и обмен сообщениями подтверждены.'];
  const messageState = field => evidence?.[`${field}_text`] && evidence?.[`${field}_enabled`] !== 0 ? 'включено'
    : evidence?.[`${field}_text`] || evidence?.[`${field}_reviewed`] ? 'выключено осознанно' : 'не настроено';
  if (details) lines.push('', `Группа: ${groupId || 'не подключена'}`,
    `Telegram: ${me.ok ? 'подтверждён' : 'нет подтверждения'}`,
    `Сервисный бот · темы: ${topics ? 'право подтверждено' : 'нет подтверждения'}`,
    `Админушка · темы: ${managerTopics ? 'право подтверждено' : 'нет подтверждения'} · закрепление: ${managerPin ? 'право подтверждено' : 'нет подтверждения'}`,
    `Главный администратор в группе: ${administratorPresent ? 'подтверждён' : 'не подтверждён'}`,
    `Webhook: ${webhook.ok && webhook.result?.url === expectedWebhook ? 'подтверждён' : 'нет подтверждения'}`,
    `Очередь Telegram: ${webhook.result?.pending_update_count ?? '—'}`,
    `Входящее: ${formatTime(evidence?.inbound)} · ответ: ${formatTime(evidence?.outbound)}`,
    `Контрольный обмен: ${testStage} · последний успех ${formatTime(evidence?.tested)}`,
    `Приветствие: ${messageState('welcome')}`,
    `Автоответ: ${messageState('auto_reply')}`,
    `Реакции: поддержка → пользователь ${evidence?.support_to_user_verified ? 'проверено' : 'не проверено'}, ${evidence?.support_to_user_enabled ? 'включено' : 'выключено'}; `
      + `пользователь → поддержка ${evidence?.user_to_support_verified ? 'проверено' : 'не проверено'}, ${evidence?.user_to_support_enabled ? 'включено' : 'выключено'}`);
  return show(lines.join('\n').slice(0, 3900),
    [...(Number(actorId) === primaryId(env) ? [[button('🧪 Контрольный обмен', `mg:test:${key}`)],
      [button('Сообщения', `mg:msgs:${key}`), button('Реакции', `mg:rx:${key}`)]] : []),
      [button('Проблемы доставки', `mg:problems:${key}:0`)],
      [button(details ? 'Краткий результат' : 'Технические детали', `mg:ready:${key}:${details ? 'brief' : 'details'}`)],
      [button('Обновить', `mg:ready:${key}:${details ? 'details' : 'brief'}`)],
      [button('К сервису', `mg:service:${key}`)]]);
}

/** Call only after manager-bot has authorized the actor for this service. */
export async function showManagerDeliveryDiagnostics(env, db, actorId, config, userId, page, show) {
  void actorId;
  const [service] = knownServices(env, config);
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid diagnostic user id');
  const currentPage = Number.isSafeInteger(Number(page)) ? Math.max(0, Math.min(100, Number(page))) : 0;
  const [conversation, work, snapshot, audit] = await Promise.all([
    first(db, `SELECT support_group_id,thread_id,status,first_name,last_name,username,created_at,last_message_at
      FROM conversations WHERE bot_id=? AND user_id=?`, service.id, id),
    first(db, `SELECT state,assigned_to,snoozed_until,last_inbound_at,last_answer_at,revision
      FROM conversation_work WHERE bot_id=? AND user_id=?`, service.id, id),
    deliverySnapshot(db, env, service.id),
    all(db, `SELECT action,result,created_at FROM operator_audit WHERE bot_id=? AND user_id=?
      ORDER BY rowid DESC LIMIT 6`, service.id, id),
  ]);
  const events = (snapshot.rows || []).filter(row => Number(row.user_id) === id);
  const pageSize = 5, pageCount = Math.max(1, Math.ceil(events.length / pageSize));
  const safePage = Math.min(currentPage, pageCount - 1);
  const lines = [`Доставка · ${opaqueManagerText(safeText(service.displayName || service.id))} · ${id}`, ''];
  if (conversation) {
    const name = customerName(conversation, id);
    lines.push(`Пользователь: ${opaqueManagerText(safeText(name))}${conversation.username && name !== `@${conversation.username}` ? ` · ${opaqueManagerText('@' + safeText(conversation.username))}` : ''}`,
      `Тема: ${conversation.status === 'closed' ? 'закрыта' : 'открыта'} · группа ${conversation.support_group_id} · тема #${conversation.thread_id}`,
      `Последнее сообщение: ${formatTime(conversation.last_message_at || conversation.created_at)}`);
  } else lines.push('Активная карточка обращения не найдена.');
  if (work) lines.push(`Очередь операторов: ${safeText(work.state)} · ответственный ${work.assigned_to || 'не назначен'}`,
    `Входящее: ${formatTime(work.last_inbound_at)} · ответ: ${formatTime(work.last_answer_at)}`);
  lines.push('', `Незавершённые доставки: ${events.length}${snapshot.limited ? '+' : ''}`);
  if (events.length) {
    const reasonLabel = { uncertain: 'исход неясен', captcha: 'ожидает капчу', banned: 'пользователь заблокирован',
      restricted: 'пользователь ограничен', muted: 'временное ограничение', disabled: 'бот выключен', telegram: 'нужен повтор от Telegram' };
    for (const event of events.slice(safePage * pageSize, (safePage + 1) * pageSize)) {
      const direction = event.direction === 'support_to_user' ? 'оператор → клиент' : 'клиент → поддержка';
      const reason = event.reason ? ` · ${reasonLabel[event.reason] || event.reason}` : ' · можно повторить';
      lines.push(`${direction}${reason} · сообщение ${event.source_chat_id}/${event.source_message_id}`);
    }
    if (events.length > pageSize) lines.push(`Страница ${safePage + 1}/${pageCount}`);
  } else lines.push('Записей о незавершённой доставке для пользователя нет.');
  const recentAudit = audit.results || [];
  if (recentAudit.length) {
    lines.push('', 'Последние действия:');
    for (const row of recentAudit.slice(0, 3)) lines.push(`${formatTime(row.created_at)} · ${safeText(row.action)} · ${safeText(row.result)}`);
  }
  const key = managementBotKey(parseBotRegistry(env.BOT_REGISTRY), service.id);
  const rows = [];
  if (conversation) rows.push([{ text: 'Открыть тему', url: `https://t.me/c/${String(conversation.support_group_id).replace(/^-100/, '')}/${conversation.thread_id}` }]);
  if (pageCount > 1) rows.push([
    ...(safePage > 0 ? [button('←', `mg:diag:${key}:${id}:${safePage - 1}`)] : []),
    ...(safePage + 1 < pageCount ? [button('→', `mg:diag:${key}:${id}:${safePage + 1}`)] : []),
  ]);
  rows.push([button('Здоровье системы', 'mg:health')], [button('Назад к сервису', `mg:service:${key}`)]);
  return show(lines.join('\n').slice(0, 3900), rows);
}
