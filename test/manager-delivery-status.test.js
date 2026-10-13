import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { createManagerWorker, publishManagerManualDelivery } from '../manager-bot.js';
import { beginManualDelivery, deliverySnapshot, manualDeliveryStatus, MANAGER_DELIVERY_UI } from '../manual-delivery.js';
import { managementBotKey } from '../worker.js';

const groupId = -1001234567890;
const threadId = 88;
const sourceMessageId = 321;
const config = { id: 'service-a', username: 'service_a_bot', displayName: 'Service A', topicPrefix: 'A', locale: 'ru',
  tokenBinding: 'SERVICE_TOKEN', webhookSecretBinding: 'SERVICE_SECRET', enabled: true };

function fixture() {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  db.sqlite.prepare("INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,'ru','2026-09-26T10:00:00.000Z')").run();
  db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,created_at)
    VALUES('service-a',55,?,?,?)`).run(groupId, threadId, '2026-09-26T10:00:00.000Z');
  db.sqlite.prepare(`INSERT INTO message_delivery_attempts
    (bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at)
    VALUES('service-a','support_to_user',?,?,?,?,?,'sendMessage','2026-09-26T10:01:00.000Z')`)
    .run(groupId, sourceMessageId, 55, threadId, 55);
  const env = { SUPPORT_DB: db, MANAGER_BOT_TOKEN: '100:MANAGER', MANAGER_WEBHOOK_SECRET: 'manager-secret',
    MANAGER_BOT_USERNAME: 'manager_bot', BOT_REGISTRY: JSON.stringify([config]), SERVICE_TOKEN: '200:SERVICE',
    SERVICE_SECRET: 'service-secret', ADMIN_IDS: '7', PUBLIC_BASE_URL: 'https://support.example.workers.dev' };
  let nextMessageId = 900;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = /bot[^/]+\/(\w+)$/.exec(String(url))[1];
    const body = JSON.parse(init.body || '{}');
    calls.push({ method, body });
    if (method === 'answerCallbackQuery') return Response.json({ ok: true, result: true });
    if (method === 'editMessageText') return Response.json({ ok: true, result: true });
    if (method === 'sendMessage') return Response.json({ ok: true, result: { message_id: ++nextMessageId } });
    return Response.json({ ok: true, result: true });
  };
  const worker = createManagerWorker({ async fetch() {}, async scheduled() {} }, fetchImpl);
  let updateId = 1;
  const send = update => worker.fetch(new Request('https://support.example.workers.dev/tg/manager', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'manager-secret' },
    body: JSON.stringify({ update_id: updateId++, ...update }),
  }), env, {});
  const command = (actor = 7) => send({ message: { message_id: 700, from: { id: actor },
    chat: { id: groupId, type: 'supergroup' }, message_thread_id: threadId, text: '/status',
    reply_to_message: { message_id: sourceMessageId } } });
  const refresh = ({ actor = 7, chat = groupId, thread = threadId, card } = {}) => send({ callback_query: {
    id: `q${updateId}`, from: { id: actor }, data: `ds:${sourceMessageId}`,
    message: { message_id: card?.message_id || 901, from: { id: 100, is_bot: true, username: 'manager_bot' }, chat: { id: chat, type: 'supergroup' },
      message_thread_id: thread, text: card?.text || `Статус доставки сообщения #${sourceMessageId}\nОжидает безопасной попытки доставки.` },
  } });
  return { db, calls, send, command, refresh, close: () => db.close() };
}

