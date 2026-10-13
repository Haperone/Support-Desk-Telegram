import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from '../../test/helpers/sqlite-d1.js';
import { monitorStatus, statusHttpResponse } from '../status-http.js';
import { recordAlertDelivery } from '../status-telemetry.js';
import { createMonitorContext } from '../budget.js';
import { sendTelegram } from '../worker.js';

const now = new Date('2026-10-12T18:00:00.000Z');
function fixture() {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  db.sqlite.prepare(`INSERT INTO usage_snapshots(checked_at,day_utc,worker_requests,kv_reads,kv_writes,kv_deletes,kv_lists)
    VALUES(?, '2026-10-12', 1,0,0,0,0)`).run(now.toISOString());
  db.sqlite.prepare('INSERT INTO monitor_state VALUES (?, ?)').run('d1_analytics_last_success', now.toISOString());
  for (const key of ['monitor:storage', 'monitor:delivery', 'monitor:alerts', 'monitor:maintenance',
    ...['queue', 'uncertain', 'ingress', 'checks', 'signals'].map(kind => `delivery:${kind}:support`)]) {
    db.sqlite.prepare(`INSERT INTO monitor_incidents(incident_key,severity,quality,message,first_seen,last_seen)
      VALUES(?,0,'available','OK',?,?)`).run(key, now.toISOString(), now.toISOString());
  }
  const env = { MONITOR_DB: db, STATUS_READ_TOKEN: 'a'.repeat(64), ALERT_BOT_TOKEN: 'bot-secret', ALERT_CHAT_ID: '-100123',
    SUPPORT_PLAN: { getPlan: async () => ({ plan: 'free' }) },
    SUPPORT_HEALTH: { services: async () => [{ id: 'support', name: 'Support' }] } };
  return { db, env };
}

test('status endpoint rejects unauthorized reads without probing any database', async () => {
  const env = { STATUS_READ_TOKEN: 'a'.repeat(64), MONITOR_DB: { prepare() { assert.fail('Unauthorized database read'); } } };
  for (const token of ['', 'Bearer bot-secret', `Bearer ${'b'.repeat(64)}`]) {
    const response = await statusHttpResponse(new Request('https://monitor.test/health/status', { headers: { authorization: token } }), env, now);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(await statusHttpResponse(new Request('https://monitor.test/'), env, now), null);
  assert.equal((await statusHttpResponse(new Request('https://monitor.test/health/status'), {}, now)).status, 404);
  assert.equal((await statusHttpResponse(new Request('https://monitor.test/health/status', { method: 'POST' }), env, now)).status, 405);
});

test('real SQLite reads report fresh checks, active services and historical confirmed alerts', async () => {
  const { db, env } = fixture();
  try {
    db.sqlite.prepare("UPDATE monitor_incidents SET last_sent=? WHERE incident_key='monitor:alerts'").run('2026-09-29T02:15:00Z');
    const response = await statusHttpResponse(new Request('https://monitor.test/health/status', {
      headers: { authorization: `Bearer ${env.STATUS_READ_TOKEN}` },
    }), env, now);
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.overall, 'healthy');
    assert.equal(status.services[0].status, 'available');
    assert.equal(status.alerts.lastSuccessAt, '2026-09-29T02:15:00Z');
    assert.equal(status.runtimeEnabled, false);
    assert.doesNotMatch(JSON.stringify(status), /bot-secret|encrypted_token|access_token/);
    assert.ok(db.queries <= 6);
  } finally { db.close(); }
});

test('stale Cron, database failures and missing alert key never produce a healthy result', async () => {
  const { db, env } = fixture();
  try {
    assert.equal((await monitorStatus(env, new Date(now.getTime() + 61 * 60_000))).overall, 'degraded');
    env.SUPPORT_PLAN.getPlan = async () => { throw new Error('private D1 details'); };
    assert.equal((await monitorStatus(env, now)).support, 'unavailable');
    env.SUPPORT_PLAN.getPlan = async () => ({ plan: 'free' });
    env.ALERT_CONFIG_REQUIRED = 'true';
    assert.equal((await monitorStatus(env, now)).alerts.route, 'unavailable');
    env.MONITOR_DB = { prepare() { throw new Error('database credential'); } };
    const failed = await monitorStatus(env, now);
    assert.equal(failed.monitorDatabase, 'unavailable');
    assert.equal(failed.support, 'available');
    assert.equal(failed.overall, 'degraded');
    assert.doesNotMatch(JSON.stringify(failed), /credential|private D1/);
  } finally { db.close(); }
});

test('paused services are excluded and old service observations are explicitly stale', async () => {
  const { db, env } = fixture();
  try {
    db.sqlite.exec("UPDATE monitor_incidents SET severity=95 WHERE incident_key='delivery:queue:support'");
    assert.equal((await monitorStatus(env, now)).incidents.total, 1);
    env.SUPPORT_HEALTH.services = async () => [];
    const paused = await monitorStatus(env, now);
    assert.equal(paused.incidents.total, 0);
    assert.equal(paused.overall, 'healthy');
    env.SUPPORT_HEALTH.services = async () => [{ id: 'new', name: 'New' }];
    assert.equal((await monitorStatus(env, now)).services[0].status, 'stale');
  } finally { db.close(); }
});

test('send telemetry retains success across later failures and out-of-order observations', async () => {
  const { db, env } = fixture();
  try {
    await recordAlertDelivery(env, { ok: true }, now);
    const later = new Date(now.getTime() + 1000);
    await recordAlertDelivery(env, { ok: false, rateLimited: true, description: 'not stored' }, later);
    await recordAlertDelivery(env, { ok: true }, new Date(now.getTime() - 1000));
    const status = await monitorStatus(env, now);
    assert.equal(status.alerts.lastSuccessAt, now.toISOString());
    assert.equal(status.alerts.lastFailureAt, later.toISOString());
    assert.equal(status.alerts.lastFailureKind, 'rate_limited');
    assert.equal(status.overall, 'degraded');
    const recovery = new Date(later.getTime() + 1000);
    await recordAlertDelivery(env, { ok: true }, recovery);
    assert.equal((await monitorStatus(env, recovery)).overall, 'healthy');
  } finally { db.close(); }
});

test('telemetry cannot exhaust a Free invocation or change successful Telegram delivery', async () => {
  const { db, env } = fixture();
  try {
    const context = createMonitorContext(env);
    for (let index = 0; index < 47; index++) await context.env.MONITOR_DB.prepare('SELECT 1').first();
    await recordAlertDelivery(context.env, { ok: true }, now);
    assert.equal(context.budget.statements, 47);
    db.prepare = () => { throw new Error('read-only database'); };
    assert.equal((await sendTelegram(env, 'test', async () => Response.json({ ok: true }))).ok, true);
  } finally { db.close(); }
});
