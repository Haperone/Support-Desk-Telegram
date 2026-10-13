import { requestTelegram } from '../telegram-response.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{20,150}$/;
const now = () => new Date().toISOString();
const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
const base64 = bytes => btoa(String.fromCharCode(...bytes));
const fromBase64 = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));

export const ALERT_CONFIG_MESSAGES = {
  keyUnavailable:{en:'The monitor alert settings key is not configured yet.',ru:'Ключ настроек алертов ещё не установлен в мониторе.',es:'La clave de configuración de alertas aún no está configurada en el monitor.',zh:'监控器尚未配置警报设置密钥。'},
  tokenCorrupt:{en:'The saved alert-bot token is damaged.',ru:'Сохранённый токен алерт-бота повреждён.',es:'El token guardado del bot de alertas está dañado.',zh:'已保存的警报机器人令牌已损坏。'},
  recipients:{en:'Select the administrator and no more than 40 operators.',ru:'Выберите администратора и не более 40 операторов.',es:'Selecciona al administrador y como máximo 40 operadores.',zh:'请选择管理员，最多再选 40 位操作员。'},
  outcomeUnknown:{en:'Telegram’s verification result is unclear. Check the new chat before retrying.',ru:'Результат проверки Telegram неясен. Осмотрите новый чат перед повтором.',es:'El resultado de la verificación de Telegram no está claro. Revisa el nuevo chat antes de volver a intentarlo.',zh:'Telegram 的验证结果不明确。重试前请检查新聊天。'},
  rateLimited:{en:'Telegram limited requests. Retry in {0} sec.',ru:'Telegram ограничил запросы. Повторите через {0} сек.',es:'Telegram limitó las solicitudes. Vuelve a intentarlo en {0} s.',zh:'Telegram 限制了请求。请在 {0} 秒后重试。'},
  botAccess:{en:'Telegram did not confirm that the bot can access the selected chat. Check its permissions and retry.',ru:'Telegram не подтвердил доступ бота к выбранному чату. Проверьте права и повторите.',es:'Telegram no confirmó que el bot pueda acceder al chat seleccionado. Revisa sus permisos y vuelve a intentarlo.',zh:'Telegram 未确认机器人可以访问所选聊天。请检查权限后重试。'},
  missingKey:{en:'The alert settings key is missing. Delivery is stopped.',ru:'Ключ настроек алертов отсутствует. Доставка остановлена.',es:'Falta la clave de configuración de alertas. Se ha detenido la entrega.',zh:'缺少警报设置密钥。消息投递已停止。'},
  stale:{en:'Settings have changed. Reopen the alert settings screen.',ru:'Настройки уже изменились. Откройте экран алертов заново.',es:'La configuración ha cambiado. Vuelve a abrir la pantalla de alertas.',zh:'设置已更改。请重新打开警报设置页面。'},
  tokenAdmin:{en:'A valid token and primary administrator ID are required.',ru:'Нужен корректный токен и ID главного администратора.',es:'Se necesita un token válido y el ID del administrador principal.',zh:'需要有效的令牌和主管理员 ID。'},
  usernameBot:{en:'The token does not belong to a Telegram bot with a public username.',ru:'Токен не принадлежит боту Telegram с публичным username.',es:'El token no pertenece a un bot de Telegram con nombre de usuario público.',zh:'该令牌不属于具有公开用户名的 Telegram 机器人。'},
  startBot:{en:'Open @{0}, press Start, then retry the connection. {1}',ru:'Откройте @{0}, нажмите Start и повторите подключение. {1}',es:'Abre @{0}, pulsa Iniciar y vuelve a conectar. {1}',zh:'打开 @{0}，点击“开始”，然后重试连接。{1}'},
  connectProbe:{en:'✅ Alert-bot delivery check. After connecting, alerts will be sent here.',ru:'✅ Проверка доставки алерт-бота. После подключения предупреждения будут приходить сюда.',es:'✅ Prueba de entrega del bot de alertas. Después de conectarlo, las alertas llegarán aquí.',zh:'✅ 警报机器人投递测试。连接后，警报将发送到此处。'},
  oldBot:{en:'🔕 @{0} will stop sending alerts here because @{1} was connected.',ru:'🔕 @{0} больше не будет отправлять сюда предупреждения: подключён @{1}.',es:'🔕 @{0} dejará de enviar alertas aquí porque se conectó @{1}.',zh:'🔕 @{0} 将不再向此处发送警报，因为已连接 @{1}。'},
  noBot:{en:'Connect an alert bot first.',ru:'Сначала подключите алерт-бота.',es:'Primero conecta un bot de alertas.',zh:'请先连接警报机器人。'},
  group:{en:'Select a support-group topic.',ru:'Выберите топик группы поддержки.',es:'Selecciona un tema del grupo de soporte.',zh:'请选择支持群组中的话题。'},
  mode:{en:'Unknown alert route mode.',ru:'Неизвестный режим алертов.',es:'Modo de destino de alertas desconocido.',zh:'未知的警报投递模式。'},
  same:{en:'This alert destination is already selected.',ru:'Этот адрес алертов уже выбран.',es:'Este destino de alertas ya está seleccionado.',zh:'已选择此警报投递目标。'},
  newDestination:{en:'✅ New alert destination check. The switch is not complete yet.',ru:'✅ Проверка нового места доставки алертов. Переключение ещё не завершено.',es:'✅ Prueba del nuevo destino de alertas. El cambio aún no se ha completado.',zh:'✅ 新警报投递目标测试。切换尚未完成。'},
  switched:{en:'🔕 Alerts were moved to another chat. New alerts will no longer arrive here.',ru:'🔕 Алерты переключены в другой чат. Сюда новые предупреждения больше не приходят.',es:'🔕 Las alertas se trasladaron a otro chat. Ya no recibirás alertas nuevas aquí.',zh:'🔕 警报已切换到其他聊天。此处将不再收到新警报。'},
  disabled:{en:'The alert bot is already disconnected.',ru:'Алерт-бот уже отключён.',es:'El bot de alertas ya está desconectado.',zh:'警报机器人已断开连接。'},
  removed:{en:'🔕 The alert bot was disconnected from support. Alerts are not being delivered now.',ru:'🔕 Алерт-бот отключён от поддержки. Предупреждения сейчас не доставляются.',es:'🔕 El bot de alertas se desconectó del soporte. Ahora no se están entregando alertas.',zh:'🔕 警报机器人已从支持服务断开。目前不会投递警报。'},
};
const ERROR_MESSAGE_KEYS = Object.freeze([
  'keyUnavailable','tokenCorrupt','recipients','outcomeUnknown','rateLimited','botAccess','missingKey','stale',
  'tokenAdmin','usernameBot','startBot','noBot','group','mode','same','disabled',
]);
const ALERT_LOCALES = Object.freeze(['en','ru','es','zh']);