test('/status reports one replied-to operator message and provides a scoped refresh action', async () => {
  const f = fixture();
  try {
    assert.equal((await f.command()).status, 200);
    const card = f.calls.find(call => call.method === 'sendMessage').body;
    assert.equal(card.chat_id, groupId);
    assert.equal(card.message_thread_id, threadId);
    assert.match(card.text, /сообщения #321/);
    assert.match(card.text, /Ожидает безопасной попытки/);
    assert.deepEqual(card.reply_markup.inline_keyboard[0][0], { text: 'Обновить статус', callback_data: 'ds:321' });
  } finally { f.close(); }
});

test('/status explains how to use it in a topic and in a private chat', async () => {
  const f = fixture();
  try {
    assert.equal((await f.send({ message: { message_id: 701, from: { id: 7 }, chat: { id: groupId, type: 'supergroup' },
      message_thread_id: threadId, text: '/status' } })).status, 200);
    assert.match(f.calls.at(-1).body.text, /ответьте командой \/status на конкретное сообщение/);
    assert.equal((await f.send({ message: { message_id: 702, from: { id: 7 }, chat: { id: 7, type: 'private' }, text: '/status' } })).status, 200);
    assert.match(f.calls.at(-1).body.text, /Статус проверяется в теме обращения/);
  } finally { f.close(); }
});

test('refresh rereads the current persisted status, edits only its topic card, and is safe to repeat', async () => {
  const f = fixture();
  try {
    await f.command();
    const card = f.calls.find(call => call.method === 'sendMessage').body;
    f.db.sqlite.prepare(`UPDATE message_delivery_attempts SET request_started_at='2026-09-26T10:02:00Z',
      completed_at='2026-09-26T10:02:01Z',target_message_id=777
      WHERE bot_id='service-a' AND source_chat_id=? AND source_message_id=?`).run(groupId, sourceMessageId);
    assert.equal((await f.refresh({ card: { message_id: 901, text: card.text } })).status, 200);
    assert.equal((await f.refresh({ card: { message_id: 901, text: card.text } })).status, 200);
    const edits = f.calls.filter(call => call.method === 'editMessageText');
    assert.equal(edits.length, 2);
    assert.ok(edits.every(call => call.body.chat_id === groupId && call.body.message_id === 901));
    assert.match(edits.at(-1).body.text, /Доставлено через Telegram/);
    assert.match(edits.at(-1).body.text, /прочтение клиентом не подтверждается/);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 1,
      'refresh never repeats the customer delivery');
  } finally { f.close(); }
});

test('delivery status refresh remains valid when the operator language changes', async () => {
  const f = fixture();
  try {
    for (const [index, locale] of ['en', 'ru', 'es', 'zh'].entries()) {
      f.db.sqlite.prepare(`INSERT INTO manager_operator_preferences(operator_id,language,updated_at)
        VALUES(7,?,?) ON CONFLICT(operator_id) DO UPDATE SET language=excluded.language,updated_at=excluded.updated_at`)
        .run(locale, new Date(Date.now() + index).toISOString());
      assert.equal((await f.command()).status, 200);
      const card = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === groupId).at(-1).body;
      assert.equal((await f.refresh({ card: { message_id: 910 + index, text: card.text } })).status, 200,
        `${locale} refresh callback is accepted`);
      assert.ok(f.calls.some(call => call.method === 'editMessageText' && Number(call.body.message_id) === 910 + index));
    }
  } finally { f.close(); }
});

test('refresh callback cannot disclose status from another topic or to an unauthorized operator', async () => {
  const f = fixture();
  try {
    await f.command();
    assert.equal((await f.refresh({ chat: groupId - 1 })).status, 200);
    assert.equal((await f.refresh({ actor: 8 })).status, 200);
    assert.equal(f.calls.filter(call => call.method === 'editMessageText').length, 0);
  } finally { f.close(); }
});

