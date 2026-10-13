import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from '../../test/helpers/sqlite-d1.js';
import { alertStatus, connectAlertBot, readAlertRoute, removeAlertBot, sendAlert, switchAlertRoute } from '../alert-config.js';

const oldToken = '12345:' + 'A'.repeat(35);
const newToken = '67890:' + 'B'.repeat(35);

function fixture() {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  const env = { MONITOR_DB: db, ALERT_CONFIG_KEY: 'a'.repeat(64), ALERT_BOT_TOKEN: oldToken,
    ALERT_CHAT_ID: '-100123', ALERT_THREAD_ID: '3' };
  const calls = [];
  const rejected = new Set();
  const fetchImpl = async (url, init) => {
    const [, token, method] = /bot([^/]+)\/(\w+)$/.exec(String(url));
    const body = JSON.parse(init.body || '{}');
    calls.push({ token, method, body });
    if (method === 'getMe') return Response.json({ ok: true,
      result: { id: token === oldToken ? 12345 : 67890, username: token === oldToken ? 'old_alert_bot' : 'new_alert_bot', is_bot: true } });
    if (rejected.has(`${token}:${body.chat_id}`)) return Response.json({ ok: false, error_code: 403,
      description: 'Forbidden: bot was blocked' }, { status: 403 });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  };
  return { db, env, calls, rejected, fetchImpl, close: () => db.close() };
}

test('one alert bot switches between one group topic and selected private recipients', async () => {
  const f = fixture();
  try {
    assert.equal((await readAlertRoute(f.env)).mode, 'group');
    assert.equal((await alertStatus(f.env, f.fetchImpl)).username, 'old_alert_bot');
    const privateSwitch = await switchAlertRoute(f.env, { expectedGeneration: 0, mode: 'private', recipientIds: [7, 8] }, f.fetchImpl);
    assert.equal(privateSwitch.generation, 1);
    assert.equal(privateSwitch.oldNotified, true);
    assert.equal((await alertStatus(f.env)).mode, 'private');
    assert.deepEqual((await alertStatus(f.env)).recipients, [7, 8]);
    const stored = f.db.sqlite.prepare('SELECT encrypted_token FROM alert_delivery_config').get().encrypted_token;
    assert.ok(stored.startsWith('v1.'));
    assert.ok(!stored.includes(oldToken));
    f.calls.length = 0;
    assert.equal((await sendAlert(f.env, 'ALERT', f.fetchImpl)).ok, true);
    assert.deepEqual(f.calls.map(call => call.body.chat_id), [7, 8]);
    f.calls.length = 0;
    const groupSwitch = await switchAlertRoute(f.env,
      { expectedGeneration: 1, mode: 'group', chatId: -100456, threadId: 5 }, f.fetchImpl);
    assert.equal(groupSwitch.generation, 2);
    assert.deepEqual(f.calls.map(call => call.body.chat_id), [-100456, 7, 8]);
    f.calls.length = 0;
    assert.equal((await sendAlert(f.env, 'NEXT', f.fetchImpl)).ok, true);
    assert.deepEqual(f.calls.map(call => [call.body.chat_id, call.body.message_thread_id]), [[-100456, 5]]);
  } finally { f.close(); }
});

test('failed new destination leaves the old route and token intact', async () => {
  const f = fixture();
  try {
    f.rejected.add(`${oldToken}:7`);
    await assert.rejects(switchAlertRoute(f.env,
      { expectedGeneration: 0, mode: 'private', recipientIds: [7] }, f.fetchImpl));
    assert.equal((await alertStatus(f.env)).mode, 'group');
    assert.ok(!f.calls.some(call => call.body.text?.startsWith('🔕')));
    f.rejected.clear();
    f.rejected.add(`${oldToken}:-100123`);
    const changed = await switchAlertRoute(f.env,
      { expectedGeneration: 0, mode: 'private', recipientIds: [7] }, f.fetchImpl);
    assert.equal(changed.oldNotified, false);
    assert.equal((await alertStatus(f.env)).mode, 'private');
  } finally { f.close(); }
});

test('replacement, private recipient changes and removal do not revive the legacy destination', async () => {
  const f = fixture();
  try {
    const connected = await connectAlertBot(f.env,
      { token: newToken, adminId: 7, expectedGeneration: 0 }, f.fetchImpl);
    assert.equal(connected.username, 'new_alert_bot');
    assert.equal((await readAlertRoute(f.env)).token, newToken);
    await switchAlertRoute(f.env, { expectedGeneration: 1, mode: 'private', recipientIds: [7] }, f.fetchImpl);
    f.calls.length = 0;
    await switchAlertRoute(f.env, { expectedGeneration: 2, mode: 'private', recipientIds: [7, 8] }, f.fetchImpl);
    assert.deepEqual(f.calls.map(call => call.body.chat_id), [7, 8], 'existing recipient stays active and gets no off notice');
    f.calls.length = 0;
    const removed = await removeAlertBot(f.env, { expectedGeneration: 3 }, f.fetchImpl);
    assert.equal(removed.mode, 'disabled');
    assert.equal((await alertStatus(f.env)).mode, 'disabled');
    assert.equal(await readAlertRoute(f.env), null);
    assert.equal((await sendAlert(f.env, 'SHOULD NOT SEND', f.fetchImpl)).disabled, true);
    assert.ok(!f.calls.some(call => call.body.text === 'SHOULD NOT SEND'));
  } finally { f.close(); }
});

test('private fan-out requires the administrator delivery and does not retry successful admin for an operator failure', async () => {
  const f = fixture();
  try {
    await switchAlertRoute(f.env, { expectedGeneration: 0, mode: 'private', recipientIds: [7, 8] }, f.fetchImpl);
    f.rejected.add(`${oldToken}:8`);
    f.calls.length = 0;
    assert.equal((await sendAlert(f.env, 'ALERT', f.fetchImpl)).ok, true);
    assert.deepEqual(f.calls.map(call => call.body.chat_id), [7, 8]);
    f.rejected.add(`${oldToken}:7`);
    f.calls.length = 0;
    assert.equal((await sendAlert(f.env, 'NEXT', f.fetchImpl)).ok, false);
    assert.deepEqual(f.calls.map(call => call.body.chat_id), [7]);
  } finally { f.close(); }
});

test('a missing encryption key stops delivery instead of restoring the legacy group', async () => {
  const f = fixture();
  try {
    await switchAlertRoute(f.env, { expectedGeneration: 0, mode: 'private', recipientIds: [7] }, f.fetchImpl);
    delete f.env.ALERT_CONFIG_KEY;
    f.env.ALERT_CONFIG_REQUIRED = 'true';
    f.calls.length = 0;
    await assert.rejects(sendAlert(f.env, 'ALERT', f.fetchImpl), /The alert settings key is missing/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