function matchMessageTemplate(template, message) {
  const pieces = template.split(/(\{\d+\})/g);
  const names = [];
  let pattern = '^';
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const placeholder = /^\{(\d+)\}$/.exec(piece);
    if (placeholder) {
      names.push(Number(placeholder[1]));
      pattern += placeholder[1] === '1' ? '(.+)' : '(.+?)';
    } else pattern += piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const match = new RegExp(`${pattern}$`, 'su').exec(String(message));
  if (!match) return null;
  return Object.fromEntries(names.map((name, index) => [name, match[index + 1]]));
}

function renderMessageTemplate(template, values) {
  return template.replace(/\{(\d+)\}/g, (_match, index) => values[Number(index)] ?? '');
}

function translateKnownAlertError(message, locale, depth = 0) {
  if (depth > 2) return null;
  for (const key of ERROR_MESSAGE_KEYS) {
    for (const sourceLocale of ALERT_LOCALES) {
      const values = matchMessageTemplate(ALERT_CONFIG_MESSAGES[key][sourceLocale], message);
      if (!values) continue;
      if (key === 'rateLimited' && !/^\d{1,9}$/.test(values[0])) continue;
      if (key === 'startBot') {
        if (!/^[A-Za-z0-9_]{5,32}$/.test(values[0])) continue;
        if (depth === 2) return null;
        const translatedReason = translateKnownAlertError(values[1], locale, depth + 1);
        if (translatedReason == null) return null;
        values[1] = translatedReason;
      }
      return renderMessageTemplate(ALERT_CONFIG_MESSAGES[key][locale], values);
    }
  }
  return null;
}

