import { ADMIN_IDS, ALERT_BOT_USERNAME, STATUS_GROUP_IDS, DISPLAY_TIMEZONE } from './settings.js';
import { statusLocale, statusText } from './copy.js';

export const authorized = actor => Number.isSafeInteger(actor) && ADMIN_IDS.includes(actor);
const validTime = value => Number.isFinite(Date.parse(value));
const checkKeys = { usage: 'usage', d1_analytics: 'd1_analytics', storage: 'storage', delivery: 'delivery',
  alerts: 'alertsJob', maintenance: 'maintenance', runtime: 'runtime' };
const statusKeys = { available: 'available', unavailable: 'unavailable', partial: 'partial', degraded: 'degradedStatus',
  stale: 'stale', disabled: 'disabled', group: 'group', private: 'private' };

function validateSnapshot(snapshot, now, cached = false) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !['healthy', 'degraded'].includes(snapshot.overall)
    || !validTime(snapshot.measuredAt) || !cached && Math.abs(now.getTime() - Date.parse(snapshot.measuredAt)) > 120_000
    || !Array.isArray(snapshot.checks) || snapshot.checks.length > 10 || !Array.isArray(snapshot.services) || snapshot.services.length > 50
    || !snapshot.alerts || !snapshot.incidents || !Array.isArray(snapshot.incidents.items) || snapshot.incidents.items.length > 5
    || !['available', 'unavailable'].includes(snapshot.monitorDatabase) || !['available', 'unavailable', 'partial'].includes(snapshot.support)
    || snapshot.checks.some(item => !item || !checkKeys[item.id] || !['available', 'degraded', 'stale'].includes(item.status))
    || snapshot.services.some(item => !item || typeof item.name !== 'string' || item.name.length > 80 || !['available', 'degraded', 'stale'].includes(item.status))
    || snapshot.incidents.items.some(item => !item || typeof item.message !== 'string' || item.message.length > 300))
    throw new Error('invalid_response');
  return snapshot;
}

export async function configureStatus(input, actor, db) {
  if (!authorized(actor)) throw new Error('forbidden');
  // Telegram's V8 runtime has no global URL constructor.
  const url = input?.monitorUrl;
  const match = typeof url === 'string' && url.match(/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+workers\.dev\/health\/status$/i);
  if (!match || match[0] !== url || url.length > 253 || !/^[a-f0-9]{64}$/i.test(input.accessToken || ''))
    throw new Error('invalid_configuration');
  await db.run(`INSERT INTO alert_status_config(id, monitor_url, access_token) VALUES(1, :url, :token)
    ON CONFLICT(id) DO UPDATE SET monitor_url=excluded.monitor_url, access_token=excluded.access_token`,
  { ':url': url, ':token': input.accessToken });
  await db.run('DELETE FROM alert_status_cache WHERE id=1');
  return { configured: true };
}

export async function loadStatus({ db, fetch }, now = new Date()) {
  const config = await db.get('SELECT monitor_url, access_token FROM alert_status_config WHERE id=1');
  if (!config) return { error: 'not_configured', snapshot: null, fetchedAt: null };
  const cache = await db.get('SELECT * FROM alert_status_cache WHERE id=1');
  let saved = null;
  try { saved = validateSnapshot(JSON.parse(cache?.snapshot_json || 'null'), now, true); }
  catch { /* A fresh request can repair the cache. */ }
  const age = now.getTime() - Date.parse(cache?.attempted_at);
  if ((saved || cache?.error_kind) && age >= 0 && age < 30_000)
    return { error: cache.error_kind, snapshot: saved, fetchedAt: cache.fetched_at, cached: true };
  let snapshot = null, error = null;
  try {
    const response = await fetch(config.monitor_url, { method: 'GET', headers: {
      authorization: `Bearer ${config.access_token}`, accept: 'application/json',
    }, redirect: 'error' });
    if (response.status === 401 || response.status === 403) throw new Error('unauthorized');
    if (![200, 503].includes(response.status)) throw new Error('unreachable');
    snapshot = validateSnapshot(await response.json(), now);
  } catch (failure) {
    error = ['unauthorized', 'invalid_response'].includes(failure?.message) ? failure.message : 'unreachable';
  }
  try {
    await db.run(`INSERT INTO alert_status_cache(id, snapshot_json, fetched_at, attempted_at, error_kind)
      VALUES(1, :snapshot, :fetched, :attempted, :error) ON CONFLICT(id) DO UPDATE SET
      snapshot_json=COALESCE(excluded.snapshot_json, snapshot_json), fetched_at=COALESCE(excluded.fetched_at, fetched_at),
      attempted_at=excluded.attempted_at, error_kind=excluded.error_kind WHERE attempted_at<=excluded.attempted_at`,
    { ':snapshot': snapshot ? JSON.stringify(snapshot) : null, ':fetched': snapshot ? now.toISOString() : null,
      ':attempted': now.toISOString(), ':error': error });
  } catch { /* Status remains usable if Telegram's cache cannot be updated. */ }
  return { error, snapshot: snapshot || saved, fetchedAt: snapshot ? now.toISOString() : cache?.fetched_at || null };
}

