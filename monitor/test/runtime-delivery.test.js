import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from '../../test/helpers/sqlite-d1.js';
import { collectRuntime, summarizeRuntime } from '../runtime-health.js';
import { collectDeliveryHealth } from '../delivery-health.js';
import { createMonitorContext } from '../budget.js';
const now = new Date('2026-09-09T12:00:00.000Z');
const database = () => new SqliteD1(new URL('../migrations/', import.meta.url));
function runtimeFetch({ unitValue = 9000, sample = 100, p90Unavailable = false } = {}) {
  return async (_url, init) => {
    const { query } = JSON.parse(init.body);
    if (p90Unavailable && query.includes('cpuTimeP90')) return Response.json({ errors: [{ message: 'unknown field cpuTimeP90' }] });
    const rows = query.includes('RuntimeStatus') ? [
      { dimensions: { status: 'success', datetimeFifteenMinutes: '2026-09-09T11:00:00Z' }, sum: { requests: 90 } },
      { dimensions: { status: 'scriptThrewException', datetimeFifteenMinutes: '2026-09-09T11:00:00Z' }, sum: { requests: 10 } },
      { dimensions: { status: 'exceededResources', datetimeFifteenMinutes: '2026-09-09T10:30:00Z' }, sum: { requests: 1 } },
    ] : ['11:00', '11:15'].map((time) => ({ dimensions: { scriptName: 'support', datetimeFifteenMinutes: `2026-09-09T${time}:00Z` }, sum: { requests: sample }, quantiles: { cpuTimeP99: unitValue } }));
    return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } } });
  };
}
test('runtime keeps percentiles within time buckets, catches past spikes, and falls back only on schema errors', async () => {
  const db = database();
  try {
    const ctx = createMonitorContext({ MONITOR_DB: db, RUNTIME_SCRIPT_NAMES: '["support"]', RUNTIME_CPU_UNIT: 'microseconds', RUNTIME_CPU_P90: 'true' }, runtimeFetch({ p90Unavailable: true }));
    const result = await collectRuntime(ctx.env, now, ctx.fetch);
    assert.equal(result.cpuQuality, 'available');
    const incidents = Object.fromEntries(db.sqlite.prepare('SELECT incident_key, severity FROM monitor_incidents').all().map((row) => [row.incident_key, row.severity]));
    assert.equal(incidents['runtime:cpu:support'], 70);
    assert.equal(incidents['runtime:resources:support'], 95);
    assert.equal(incidents['runtime:exceptions:support'], 95);
    const payload = JSON.parse(db.sqlite.prepare('SELECT payload FROM runtime_samples').get().payload);
    assert.equal(payload.cpu.p99, 9);
    assert.equal(ctx.budget.requests, 3);
    assert.ok(ctx.budget.statements < 15);
  } finally { db.close(); }
});
test('low traffic, unknown units and new status never manufacture healthy CPU percentages', async () => {
  assert.equal(summarizeRuntime([{ dimensions: { status: 'newStatus' }, sum: { requests: 10 } }]).quality, 'partial');
  for (const config of [{ RUNTIME_CPU_UNIT: 'unverified' }, { RUNTIME_CPU_UNIT: 'microseconds', sample: 2 }]) {
    const db = database();
    try {
      await collectRuntime({ MONITOR_DB: db, RUNTIME_SCRIPT_NAMES: '["support"]', ...config }, now, runtimeFetch({ sample: config.sample }));
      const cpu = db.sqlite.prepare("SELECT * FROM monitor_incidents WHERE incident_key = 'runtime:cpu:support'").get();
      assert.equal(cpu.severity, 0);
      assert.equal(cpu.quality, 'unavailable');
    } finally { db.close(); }
  }
});
test('delivery alerts distinguish stalled, uncertain and inbound failure; separate complete samples recover', async () => {
  const db = database();
  try {
    let measured = now;
    let healthy = false;
    const env = { MONITOR_DB: db, SUPPORT_HEALTH: { services: async () => [{ id: 'bot', name: 'Support' }], snapshot: async () => ({ botId: 'bot', measuredAt: measured.toISOString(), pending: healthy ? 0 : 2, oldestSeconds: healthy ? 0 : 3600,
      oldestAt: healthy ? null : '2026-09-09T11:00:00Z', uncertain: healthy ? 0 : 1, quality: 'available', signals: [], webhook: { quality: 'available', configured: true, matchesExpected: healthy, pending: healthy ? 0 : 3, recentError: !healthy } }) } };
    await collectDeliveryHealth(env, measured);
    measured = new Date(now.getTime() + 900000);
    await collectDeliveryHealth(env, measured);
    assert.equal(db.sqlite.prepare("SELECT severity FROM monitor_incidents WHERE incident_key = 'delivery:queue:bot'").get().severity, 95);
    assert.equal(db.sqlite.prepare("SELECT severity FROM monitor_incidents WHERE incident_key = 'delivery:ingress:bot'").get().severity, 95);
    healthy = true;
    for (let n = 2; n < 4; n++) { measured = new Date(now.getTime() + n * 900000); await collectDeliveryHealth(env, measured); }
    assert.equal(db.sqlite.prepare("SELECT severity FROM monitor_incidents WHERE incident_key = 'delivery:queue:bot'").get().severity, 0);
  } finally { db.close(); }
});