export function localizedAlertConfigError(message, locale) {
  const language = ALERT_LOCALES.includes(locale) ? locale : 'en';
  return translateKnownAlertError(message, language);
}

function alertText(env,key,...values) {
  const language=['en','ru','es','zh'].includes(env.MONITOR_LOCALE)?env.MONITOR_LOCALE:'en';
  return ALERT_CONFIG_MESSAGES[key][language].replace(/\{(\d+)\}/g,(_match,index)=>values[index]??'');
}

export class AlertConfigError extends Error {}

async function cryptoKey(env) {
  if (!/^[a-f0-9]{64}$/i.test(env.ALERT_CONFIG_KEY || '')) throw new AlertConfigError(alertText(env,'keyUnavailable'));
  const bytes = Uint8Array.from(env.ALERT_CONFIG_KEY.match(/../g), value => parseInt(value, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealToken(env, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: encoder.encode('monitor-alert-token:v1') }, await cryptoKey(env), encoder.encode(token)));
  return `v1.${base64(iv)}.${base64(encrypted)}`;
}

async function openToken(env, value) {
  const [version, iv, ciphertext, extra] = String(value || '').split('.');
  if (version !== 'v1' || !iv || !ciphertext || extra) throw new AlertConfigError(alertText(env,'tokenCorrupt'));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv),
    additionalData: encoder.encode('monitor-alert-token:v1') }, await cryptoKey(env), fromBase64(ciphertext));
  return decoder.decode(plain);
}

function validRecipient(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0; }
function recipients(values,env) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 41 || values.some(value => !validRecipient(value)))
    throw new AlertConfigError(alertText(env,'recipients'));
  return [...new Set(values.map(Number))];
}

async function telegram(env, token, method, body, fetchImpl) {
  const result = await requestTelegram({ token, method, body, fetchImpl, timeoutMs: 10000 });
  if (!result.ok) throw new AlertConfigError(result.deliveryUncertain
    ? alertText(env,'outcomeUnknown')
    : result.rateLimited ? alertText(env,'rateLimited',result.retryAfterSeconds||60)
      : alertText(env,'botAccess'));
  return result.result;
}

async function readRow(env) {
  try { return await first(env.MONITOR_DB, 'SELECT * FROM alert_delivery_config WHERE id=1'); }
  catch (error) {
    // Keep the legacy alert route available during the migration and in the
    // independent emergency path. Once the encryption key is configured,
    // failing closed prevents a stale legacy destination from receiving alerts.
    if (env.ALERT_CONFIG_KEY) throw error;
    return null;
  }
}

export async function readAlertRoute(env) {
  // Existing installations keep their D1-free legacy route until the new key
  // is installed. Once the UI is enabled, losing that key must fail closed.
  if (!env.ALERT_CONFIG_KEY) {
    if (env.ALERT_CONFIG_REQUIRED === 'true') throw new AlertConfigError(alertText(env,'missingKey'));
    return legacyRoute(env);
  }
  const context = env.MONITOR_CONTEXT;
  if (context?.alertRoutePromise) return context.alertRoutePromise;
  const routePromise = readConfiguredRoute(env);
  if (context) context.alertRoutePromise = routePromise;
  return routePromise;
}

function legacyRoute(env) {
  if (!env.ALERT_BOT_TOKEN || !env.ALERT_CHAT_ID) return null;
  return { generation: 0, mode: 'group', username: null, botId: null, token: env.ALERT_BOT_TOKEN,
    chatId: Number(env.ALERT_CHAT_ID), threadId: env.ALERT_THREAD_ID ? Number(env.ALERT_THREAD_ID) : null,
    recipients: [] };
}

async function readConfiguredRoute(env) {
  const row = await readRow(env);
  if (row) {
    if (row.mode === 'disabled') return null;
    return { generation: Number(row.generation), mode: row.mode, username: row.username,
      botId: Number(row.bot_id), token: await openToken(env, row.encrypted_token),
      chatId: Number(row.chat_id), threadId: row.thread_id == null ? null : Number(row.thread_id),
      recipients: JSON.parse(row.recipients_json) };
  }
  return legacyRoute(env);
}

