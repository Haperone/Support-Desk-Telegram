import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { status } from './status-fixture.js';
const { configureStatus, loadStatus, formatStatus, handleMessage, handleCallback } = status;

const actor = 123456789;
const now = new Date('2026-10-12T18:00:00Z');
const monitorUrl = 'https://example.workers.dev/health/status';
const accessToken = 'b'.repeat(64);
const snapshot = () => ({ schemaVersion: 1, measuredAt: now.toISOString(), overall: 'healthy',
  monitorDatabase: 'available', support: 'available', checks: [{ id: 'usage', status: 'available', measuredAt: now.toISOString() }],
  services: [], incidents: { total: 0, items: [] }, alerts: { route: 'group', lastSuccessAt: '2026-09-29T02:15:00Z' }, runtimeEnabled: false });

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE alert_status_config(id INTEGER PRIMARY KEY, monitor_url TEXT NOT NULL, access_token TEXT NOT NULL);
    CREATE TABLE alert_status_cache(id INTEGER PRIMARY KEY, snapshot_json TEXT, fetched_at TEXT, attempted_at TEXT NOT NULL, error_kind TEXT);`);
  const db = { get: async (sql, params = {}) => sqlite.prepare(sql).get(params) || null,
    run: async (sql, params = {}) => sqlite.prepare(sql).run(params) };
  return { db, sqlite, close: () => sqlite.close() };
}

test('configuration requires the owner and keeps the access token out of its response', async () => {
  const f = fixture();
  try {
    await assert.rejects(configureStatus({ monitorUrl, accessToken }, 1, f.db), /forbidden/);
    await assert.rejects(configureStatus({ monitorUrl: 'https://evil.test/health/status', accessToken }, actor, f.db));
    await assert.rejects(configureStatus({ monitorUrl, accessToken: 'bot-token' }, actor, f.db));
    assert.deepEqual(await configureStatus({ monitorUrl, accessToken }, actor, f.db), { configured: true });
    assert.equal(f.sqlite.prepare('SELECT access_token FROM alert_status_config').get().access_token, accessToken);
  } finally { f.close(); }
});

test('fresh response is saved and rapid refreshes reuse it without another HTTP request', async () => {
  const f = fixture();
  try {
    await configureStatus({ monitorUrl, accessToken }, actor, f.db);
    let calls = 0;
    const dependencies = { db: f.db, fetch: async (url, init) => {
      calls++; assert.equal(url, monitorUrl); assert.equal(init.headers.authorization, `Bearer ${accessToken}`);
      assert.equal(init.redirect, 'error'); return Response.json(snapshot());
    } };
    const view = await loadStatus(dependencies, now);
    assert.equal(view.error, null);
    assert.equal((await loadStatus(dependencies, new Date(now.getTime() + 5000))).cached, true);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(view), new RegExp(accessToken));
    assert.match(formatStatus(view, now), /Проверяемые компоненты работают/);
  } finally { f.close(); }
});

test('Cloudflare outage preserves the last snapshot and clearly labels its age', async () => {
  const f = fixture();
  try {
    await configureStatus({ monitorUrl, accessToken }, actor, f.db);
    await loadStatus({ db: f.db, fetch: async () => Response.json(snapshot()) }, now);
    const later = new Date(now.getTime() + 47 * 60_000);
    const outage = { db: f.db, fetch: async () => { throw new Error('sensitive URL and token'); } };
    const view = await loadStatus(outage, later);
    assert.equal(view.error, 'unreachable');
    assert.equal(view.snapshot.overall, 'healthy');
    const text = formatStatus(view, later);
    assert.match(text, /Монитор Cloudflare не отвечает/);
    assert.match(text, /47 мин. назад/);
    assert.match(text, /не подтверждает текущее состояние/);
    assert.doesNotMatch(text, /Проверяемые компоненты работают|sensitive|token/);
    assert.equal((await loadStatus(outage, new Date(later.getTime() + 5000))).error, 'unreachable');
  } finally { f.close(); }
});

test('503 with valid status remains readable; static 200, old data and auth rejection do not appear healthy', async () => {
  const f = fixture();
  try {
    await configureStatus({ monitorUrl, accessToken }, actor, f.db);
    const failed = { ...snapshot(), overall: 'degraded', monitorDatabase: 'unavailable' };
    assert.equal((await loadStatus({ db: f.db, fetch: async () => Response.json(failed, { status: 503 }) }, now)).snapshot.overall, 'degraded');
    for (const response of [new Response('active'), Response.json(snapshot()), new Response('', { status: 401 })]) {
      const view = await loadStatus({ db: f.db, fetch: async () => response }, new Date(now.getTime() + 5 * 60_000));
      assert.ok(view.error);
      f.sqlite.exec('DELETE FROM alert_status_cache');
    }
  } finally { f.close(); }
});

test('commands and callbacks reject unauthorized users and unrelated groups before database or HTTP calls', async () => {
  const sent = [], answers = [];
  let reads = 0;
  const dependencies = { db: { get: async () => { reads++; return null; } }, fetch: () => assert.fail('Unexpected HTTP call'),
    api: { sendMessage: async value => sent.push(value), answerCallbackQuery: async value => answers.push(value) } };
  await handleMessage({ from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/status' }, dependencies);
  await handleMessage({ from: { id: actor }, chat: { id: -100, type: 'supergroup' }, text: '/status' }, dependencies);
  await handleMessage({ from: { id: 1 }, chat: { id: -1001234567890, type: 'supergroup' }, text: '/status' }, dependencies);
  await handleMessage({ from: { id: actor }, chat: { id: -1001234567890, type: 'supergroup' }, text: '/status@other_bot' }, dependencies);
  assert.equal(sent.length, 0);
  await handleCallback({ id: 'q', from: { id: 1 }, message: { chat: { id: actor, type: 'private' } }, data: 'status:refresh' }, dependencies);
  assert.equal(answers[0].text, 'Нет доступа.');
  await handleCallback({ id: 'other-group', from: { id: actor }, message: { chat: { id: -100, type: 'supergroup' } }, data: 'status:refresh' }, dependencies);
  await handleCallback({ id: 'other-user', from: { id: 1 }, message: { chat: { id: -1001234567890, type: 'supergroup' } }, data: 'status:refresh' }, dependencies);
  assert.equal(answers[1].text, 'Нет доступа.');
  assert.equal(answers[2].text, 'Нет доступа.');
  assert.equal(reads, 0);
  await handleMessage({ from: { id: actor }, chat: { id: actor, type: 'private' }, text: '/status@example_alert_bot' }, dependencies);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /ещё не настроено/);
});

test('support group commands reply in their originating forum topic and allow owner refresh', async () => {
  const sent = [], calls = [];
  const chat = { id: -1001234567890, type: 'supergroup' };
  const dependencies = { db: { get: async () => null }, fetch: () => assert.fail('Unexpected HTTP call'), api: {
    sendMessage: async value => sent.push(value), answerCallbackQuery: async value => calls.push(['answer', value]),
    editMessageText: async value => calls.push(['edit', value]),
  } };
  await handleMessage({ from: { id: actor }, chat, message_id: 400, message_thread_id: 3, text: '/status@example_alert_bot' }, dependencies);
  assert.equal(sent[0].chat_id, chat.id);
  assert.equal(sent[0].message_thread_id, 3);
  assert.deepEqual(sent[0].reply_parameters, { message_id: 400, allow_sending_without_reply: true });
  assert.equal(sent[0].reply_markup.inline_keyboard[0][0].callback_data, 'status:refresh');
  await handleMessage({ from: { id: actor }, chat, message_id: 401, message_thread_id: 7, text: '/health' }, dependencies);
  assert.equal(sent[1].message_thread_id, 7);
  await handleMessage({ from: { id: actor }, chat, message_id: 402, text: '/status' }, dependencies);
  assert.equal(Object.hasOwn(sent[2], 'message_thread_id'), false);
  await handleCallback({ id: 'group-refresh', from: { id: actor }, message: { chat, message_id: 403 }, data: 'status:refresh' }, dependencies);
  assert.deepEqual(calls.map(item => item[0]), ['answer', 'edit']);
  assert.equal(calls[1][1].chat_id, chat.id);
  assert.equal(calls[1][1].message_id, 403);
});

test('callback refresh edits its message and tolerates Telegram message-not-modified', async () => {
  const calls = [];
  const dependencies = { db: { get: async () => null }, api: {
    answerCallbackQuery: async value => calls.push(['answer', value]),
    editMessageText: async value => { calls.push(['edit', value]); throw { code: 400, description: 'Bad Request: message is not modified' }; },
  } };
  await handleCallback({ id: 'q', from: { id: actor }, message: { chat: { id: actor, type: 'private' }, message_id: 7 }, data: 'status:refresh' }, dependencies);
  assert.deepEqual(calls.map(item => item[0]), ['answer', 'edit']);
  assert.equal(calls[1][1].message_id, 7);
});