test('manager DM exposes recovery only to the administrator and scopes it to the service group', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare('INSERT INTO support_groups(group_id,created_at,updated_at) VALUES(?,?,?)')
      .run(groupId, '2026-09-26T10:00:00.000Z', '2026-09-26T10:00:00.000Z');
    f.db.sqlite.prepare("INSERT INTO service_group_routes(bot_id,group_id,source,updated_at) VALUES('service-a',?,'wizard',?)")
      .run(groupId, '2026-09-26T10:00:00.000Z');
    const requests = [];
    const service = {
      status: async options => { requests.push(options); return { snapshot: { rows: [], targets: [], limited: false } }; },
      start: async options => { requests.push(options); return { started: true }; },
    };
    const worker = createManagerWorker({ async fetch() {}, async scheduled() {} }, async (url, init) => {
      const method = /bot[^/]+\/(\w+)$/.exec(String(url))[1];
      const body = JSON.parse(init.body || '{}');
      f.calls.push({ method, body });
      return Response.json({ ok: true, result: method === 'sendMessage' ? { message_id: 901 } : true });
    });
    let id = 4000;
    const key = managementBotKey([config], config.id);
    const callback = (actor, action, serviceKey = key) => worker.fetch(new Request('https://support.example.workers.dev/tg/manager', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'manager-secret' },
      body: JSON.stringify({ update_id: id++, callback_query: { id: `q${id}`, from: { id: actor }, data: `mg:${action}:${serviceKey}`,
        message: { message_id: 901, chat: { id: actor, type: 'private' }, text: 'Service A' } } }),
    }), { SUPPORT_DB: f.db, MANAGER_BOT_TOKEN: '100:MANAGER', MANAGER_WEBHOOK_SECRET: 'manager-secret',
      MANAGER_BOT_USERNAME: 'manager_bot', BOT_REGISTRY: JSON.stringify([config]), SERVICE_TOKEN: '200:SERVICE',
      SERVICE_SECRET: 'service-secret', ADMIN_IDS: '7', PUBLIC_BASE_URL: 'https://support.example.workers.dev' },
    { exports: { DeliveryRecovery: service } });
    assert.equal((await callback(8, 'delivery')).status, 200);
    assert.equal(requests.length, 0);
    assert.equal((await callback(7, 'delivery')).status, 200);
    assert.equal(requests[0].groupId, groupId);
    assert.equal(requests[0].botId, 'service-a');
    assert.equal(requests[0].uiBotId, MANAGER_DELIVERY_UI);
    assert.equal((await callback(7, 'recover')).status, 200);
    assert.equal(requests[1].requestKey.startsWith('manager:q'), true);
    assert.equal(requests[1].messageId, 901);
    assert.equal((await callback(8, 'delivery', 'a')).status, 200);
    assert.equal(requests.length, 2);
    assert.equal((await callback(7, 'delivery', 'a')).status, 200);
    assert.equal(requests[2].botId, null);
    assert.equal(requests[2].groupId, 0);
    assert.equal((await callback(7, 'recover', 'a')).status, 200);
    assert.equal(requests[3].botId, null);
  } finally { f.close(); }
});

test('manager recovery rejects stale group route and preserves the old General authorization', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare('INSERT INTO support_groups(group_id,created_at,updated_at) VALUES(?,?,?)')
      .run(groupId, '2026-09-26T10:00:00.000Z', '2026-09-26T10:00:00.000Z');
    f.db.sqlite.prepare("INSERT INTO service_group_routes(bot_id,group_id,source,updated_at) VALUES('service-a',?,'wizard',?)")
      .run(groupId, '2026-09-26T10:00:00.000Z');
    const env = { SUPPORT_DB: f.db, BOT_REGISTRY: JSON.stringify([config]), ADMIN_IDS: '7', SUPPORT_GROUP_ID: '-1000000000001' };
    const options = { actorId: 7, groupId, threadId: null, botId: 'service-a', uiBotId: MANAGER_DELIVERY_UI,
      messageId: 901, requestKey: 'manager:test' };
    await assert.rejects(manualDeliveryStatus(env, { ...options, groupId: groupId - 1 }), /group changed/i);
    await assert.rejects(beginManualDelivery(env, { ...options, actorId: 8 }, async () => {}), /primary administrator/i);
    await assert.rejects(beginManualDelivery(env, { ...options, groupId: groupId - 1 }, async () => {}), /group changed/i);
    const started = await beginManualDelivery(env, options, async () => {});
    assert.equal(started.started, true);
    const repeated = await beginManualDelivery(env, options, async () => {});
    assert.equal(repeated.run.token, started.run.token);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM manual_delivery_runs').get().n, 1);
  } finally { f.close(); }
});