export async function alertStatus(env, fetchImpl = fetch) {
  const row = await readRow(env);
  if (row) return { generation: Number(row.generation), mode: row.mode,
    username: row.username, botId: row.bot_id, chatId: row.chat_id, threadId: row.thread_id,
    recipients: JSON.parse(row.recipients_json) };
  let identity = null;
  if (env.ALERT_BOT_TOKEN) {
    try {
      const response = await requestTelegram({ token: env.ALERT_BOT_TOKEN, method: 'getMe', body: {}, fetchImpl, timeoutMs: 5000 });
      if (response.ok && response.result?.is_bot) identity = response.result;
    } catch { /* A temporary Telegram failure must not hide the current route. */ }
  }
  return { generation: 0, mode: env.ALERT_BOT_TOKEN && env.ALERT_CHAT_ID ? 'group' : 'disabled',
    username: identity?.username || null, botId: identity?.id || null, chatId: env.ALERT_CHAT_ID ? Number(env.ALERT_CHAT_ID) : null,
    threadId: env.ALERT_THREAD_ID ? Number(env.ALERT_THREAD_ID) : null, recipients: [] };
}

async function sendTo(env, token, destination, text, fetchImpl) {
  const chats = destination.mode === 'private' ? destination.recipients.map(chatId => ({ chat_id: chatId }))
    : [{ chat_id: destination.chatId, ...(destination.threadId ? { message_thread_id: destination.threadId } : {}) }];
  for (const chat of chats) await telegram(env, token, 'sendMessage', { ...chat, text }, fetchImpl);
}

async function notifyOld(env, route, text, fetchImpl, replacement = null) {
  if (!route) return false;
  const destination = route.mode === 'private' && replacement?.mode === 'private'
    ? { mode: 'private', recipients: route.recipients.filter(id => !replacement.recipients.includes(id)) } : route;
  if (destination.mode === 'private' && destination.recipients.length === 0) return true;
  if (destination.mode === 'private') {
    const outcomes = await Promise.allSettled(destination.recipients.map(chatId => telegram(env, route.token, 'sendMessage',
      { chat_id: chatId, text }, fetchImpl)));
    return outcomes.every(outcome => outcome.status === 'fulfilled');
  }
  try { await sendTo(env, route.token, destination, text, fetchImpl); return true; }
  catch { return false; }
}

async function save(env, expectedGeneration, next) {
  const row = await readRow(env);
  const current = Number(row?.generation || 0);
  if (current !== expectedGeneration) throw new AlertConfigError(alertText(env,'stale'));
  const values = [next.mode, next.username || null, next.botId || null, next.encryptedToken || null,
    next.chatId || null, next.threadId || null, JSON.stringify(next.recipients || []), now()];
  if (!row) {
    const inserted = await run(env.MONITOR_DB, `INSERT OR IGNORE INTO alert_delivery_config
      (id,generation,mode,username,bot_id,encrypted_token,chat_id,thread_id,recipients_json,updated_at)
      VALUES(1,1,?,?,?,?,?,?,?,?)`, ...values);
    if (inserted.meta?.changes === 1) return 1;
  } else {
    const changed = await run(env.MONITOR_DB, `UPDATE alert_delivery_config SET generation=generation+1,
      mode=?,username=?,bot_id=?,encrypted_token=?,chat_id=?,thread_id=?,recipients_json=?,updated_at=?
      WHERE id=1 AND generation=?`, ...values, expectedGeneration);
    if (changed.meta?.changes === 1) return expectedGeneration + 1;
  }
  throw new AlertConfigError(alertText(env,'stale'));
}

