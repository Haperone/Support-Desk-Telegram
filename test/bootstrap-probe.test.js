import assert from 'node:assert/strict';
import test from 'node:test';
import { probeManagerEndpoint, probeMonitorEndpoint } from '../scripts/bootstrap-probe.mjs';

test('bootstrap probes the deployed manager route with its webhook secret before Telegram setup', async () => {
  let call;
  await probeManagerEndpoint('https://fresh.example.workers.dev', 'secret', async (url, options) => {
    call = { url, options };
    return new Response('Invalid update', { status: 400 });
  });
  assert.equal(call.url, 'https://fresh.example.workers.dev/tg/manager');
  assert.equal(call.options.headers['x-telegram-bot-api-secret-token'], 'secret');
  assert.equal(call.options.body, '{}');
  assert.equal(call.options.redirect, 'error');
  await assert.rejects(() => probeManagerEndpoint('https://fresh.example.workers.dev', 'secret',
    async () => new Response('Forbidden', { status: 403 })), /не совпадают/);
});

test('installation checks actual database connectivity while allowing a new monitor awaiting its first Cron', async () => {
  const snapshot = { schemaVersion: 1, measuredAt: new Date().toISOString(), overall: 'degraded',
    monitorDatabase: 'available', support: 'available' };
  const probe = fetchImpl => probeMonitorEndpoint('https://fresh-monitor.example.workers.dev', 'test-secret', fetchImpl);
  assert.deepEqual(await probe(async (url, options) => {
    assert.equal(url, 'https://fresh-monitor.example.workers.dev/health/status');
    assert.equal(options.headers.authorization, 'Bearer test-secret');
    return Response.json(snapshot, { status: 503 });
  }), { databasesAvailable: true, monitoringReady: false });
  await assert.rejects(probe(async () => Response.json({ ...snapshot, support: 'unavailable' }, { status: 503 })), /обеих БД/);
  await assert.rejects(probe(async () => Response.json({ ...snapshot, measuredAt: '2000-01-01' })), /обеих БД/);
  await assert.rejects(probe(async () => new Response('active')), /защищённый статус/);
  await assert.rejects(probe(async () => new Response('', { status: 401 })), /защищённый статус/);
});