test('manager global recovery spans service groups and stays restricted to the primary administrator', async () => {
  const f = fixture();
  try {
    const otherGroup = groupId - 1;
    const other = { ...config, id: 'service-b', displayName: 'Service B', username: 'service_b_bot',
      tokenBinding: 'OTHER_TOKEN', webhookSecretBinding: 'OTHER_SECRET' };
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,created_at)
      VALUES('service-b',56,?,89,'2026-09-26T10:00:00.000Z')`).run(otherGroup);
    f.db.sqlite.prepare(`INSERT INTO pending_messages
      (bot_id,user_id,update_id,source_chat_id,source_message_id,created_at,source_created_at,failure_code)
      VALUES('service-b',56,913,56,323,'2026-09-26T10:02:00.000Z','2026-09-26T10:02:00.000Z','support_group_unavailable')`).run();
    const env = { SUPPORT_DB: f.db, BOT_REGISTRY: JSON.stringify([config, other]), ADMIN_IDS: '7' };
    const options = { actorId: 7, groupId: 0, threadId: null, botId: null, uiBotId: MANAGER_DELIVERY_UI,
      messageId: 901, requestKey: 'manager:global' };
    const status = await manualDeliveryStatus(env, options);
    assert.ok(status.snapshot.rows.some(row => row.bot_id === 'service-a'));
    assert.ok(status.snapshot.rows.some(row => row.bot_id === 'service-b'));
    await assert.rejects(manualDeliveryStatus(env, { ...options, actorId: 8 }), /primary administrator/i);
    await assert.rejects(manualDeliveryStatus(env, { ...options, groupId }), /scope/i);
    const started = await beginManualDelivery(env, options, async () => {});
    assert.equal(started.started, true);
    assert.equal(started.run.bot_id, null);
    assert.equal(started.run.group_id, 0);
  } finally { f.close(); }
});

test('manager recovery publishes into its own DM panel and ignores a changed service group', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare('INSERT INTO support_groups(group_id,created_at,updated_at) VALUES(?,?,?)')
      .run(groupId, '2026-09-26T10:00:00.000Z', '2026-09-26T10:00:00.000Z');
    f.db.sqlite.prepare("INSERT INTO service_group_routes(bot_id,group_id,source,updated_at) VALUES('service-a',?,'wizard',?)")
      .run(groupId, '2026-09-26T10:00:00.000Z');
    const env = { SUPPORT_DB: f.db, BOT_REGISTRY: JSON.stringify([config]), ADMIN_IDS: '7', MANAGER_BOT_TOKEN: '100:MANAGER' };
    const run = { ui_bot_id: MANAGER_DELIVERY_UI, actor_id: 7, group_id: groupId, bot_id: 'service-a',
      message_id: 901, status: 'finished', created_at: '2026-09-26T10:00:00.000Z', report_json: '{}' };
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: true });
    };
    await publishManagerManualDelivery(env, run, fetchImpl);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.chat_id, 7);
    assert.equal(calls[0].body.message_id, 901);
    assert.match(calls[0].body.text, /Попытка завершена/);
    await publishManagerManualDelivery(env, { ...run, group_id: groupId - 1 }, fetchImpl);
    assert.equal(calls.length, 1);
    await publishManagerManualDelivery(env, { ...run, bot_id: null, group_id: 0 }, fetchImpl);
    assert.equal(calls.length, 2);
    assert.match(calls.at(-1).body.text, /Все сервисы/);
    assert.equal(calls.at(-1).body.reply_markup.inline_keyboard[0][0].callback_data, 'mg:recover:a');
  } finally { f.close(); }
});

test('definite group access failure remains eligible for safe manual recovery', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO pending_messages
      (bot_id,user_id,update_id,source_chat_id,source_message_id,created_at,source_created_at,failure_code)
      VALUES('service-a',55,912,55,322,'2026-09-26T10:02:00.000Z','2026-09-26T10:02:00.000Z','support_group_unavailable')`).run();
    const snapshot = await deliverySnapshot(f.db, { BOT_REGISTRY: JSON.stringify([config]) }, 'service-a');
    const row = snapshot.rows.find(item => item.source_message_id === 322);
    assert.equal(row?.reason, null);
    assert.ok(snapshot.targets.some(item => item.kind === 'release' && item.userId === 55));
  } finally { f.close(); }
});
