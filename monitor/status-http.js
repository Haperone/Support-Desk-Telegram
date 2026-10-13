import { readAlertRoute } from './alert-config.js';

const MINUTE = 60_000;
const validTime = value => Number.isFinite(Date.parse(value));
const latest = values => values.filter(validTime).sort().at(-1) || null;
const fresh = (value, now, minutes) => validTime(value)
  && Date.parse(value) <= now.getTime() + MINUTE && now.getTime() - Date.parse(value) <= minutes * MINUTE;

async function timed(task) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Health probe timeout')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function monitorStatus(env, now = new Date()) {
  const result = { schemaVersion: 1, measuredAt: now.toISOString(), overall: 'degraded',
    monitorDatabase: 'unavailable', support: 'unavailable', checks: [], services: [],
    incidents: { total: null, items: [] }, alerts: { route: 'unavailable', lastSuccessAt: null, lastFailureAt: null },
    runtimeEnabled: env.MONITOR_RUNTIME_ENABLED === 'true' };
  const [planProbe, servicesProbe] = await Promise.allSettled([
    timed(() => env.SUPPORT_PLAN.getPlan()), timed(() => env.SUPPORT_HEALTH.services()),
  ]);
  const plan = planProbe.status === 'fulfilled' ? planProbe.value : null;
  const services = servicesProbe.status === 'fulfilled' && Array.isArray(servicesProbe.value)
    && servicesProbe.value.length <= 1000 ? servicesProbe.value : null;
  if (plan && ['free', 'paid'].includes(plan.plan) && services) result.support = 'available';
  try {
    const state = Object.fromEntries((await timed(() => env.MONITOR_DB.prepare(`SELECT key, value FROM monitor_state
      WHERE key IN ('d1_analytics_last_success', 'alert_delivery_status')`).all()))
      .results.map(row => [row.key, row.value]));
    const incidents = (await timed(() => env.MONITOR_DB.prepare(`SELECT incident_key, severity, quality, message, last_seen, last_sent
      FROM monitor_incidents ORDER BY incident_key LIMIT 1000`).all())).results;
    const usage = await timed(() => env.MONITOR_DB.prepare('SELECT checked_at FROM usage_snapshots ORDER BY checked_at DESC LIMIT 1').first());
    const history = await timed(() => env.MONITOR_DB.prepare(`SELECT MAX(sent_at) AS last_sent FROM (
      SELECT MAX(sent_at) AS sent_at FROM sent_alerts UNION ALL SELECT MAX(last_sent) FROM monitor_incidents)`).first());
    result.checks = [{ id: 'usage', status: fresh(usage?.checked_at, now, 60) ? 'available' : 'stale',
      measuredAt: usage?.checked_at || null },
    { id: 'd1_analytics', status: fresh(state.d1_analytics_last_success, now, 60) ? 'available' : 'stale',
      measuredAt: state.d1_analytics_last_success || null }];
    for (const job of ['storage', 'delivery', 'alerts', 'maintenance', ...(result.runtimeEnabled ? ['runtime'] : [])]) {
      const item = incidents.find(row => row.incident_key === `monitor:${job}`);
      result.checks.push({ id: job, status: !fresh(item?.last_seen, now, 60) ? 'stale'
        : item.severity > 0 || item.quality !== 'available' ? 'degraded' : 'available', measuredAt: item?.last_seen || null });
    }
    const activeServices = new Set((services || []).map(service => service.id));
    const relevant = row => !row.incident_key.startsWith('delivery:') || activeServices.has(row.incident_key.split(':').slice(2).join(':'));
    const active = incidents.filter(row => row.severity > 0 && relevant(row));
    result.incidents = { total: active.length, items: active.slice(0, 5).map(row => ({
      key: row.incident_key, severity: row.severity, quality: row.quality, message: row.message.slice(0, 300), measuredAt: row.last_seen,
    })) };
    result.services = (services || []).slice(0, 50).map(service => {
      const observations = incidents.filter(row => row.incident_key.startsWith('delivery:') && row.incident_key.endsWith(`:${service.id}`));
      const measuredAt = observations.length === 5 ? observations.map(row => row.last_seen).sort()[0] : null;
      return { id: service.id, name: String(service.name || service.id).slice(0, 80), measuredAt,
        status: !fresh(measuredAt, now, Math.max(60, services.length * 30 + 30)) ? 'stale'
          : observations.some(row => row.severity > 0 || row.quality !== 'available') ? 'degraded' : 'available' };
    });
    if (services?.length > 50 || incidents.length === 1000) result.support = 'partial';
    let delivery = {};
    try { delivery = JSON.parse(state.alert_delivery_status || '{}'); } catch { /* Older state still has the send history. */ }
    result.alerts.lastSuccessAt = latest([delivery.lastSuccessAt, history?.last_sent]);
    result.alerts.lastFailureAt = validTime(delivery.lastFailureAt) ? delivery.lastFailureAt : null;
    result.alerts.lastFailureKind = delivery.lastFailureKind || null;
    result.monitorDatabase = 'available';
  } catch { /* Return explicit degradation without exposing D1 errors or credentials. */ }
  try {
    const route = await timed(() => readAlertRoute(env));
    result.alerts.route = route?.mode || 'disabled';
  } catch { /* An inaccessible route is independently visible. */ }
  const alertFailed = result.alerts.lastFailureAt && (!result.alerts.lastSuccessAt
    || result.alerts.lastFailureAt > result.alerts.lastSuccessAt);
  if (result.monitorDatabase === 'available' && result.support === 'available'
    && result.checks.every(check => check.status === 'available') && result.services.every(service => service.status === 'available')
    && result.incidents.total === 0 && ['group', 'private'].includes(result.alerts.route) && !alertFailed) result.overall = 'healthy';
  return result;
}

function sameToken(provided, expected) {
  if (!/^[a-f0-9]{64}$/i.test(expected || '') || provided.length !== expected.length) return false;
  let different = 0;
  for (let index = 0; index < expected.length; index++) different |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  return different === 0;
}

export async function statusHttpResponse(request, env, now = new Date()) {
  if (new URL(request.url).pathname !== '/health/status') return null;
  const headers = { 'cache-control': 'no-store', vary: 'Authorization' };
  if (!env.STATUS_READ_TOKEN) return new Response('Not found', { status: 404, headers });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { ...headers, allow: 'GET' } });
  const authorization = request.headers.get('authorization') || '';
  if (!sameToken(authorization.startsWith('Bearer ') ? authorization.slice(7) : '', env.STATUS_READ_TOKEN))
    return new Response('Unauthorized', { status: 401, headers });
  const snapshot = await monitorStatus(env, now);
  return Response.json(snapshot, { status: snapshot.overall === 'healthy' ? 200 : 503, headers });
}