export async function connectAlertBot(env, { token, adminId, expectedGeneration }, fetchImpl = fetch) {
  if (!TOKEN.test(String(token || '')) || !validRecipient(adminId)) throw new AlertConfigError(alertText(env,'tokenAdmin'));
  const current = await readAlertRoute(env);
  const status = await alertStatus(env);
  if (status.generation !== expectedGeneration) throw new AlertConfigError(alertText(env,'stale'));
  const me = await telegram(env, token, 'getMe', {}, fetchImpl);
  if (!me?.is_bot || !Number.isSafeInteger(Number(me.id)) || !/^[a-z0-9_]{5,32}$/i.test(me.username || ''))
    throw new AlertConfigError(alertText(env,'usernameBot'));
  const target = current || { mode: 'private', recipients: [Number(adminId)] };
  try { await sendTo(env, token, target, alertText(env,'connectProbe'), fetchImpl); }
  catch (error) {
    if (!current && error instanceof AlertConfigError) throw new AlertConfigError(
      alertText(env,'startBot',me.username,error.message));
    throw error;
  }
  const generation = await save(env, expectedGeneration, { mode: target.mode, username: me.username,
    botId: Number(me.id), encryptedToken: await sealToken(env, token), chatId: target.mode === 'group' ? target.chatId : null,
    threadId: target.mode === 'group' ? target.threadId : null,
    recipients: target.mode === 'private' ? target.recipients : [] });
  const oldNotified = !current || await notifyOld(env,current,
    alertText(env,'oldBot',current?.username || ({en:'previous-alert-bot',ru:'Прежний-алерт-бот',es:'bot-alertas-anterior',zh:'旧警报机器人'}[env.MONITOR_LOCALE]||'previous-alert-bot'),me.username), fetchImpl);
  return { generation, oldNotified, username: me.username, mode: target.mode };
}

export async function switchAlertRoute(env, { expectedGeneration, mode, chatId, threadId, recipientIds }, fetchImpl = fetch) {
  const current = await readAlertRoute(env);
  if (!current) throw new AlertConfigError(alertText(env,'noBot'));
  if (current.generation !== expectedGeneration) throw new AlertConfigError(alertText(env,'stale'));
  let target;
  if (mode === 'group') {
    if (!Number.isSafeInteger(Number(chatId)) || Number(chatId) >= 0 || !Number.isSafeInteger(Number(threadId)) || Number(threadId) <= 1)
      throw new AlertConfigError(alertText(env,'group'));
    target = { mode, chatId: Number(chatId), threadId: Number(threadId) };
  } else if (mode === 'private') target = { mode, recipients: recipients(recipientIds,env) };
  else throw new AlertConfigError(alertText(env,'mode'));
  if (current.mode === target.mode && (mode === 'group'
    ? current.chatId === target.chatId && current.threadId === target.threadId
    : current.recipients.length === target.recipients.length
      && current.recipients.every(id => target.recipients.includes(id))))
    throw new AlertConfigError(alertText(env,'same'));
  const encryptedToken = (await readRow(env))?.encrypted_token || await sealToken(env, current.token);
  await sendTo(env,current.token, target, alertText(env,'newDestination'), fetchImpl);
  const generation = await save(env, expectedGeneration, { mode, username: current.username,
    botId: current.botId, encryptedToken, chatId: target.chatId, threadId: target.threadId,
    recipients: target.recipients });
  const oldNotified = await notifyOld(env,current, alertText(env,'switched'), fetchImpl, target);
  return { generation, oldNotified, mode };
}

export async function removeAlertBot(env, { expectedGeneration }, fetchImpl = fetch) {
  const current = await readAlertRoute(env);
  if (!current) throw new AlertConfigError(alertText(env,'disabled'));
  if (current.generation !== expectedGeneration) throw new AlertConfigError(alertText(env,'stale'));
  const generation = await save(env, expectedGeneration, { mode: 'disabled' });
  const oldNotified = await notifyOld(env,current, alertText(env,'removed'), fetchImpl);
  return { generation, oldNotified, mode: 'disabled' };
}

export async function sendAlert(env, text, fetchImpl = fetch, activeRoute = null, timeoutMs = 10000) {
  const route = activeRoute || await readAlertRoute(env);
  if (!route) return { ok: false, disabled: true, description: 'Alert delivery disabled' };
  const chats = route.mode === 'private' ? route.recipients.map(chatId => ({ chat_id: chatId }))
    : [{ chat_id: route.chatId, ...(route.threadId ? { message_thread_id: route.threadId } : {}) }];
  for (const [index, chat] of chats.entries()) {
    const result = await requestTelegram({ token: route.token, method: 'sendMessage',
      body: { ...chat, text }, fetchImpl, timeoutMs });
    if (!result.ok && index === 0) return result;
    if (!result.ok) console.warn(JSON.stringify({ event: 'alert_operator_delivery_failed', chat_id: chat.chat_id,
      uncertain: result.deliveryUncertain === true }));
  }
  return { ok: true };
}
