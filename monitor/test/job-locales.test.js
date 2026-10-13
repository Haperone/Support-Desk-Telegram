import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from '../../test/helpers/sqlite-d1.js';
import { monitorText } from '../incident-copy.js';
import { monitorJobName, runOperationalMonitor } from '../runner.js';

const jobs = ['usage', 'storage', 'runtime', 'delivery', 'alerts', 'maintenance'];
const locales = ['en', 'ru', 'es', 'zh'];

test('every scheduler job uses a localized display name in healthy and degraded incident copy', () => {
  for (const locale of locales) {
    const env = { MONITOR_LOCALE: locale };
    for (const key of jobs) {
      const name = monitorJobName(env, key);
      assert.ok(name, `${locale}.${key} has a display name`);
      assert.notEqual(name, key, `${locale}.${key} does not expose the scheduler enum`);
      for (const copyKey of ['job_available', 'job_unavailable', 'job_details']) {
        const message = monitorText(env, copyKey, { job: name });
        assert.ok(message.includes(name), `${locale}.${key}.${copyKey} contains its localized display name`);
        assert.ok(!message.includes(`'${key}'`) && !message.includes(`“${key}”`), `${locale}.${key}.${copyKey} does not expose its enum`);
      }
    }
  }
});

test('operational monitor persists localized scheduler labels in non-English incident rows', async () => {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  let measuredAt;
  const supportHealth = {
    services: async () => [{ id: 'support', name: 'Support' }],
    snapshot: async () => ({ botId: 'support', measuredAt, pending: 0, oldestSeconds: 0, uncertain: 0,
      quality: 'available', signals: [], webhook: { quality: 'available', configured: true, matchesExpected: true, pending: 0 } }),
  };
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.cloudflare.com' && parsed.pathname.endsWith('/graphql'))
      return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [], kvOperationsAdaptiveGroups: [], d1AnalyticsAdaptiveGroups: [] }] } } });
    if (parsed.hostname === 'api.cloudflare.com' && parsed.pathname.endsWith('/d1/database'))
      return Response.json({ success: true, result: [], result_info: { page: 1, per_page: 100, total_count: 0 } });
    if (parsed.hostname === 'api.telegram.org') return Response.json({ ok: true });
    throw new Error(`Unexpected request ${parsed.href}`);
  };
  try {
    const env = { MONITOR_DB: db, MONITOR_HEALTH_ENABLED: 'true', MONITOR_LOCALE: 'es', MONITOR_RUNTIME_ENABLED: 'true',
      CF_ACCOUNT_ID: 'account', CF_ANALYTICS_TOKEN: 'read', ALERT_BOT_TOKEN: 'alert', ALERT_CHAT_ID: '123', SUPPORT_HEALTH: supportHealth };
    const seen = new Set();
    for (let index = 0; index < jobs.length * 5; index++) {
      const now = new Date(Date.UTC(2026, 8, 30, 12, index * 15));
      measuredAt = now.toISOString();
      const result = await runOperationalMonitor(env, { now, fetchImpl });
      for (const job of result.jobs || []) {
        assert.ok(!job.error, `${job.job} does not fail: ${JSON.stringify(job)}`);
        if (!job.deferred) seen.add(job.job);
      }
      if (seen.size === jobs.length) break;
    }
    assert.deepEqual([...seen].sort(), jobs.slice().sort());
    const incidents = db.sqlite.prepare("SELECT incident_key,message FROM monitor_incidents WHERE incident_key LIKE 'monitor:%' ORDER BY incident_key").all();
    assert.equal(incidents.length, jobs.length);
    for (const incident of incidents) {
      const key = incident.incident_key.slice('monitor:'.length);
      const name = monitorJobName({ MONITOR_LOCALE: 'es' }, key);
      assert.ok(incident.message.includes(name), `${key} persists its Spanish display name`);
      assert.ok(!incident.message.includes(`'${key}'`), `${key} does not persist its scheduler key`);
    }
  } finally { db.close(); }
});