function time(value, locale) {
  if (!validTime(value)) return statusText(locale, 'noData');
  return new Date(value).toLocaleString({ en: 'en-GB', ru: 'ru-RU', es: 'es-ES', zh: 'zh-CN' }[locale], { timeZone: DISPLAY_TIMEZONE, day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false });
}
function age(value, now, locale) {
  if (!validTime(value)) return '';
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(value)) / 60_000));
  return minutes < 60 ? statusText(locale, 'minutesAgo', { minutes })
    : statusText(locale, 'hoursAgo', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}
const line = text => String(text).replace(/[\r\n]+/g, ' ');

export function formatStatus(view, now = new Date(), requestedLocale) {
  const locale = statusLocale(requestedLocale);
  const t = (key, values) => statusText(locale, key, values);
  const timestamp = value => time(value, locale);
  const label = (value, fallback = 'unknown') => t(statusKeys[value] || fallback);
  if (view.error === 'not_configured') return `${t('title')}\n\n${t('notConfigured')}`;
  const snapshot = view.snapshot;
  const lines = [t('title'), '', view.error ? t(view.error)
    : t(snapshot?.overall === 'healthy' ? 'healthy' : 'degraded')];
  if (!snapshot) return lines.concat('', t('noSnapshot'), t('onDemand')).join('\n');
  const received = { time: timestamp(view.fetchedAt), age: age(view.fetchedAt, now, locale) };
  if (view.error) lines.push('', t('historical', received), t('historicalWarning'));
  else lines.push(t('received', received));
  lines.push('', t('support', { status: label(snapshot.support) }), t('database', { status: label(snapshot.monitorDatabase) }));
  for (const check of snapshot.checks) lines.push(`${t(checkKeys[check.id])}: ${label(check.status)} · ${timestamp(check.measuredAt)}`);
  if (snapshot.services.length) lines.push('', ...snapshot.services.map(service =>
    `${line(service.name)}: ${label(service.status)} · ${timestamp(service.measuredAt)}`));
  lines.push('', t('incidents', { count: snapshot.incidents.total ?? t('noData') }));
  for (const incident of snapshot.incidents.items) lines.push(`• ${line(incident.message)}`);
  if (snapshot.incidents.items.length) lines.push(t('incidentLanguage'));
  lines.push('', t('alerts', { status: label(snapshot.alerts.route, 'unavailableLabel') }),
    t('lastSuccess', { time: timestamp(snapshot.alerts.lastSuccessAt) }));
  if (snapshot.alerts.lastFailureAt) lines.push(t('lastFailure', { time: timestamp(snapshot.alerts.lastFailureAt) }));
  if (!snapshot.runtimeEnabled) lines.push(t('runtimeDisabled'));
  lines.push('', t('footer', { zone: DISPLAY_TIMEZONE }));
  return lines.join('\n').slice(0, 3900);
}

const keyboard = () => ({ inline_keyboard: [[{ text: statusText(undefined, 'refresh'), callback_data: 'status:refresh' }]] });
function allowedChat(chat, actor) {
  return authorized(actor) && (chat?.type === 'private' && chat.id === actor
    || ['group', 'supergroup'].includes(chat?.type) && STATUS_GROUP_IDS.includes(chat.id));
}
async function readView(dependencies) {
  try { return await loadStatus(dependencies); }
  catch { return { error: 'local_state_unavailable', snapshot: null, fetchedAt: null }; }
}

export async function handleMessage(message, dependencies) {
  if (!allowedChat(message?.chat, message?.from?.id)) return;
  const command = (message.text || '').match(/^\/(?:start|status|health)(?:@(\w+))?(?:\s|$)/i);
  if (!command || command[1] && command[1].toLowerCase() !== ALERT_BOT_USERNAME) return;
  const group = message.chat.type !== 'private';
  return dependencies.api.sendMessage({ chat_id: message.chat.id,
    ...(group && Number.isSafeInteger(message.message_thread_id) && message.message_thread_id > 0
      ? { message_thread_id: message.message_thread_id } : {}),
    ...(group && Number.isSafeInteger(message.message_id) && message.message_id > 0
      ? { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } } : {}),
    text: formatStatus(await readView(dependencies)), reply_markup: keyboard() });
}

export async function handleCallback(query, dependencies) {
  if (query?.data !== 'status:refresh') return;
  if (!allowedChat(query.message?.chat, query.from?.id)) {
    return dependencies.api.answerCallbackQuery({ callback_query_id: query.id, text: statusText(undefined, 'forbidden'), show_alert: true });
  }
  await dependencies.api.answerCallbackQuery({ callback_query_id: query.id });
  try {
    return await dependencies.api.editMessageText({ chat_id: query.message.chat.id, message_id: query.message.message_id,
      text: formatStatus(await readView(dependencies)), reply_markup: keyboard() });
  } catch (error) {
    if (error?.code === 400 && /message is not modified/i.test(error.description || '')) return;
    throw error;
  }
}
