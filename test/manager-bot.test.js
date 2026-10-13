import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { createManagerWorker } from '../src/manager-bot.js';
import { commitGroupCutover, registerSupportGroup } from '../src/service-groups.js';
import { managementBotKey } from '../src/worker.js';
import { createReactionChecks } from '../src/reaction-checks.js';
import { registeredConfig, sealCredentials } from '../src/bot-registry.js';
import { ALERT_CONFIG_MESSAGES } from '../monitor/alert-config.js';
import { STORAGE_RESET_PHRASES } from '../src/storage-ui.js';
import { statisticsCopy } from '../src/statistics-copy.js';
import { messageDeletionWarning } from '../src/message-deletion-copy.js';

test('statistics is reachable and edits one rich report in every language; custom dates and back navigation remain usable',async()=>{
  for(const locale of ['en','ru','es','zh']){
    const f=fixture();try{
      f.db.sqlite.prepare('UPDATE manager_operator_preferences SET language=? WHERE operator_id=7').run(locale);
      await f.press('mg:home');
      assert.ok(f.calls.filter(c=>c.method==='sendMessage').at(-1).body.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='mg:stats:home'));
      await f.press('mg:stats:home');await f.press('mg:stats:report');
      const rendered=f.wireCalls.filter(c=>c.method==='editMessageText'&&c.body.rich_message).at(-1).body;
      assert.ok(rendered.rich_message.markdown.includes(statisticsCopy(locale).title));
      assert.ok(rendered.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='mg:home'));
      await f.press('mg:stats:periodset:custom');
      assert.equal(f.db.sqlite.prepare('SELECT input_kind FROM manager_statistics_preferences WHERE operator_id=7').get().input_kind,'dates');
      await f.send(f.input('2026-09-01 2026-09-02'));
      assert.equal(f.db.sqlite.prepare('SELECT period,input_kind FROM manager_statistics_preferences WHERE operator_id=7').get().period,'custom');
      await f.press('mg:stats:periodset:custom');await f.press('mg:home');
      assert.equal(f.db.sqlite.prepare('SELECT input_kind FROM manager_statistics_preferences WHERE operator_id=7').get().input_kind,null,'leaving the form suspends it');
    }finally{f.close();}
  }
});

const newServiceToken = '987654:' + 'N'.repeat(35);

test('statistics schedule configuration and group selection fit real Free manager ingress',async()=>{
 const f=fixture();try{
 f.env.RECOVERY_D1_PLAN='free';f.env.TELEGRAM_COOLDOWN_ENABLED='true';f.env.OPERATIONAL_HEALTH_ENABLED='true';f.env.RETENTION_ENABLED='true';f.env.STORAGE_GUARD_ENABLED='true';
 f.db.sqlite.exec("INSERT INTO support_operators(user_id,first_name,active,added_at,added_by,added_by_name) VALUES(8,'Operator',1,'now',7,'Admin');INSERT INTO manager_dm_status(operator_id,started_at,updated_at) VALUES(8,'now','now');INSERT INTO service_responsibility(bot_id,primary_id,updated_at) VALUES('service-a',8,'now');INSERT INTO support_groups(group_id,title,created_at,updated_at) VALUES(-100,'Team','now','now');INSERT INTO service_group_routes(bot_id,group_id,source,updated_at) VALUES('service-a',-100,'wizard','now')");
 for(const route of ['mg:stats:home','mg:stats:scope:0','mg:stats:sched:8:daily','mg:stats:scope:0:8:daily','mg:stats:scopeset:g-100:8:daily','mg:stats:config:8:daily'])assert.equal((await f.press(route)).status,200,route);
 assert.equal((await f.send(f.input('10:30 Europe/Budapest 1'))).status,200);
 assert.equal((await f.press('mg:stats:toggle:8:daily:1')).status,200);
 const row=f.db.sqlite.prepare("SELECT * FROM statistics_schedules WHERE recipient_id=8 AND frequency='daily'").get();
 assert.equal(row.scope,'g-100');assert.equal(row.enabled,1);
 const version=row.revision;
 assert.equal((await f.press('mg:stats:toggle:8:daily:1')).status,200);
 assert.equal(f.db.sqlite.prepare("SELECT revision FROM statistics_schedules WHERE recipient_id=8 AND frequency='daily'").get().revision,version);
 assert.equal((await f.press('mg:stats:report',8)).status,200);
 assert.ok(f.wireCalls.some(c=>c.method==='editMessageText'&&c.body.rich_message&&c.body.chat_id===8));
 }finally{f.close();}
});

test('statistics stale schedule forms return a localized conflict through real Free ingress',async()=>{
 for(const locale of ['en','ru','es','zh']){
 const f=fixture();try{
 f.env.RECOVERY_D1_PLAN='free';f.env.TELEGRAM_COOLDOWN_ENABLED='true';f.env.OPERATIONAL_HEALTH_ENABLED='true';f.env.RETENTION_ENABLED='true';f.env.STORAGE_GUARD_ENABLED='true';
 f.db.sqlite.prepare('UPDATE manager_operator_preferences SET language=? WHERE operator_id=7').run(locale);
 assert.equal((await f.press('mg:stats:config:7:daily')).status,200);
 f.db.sqlite.exec("UPDATE statistics_schedules SET send_hour=12");
 assert.equal((await f.send(f.input('11:30 Asia/Shanghai 2'))).status,200);
 assert.equal(f.db.sqlite.prepare('SELECT send_hour FROM statistics_schedules').get().send_hour,12);
 const card=f.wireCalls.filter(c=>c.method==='sendRichMessage').at(-1).body;
 assert.equal(card.rich_message.markdown,statisticsCopy(locale).configChanged);
 assert.ok(card.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='mg:stats:sched:7:daily'));
 }finally{f.close();}
 }
});

test('alert connection recovery instructions use the administrator language across monitor locales', async () => {
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const f = fixture();
    try {
      f.db.sqlite.prepare('UPDATE manager_operator_preferences SET language=? WHERE operator_id=7').run(locale);
      f.env.ALERT_SETTINGS = {
        status: async () => ({ generation: 0, mode: 'disabled', username: null, recipients: [] }),
        connect: async () => {
          throw new Error(ALERT_CONFIG_MESSAGES.startBot.en.replace('{0}', 'alerts_bot')
            .replace('{1}', ALERT_CONFIG_MESSAGES.botAccess.en));
        },
      };
      await f.press('mg:alert:connect');
      await f.send(f.input('67890:' + 'B'.repeat(35)));
      const screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
      assert.equal(screen.text, ALERT_CONFIG_MESSAGES.startBot[locale].replace('{0}', 'alerts_bot')
        .replace('{1}', ALERT_CONFIG_MESSAGES.botAccess[locale]));
    } finally { f.close(); }
  }
});

const config = { id: 'service-a', username: 'service_a_bot', displayName: 'Service A', topicPrefix: 'A', locale: 'ru',
  tokenBinding: 'SERVICE_TOKEN', webhookSecretBinding: 'SERVICE_SECRET', enabled: true };

function fixture(rights = { managerPin: true, serviceTopics: true }) {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  // Existing assertions exercise the legacy Russian UI; production defaults to English.
  db.sqlite.prepare(`INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,'ru',?)`)
    .run(new Date().toISOString());
  db.sqlite.prepare(`INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(8,'ru',?)`)
    .run(new Date().toISOString());
  db.sqlite.prepare(`INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(9,'ru',?)`)
    .run(new Date().toISOString());
  const env = { SUPPORT_DB: db, MANAGER_BOT_TOKEN: '100:MANAGER', MANAGER_WEBHOOK_SECRET: 'manager-secret',
    MANAGER_BOT_USERNAME: 'manager_bot', BOT_REGISTRY: JSON.stringify([config]), SERVICE_TOKEN: '200:SERVICE',
    SERVICE_SECRET: 'service-secret', ADMIN_IDS: '7', PUBLIC_BASE_URL: 'https://support.example.workers.dev' };
  let nextMessage = 500;
  const calls = [];
  const wireCalls = [];
  const pinnedMessages = new Map();
  const webhooks = new Map([[newServiceToken, '']]);
  const fetchImpl = async (url, init) => {
    const match = /bot([^/]+)\/(\w+)$/.exec(String(url));
    assert.ok(match, `unexpected Telegram URL ${url}`);
    const [, token, method] = match;
    const body = JSON.parse(init.body || '{}');
    wireCalls.push({ token, method, body });
    calls.push({ token, method, body });
    // Older assertions inspect the latest rendered private screen through
    // sendMessage. Keep that screen-history view while wireCalls records the
    // actual Telegram method for navigation and duplicate-send assertions.
    if (method === 'editMessageText' && Number(body.chat_id) > 0)
      calls.push({ token, method: 'sendMessage', body, virtualScreen: true });
    if (method === 'getMe') return Response.json({ ok: true, result: token === '100:MANAGER'
      ? { id: 100, username: 'manager_bot', is_bot: true, can_manage_bots: true }
      : token === newServiceToken ? { id: 987654, username: 'new_service_bot', first_name: 'New Service', is_bot: true }
        : { id: 200, username: 'service_a_bot', is_bot: true } });
    if (method === 'getChat') return Response.json({ ok: true, result: { id: Number(body.chat_id), type: 'supergroup', title: 'Support group', is_forum: true,
      ...(pinnedMessages.has(Number(body.chat_id)) ? { pinned_message: { message_id: pinnedMessages.get(Number(body.chat_id)) } } : {}) } });
    if (method === 'getChatMember') {
      const manager = Number(body.user_id) === 100;
      return Response.json({ ok: true, result: { status: 'administrator', can_pin_messages: manager ? rights.managerPin : rights.servicePin !== false,
        can_manage_topics: manager ? rights.managerTopics !== false : rights.serviceTopics } });
    }
    if (method === 'getForumTopicIconStickers') return Response.json({ ok: true, result: [
      { custom_emoji_id: '123456789', emoji: '💬' }, { custom_emoji_id: '987654321', emoji: '🧩' },
    ] });
    if (method === 'getWebhookInfo') return Response.json({ ok: true, result: {
      url: webhooks.get(token) ?? 'https://support.example.workers.dev/tg/service-a',
      pending_update_count: rights.pendingWebhookUpdates || 0,
    } });
    if (method === 'closeForumTopic' && rights.failClose)
      return Response.json({ ok: false, error_code: 403, description: 'Forbidden: bot lacks topic rights' }, { status: 403 });
    if (method === 'setWebhook') { webhooks.set(token, body.url); return Response.json({ ok: true, result: true }); }
    if (method === 'deleteWebhook') { webhooks.set(token, ''); return Response.json({ ok: true, result: true }); }
    if (method === 'sendMessage' || method === 'sendRichMessage') {
      if (Number(body.chat_id) > 0 && rights.pauseDmSend) {
        const gate = rights.pauseDmSend;
        delete rights.pauseDmSend;
        gate.entered();
        await gate.finish;
      }
      const messageId = ++nextMessage;
      if (Number(body.chat_id) > 0 && rights.uncertainDmSend) {
        rights.uncertainDmSend = false;
        throw new Error('lost Telegram response after private screen send');
      }
      if (Number(body.chat_id) > 0 && rights.rateLimitDmSend) {
        rights.rateLimitDmSend = false;
        return Response.json({ ok: false, error_code: 429, description: 'Too Many Requests',
          parameters: { retry_after: 1 } }, { status: 429 });
      }
      if (Number(body.chat_id) < 0 && rights.uncertainMenuSend) {
        rights.uncertainMenuSend = false;
        rights.uncertainMenuMessageId = messageId;
        throw new Error('lost Telegram response after menu send');
      }
      return Response.json({ ok: true, result: { message_id: messageId, chat: { id: body.chat_id } } });
    }
    if (method === 'answerCallbackQuery' && rights.ackExpired) return Response.json({ ok: false, error_code: 400, description: 'query is too old' }, { status: 400 });
    if (method === 'sendChatAction' && rights.blockedDmProbeIds?.has(Number(body.chat_id)))
      return Response.json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, { status: 403 });
    if (method === 'pinChatMessage' && rights.failPin) return Response.json({ ok: false, error_code: 403, description: 'pin denied' }, { status: 403 });
    if (method === 'editMessageText' && Number(body.chat_id) === rights.failMenuEditGroup)
      return Response.json({ ok: false, error_code: 403, description: 'edit denied' }, { status: 403 });
    if (method === 'editMessageText' && Number(body.chat_id) > 0 && rights.uncertainDmEdit) {
      rights.uncertainDmEdit = false;
      throw new Error('lost Telegram response after private screen edit');
    }
    if ((method === 'pinChatMessage' || method === 'editMessageText') && rights.deletedMenuMessageIds?.has(Number(body.message_id)))
      return Response.json({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }, { status: 400 });
    if (method === 'pinChatMessage') {
      pinnedMessages.set(Number(body.chat_id), Number(body.message_id));
      if (Number(body.chat_id) === rights.blockCutoverAfterMenuPin && !rights.cutoverBlocked) {
        rights.cutoverBlocked = true;
        db.sqlite.prepare(`INSERT INTO message_delivery_attempts(bot_id,direction,source_chat_id,
          source_message_id,user_id,thread_id,target_chat_id,method,started_at,request_started_at)
          VALUES('service-a','user_to_support',7,11,7,42,?,'copyMessage','now','now')`).run(body.chat_id);
      }
      if (Number(body.chat_id) === rights.rerouteAfterMenuPin && !rights.rerouted) {
        rights.rerouted = true;
        db.sqlite.prepare("UPDATE service_group_routes SET group_id=?,revision=revision+1 WHERE bot_id='service-a'").run(rights.rerouteToGroup);
      }
    }
    if (method === 'editMessageText' && Number(body.chat_id) === rights.rerouteAfterMenuEdit && !rights.rerouted) {
      rights.rerouted = true;
      db.sqlite.prepare("UPDATE service_group_routes SET group_id=?,revision=revision+1 WHERE bot_id='service-a'").run(rights.rerouteToGroup);
    }
    if (method === 'pinChatMessage' || method === 'editMessageText' || method === 'answerCallbackQuery') return Response.json({ ok: true, result: true });
    return Response.json({ ok: true, result: true });
  };
  const base = { async fetch() { return new Response('base'); }, async scheduled() {} };
  const worker = createManagerWorker(base, fetchImpl);
  let updateId = 10;
  const send = async (update, secret = env.MANAGER_WEBHOOK_SECRET) => {
    db.queries = 0;
    const response = await worker.fetch(new Request('https://support.example.workers.dev/tg/manager', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update),
    }), env, {});
    assert.ok(db.queries <= 50, `Manager update used ${db.queries} D1 statements`);
    return response;
  };
  const input = (text, actor = 7, chat = actor, type = 'private') => ({ update_id: updateId++, message: {
    message_id: updateId, from: { id: actor, first_name: 'Admin' }, chat: { id: chat, type }, text,
  } });
  const press = async (data, actor = 7) => send({ update_id: updateId++, callback_query: { id: `q${updateId}`, from: { id: actor },
    message: { message_id: 300, chat: { id: actor, type: 'private' } }, data } });
  const startFlow = async () => {
    await send(input('/start'));
    await press('mg:section:bots');
    const service = calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:service:')).callback_data;
    await press(service);
    const begin = calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard[0][0].callback_data;
    await press(begin);
    return db.sqlite.prepare('SELECT * FROM manager_group_flows WHERE owner_id=7').get();
  };
  return { db, env, calls, wireCalls, pinnedMessages, webhooks, send, input, press, startFlow, close: () => db.close() };
}

test('manager webhook rejects an invalid secret before database or Telegram access', async () => {
  const f = fixture();
  try {
    const response = await f.send(f.input('/start'), 'wrong-secret');
    assert.equal(response.status, 403);
    assert.equal(f.db.queries, 0);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('private manager buttons redraw the clicked card while a new command starts a fresh card', async () => {
  const f = fixture();
  try {
    await f.send(f.input('/start'));
    const initial = f.wireCalls.find(call => call.method === 'sendMessage' && call.body.chat_id === 7);
    assert.ok(initial);
    const click = (id, data) => f.send({ update_id: id, callback_query: { id: `q${id}`,
      from: { id: 7 }, message: { message_id: 501, chat: { id: 7, type: 'private' } }, data } });
    const before = f.wireCalls.length;
    assert.equal((await click(80001, 'mg:users')).status, 200);
    assert.equal((await click(80002, 'mg:home')).status, 200);
    const navigation = f.wireCalls.slice(before).filter(call => ['sendMessage', 'editMessageText'].includes(call.method));
    assert.deepEqual(navigation.map(call => call.method), ['editMessageText', 'editMessageText']);
    assert.ok(navigation.every(call => call.body.message_id === 501 && call.body.chat_id === 7));
    assert.match(navigation[0].body.text, /Пользователи/);
    assert.match(navigation[1].body.text, /Управление поддержкой/);
    await f.send(f.input('/start'));
    assert.equal(f.wireCalls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).length, 2);
  } finally { f.close(); }
});

test('service names that match translated labels stay intact on the manager home screen', async () => {
  const f = fixture();
  try {
    f.env.BOT_REGISTRY = JSON.stringify([{ ...config, displayName: 'Пользователи', locale: 'en' }]);
    f.db.sqlite.prepare("UPDATE manager_operator_preferences SET language='en' WHERE operator_id=7").run();
    await f.send(f.input('/start'));
    await f.press('mg:section:bots');
    const screen = f.wireCalls.filter(call => ['sendMessage', 'editMessageText'].includes(call.method)
      && call.body.chat_id === 7 && call.body.reply_markup?.inline_keyboard).at(-1);
    const serviceButton = screen.body.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:service:'));
    assert.equal(serviceButton.text, '🔧 Пользователи');
  } finally { f.close(); }
});

test('private manager cards have a separated Back and Menu footer across sections', async () => {
  const f = fixture();
  try {
    const footer = () => f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7)
      .at(-1).body.reply_markup.inline_keyboard.slice(-2);
    const expectFooter = back => {
      assert.deepEqual(footer(), [[{ text: '────────', disabled: {} }],
        [{ text: '← Назад', callback_data: back, style: 'primary' },
          { text: '🏠 Меню', callback_data: 'mg:home', style: 'primary' }]]);
    };
    await f.send(f.input('/start'));
    await f.press('mg:section:bots');
    expectFooter('mg:home');
    const key = managementBotKey([config], config.id);
    await f.press(`mg:service:${key}`);
    expectFooter('mg:section:bots');
    await f.press(`mg:settings:${key}`);
    expectFooter(`mg:service:${key}`);
    await f.press(`mg:msgs:${key}`);
    expectFooter(`mg:settings:${key}`);
    await f.press('mu:home:a');
    expectFooter('mg:home');
    await f.press('mu:list:a:x:0');
    expectFooter('mu:home:a');
    await f.press('mu:search');
    expectFooter('mu:searchcancel');
  } finally { f.close(); }
});

test('private manager redraw retries uncertain edits and replaces only definitively missing cards', async () => {
  const rights = { uncertainDmEdit: true, deletedMenuMessageIds: new Set() };
  const f = fixture(rights);
  try {
    const callback = { update_id: 80003, callback_query: { id: 'q80003', from: { id: 7 },
      message: { message_id: 501, chat: { id: 7, type: 'private' } }, data: 'mg:users' } };
    assert.equal((await f.send(callback)).status, 503);
    assert.equal(f.wireCalls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).length, 0);
    assert.equal((await f.send(callback)).status, 200);
    assert.equal(f.wireCalls.filter(call => call.method === 'editMessageText' && call.body.message_id === 501).length, 2);
    rights.deletedMenuMessageIds.add(501);
    const missing = { ...callback, update_id: 80004,
      callback_query: { ...callback.callback_query, id: 'q80004' } };
    assert.equal((await f.send(missing)).status, 200);
    assert.equal((await f.send(missing)).status, 200);
    assert.equal(f.wireCalls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).length, 1);
  } finally { f.close(); }
});

test('leaving private storage redraws its card and retires the old cleanup buttons', async () => {
  const f = fixture();
  try {
    f.env.SUPPORT_GROUP_ID = '-1001234567890';
    f.env.RETENTION_ENABLED = 'true';
    await registerSupportGroup(f.db, -1001234567890, { title: 'Support group' });
    await f.press('mg:storage:group:-1001234567890');
    const screenId = f.db.sqlite.prepare('SELECT screen_message_id FROM manager_storage_sessions WHERE owner_id=7').get().screen_message_id;
    const oldScreen = { message_id: screenId, chat: { id: 7, type: 'private' }, text: 'Хранилище',
      reply_markup: { inline_keyboard: [[{ callback_data: 'um:st:danger' }, { callback_data: 'mg:home' }]] } };
    const before = f.wireCalls.length;
    assert.equal((await f.send({ update_id: 80005, callback_query: { id: 'q80005', from: { id: 7 },
      message: oldScreen, data: 'mg:home' } })).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT 1 FROM manager_storage_sessions WHERE owner_id=7').get(), undefined);
    assert.ok(f.wireCalls.slice(before).some(call => call.method === 'editMessageText'
      && call.body.message_id === screenId && /Управление поддержкой/.test(call.body.text)));
    assert.equal((await f.send({ update_id: 80006, callback_query: { id: 'q80006', from: { id: 7 },
      message: oldScreen, data: 'um:st:danger' } })).status, 200);
    assert.ok(f.wireCalls.some(call => call.method === 'answerCallbackQuery'
      && call.body.callback_query_id === 'q80006' && /устарел/.test(call.body.text || '')));
  } finally { f.close(); }
});
test('manager webhook defers operator actions while conversation storage is resetting', async () => {
  const f = fixture();
  try {
    f.env.RETENTION_ENABLED = 'true';
    f.db.sqlite.exec("UPDATE storage_control SET mode='reset'");
    const response = await f.send(f.input('/start'));
    assert.equal(response.status, 503);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('administrator can pause an in-progress full reset from private storage', async () => {
  const f = fixture();
  try {
    f.env.SUPPORT_GROUP_ID = '-1001234567890';
    f.env.RETENTION_ENABLED = 'true';
    await registerSupportGroup(f.db, -1001234567890, { title: 'Original' });
    f.db.sqlite.prepare(`UPDATE storage_control SET mode='reset',reset_actor=7,reset_group=?,reset_started=?,
      reset_id='test-reset',generation=generation+1 WHERE id=1`).run(-1001234567890, new Date().toISOString());
    assert.equal((await f.send(f.input('/storage'))).status, 200);
    const session = f.db.sqlite.prepare('SELECT screen_message_id FROM manager_storage_sessions WHERE owner_id=7').get();
    assert.ok(session.screen_message_id);
    const callback = { update_id: 92000, callback_query: { id: 'pause-reset', from: { id: 7 },
      data: `um:st:pause:1`, message: { message_id: session.screen_message_id,
        chat: { id: 7, type: 'private' }, text: 'Полная очистка',
        reply_markup: { inline_keyboard: [[{ callback_data: 'um:st:pause:1' }]] } } } };
    assert.equal((await f.send(callback)).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT stopped FROM storage_control WHERE id=1').get().stopped, 1);
  } finally { f.close(); }
});

test('private emergency storage opens without a writable screen session', async () => {
  const f = fixture();
  try {
    f.env.SUPPORT_GROUP_ID = '-1001234567890';
    f.env.RETENTION_ENABLED = 'true';
    const originalPrepare = f.db.prepare.bind(f.db);
    f.db.prepare = sql => {
      if (String(sql).includes('INSERT INTO manager_storage_sessions')) throw new Error('database full');
      return originalPrepare(sql);
    };
    assert.equal((await f.send(f.input('/storage emergency'))).status, 200);
    const panel = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(panel.text, /Аварийное хранилище/);
    assert.ok(!panel.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'um:st:old:all'));
    const callback = { update_id: 93000, callback_query: { id: 'emergency-reset', from: { id: 7 },
      data: 'um:st:reset', message: { message_id: 777, chat: { id: 7, type: 'private' },
        from: { id: 100, username: 'manager_bot', is_bot: true }, text: panel.text,
        reply_markup: panel.reply_markup } } };
    assert.equal((await f.send(callback)).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT confirmation_actor FROM storage_control WHERE id=1').get().confirmation_actor, 7);
  } finally { f.close(); }
});

test('an ambiguous private screen is never sent twice for a replayed manager update', async () => {
  const f = fixture({ managerPin: true, serviceTopics: true, uncertainDmSend: true });
  try {
    const update = f.input('/start');
    assert.equal((await f.send(update)).status, 503);
    assert.equal(f.db.sqlite.prepare('SELECT status FROM manager_message_sends WHERE update_id=?').get(update.update_id).status,
      'uncertain');
    assert.equal((await f.send(update)).status, 200);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.text.startsWith('Управление поддержкой')).length, 1);
    assert.equal((await f.send(f.input('/menu'))).status, 200, 'a new command can refresh the screen');
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.text.startsWith('Управление поддержкой')).length, 2);
  } finally { f.close(); }
});

test('a burst of home commands refreshes one private menu and never overwrites it on replay', async () => {
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const f = fixture();
    try {
      f.db.sqlite.prepare('UPDATE manager_operator_preferences SET language=? WHERE operator_id=7').run(locale);
      Object.assign(f.env, { BOT_ONBOARDING_ENABLED: 'true', BOT_REGISTRY_KEY: '1'.repeat(64),
        TELEGRAM_COOLDOWN_ENABLED: 'true', RETENTION_ENABLED: 'true', STORAGE_GUARD_ENABLED: 'true' });
      const first = f.input('/start');
      assert.equal((await f.send(first)).status, 200);
      const menu = f.wireCalls.find(call => call.method === 'sendMessage' && call.body.chat_id === 7);
      const messageId = f.db.sqlite.prepare('SELECT message_id FROM manager_home_screens WHERE operator_id=7').get().message_id;
      assert.ok(messageId);
      for (const text of ['/menu', '/start menu', '/start@manager_bot', '/groups', '/start'])
        assert.equal((await f.send(f.input(text))).status, 200);
      assert.equal(f.wireCalls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).length, 1);
      const edits = f.wireCalls.filter(call => call.method === 'editMessageText' && call.body.chat_id === 7);
      assert.equal(edits.length, 5);
      assert.ok(edits.every(call => call.body.message_id === messageId && call.body.text === menu.body.text));
      const before = f.wireCalls.length;
      assert.equal((await f.send(first)).status, 200);
      assert.equal(f.wireCalls.length, before, 'old update does not redraw a newer screen');
      f.db.sqlite.prepare("UPDATE manager_home_screens SET requested_at='2000-01-01T00:00:00.000Z' WHERE operator_id=7").run();
      assert.equal((await f.send(f.input('/menu'))).status, 200);
      assert.equal(f.wireCalls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).length, 2);
    } finally { f.close(); }
  }
});

test('a home command arriving during its first render does not create a second menu', async () => {
  let entered, finish;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const f = fixture({ managerPin: true, serviceTopics: true, pauseDmSend: { entered, finish: gate } });
  try {
    const active = f.send(f.input('/start'));
    await ready;
    assert.equal((await f.send(f.input('/menu'))).status, 200);
    finish();
    assert.equal((await active).status, 200);
    assert.equal(f.wireCalls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).length, 1);
  } finally { finish(); f.close(); }
});

test('a missing recent home message is replaced once; an ambiguous edit is never replaced', async () => {
  for (const uncertain of [false, true]) {
    const rights = { managerPin: true, serviceTopics: true };
    const f = fixture(rights);
    try {
      await f.send(f.input('/start'));
      const messageId = f.db.sqlite.prepare('SELECT message_id FROM manager_home_screens WHERE operator_id=7').get().message_id;
      if (uncertain) rights.uncertainDmEdit = true;
      else rights.deletedMenuMessageIds = new Set([messageId]);
      const update = f.input('/menu');
      assert.equal((await f.send(update)).status, uncertain ? 503 : 200);
      assert.equal(f.wireCalls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).length, uncertain ? 1 : 2);
      assert.equal((await f.send(update)).status, 200);
      assert.equal(f.wireCalls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).length, uncertain ? 1 : 2);
    } finally { f.close(); }
  }
});

test('a failed home-pointer write recovers its send receipt and keeps the next command on the same menu', async () => {
  const f = fixture();
  try {
    const prepare = f.db.prepare.bind(f.db);
    let fail = true;
    f.db.prepare = sql => {
      if (fail && sql.startsWith('UPDATE manager_home_screens SET message_id=')) {
        fail = false;
        throw new Error('injected home pointer failure');
      }
      return prepare(sql);
    };
    const update = f.input('/start');
    assert.equal((await f.send(update)).status, 503);
    assert.equal((await f.send(update)).status, 200);
    assert.ok(f.db.sqlite.prepare('SELECT message_id FROM manager_home_screens WHERE operator_id=7').get().message_id);
    assert.equal((await f.send(f.input('/menu'))).status, 200);
    assert.equal(f.wireCalls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).length, 1);
    assert.equal(f.wireCalls.filter(call => call.method === 'editMessageText' && call.body.chat_id === 7).length, 1);
  } finally { f.close(); }
});

test('home timing distinguishes update age from processing without logging message contents', async () => {
  const f = fixture(), records = [], info = console.info;
  console.info = value => records.push(JSON.parse(value));
  try {
    const update = f.input('/start');
    update.message.date = Math.floor(Date.now() / 1000) - 60;
    update.message.from.first_name = 'PRIVATE-NAME-DO-NOT-LOG';
    assert.equal((await f.send(update)).status, 200);
    assert.equal(records.length, 1);
    assert.equal(records[0].event, 'manager_update_timing');
    assert.equal(records[0].kind, 'start');
    assert.ok(records[0].source_age_ms >= 60_000);
    assert.ok(records[0].elapsed_ms >= 0);
    assert.ok(records[0].queries <= 50);
    assert.ok(!JSON.stringify(records).includes('PRIVATE-NAME-DO-NOT-LOG'));
    assert.ok(!JSON.stringify(records).includes(f.env.MANAGER_BOT_TOKEN));
    assert.ok(!JSON.stringify(records).includes(f.env.MANAGER_WEBHOOK_SECRET));
    assert.equal(f.db.statements.filter(sql => sql.startsWith('DELETE FROM manager_search_flows')).length, 1);
  } finally { console.info = info; f.close(); }
});

test('a confirmed rate limit releases the screen claim so the same update can retry', async () => {
  const f = fixture({ managerPin: true, serviceTopics: true, rateLimitDmSend: true });
  try {
    const update = f.input('/start');
    assert.equal((await f.send(update)).status, 503);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM manager_message_sends WHERE update_id=?').get(update.update_id).n, 0);
    assert.equal((await f.send(update)).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT status FROM manager_message_sends WHERE update_id=?').get(update.update_id).status,
      'sent');
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.text.startsWith('Управление поддержкой')).length, 2);
  } finally { f.close(); }
});

test('a lost screen receipt write does not trigger a duplicate Telegram send', async () => {
  const f = fixture();
  try {
    const update = f.input('/start');
    const prepare = f.db.prepare.bind(f.db);
    let fail = true;
    f.db.prepare = sql => {
      if (fail && sql.startsWith("UPDATE manager_message_sends SET status='sent'")) {
        fail = false;
        throw new Error('injected D1 receipt failure');
      }
      return prepare(sql);
    };
    assert.equal((await f.send(update)).status, 503);
    assert.equal((await f.send(update)).status, 200);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.text.startsWith('Управление поддержкой')).length, 1);
    assert.equal(f.db.sqlite.prepare('SELECT status FROM manager_message_sends WHERE update_id=?').get(update.update_id).status,
      'sending');
  } finally { f.close(); }
});

test('only the configured administrator can pair a group', async () => {
  const f = fixture();
  try {
    const flow = await f.startFlow();
    assert.equal(flow.stage, 'awaiting_group');
    const response = await f.send(f.input(`/connect ${flow.code}`, 8, -1001234567890, 'supergroup'));
    assert.equal(response.status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT stage FROM manager_group_flows WHERE owner_id=7').get().stage, 'awaiting_group');
    assert.equal(f.calls.some(call => ['getMe', 'getChat', 'getChatMember'].includes(call.method)), false);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM service_group_routes').get().n, 0);
  } finally { f.close(); }
});

for (const [rights, message] of [
  [{ managerPin: false, serviceTopics: true }, /закреплять сообщения/],
  [{ managerPin: true, managerTopics: false, serviceTopics: true }, /управлять темами/],
  [{ managerPin: true, serviceTopics: false }, /управлять темами/],
]) test(`group pairing refuses to proceed when required bot rights are missing: ${message}`, async () => {
  const f = fixture(rights);
  try {
    const flow = await f.startFlow();
    const response = await f.send(f.input(`/connect ${flow.code}`, 7, -1001234567890, 'supergroup'));
    assert.equal(response.status, 200, 'a missing right needs administrator action, not a webhook retry loop');
    assert.equal(f.db.sqlite.prepare('SELECT stage FROM manager_group_flows WHERE owner_id=7').get().stage, 'awaiting_group');
    assert.ok(f.calls.filter(call => call.method === 'getChatMember').length >= 1);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, message);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM service_group_routes').get().n, 0);
  } finally { f.close(); }
});

test('confirming and replaying group pairing creates one route and one group menu', async () => {
  const f = fixture();
  try {
    const flow = await f.startFlow();
    assert.equal((await f.send(f.input(`/connect ${flow.code}`, 7, -1001234567890, 'supergroup'))).status, 200);
    const staged = f.db.sqlite.prepare('SELECT * FROM manager_group_flows WHERE owner_id=7').get();
    assert.equal(staged.stage, 'confirm');
    const confirmCall = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1);
    assert.match(confirmCall.body.text, /Сервис: Service A[\s\S]*Группа: Support group[\s\S]*Управляющий бот: @manager_bot[\s\S]*Сервисный бот: @service_a_bot[\s\S]*Ответственный: главный администратор/);
    const confirm = confirmCall.body.reply_markup.inline_keyboard[0][0].callback_data;
    const expires = new Date(Date.now() + 600000).toISOString();
    f.db.sqlite.prepare(`INSERT INTO operator_pending_actions
      (operator_id,operator_name,management_bot_id,action,stage,chat_id,thread_id,created_at,expires_at,flow_nonce)
      VALUES(8,'Operator','service-a','ban','service',-1001234567890,1,?,?,?)`)
      .run(expires, expires, 'legacy-form');
    f.db.sqlite.prepare(`INSERT INTO operator_work_inputs
      (operator_id,bot_id,user_id,nonce,expected_revision,chat_id,thread_id,expires_at)
      VALUES(9,'service-a',901,'topic-form',0,-1001234567890,42,?)`).run(expires);
    assert.equal((await f.press(confirm)).status, 200);
    assert.equal((await f.press(confirm)).status, 200);

    const route = f.db.sqlite.prepare('SELECT * FROM service_group_routes WHERE bot_id=?').get('service-a');
    assert.equal(route.group_id, -1001234567890);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM service_group_routes WHERE bot_id=?').get('service-a').n, 1);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM support_groups WHERE group_id=?').get(-1001234567890).n, 1);
    assert.equal(f.db.sqlite.prepare('SELECT suspended FROM operator_pending_actions WHERE operator_id=8').get().suspended, 1);
    assert.equal(f.db.sqlite.prepare('SELECT active FROM operator_input_guards WHERE operator_id=8').get().active, 0);
    assert.equal(f.db.sqlite.prepare('SELECT suspended FROM operator_work_inputs WHERE operator_id=9').get().suspended, 0);
    assert.ok(f.db.sqlite.prepare('SELECT menu_message_id FROM support_groups WHERE group_id=?').get(-1001234567890).menu_message_id);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === -1001234567890).length, 1);
    assert.equal(f.calls.filter(call => call.method === 'pinChatMessage' && call.body.chat_id === -1001234567890).length, 1);
  } finally { f.close(); }
});

test('manager opens storage in private chat for a selected group and ignores the old group command', async () => {
  const f = fixture();
  try {
    f.env.SUPPORT_GROUP_ID = '-1001234567890';
    f.env.RETENTION_ENABLED = 'true';
    await registerSupportGroup(f.db, -1001234567890, { title: 'Original' });
    await registerSupportGroup(f.db, -1002223334445, { title: 'Second' });
    await f.send(f.input('/start'));
    const home = f.calls.filter(call => call.token === '100:MANAGER' && call.method === 'sendMessage').at(-1);
    assert.ok(home.body.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'mg:section:platform'));
    await f.press('mg:section:platform');
    assert.ok(f.calls.filter(call => call.token === '100:MANAGER' && call.method === 'sendMessage').at(-1)
      .body.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'mg:storage'));
    await f.press('mg:storage');
    const choices = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(choices.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'mg:storage:group:-1002223334445'));
    await f.press('mg:storage:group:-1002223334445');
    const storage = f.calls.filter(call => call.token === '100:MANAGER' && call.method === 'sendMessage'
      && Number(call.body.chat_id) === 7).at(-1);
    assert.ok(storage.body.text.includes('Хранилище'));
    assert.ok(storage.body.text.includes('Группа: Second'));
    assert.ok(storage.body.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'mg:storage'));
    assert.deepEqual(storage.body.reply_markup.inline_keyboard.slice(-2), [[{ text: '────────', disabled: {} }],
      [{ text: '← Назад', callback_data: 'mg:storage', style: 'primary' },
        { text: '🏠 Меню', callback_data: 'mg:home', style: 'primary' }]]);
    assert.equal(storage.body.reply_markup.inline_keyboard.flat()
      .find(item => item.text === 'Очистить удалённые топики')?.style, 'danger');
    assert.equal(f.db.sqlite.prepare('SELECT group_id FROM manager_storage_sessions WHERE owner_id=7').get().group_id, -1002223334445);
    assert.equal((await f.send(f.input('/storage rules 90 14 1000'))).status, 200);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, /Новые правила/);
    const before = f.calls.length;
    assert.equal((await f.send(f.input('/storage@manager_bot', 7, -1001234567890, 'supergroup'))).status, 200);
    assert.equal(f.calls.length, before);
    assert.equal(f.calls.some(call => call.token === '200:SERVICE' && call.method === 'sendMessage'), false);
  } finally { f.close(); }
});

test('storage and bot setup can reach groups beyond the former 40-group cutoff', async () => {
  const f = fixture();
  try {
    const insert = f.db.sqlite.prepare(`INSERT INTO support_groups(group_id,title,menu_state,created_at,updated_at)
      VALUES(?,?,'ready',?,?)`);
    for (let index = 0; index < 45; index++) {
      const stamp = new Date(Date.UTC(2026, 8, 29, 0, index)).toISOString();
      insert.run(-1007000000000 - index, `Group ${index}`, stamp, stamp);
    }
    await f.press('mg:storage');
    let screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:storage:page:1'));
    await f.press('mg:storage:page:2');
    screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:storage:group:-1007000000000'));
    await f.press('mg:addbot');
    screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:addbotpage:1'));
    await f.press('mg:addbotpage:2');
    screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:reggrp:-1007000000000'));
  } finally { f.close(); }
});

test('owner, transfer and alert recipient pickers can reach operators beyond 40', async () => {
  const f = fixture();
  try {
    const insert = f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
      VALUES(?,?,1,7,'Admin','now')`);
    for (let index = 0; index < 45; index++) insert.run(1000 + index, `Op${String(index).padStart(2, '0')}`);
    const key = managementBotKey([config], config.id);
    await f.press(`mg:choose:${key}:p`);
    let screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:choose:${key}:p:1`));
    await f.press(`mg:choose:${key}:p:2`);
    screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:set:${key}:p:1044`));
    f.db.sqlite.prepare(`INSERT INTO manager_dm_status(operator_id,started_at,available,updated_at)
      VALUES(1044,'now',1,'now')`).run();
    await f.press(`mg:set:${key}:p:1044`);
    assert.equal(f.db.sqlite.prepare("SELECT primary_id FROM service_responsibility WHERE bot_id='service-a'").get().primary_id, 1044);

    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,revision,updated_at)
      VALUES('service-a',42,'needs_reply',0,'now')`).run();
    await f.press(`mg:transfer:${key}:42:0`);
    screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const nextTransfer = screen.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:transferpage:'));
    assert.ok(nextTransfer);
    const transferNonce = nextTransfer.callback_data.split(':')[2];
    await f.press(`mg:transferpage:${transferNonce}:2`);
    screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:to:${transferNonce}:1044`));
    await f.press(`mg:to:${transferNonce}:1044`);
    assert.deepEqual({ ...f.db.sqlite.prepare('SELECT target_id,stage FROM manager_work_flows WHERE operator_id=7').get() },
      { target_id: 1044, stage: 'note' });

    f.env.ALERT_SETTINGS = { status: async () => ({ generation: 0, mode: 'private', username: 'alert_bot',
      recipients: [7] }) };
    await f.press('mg:alert:private');
    screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const nextAlert = screen.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:alert:page:'));
    assert.ok(nextAlert);
    const alertNonce = nextAlert.callback_data.split(':')[3];
    await f.press(`mg:alert:page:${alertNonce}:2`);
    screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const lastOperator = screen.reply_markup.inline_keyboard.flat().find(item => item.callback_data === `mg:alert:toggle:${alertNonce}:1044:2`);
    assert.ok(lastOperator);
    await f.press(lastOperator.callback_data);
    screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(screen.text, /Страница операторов 3/);
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.text.includes('✅ Op44')));
  } finally { f.close(); }
});

test('manager service card exposes preserved message, reaction and topic settings', async () => {
  const f = fixture();
  try {
    f.env.SUPPORT_GROUP_ID = '-1001234567890';
    await registerSupportGroup(f.db, -1001234567890, { title: 'Support' });
    await commitGroupCutover(f.db, 'service-a', -1001234567890, null);
    f.db.sqlite.prepare(`INSERT INTO bot_message_settings(bot_id,welcome_text,auto_reply_text,revision,updated_by,updated_at)
      VALUES('service-a','Old welcome','Old reply','v1',7,'now')`).run();
    await f.send(f.input('/start'));
    await f.press('mg:section:bots');
    const cardButton = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:service:'));
    await f.press(cardButton.callback_data);
    const card = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const settingsButton = card.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:settings:'));
    assert.ok(settingsButton);
    const key = settingsButton.callback_data.split(':')[2];
    await f.press(settingsButton.callback_data);
    const settings = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    for (const section of ['msgs', 'rx', 'style'])
      assert.ok(settings.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:${section}:${key}`));
    await f.press(`mg:msgs:${key}`);
    await f.press(`mg:msg:${key}:w:view`);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, /Old welcome/);
    assert.equal(f.db.sqlite.prepare("SELECT welcome_text FROM bot_message_settings WHERE bot_id='service-a'").get().welcome_text, 'Old welcome');
    await f.press(`mg:rx:${key}`);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, /не проверено/);
    await f.press(`mg:rxtest:${key}`);
    const check = f.db.sqlite.prepare("SELECT state,group_id FROM reaction_checks WHERE bot_id='service-a'").get();
    assert.equal(check.state, 'waiting');
    assert.equal(check.group_id, -1001234567890);
    assert.ok(f.calls.some(call => call.method === 'setWebhook' && call.body.allowed_updates.includes('message_reaction')));
  } finally { f.close(); }
});

test('manager copies welcome and acknowledgement texts with their switches after preview', async () => {
  const f = fixture();
  try {
    const target = { ...config, id: 'service-b', displayName: 'Service B',
      tokenBinding: 'SERVICE_B_TOKEN', webhookSecretBinding: 'SERVICE_B_SECRET' };
    f.env.BOT_REGISTRY = JSON.stringify([config, target]);
    const sourceKey = managementBotKey([config, target], config.id);
    const targetKey = managementBotKey([config, target], target.id);
    f.db.sqlite.prepare(`INSERT INTO bot_message_settings(bot_id,welcome_text,auto_reply_text,revision,updated_by,updated_at)
      VALUES('service-a','Hello from A','We received it','source-v1',7,'now'),
        ('service-b','Old target','Old acknowledgement','target-v1',7,'now')`).run();
    f.db.sqlite.prepare(`INSERT INTO bot_message_preferences(bot_id,welcome_enabled,auto_reply_enabled,welcome_reviewed,auto_reply_reviewed)
      VALUES('service-a',1,0,1,1),('service-b',0,1,0,0)`).run();
    await f.press(`mg:copymsg:${targetKey}`);
    const chooser = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(chooser.reply_markup.inline_keyboard.flat().some(item =>
      item.callback_data === `mg:copypreview:${targetKey}:${sourceKey}`));
    await f.press(`mg:copypreview:${targetKey}:${sourceKey}`);
    const preview = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(preview.text, /Hello from A/);
    assert.match(preview.text, /We received it/);
    assert.match(preview.text, /выключена/);
    assert.equal(f.db.sqlite.prepare("SELECT welcome_text FROM bot_message_settings WHERE bot_id='service-b'").get().welcome_text,
      'Old target');
    const apply = preview.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:copyapply:'));
    assert.ok(apply.callback_data.length <= 64);
    f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
      VALUES(8,'Operator',1,7,'Admin','now')`).run();
    await f.press(apply.callback_data, 8);
    assert.equal(f.db.sqlite.prepare("SELECT welcome_text FROM bot_message_settings WHERE bot_id='service-b'").get().welcome_text,
      'Old target');
    await f.press(apply.callback_data);
    assert.deepEqual({ ...f.db.sqlite.prepare("SELECT welcome_text,auto_reply_text FROM bot_message_settings WHERE bot_id='service-b'").get() },
      { welcome_text: 'Hello from A', auto_reply_text: 'We received it' });
    assert.deepEqual({ ...f.db.sqlite.prepare("SELECT welcome_enabled,auto_reply_enabled,welcome_reviewed,auto_reply_reviewed FROM bot_message_preferences WHERE bot_id='service-b'").get() },
      { welcome_enabled: 1, auto_reply_enabled: 0, welcome_reviewed: 1, auto_reply_reviewed: 1 });
    assert.equal(f.db.sqlite.prepare("SELECT welcome_text FROM bot_message_settings WHERE bot_id='service-a'").get().welcome_text,
      'Hello from A');
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM operator_audit WHERE action='bot_messages_copy' AND bot_id='service-b'").get().n, 1);
    await f.press(apply.callback_data);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM operator_audit WHERE action='bot_messages_copy' AND bot_id='service-b'").get().n, 1);
  } finally { f.close(); }
});

test('saved messages of a paused service remain usable as a copy source', async () => {
  const f = fixture();
  try {
    const source = { ...config, enabled: false };
    const target = { ...config, id: 'service-b', displayName: 'Service B',
      tokenBinding: 'SERVICE_B_TOKEN', webhookSecretBinding: 'SERVICE_B_SECRET' };
    f.env.BOT_REGISTRY = JSON.stringify([source, target]);
    f.db.sqlite.prepare(`INSERT INTO bot_message_settings(bot_id,welcome_text,auto_reply_text,revision,updated_by,updated_at)
      VALUES('service-a','Saved welcome','Saved acknowledgement','source-v1',7,'now')`).run();
    const sourceKey = managementBotKey([source, target], source.id);
    const targetKey = managementBotKey([source, target], target.id);
    await f.press(`mg:copymsg:${targetKey}`);
    const chooser = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(chooser.reply_markup.inline_keyboard.flat().some(item => item.text.includes('⏸')
      && item.callback_data === `mg:copypreview:${targetKey}:${sourceKey}`));
    await f.press(`mg:copypreview:${targetKey}:${sourceKey}`);
    const preview = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(preview.text, /Saved welcome/);
    const apply = preview.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:copyapply:'));
    await f.press(apply.callback_data);
    assert.equal(f.db.sqlite.prepare("SELECT welcome_text FROM bot_message_settings WHERE bot_id='service-b'").get().welcome_text,
      'Saved welcome');
  } finally { f.close(); }
});

test('service protection screen retains thresholds and recent event counts', async () => {
  const f = fixture();
  try {
    const key = managementBotKey([config], config.id);
    f.db.sqlite.prepare(`INSERT INTO abuse_events(bot_id,user_id,event_key,event_type,created_at)
      VALUES('service-a',42,'new-1','new_user',?),('service-a',42,'limit-1','minute_limit',?),
        ('service-a',42,'captcha-1','verification_requested',?)`).run(...Array(3).fill(new Date().toISOString()));
    await f.press(`mg:attack:${key}`);
    const screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(screen.text, /Пороги сообщений:/);
    assert.match(screen.text, /Порог CAPTCHA:/);
    assert.match(screen.text, /новых пользователей 1, ограничений частоты 1, CAPTCHA 1/);
  } finally { f.close(); }
});

test('manager journal renders restored and manager-origin actions in plain language', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO operator_audit(bot_id,user_id,actor_type,operator_id,operator_name,action,result,created_at)
      VALUES('service-a',42,'operator',7,'Admin','manager_work_snooze','success','2026-09-29T12:00:00Z'),
        ('service-a',42,'system',NULL,NULL,'conversation_reopened_by_user','success','2026-09-29T11:00:00Z')`).run();
    await f.press('mg:audit:0');
    const screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(screen.text, /Обращение отложено/);
    assert.match(screen.text, /Обращение возобновлено пользователем/);
  } finally { f.close(); }
});

test('long journal entries stay readable and older entries remain reachable', async () => {
  const f = fixture();
  try {
    const longText = 'Д'.repeat(120);
    for (let index = 1; index <= 7; index++)
      f.db.sqlite.prepare(`INSERT INTO operator_audit(bot_id,user_id,actor_type,operator_id,operator_name,action,reason,result,created_at)
        VALUES('service-a',42,'operator',7,?,?,?,'success',?)`)
        .run(longText, longText, longText, `2026-09-${String(index).padStart(2, '0')}T12:00:00Z`);
    await f.press('mg:audit:0');
    let screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(screen.text.length < 4096);
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:audit:a:1'));
    await f.press('mg:audit:a:1');
    screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(screen.text, /страница 2/);
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:audit:a:0'));
  } finally { f.close(); }
});

test('message copy refuses a preview after either bot settings change', async () => {
  const f = fixture();
  try {
    const target = { ...config, id: 'service-b', displayName: 'Service B',
      tokenBinding: 'SERVICE_B_TOKEN', webhookSecretBinding: 'SERVICE_B_SECRET' };
    f.env.BOT_REGISTRY = JSON.stringify([config, target]);
    const sourceKey = managementBotKey([config, target], config.id);
    const targetKey = managementBotKey([config, target], target.id);
    f.db.sqlite.prepare(`INSERT INTO bot_message_settings(bot_id,welcome_text,auto_reply_text,revision,updated_by,updated_at)
      VALUES('service-a','First','Second','source-v1',7,'now')`).run();
    await f.press(`mg:copypreview:${targetKey}:${sourceKey}`);
    const apply = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:copyapply:'));
    f.db.sqlite.prepare("UPDATE bot_message_settings SET welcome_text='Changed',revision='source-v2' WHERE bot_id='service-a'").run();
    await f.press(apply.callback_data);
    const response = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(response.text, /изменились/);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM bot_message_settings WHERE bot_id='service-b'").get().n, 0);
    await f.press(`mg:copypreview:${targetKey}:${sourceKey}`);
    const secondApply = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:copyapply:'));
    f.db.sqlite.prepare(`INSERT INTO bot_message_settings(bot_id,welcome_text,auto_reply_text,revision,updated_by,updated_at)
      VALUES('service-b','New target','Other text','target-v1',7,'now')`).run();
    await f.press(secondApply.callback_data);
    const secondResponse = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(secondResponse.text, /изменились/);
    assert.equal(f.db.sqlite.prepare("SELECT welcome_text FROM bot_message_settings WHERE bot_id='service-b'").get().welcome_text,
      'New target');
  } finally { f.close(); }
});

test('manager reaction check can be closed and restarted without losing its webhook subscription', async () => {
  const f = fixture();
  try {
    await registerSupportGroup(f.db, -1001234567890, { title: 'Support' });
    await commitGroupCutover(f.db, 'service-a', -1001234567890, null);
    const key = managementBotKey([config], config.id);
    await f.press(`mg:rxtest:${key}`);
    const original = f.db.sqlite.prepare("SELECT nonce FROM reaction_checks WHERE bot_id='service-a'").get().nonce;
    const checkScreen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(checkScreen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:rxstop:${key}:${original}`));
    await f.press(`mg:rxset:${key}:0:off`);
    const duringCheck = f.calls.filter(call => call.method === 'setWebhook').at(-1);
    assert.ok(duringCheck.body.allowed_updates.includes('message_reaction'));
    await f.press(`mg:rxstop:${key}:${original}`);
    const afterStop = f.calls.filter(call => call.method === 'setWebhook').at(-1);
    assert.equal(afterStop.body.allowed_updates.includes('message_reaction'), false);
    await f.press(`mg:rxtest:${key}`);
    assert.notEqual(f.db.sqlite.prepare("SELECT nonce FROM reaction_checks WHERE bot_id='service-a'").get().nonce, original);
    f.db.sqlite.prepare("INSERT INTO bots(id,display_name,topic_prefix,enabled,created_at) VALUES('service-a','Service A','A',0,'now')").run();
    await f.press(`mg:rxstop:${key}:${original}`);
    await f.press(`mg:rxtest:${key}`);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, /аварийным выключателем/);
  } finally { f.close(); }
});

test('manager-started reaction check automatically enables both directions only after both proofs', async () => {
  const f = fixture();
  try {
    const groupId = -1001234567890, key = managementBotKey([config], config.id);
    await registerSupportGroup(f.db, groupId, { title: 'Support' });
    await commitGroupCutover(f.db, config.id, groupId, null);
    await f.press(`mg:rxtest:${key}`);
    const started = f.db.sqlite.prepare("SELECT * FROM reaction_checks WHERE bot_id='service-a'").get();
    assert.equal(started.state, 'waiting');
    let messageId = 2000;
    const checks = createReactionChecks({ ...f.env, SUPPORT_GROUP_ID: String(groupId) }, {
      primaryId: 7, resolveBot: () => config, botKey: () => key, receiverId: async () => config.id,
      subscribe: async () => {},
      telegram: async (_target, method, body) => ({ ok: true, result: method === 'sendMessage'
        ? { message_id: ++messageId, chat: { id: body.chat_id } } : true }),
    });
    await checks.open(config.id, { from: { id: 7 }, chat: { id: 7, type: 'private' } }, started.nonce);
    const ready = f.db.sqlite.prepare("SELECT * FROM reaction_checks WHERE bot_id='service-a'").get();
    assert.equal(ready.state, 'ready');
    let updateId = 21000;
    const proof = async (chatId, targetMessageId, emoji) => {
      const event = { chat: { id: chatId }, message_id: targetMessageId, user: { id: 7, is_bot: false },
        date: Math.floor(Date.now() / 1000), new_reaction: emoji ? [{ type: 'emoji', emoji }] : [] };
      const update = { update_id: ++updateId, message_reaction: event };
      assert.equal(await checks.reaction(config.id, update, { event, emoji, unsupported: false }), true);
    };
    for (const emoji of ['👍', '👀', null]) await proof(groupId, ready.group_message_id, emoji);
    let settings = f.db.sqlite.prepare("SELECT * FROM reaction_settings WHERE bot_id='service-a'").get();
    assert.equal(settings.support_to_user_verified, 1);
    assert.equal(settings.enabled, 0);
    assert.equal(settings.user_to_support_enabled, 0);
    for (const emoji of ['👍', '👀', null]) await proof(7, ready.private_message_id, emoji);
    settings = f.db.sqlite.prepare("SELECT * FROM reaction_settings WHERE bot_id='service-a'").get();
    assert.equal(settings.support_to_user_enabled, 1);
    assert.equal(settings.user_to_support_enabled, 1);
    assert.equal(settings.enabled, 1);
    await f.press(`mg:rxcheck:${key}`);
    const screen = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7).at(-1).body;
    assert.match(screen.text, /включено, проверено/);
    await f.press(`mg:service:${key}`);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7).at(-1).body.text,
      /Реакции: ✅ проверены и включены/);
  } finally { f.close(); }
});

test('manager private settings save messages, style and protection while retaining old data', async () => {
  const f = fixture();
  try {
    const key = managementBotKey([config], config.id);
    f.db.sqlite.prepare(`INSERT INTO bot_message_settings(bot_id,welcome_text,auto_reply_text,revision,updated_by,updated_at)
      VALUES('service-a','Welcome before','Reply before','v1',7,'now')`).run();
    await f.press(`mg:msg:${key}:w:edit`);
    assert.equal((await f.send(f.input('Welcome after'))).status, 200);
    const flow = f.db.sqlite.prepare('SELECT nonce,stage FROM bot_message_flows WHERE owner_id=7').get();
    assert.equal(flow.stage, 'confirm');
    const confirmScreen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(confirmScreen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:msgrevise:${flow.nonce}`));
    await f.press(`mg:msgrevise:${flow.nonce}`);
    assert.equal(f.db.sqlite.prepare('SELECT stage FROM bot_message_flows WHERE owner_id=7').get().stage, 'text');
    await f.send(f.input('Welcome after'));
    await f.press(`mg:msgsave:${flow.nonce}`);
    const savedMessages = f.db.sqlite.prepare('SELECT welcome_text,auto_reply_text FROM bot_message_settings WHERE bot_id=?').get('service-a');
    assert.equal(savedMessages.welcome_text, 'Welcome after');
    assert.equal(savedMessages.auto_reply_text, 'Reply before');
    f.db.sqlite.prepare(`INSERT INTO bot_message_drafts(owner_id,bot_id,field,draft,expected_revision,updated_at)
      VALUES(7,'service-a','auto_reply_text','Draft reply',?,'now')`).run(
      f.db.sqlite.prepare("SELECT revision FROM bot_message_settings WHERE bot_id='service-a'").get().revision);
    await f.press(`mg:msg:${key}:a:view`);
    assert.ok(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:msg:${key}:a:restore`));
    await f.press(`mg:msg:${key}:a:restore`);
    assert.equal(f.db.sqlite.prepare('SELECT draft FROM bot_message_flows WHERE owner_id=7').get()?.draft, 'Draft reply',
      f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text);
    await f.send(f.input('/cancel'));
    assert.equal(f.db.sqlite.prepare('SELECT draft FROM bot_message_drafts WHERE owner_id=7').get().draft, 'Draft reply');
    await f.press(`mg:msg:${key}:a:off`);
    assert.deepEqual({ ...f.db.sqlite.prepare("SELECT auto_reply_enabled,auto_reply_reviewed FROM bot_message_preferences WHERE bot_id='service-a'").get() },
      { auto_reply_enabled: 0, auto_reply_reviewed: 1 });
    await f.press(`mg:stylecolor:${key}:7322096`);
    assert.equal(f.db.sqlite.prepare("SELECT icon_color FROM topic_style_settings WHERE bot_id='service-a'").get().icon_color, 7322096);
    await f.press(`mg:styleicons:${key}:0`);
    await f.press(`mg:styleicon:${key}:123456789`);
    assert.equal(f.db.sqlite.prepare("SELECT icon_custom_emoji_id FROM topic_style_settings WHERE bot_id='service-a'").get().icon_custom_emoji_id, '123456789');
    await f.press(`mg:stylecolor:${key}:9367192`);
    assert.equal(f.db.sqlite.prepare("SELECT icon_custom_emoji_id FROM topic_style_settings WHERE bot_id='service-a'").get().icon_custom_emoji_id, '123456789');
    await f.press(`mg:stylereset:${key}`);
    assert.equal(f.db.sqlite.prepare("SELECT icon_color FROM topic_style_settings WHERE bot_id='service-a'").get().icon_color, null);
    assert.equal(f.db.sqlite.prepare("SELECT icon_custom_emoji_id FROM topic_style_settings WHERE bot_id='service-a'").get().icon_custom_emoji_id, null);
    await f.press(`mg:attackset:${key}:on`);
    assert.equal(f.db.sqlite.prepare("SELECT manual_override FROM service_attack_state WHERE bot_id='service-a'").get().manual_override, 'on');
    await f.press(`mg:attackconfirm:${key}`);
    assert.equal(f.db.sqlite.prepare("SELECT manual_override FROM service_attack_state WHERE bot_id='service-a'").get().manual_override, 'on');
    await f.press(`mg:attackset:${key}:off`, 8);
    assert.equal(f.db.sqlite.prepare("SELECT manual_override FROM service_attack_state WHERE bot_id='service-a'").get().manual_override, 'on');
    const confirmation = { update_id: 18001, callback_query: { id: 'attack-confirm', from: { id: 7 },
      message: { message_id: 300, chat: { id: 7, type: 'private' },
        text: 'Выключить автоматическую защиту Service A на один час?' }, data: `mg:attackset:${key}:off` } };
    await f.send(confirmation);
    assert.equal(f.db.sqlite.prepare("SELECT manual_override FROM service_attack_state WHERE bot_id='service-a'").get().manual_override, 'off');
    let nextUpdateId = 18010;
    for (const [index, locale] of ['en', 'es', 'zh'].entries()) {
      f.db.sqlite.prepare(`UPDATE manager_operator_preferences SET language=?,updated_at=? WHERE operator_id=7`)
        .run(locale, new Date(Date.now() + index + 1).toISOString());
      await f.press(`mg:attackset:${key}:on`);
      await f.press(`mg:attackconfirm:${key}`);
      const localizedCard = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7).at(-1).body;
      assert.ok(!/[А-Яа-яЁё]/u.test(localizedCard.text), `${locale} confirmation is localized`);
      const click = { update_id: nextUpdateId++, callback_query: { id: `attack-confirm-${locale}`, from: { id: 7 },
        message: { message_id: localizedCard.message_id || 300, chat: { id: 7, type: 'private' }, text: localizedCard.text },
        data: `mg:attackset:${key}:off` } };
      assert.equal((await f.send(click)).status, 200);
      assert.equal(f.db.sqlite.prepare("SELECT manual_override FROM service_attack_state WHERE bot_id='service-a'").get().manual_override, 'off');
    }
  } finally { f.close(); }
});

test('clearing a bot message records an intentional off state for setup checks', async () => {
  const f = fixture();
  try {
    const key = managementBotKey([config], config.id);
    f.db.sqlite.prepare(`INSERT INTO bot_message_settings(bot_id,welcome_text,auto_reply_text,revision,updated_by,updated_at)
      VALUES('service-a','Hello','','v1',7,'now')`).run();
    await f.press(`mg:msg:${key}:w:clear`);
    const nonce = f.db.sqlite.prepare('SELECT nonce FROM bot_message_flows WHERE owner_id=7').get().nonce;
    await f.press(`mg:msgsave:${nonce}`);
    const preference = f.db.sqlite.prepare("SELECT welcome_enabled,welcome_reviewed FROM bot_message_preferences WHERE bot_id='service-a'").get();
    assert.deepEqual({ ...preference }, { welcome_enabled: 0, welcome_reviewed: 1 });
    await f.press(`mg:settings:${key}`);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text,
      /Приветствие: выключено/);
  } finally { f.close(); }
});

test('manager private menu exposes the global Cloudflare plan with a confirmation', async () => {
  const f = fixture();
  try {
    await f.send(f.input('/start'));
    const home = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(home.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:section:platform'));
    await f.press('mg:section:platform');
    assert.ok(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:plan'));
    await f.press('mg:plan');
    const revision = f.db.sqlite.prepare('SELECT revision FROM cloudflare_plan_settings WHERE id=1').get().revision;
    await f.press(`mg:plan:choose:free:${revision}`);
    assert.equal(f.db.sqlite.prepare('SELECT plan FROM cloudflare_plan_settings WHERE id=1').get().plan, null);
    await f.press(`mg:plan:set:free:${revision}`);
    assert.equal(f.db.sqlite.prepare('SELECT plan FROM cloudflare_plan_settings WHERE id=1').get().plan, 'free');
  } finally { f.close(); }
});

test('paid renewal day can be changed after the plan has already been configured', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare("UPDATE cloudflare_plan_settings SET plan='paid',billing_day=12 WHERE id=1").run();
    const revision = f.db.sqlite.prepare('SELECT revision FROM cloudflare_plan_settings WHERE id=1').get().revision;
    await f.press('mg:plan');
    const home = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(home.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:plan:day:paid:${revision}`));
    await f.press(`mg:plan:day:paid:${revision}`);
    const days = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(days.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:plan:choose:paid:${revision}:18`));
    await f.press(`mg:plan:choose:paid:${revision}:18`);
    await f.press(`mg:plan:set:paid:${revision}:18`);
    assert.equal(f.db.sqlite.prepare('SELECT billing_day FROM cloudflare_plan_settings WHERE id=1').get().billing_day, 18);
  } finally { f.close(); }
});

test('manager private menu restores user search and the action log', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,username,support_group_id,thread_id,status,created_at)
      VALUES('service-a',42,'Alice','alice',-1001234567890,123,'open',?)`).run(new Date().toISOString());
    assert.equal((await f.send(f.input('/user @alice'))).status, 200);
    const search = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const result = search.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.endsWith(':42'));
    assert.ok(result);
    await f.press(result.callback_data);
    const profile = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(profile.text, /Alice/);
    assert.ok(profile.reply_markup.inline_keyboard.flat().some(item => item.callback_data?.startsWith('mu:act:ban:')));
    const workButton = profile.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:work:'));
    assert.ok(workButton);
    await f.press(workButton.callback_data);
    const historicalCard = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(historicalCard.text, /Записи в очереди операторов нет/);
    assert.ok(historicalCard.reply_markup.inline_keyboard.flat().some(item => item.text === 'Перейти в тему'));
    assert.equal((await f.send(f.input('/users'))).status, 200);
    const users = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(users.text, /Пользователи/);
    assert.ok(users.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mu:list:a:x:0'));
    await f.press('mu:list:a:x:0');
    assert.ok(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().some(item => item.callback_data === result.callback_data));
    assert.equal((await f.send(f.input('/audit'))).status, 200);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, /Журнал действий/);
  } finally { f.close(); }
});

test('search button accepts the next message and cancellation clears the pending query', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,username,support_group_id,thread_id,status,created_at)
      VALUES('service-a',42,'Alice','alice',-1001234567890,123,'open',?)`).run(new Date().toISOString());
    await f.press('mu:search');
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM manager_search_flows WHERE operator_id=7').get().count, 1);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, /обычным сообщением/);
    assert.equal((await f.send(f.input('Alice'))).status, 200);
    const result = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(result.text, /Найдено профилей: 1/);
    assert.ok(result.reply_markup.inline_keyboard.flat().some(item => item.callback_data?.endsWith(':42')));
    assert.ok(result.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mu:search'));
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM manager_search_flows WHERE operator_id=7').get().count, 0);
    await f.press('mu:search');
    await f.press('mu:searchcancel');
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM manager_search_flows WHERE operator_id=7').get().count, 0);
    await f.press('mu:search');
    assert.equal((await f.send(f.input('/cancel'))).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM manager_search_flows WHERE operator_id=7').get().count, 0);
    await f.press('mu:search');
    await f.press('mg:home');
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM manager_search_flows WHERE operator_id=7').get().count, 0);
    await f.press('mu:search');
    await f.send(f.input('/users'));
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM manager_search_flows WHERE operator_id=7').get().count, 0);
  } finally { f.close(); }
});

test('both search buttons accept a plain ID, username or name without /user', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,username,support_group_id,thread_id,status,created_at)
      VALUES('service-a',42,'Alice','alice',-1001234567890,123,'open',?)`).run(new Date().toISOString());
    const screen = () => f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    await f.press('mg:home');
    assert.ok(screen().reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mu:search'));
    await f.press('mu:search');
    assert.match(screen().text, /обычным сообщением/);
    assert.doesNotMatch(screen().text, /\/user/);
    await f.send(f.input('42'));
    assert.match(screen().text, /Найдено профилей: 1/);
    await f.press('mu:home:a');
    assert.ok(screen().reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mu:search'));
    await f.press('mu:search');
    await f.send(f.input('@alice'));
    assert.match(screen().text, /Найдено профилей: 1/);
    await f.press('mu:search');
    await f.send(f.input('Ali'));
    assert.match(screen().text, /Найдено профилей: 1/);
  } finally { f.close(); }
});

test('switching manager screens suspends text forms and old confirmation buttons', async () => {
  const f = fixture();
  try {
    const expires = new Date(Date.now() + 600000).toISOString();
    f.db.sqlite.prepare('INSERT INTO manager_search_flows(operator_id,expires_at) VALUES(7,?)').run(expires);
    f.db.sqlite.prepare(`INSERT INTO operator_pending_actions
      (operator_id,operator_name,management_bot_id,target_bot_id,user_id,action,stage,chat_id,
       flow_nonce,created_at,expires_at)
      VALUES(7,'Admin','__manager__','service-a',42,'ban','reason',7,'mod-draft','now',?)`).run(expires);
    f.db.sqlite.prepare(`INSERT INTO manager_work_flows
      (operator_id,bot_id,user_id,expected_revision,target_id,stage,nonce,expires_at,updated_at)
      VALUES(7,'service-a',42,0,7,'note','work-draft',?,'now')`).run(expires);
    f.db.sqlite.prepare(`INSERT INTO bot_message_flows
      (owner_id,bot_id,field,stage,draft,expected_revision,nonce,chat_id,expires_at)
      VALUES(7,'service-a','welcome_text','text','','','message-draft',7,?)`).run(expires);
    await f.press('mg:home');
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM manager_search_flows').get().n, 0);
    for (const table of ['operator_pending_actions', 'manager_work_flows', 'bot_message_flows'])
      assert.equal(f.db.sqlite.prepare(`SELECT suspended FROM ${table} WHERE 1=1`).get().suspended, 1, table);
    const before = f.calls.length;
    await f.send(f.input('Обычное сообщение после перехода'));
    assert.equal(f.calls.length, before);
    assert.equal(f.db.sqlite.prepare('SELECT reason FROM operator_pending_actions WHERE operator_id=7').get().reason, null);
    assert.equal(f.db.sqlite.prepare('SELECT note FROM manager_work_flows WHERE operator_id=7').get().note, null);
    assert.equal(f.db.sqlite.prepare('SELECT draft FROM bot_message_flows WHERE owner_id=7').get().draft, '');
    await f.press('mu:resume');
    assert.equal(f.db.sqlite.prepare('SELECT suspended FROM operator_pending_actions WHERE operator_id=7').get().suspended, 0);
    await f.send(f.input('Новая причина'));
    assert.equal(f.db.sqlite.prepare('SELECT reason FROM operator_pending_actions WHERE operator_id=7').get().reason, 'Новая причина');
    await f.press('mg:drafts');
    await f.press('mg:draftwork:work-draft');
    assert.equal(f.db.sqlite.prepare('SELECT suspended FROM manager_work_flows WHERE operator_id=7').get().suspended, 0);
    await f.send(f.input('Внутренняя заметка'));
    assert.equal(f.db.sqlite.prepare('SELECT note FROM manager_work_flows WHERE operator_id=7').get().note, 'Внутренняя заметка');
  } finally { f.close(); }
});

test('manager action log offers service scope and raw action codes', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO operator_audit(bot_id,user_id,actor_type,operator_id,operator_name,action,result,created_at)
      VALUES('service-a',42,'operator',7,'Admin','manual_ban','success','2026-01-01T00:00:00Z')`).run();
    await f.press('mg:audit:0');
    const global = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const service = global.reply_markup.inline_keyboard.flat().find(item => item.text === 'Service A');
    assert.ok(service);
    await f.press(service.callback_data);
    const scoped = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(scoped.text, /Пользователь заблокирован/);
    const technical = scoped.reply_markup.inline_keyboard.flat().find(item => item.text === 'Технические коды');
    await f.press(technical.callback_data);
    const details = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(details.text, /\[manual_ban\]/);
  } finally { f.close(); }
});

test('drafts can resume an unexpired General moderation action in manager DM', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO operator_pending_actions
      (operator_id,operator_name,management_bot_id,target_bot_id,user_id,action,stage,chat_id,flow_nonce,expected_state_key,created_at,expires_at)
      VALUES(7,'Admin','service-a','service-a',42,'ban','reason',-1001234567890,'legacy-pending','old-state',?,?)`)
      .run(new Date().toISOString(), new Date(Date.now() + 600000).toISOString());
    await f.press('mg:drafts');
    const drafts = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(drafts.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:importpending:legacy-pending'));
    await f.press('mg:importpending:legacy-pending');
    const pending = f.db.sqlite.prepare('SELECT management_bot_id,chat_id,stage FROM operator_pending_actions WHERE operator_id=7').get();
    assert.deepEqual({ ...pending }, { management_bot_id: '__manager__', chat_id: 7, stage: 'reason' });
    const prompt = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(prompt.text, /внутреннюю причину/);
  } finally { f.close(); }
});

test('private storage screens stay bound to their group and full reset keeps the system-wide anchor', async () => {
  const f = fixture();
  try {
    f.env.SUPPORT_GROUP_ID = '-1001234567890';
    f.env.RETENTION_ENABLED = 'true';
    await registerSupportGroup(f.db, -1001234567890, { title: 'Original' });
    await registerSupportGroup(f.db, -1002223334445, { title: 'Second' });
    const generation = f.db.sqlite.prepare('SELECT generation FROM storage_control WHERE id=1').get().generation;
    f.db.sqlite.prepare(`INSERT INTO storage_topics(bot_id,support_group_id,thread_id,user_id,state,generation)
      VALUES('service-a',?,42,7,'present',?)`).run(-1001234567890, generation);
    f.db.sqlite.prepare(`INSERT INTO storage_topics(bot_id,support_group_id,thread_id,user_id,state,generation)
      VALUES('service-a',?,43,8,'present',?)`).run(-1002223334445, generation);
    await f.press('mg:storage:group:-1002223334445');
    const oldScreenId = f.db.sqlite.prepare('SELECT screen_message_id FROM manager_storage_sessions WHERE owner_id=7').get().screen_message_id;
    let sequence = 90000;
    const storageClick = async (data, messageId = oldScreenId) => f.send({ update_id: ++sequence, callback_query: {
      id: `storage-${sequence}`, from: { id: 7 }, data,
      message: { message_id: messageId, chat: { id: 7, type: 'private' }, text: 'Хранилище', reply_markup: { inline_keyboard: [[{ callback_data: data }]] } },
    } });
    await storageClick('um:st:list:0');
    const list = f.calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === 7).at(-1).body;
    assert.ok(list.reply_markup.inline_keyboard.flat().some(button => button.text?.includes('43')));
    assert.ok(!list.reply_markup.inline_keyboard.flat().some(button => button.text?.includes('42')));
    await storageClick('um:st:reset');
    assert.equal(f.db.sqlite.prepare('SELECT confirmation_group FROM storage_control WHERE id=1').get().confirmation_group, -1001234567890);
    assert.equal((await f.press('mg:storage:group:-1001234567890')).status, 200, `queries: ${f.db.queries}`);
    assert.equal(f.db.sqlite.prepare('SELECT confirmation_actor FROM storage_control WHERE id=1').get().confirmation_actor, null);
    const before = f.calls.filter(call => call.method === 'editMessageText').length;
    await storageClick('um:st:danger', oldScreenId);
    assert.equal(f.calls.filter(call => call.method === 'editMessageText').length, before);
    assert.ok(f.calls.some(call => call.method === 'answerCallbackQuery' && /устарел/.test(call.body.text || '')));
  } finally { f.close(); }
});

test('the private storage reset phrase works from a secondary group screen only for the primary administrator', async () => {
  for (const locale of ['en', 'ru', 'es', 'zh']) {
  const f = fixture();
  try {
    f.db.sqlite.prepare('UPDATE manager_operator_preferences SET language=? WHERE operator_id=7').run(locale);
    f.env.SUPPORT_GROUP_ID = '-1001234567890';
    f.env.RETENTION_ENABLED = 'true';
    await registerSupportGroup(f.db, -1001234567890, { title: 'Original' });
    await registerSupportGroup(f.db, -1002223334445, { title: 'Second' });
    await f.press('mg:storage:group:-1002223334445');
    const screenId = f.db.sqlite.prepare('SELECT screen_message_id FROM manager_storage_sessions WHERE owner_id=7').get().screen_message_id;
    let sequence = 91000;
    const click = data => f.send({ update_id: ++sequence, callback_query: { id: `reset-${sequence}`,
      from: { id: 7 }, data, message: { message_id: screenId, chat: { id: 7, type: 'private' },
        text: 'Хранилище', reply_markup: { inline_keyboard: [[{ callback_data: data }]] } } } });
    await click('um:st:reset');
    const nonce = f.db.sqlite.prepare('SELECT confirmation_nonce FROM storage_control WHERE id=1').get().confirmation_nonce;
    await click(`um:st:arm:${nonce}`);
    const prompt = f.calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === 7).at(-1).body.text;
    assert.ok(prompt.includes(STORAGE_RESET_PHRASES[locale]), `${locale} confirmation phrase is localized`);
    const outsider = f.input(STORAGE_RESET_PHRASES[locale], 8);
    assert.equal((await f.send(outsider)).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT mode FROM storage_control WHERE id=1').get().mode, 'normal');
    assert.equal((await f.send(f.input(STORAGE_RESET_PHRASES[locale]))).status, 200);
    const control = f.db.sqlite.prepare('SELECT mode,reset_group FROM storage_control WHERE id=1').get();
    assert.equal(control.mode, 'reset');
    assert.equal(control.reset_group, -1001234567890);
  } finally { f.close(); }
  }
});

test('moving a service updates the pinned menus in both groups', async () => {
  const f = fixture();
  const oldGroup = -1003334445556;
  const newGroup = -1001234567890;
  try {
    await registerSupportGroup(f.db, oldGroup, { title: 'Previous group' });
    await commitGroupCutover(f.db, 'service-a', oldGroup, null);
    await f.send(f.input('/menu', 7, oldGroup, 'supergroup'));
    assert.match(f.calls.find(call => call.method === 'sendMessage' && call.body.chat_id === oldGroup).body.text, /Services: Service A/);
    const flow = await f.startFlow();
    await f.send(f.input(`/connect ${flow.code}`, 7, newGroup, 'supergroup'));
    await f.press(`mg:confirm:${flow.nonce}`);

    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id, newGroup);
    assert.equal(f.db.sqlite.prepare('SELECT stage FROM manager_group_flows WHERE owner_id=7').get().stage, 'done');
    assert.match(f.calls.find(call => call.method === 'sendMessage' && call.body.chat_id === newGroup).body.text, /Services: none/);
    assert.match(f.calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === newGroup).at(-1).body.text, /Services: Service A/);
    assert.match(f.calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === oldGroup).at(-1).body.text, /Services: none/);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === oldGroup && call.body.text.startsWith('Support management')).length, 1);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === newGroup).length, 1);
  } finally { f.close(); }
});

test('an expired partial cutover can finish refreshing the old group menu without moving twice', async () => {
  const oldGroup = -1003334445556;
  const newGroup = -1001234567890;
  const rights = { managerPin: true, serviceTopics: true, failMenuEditGroup: oldGroup };
  const f = fixture(rights);
  try {
    await registerSupportGroup(f.db, oldGroup, { title: 'Previous group' });
    await commitGroupCutover(f.db, 'service-a', oldGroup, null);
    await f.send(f.input('/menu', 7, oldGroup, 'supergroup'));
    const flow = await f.startFlow();
    await f.send(f.input(`/connect ${flow.code}`, 7, newGroup, 'supergroup'));
    await f.press(`mg:confirm:${flow.nonce}`);
    const partial = f.db.sqlite.prepare('SELECT stage,source_group_id FROM manager_group_flows WHERE owner_id=7').get();
    assert.equal(partial.stage, 'connecting');
    assert.equal(partial.source_group_id, oldGroup);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id, newGroup);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, /Сервис уже перенесён.*Меню прежней группы/);
    f.db.sqlite.prepare("UPDATE manager_group_flows SET expires_at='2000-01-01T00:00:00.000Z' WHERE owner_id=7").run();
    rights.failMenuEditGroup = null;
    await f.send(f.input('/start'));
    const continueAction = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().find(button => button.callback_data === `mg:flow:${flow.nonce}`);
    assert.ok(continueAction);
    await f.press(continueAction.callback_data);
    const finishAction = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().find(button => button.callback_data === `mg:confirm:${flow.nonce}`);
    assert.ok(finishAction);
    await f.press(finishAction.callback_data);
    assert.equal(f.db.sqlite.prepare('SELECT stage FROM manager_group_flows WHERE owner_id=7').get().stage, 'done');
    assert.match(f.calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === oldGroup).at(-1).body.text, /Services: none/);
    assert.equal(f.db.sqlite.prepare("SELECT revision FROM service_group_routes WHERE bot_id='service-a'").get().revision, 1);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === newGroup).length, 1);
  } finally { f.close(); }
});

test('an existing target menu that cannot be refreshed remains resumable after cutover', async () => {
  const oldGroup = -1003334445556;
  const newGroup = -1001234567890;
  const rights = { managerPin: true, serviceTopics: true, failMenuEditGroup: newGroup };
  const f = fixture(rights);
  try {
    await registerSupportGroup(f.db, oldGroup, { title: 'Previous group' });
    await commitGroupCutover(f.db, 'service-a', oldGroup, null);
    await registerSupportGroup(f.db, newGroup, { title: 'Target group' });
    f.db.sqlite.prepare("UPDATE support_groups SET menu_message_id=499,menu_state='ready',menu_services_json='[]' WHERE group_id=?").run(newGroup);
    f.pinnedMessages.set(newGroup, 499);
    const flow = await f.startFlow();
    await f.send(f.input(`/connect ${flow.code}`, 7, newGroup, 'supergroup'));
    await f.press(`mg:confirm:${flow.nonce}`);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id, newGroup);
    assert.equal(f.db.sqlite.prepare('SELECT stage FROM manager_group_flows WHERE owner_id=7').get().stage, 'connecting');
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, /Сервис уже перенесён.*Меню новой группы/);
    rights.failMenuEditGroup = null;
    await f.press(`mg:confirm:${flow.nonce}`);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id, newGroup);
    assert.equal(f.db.sqlite.prepare('SELECT stage FROM manager_group_flows WHERE owner_id=7').get().stage, 'done');
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === newGroup).length, 0);
  } finally { f.close(); }
});

test('a newly unresolved delivery after menu pin keeps the old route and target menu accurate', async () => {
  const oldGroup = -1003334445556;
  const newGroup = -1001234567890;
  const rights = { managerPin: true, serviceTopics: true, blockCutoverAfterMenuPin: newGroup };
  const f = fixture(rights);
  try {
    await registerSupportGroup(f.db, oldGroup, { title: 'Previous group' });
    await commitGroupCutover(f.db, 'service-a', oldGroup, null);
    const flow = await f.startFlow();
    await f.send(f.input(`/connect ${flow.code}`, 7, newGroup, 'supergroup'));
    assert.equal((await f.press(`mg:confirm:${flow.nonce}`)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id, oldGroup);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, /Перенос не выполнен.*исход отправки сообщения ещё не подтверждён/);
    assert.match(f.calls.find(call => call.method === 'sendMessage' && call.body.chat_id === newGroup).body.text, /Services: none/);
    assert.equal(f.calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === newGroup).length, 0);
    f.db.sqlite.prepare("UPDATE message_delivery_attempts SET completed_at='now' WHERE bot_id='service-a'").run();
    await f.press(`mg:confirm:${flow.nonce}`);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id, newGroup);
    assert.match(f.calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === newGroup).at(-1).body.text, /Services: Service A/);
  } finally { f.close(); }
});

test('failed target menu refresh after route cutover is reported and resumable', async () => {
  const oldGroup = -1003334445556;
  const newGroup = -1001234567890;
  const rights = { managerPin: true, serviceTopics: true, failMenuEditGroup: newGroup };
  const f = fixture(rights);
  try {
    await registerSupportGroup(f.db, oldGroup, { title: 'Previous group' });
    await commitGroupCutover(f.db, 'service-a', oldGroup, null);
    const flow = await f.startFlow();
    await f.send(f.input(`/connect ${flow.code}`, 7, newGroup, 'supergroup'));
    await f.press(`mg:confirm:${flow.nonce}`);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id, newGroup);
    assert.equal(f.db.sqlite.prepare('SELECT stage FROM manager_group_flows WHERE owner_id=7').get().stage, 'connecting');
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, /Сервис уже перенесён.*Меню новой группы/);
    rights.failMenuEditGroup = null;
    await f.press(`mg:confirm:${flow.nonce}`);
    assert.equal(f.db.sqlite.prepare('SELECT stage FROM manager_group_flows WHERE owner_id=7').get().stage, 'done');
    assert.match(f.calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === newGroup).at(-1).body.text, /Services: Service A/);
  } finally { f.close(); }
});

test('the manager explains that an unfinished reopening must finish before group transfer', async () => {
  const oldGroup = -1003334445556;
  const newGroup = -1001234567890;
  const f = fixture();
  try {
    await registerSupportGroup(f.db, oldGroup);
    await commitGroupCutover(f.db, 'service-a', oldGroup, null);
    const flow = await f.startFlow();
    await f.send(f.input(`/connect ${flow.code}`, 7, newGroup, 'supergroup'));
    f.db.sqlite.prepare(`INSERT INTO conversation_reopen_effects(bot_id,user_id,old_thread_id,created_at)
      VALUES('service-a',7,42,'now')`).run();
    assert.equal((await f.press(`mg:confirm:${flow.nonce}`)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id, oldGroup);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text,
      /повторное открытие обращения ещё не завершено/);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === newGroup).length, 0);
  } finally { f.close(); }
});

test('confirmation cannot replace a route changed after the group was selected', async () => {
  const oldGroup = -1003334445556;
  const newGroup = -1001234567890;
  const otherGroup = -1007778889990;
  const f = fixture();
  try {
    await registerSupportGroup(f.db, oldGroup);
    await registerSupportGroup(f.db, otherGroup);
    await commitGroupCutover(f.db, 'service-a', oldGroup, null);
    const flow = await f.startFlow();
    await f.send(f.input(`/connect ${flow.code}`, 7, newGroup, 'supergroup'));
    assert.equal(f.db.sqlite.prepare('SELECT source_group_id FROM manager_group_flows WHERE owner_id=7').get().source_group_id, oldGroup);
    await commitGroupCutover(f.db, 'service-a', otherGroup, oldGroup);
    assert.equal((await f.press(`mg:confirm:${flow.nonce}`)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id, otherGroup);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, /Маршрут сервиса изменился.*начните заново/);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === newGroup).length, 0);
  } finally { f.close(); }
});

test('a pending or completed old confirmation cannot pull a service back from another group', async () => {
  const oldGroup = -1003334445556;
  const newGroup = -1001234567890;
  const otherGroup = -1007778889990;
  const rights = { managerPin: true, serviceTopics: true, failPin: true };
  const f = fixture(rights);
  try {
    await registerSupportGroup(f.db, oldGroup);
    await registerSupportGroup(f.db, otherGroup);
    await commitGroupCutover(f.db, 'service-a', oldGroup, null);
    const flow = await f.startFlow();
    await f.send(f.input(`/connect ${flow.code}`, 7, newGroup, 'supergroup'));
    await f.press(`mg:confirm:${flow.nonce}`);
    assert.equal(f.db.sqlite.prepare('SELECT stage FROM manager_group_flows WHERE owner_id=7').get().stage, 'connecting');
    await commitGroupCutover(f.db, 'service-a', otherGroup, oldGroup);
    rights.failPin = false;
    await f.press(`mg:confirm:${flow.nonce}`);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id, otherGroup);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM manager_group_flows WHERE owner_id=7').get().n, 0);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, /Маршрут сервиса изменился/);

    const nextFlow = await f.startFlow();
    await f.send(f.input(`/connect ${nextFlow.code}`, 7, newGroup, 'supergroup'));
    await f.press(`mg:confirm:${nextFlow.nonce}`);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id, newGroup);
    await commitGroupCutover(f.db, 'service-a', otherGroup, newGroup);
    await f.press(`mg:confirm:${nextFlow.nonce}`);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id, otherGroup);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, /кнопка устарела/);
  } finally { f.close(); }
});

test('a route changed during menu preparation releases the obsolete wizard', async () => {
  const oldGroup = -1003334445556;
  const newGroup = -1001234567890;
  const otherGroup = -1007778889990;
  const rights = { managerPin: true, serviceTopics: true, rerouteAfterMenuPin: newGroup, rerouteToGroup: otherGroup };
  const f = fixture(rights);
  try {
    await registerSupportGroup(f.db, oldGroup);
    await registerSupportGroup(f.db, otherGroup);
    await commitGroupCutover(f.db, 'service-a', oldGroup, null);
    const flow = await f.startFlow();
    await f.send(f.input(`/connect ${flow.code}`, 7, newGroup, 'supergroup'));
    assert.equal((await f.press(`mg:confirm:${flow.nonce}`)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id, otherGroup);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM manager_group_flows WHERE owner_id=7').get().n, 0);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text, /Маршрут сервиса изменился/);
    assert.match(f.calls.find(call => call.method === 'sendMessage' && call.body.chat_id === newGroup).body.text, /Services: none/);
    assert.equal(f.calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === newGroup).length, 0);
    const nextFlow = await f.startFlow();
    assert.notEqual(nextFlow.nonce, flow.nonce);
  } finally { f.close(); }
});

test('final confirmation refuses success when the route changes during menu refresh', async () => {
  const oldGroup = -1003334445556;
  const newGroup = -1001234567890;
  const otherGroup = -1007778889990;
  const rights = { managerPin: true, serviceTopics: true, rerouteAfterMenuEdit: newGroup, rerouteToGroup: otherGroup };
  const f = fixture(rights);
  try {
    await registerSupportGroup(f.db, oldGroup);
    await registerSupportGroup(f.db, otherGroup);
    await commitGroupCutover(f.db, 'service-a', oldGroup, null);
    const flow = await f.startFlow();
    await f.send(f.input(`/connect ${flow.code}`, 7, newGroup, 'supergroup'));
    assert.equal((await f.press(`mg:confirm:${flow.nonce}`)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id, otherGroup);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM manager_group_flows WHERE owner_id=7').get().n, 0);
    const targetEdits = f.calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === newGroup);
    assert.match(targetEdits[0].body.text, /Services: Service A/);
    assert.match(targetEdits.at(-1).body.text, /Services: none/);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text,
      /Маршрут сервиса изменился.*Подключение к выбранной группе не подтверждено/);
  } finally { f.close(); }
});

test('pairing code in an ordinary topic cannot prepare a group', async () => {
  const f = fixture();
  try {
    const flow = await f.startFlow();
    const update = f.input(`/connect ${flow.code}`, 7, -1001234567890, 'supergroup');
    update.message.message_thread_id = 42;
    assert.equal((await f.send(update)).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT stage FROM manager_group_flows WHERE owner_id=7').get().stage,'awaiting_group');
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM support_groups').get().n,0);
  } finally { f.close(); }
});

test('failed menu pin leaves the old route active until retry succeeds', async () => {
  const rights = { managerPin: true, serviceTopics: true, failPin: true };
  const f = fixture(rights);
  try {
    await registerSupportGroup(f.db, -1003334445556, { title: 'Previous group' });
    await commitGroupCutover(f.db, 'service-a', -1003334445556, null);
    const flow = await f.startFlow();
    await f.send(f.input(`/connect ${flow.code}`, 7, -1001234567890, 'supergroup'));
    assert.equal((await f.press(`mg:confirm:${flow.nonce}`)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id,-1003334445556);
    assert.equal(f.db.sqlite.prepare("SELECT stage FROM manager_group_flows WHERE owner_id=7").get().stage,'connecting');
    rights.failPin = false;
    assert.equal((await f.press(`mg:confirm:${flow.nonce}`)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id,-1001234567890);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === -1001234567890).length,1);
  } finally { f.close(); }
});

test('uncertain menu send can adopt the observed message without creating a duplicate', async () => {
  const rights = { managerPin: true, serviceTopics: true, uncertainMenuSend: true };
  const f = fixture(rights);
  try {
    const flow = await f.startFlow();
    await f.send(f.input(`/connect ${flow.code}`, 7, -1001234567890, 'supergroup'));
    assert.equal((await f.press(`mg:confirm:${flow.nonce}`)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT menu_state FROM support_groups WHERE group_id=-1001234567890").get().menu_state,'uncertain');
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM service_group_routes WHERE bot_id='service-a'").get().n,0);
    const adopt = f.input('/adoptmenu', 7, -1001234567890, 'supergroup');
    adopt.message.reply_to_message = { message_id: rights.uncertainMenuMessageId,
      from: { id: 100, is_bot: true }, text: 'Управление поддержкой\n\nСервисы: нет' };
    assert.equal((await f.send(adopt)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT menu_state FROM support_groups WHERE group_id=-1001234567890").get().menu_state,'ready');
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === -1001234567890).length,1);
    assert.equal((await f.press(`mg:confirm:${flow.nonce}`)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id,-1001234567890);
  } finally { f.close(); }
});

test('administrator can retry an unobserved menu only after explicitly checking General', async () => {
  const rights = { managerPin: true, serviceTopics: true, uncertainMenuSend: true };
  const f = fixture(rights);
  try {
    const flow = await f.startFlow();
    await f.send(f.input(`/connect ${flow.code}`, 7, -1001234567890, 'supergroup'));
    await f.press(`mg:confirm:${flow.nonce}`);
    assert.equal(f.db.sqlite.prepare("SELECT menu_state FROM support_groups WHERE group_id=-1001234567890").get().menu_state,'uncertain');
    await f.send(f.input('/retrymenu', 7, -1001234567890, 'supergroup'));
    await f.send(f.input('/retrymenu', 7, -1001234567890, 'supergroup'));
    assert.equal(f.db.sqlite.prepare("SELECT menu_state FROM support_groups WHERE group_id=-1001234567890").get().menu_state,'pending');
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === -1001234567890).length,1);
    await f.press(`mg:confirm:${flow.nonce}`);
    assert.equal(f.db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='service-a'").get().group_id,-1001234567890);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === -1001234567890).length,2);
  } finally { f.close(); }
});

test('a removed or unpinned group menu is restored without keeping a stale ready marker', async () => {
  const rights = { managerPin: true, serviceTopics: true, deletedMenuMessageIds: new Set() };
  const f = fixture(rights);
  try {
    await registerSupportGroup(f.db, -1001234567890, { title: 'Support group' });
    await commitGroupCutover(f.db, 'service-a', -1001234567890, null);
    const command = () => f.send(f.input('/menu', 7, -1001234567890, 'supergroup'));
    assert.equal((await command()).status, 200);
    const firstId = f.db.sqlite.prepare('SELECT menu_message_id FROM support_groups WHERE group_id=?').get(-1001234567890).menu_message_id;
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === -1001234567890).length, 2);
    f.pinnedMessages.delete(-1001234567890);
    assert.equal((await command()).status, 200);
    assert.equal(f.pinnedMessages.get(-1001234567890), firstId);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.text?.startsWith('Support management')).length, 1);
    rights.deletedMenuMessageIds.add(firstId);
    f.pinnedMessages.delete(-1001234567890);
    assert.equal((await command()).status, 200);
    const current = f.db.sqlite.prepare('SELECT menu_message_id,menu_state FROM support_groups WHERE group_id=?').get(-1001234567890);
    assert.equal(current.menu_state, 'ready');
    assert.notEqual(current.menu_message_id, firstId);
    assert.equal(f.pinnedMessages.get(-1001234567890), current.menu_message_id);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.text?.startsWith('Support management')).length, 2);
  } finally { f.close(); }
});

test('parallel menu requests claim one Telegram send and expired claim requires inspection', async () => {
  const f = fixture();
  try {
    await registerSupportGroup(f.db, -1001234567890, { title: 'Support group' });
    await commitGroupCutover(f.db, 'service-a', -1001234567890, null);
    const command = () => f.send(f.input('/menu', 7, -1001234567890, 'supergroup'));
    await Promise.all([command(), command()]);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.text?.startsWith('Support management')).length, 1);
    f.db.sqlite.prepare(`UPDATE support_groups SET menu_message_id=NULL,menu_state='pending',menu_services_json=NULL,
      menu_claim_token='expired-claim',menu_claim_expires_at='2020-01-01T00:00:00.000Z' WHERE group_id=?`)
      .run(-1001234567890);
    await command();
    assert.equal(f.db.sqlite.prepare('SELECT menu_state FROM support_groups WHERE group_id=?').get(-1001234567890).menu_state, 'uncertain');
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.text?.startsWith('Support management')).length, 1);
  } finally { f.close(); }
});

test('expired callback acknowledgement does not suppress a durable menu action', async () => {
  const f = fixture({ managerPin: true, serviceTopics: true, ackExpired: true });
  try {
    await f.send(f.input('/start'));
    await f.press('mg:section:bots');
    const service = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:service:'));
    assert.equal((await f.press(service.callback_data)).status, 200);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text,
      /Сервис: Service A/);
  } finally { f.close(); }
});

test('a token pasted into a group is never echoed by the manager bot', async () => {
  const f = fixture();
  try {
    const token = '987654:' + 'S'.repeat(35);
    assert.equal((await f.send(f.input(token, 7, -1001234567890, 'supergroup'))).status, 200);
    assert.ok(f.calls.some(call => call.method === 'deleteMessage' && call.body.chat_id === -1001234567890));
    assert.ok(!f.calls.some(call => JSON.stringify(call.body).includes(token)));
  } finally { f.close(); }
});

test('manager starts a group-scoped controlled exchange and reports completion only after both directions finish', async () => {
  const f = fixture();
  try {
    const flow = await f.startFlow();
    await f.send(f.input(`/connect ${flow.code}`, 7, -1001234567890, 'supergroup'));
    await f.press(`mg:confirm:${flow.nonce}`);
    const confirmation = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(confirmation.text, /До отметки «готово»/);
    const start = confirmation.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:test:'));
    assert.ok(start);
    await f.press(start.callback_data);
    const check = f.db.sqlite.prepare("SELECT nonce,stage,group_id FROM service_checks WHERE bot_id='service-a'").get();
    assert.equal(check.stage, 'waiting');
    assert.equal(check.group_id, -1001234567890);
    const instructions = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(instructions.reply_markup.inline_keyboard.flat().some(item => item.url?.includes(`qc_${check.nonce}`)));
    f.db.sqlite.prepare("UPDATE service_checks SET stage='done' WHERE nonce=?").run(check.nonce);
    await f.press(start.callback_data);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text,
      /Контрольный обмен .* завершён/);
  } finally { f.close(); }
});

test('operator home lists assigned services and opens only that operator’s work queue', async () => {
  const f = fixture();
  try {
    f.env.BOT_REGISTRY = JSON.stringify([config, { ...config, id: 'service-b', displayName: 'Service B', username: 'service_b_bot',
      tokenBinding: 'SERVICE_B_TOKEN', webhookSecretBinding: 'SERVICE_B_SECRET' }]);
    f.env.SERVICE_B_TOKEN = '201:SERVICE_B';
    f.env.SERVICE_B_SECRET = 'service-b-secret';
    f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
      VALUES(8,'Operator',1,7,'Admin',?)`).run(new Date().toISOString());
    f.db.sqlite.prepare(`INSERT INTO service_responsibility(bot_id,primary_id,updated_at) VALUES('service-a',8,?)`)
      .run(new Date().toISOString());
    assert.equal((await f.send(f.input('/start', 8))).status, 200);
    const home = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    const labels = home.reply_markup.inline_keyboard.flat().map(item => item.text);
    assert.ok(labels.some(label => label.includes('Service A')));
    assert.ok(!labels.some(label => label.includes('Service B')));
    assert.ok(labels.some(label => label.includes('Мои обращения')));
    assert.ok(labels.some(label => label.includes('Операторы')));
    assert.equal((await f.press('mg:operators', 8)).status, 200);
    const team = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    assert.match(team.text, /Главный администратор/);
    assert.ok(team.reply_markup.inline_keyboard.flat().some(item => item.text?.includes('Operator') && item.callback_data === 'mg:opcard:8'));
    assert.ok(!team.reply_markup.inline_keyboard.flat().some(item => /mg:op(add|remove):/.test(item.callback_data || '')));
    assert.equal((await f.press('mg:opcard:8', 8)).status, 200);
    const card = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    assert.match(card.text, /Telegram ID: 8/);
    assert.ok(!card.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:opremove:8'));
    assert.equal((await f.press('mg:opremove:8', 8)).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT active FROM support_operators WHERE user_id=8').get().active, 1);
    assert.equal((await f.press('mg:mine', 8)).status, 200);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body.text,
      /нет открытых обращений/);
  } finally { f.close(); }
});

test('administrator can page through waiting cases and open their assignment cards', async () => {
  const f = fixture();
  try {
    const stamp = new Date().toISOString();
    for (let i = 0; i < 22; i++) {
      const userId = 1000 + i;
      f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at)
        VALUES('service-a',?,?,-1001234567890,?,'open',?,?)`).run(userId, `Client ${i}`, 42 + i, stamp, stamp);
      f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,assigned_to,last_inbound_at,updated_at,notification_cycle)
        VALUES('service-a',?,'waiting',7,?,?,1)`).run(userId, stamp, stamp);
    }
    await f.send(f.input('/start'));
    await f.press('mg:all');
    const firstPage = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(firstPage.text, /страница 1/);
    assert.ok(firstPage.reply_markup.inline_keyboard.flat().some(item => /:1000:\d+:[0-9a-z]+$/.test(item.callback_data || '')));
    assert.ok(!firstPage.reply_markup.inline_keyboard.flat().some(item => /:1021:\d+:[0-9a-z]+$/.test(item.callback_data || '')));
    const next = firstPage.reply_markup.inline_keyboard.flat().find(item => item.callback_data === 'mg:page:all:1');
    assert.ok(next);
    await f.press(next.callback_data);
    const secondPage = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(secondPage.text, /страница 2/);
    const waitingCase = secondPage.reply_markup.inline_keyboard.flat().find(item => /:1021:\d+:[0-9a-z]+$/.test(item.callback_data || ''));
    assert.ok(waitingCase);
    await f.press(waitingCase.callback_data);
    const card = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(card.text, /Client 21[\s\S]*Ждём клиента/);
    assert.ok(card.reply_markup.inline_keyboard.flat().some(item => item.callback_data?.startsWith('mg:transfer:')));
    const back = card.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:workreturn:'));
    assert.ok(back);
    await f.press(back.callback_data);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text,
      /страница 2/);
  } finally { f.close(); }
});

test('urgent queue uses each service reminder threshold and keeps operator scope', async () => {
  const f = fixture();
  try {
    f.env.BOT_REGISTRY = JSON.stringify([config, { ...config, id: 'service-b', displayName: 'Service B',
      tokenBinding: 'SERVICE_B_TOKEN', webhookSecretBinding: 'SERVICE_B_SECRET' }]);
    f.env.SERVICE_B_TOKEN = '201:SERVICE_B';
    f.env.SERVICE_B_SECRET = 'service-b-secret';
    const timestamp = minutes => new Date(Date.now() - minutes * 60000).toISOString();
    const stamp = timestamp(90);
    f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
      VALUES(8,'Operator',1,7,'Admin',?)`).run(stamp);
    f.db.sqlite.prepare(`INSERT INTO service_responsibility(bot_id,reminder_minutes,fallback_minutes,updated_at)
      VALUES('service-a',60,120,?)`).run(stamp);
    for (const [userId, name, assignee, state, age] of [
      [901, 'Old Client', 8, 'needs_reply', 90],
      [902, 'Recent Client', 8, 'needs_reply', 40],
      [903, 'Other Client', 7, 'needs_reply', 80],
      [904, 'Waiting Client', 8, 'waiting', 120],
    ]) {
      f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at)
        VALUES('service-a',?,?,-1001234567890,?,'open',?,?)`).run(userId, name, userId, stamp, stamp);
      f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,assigned_to,last_inbound_at,updated_at,notification_cycle,cycle_started_at)
        VALUES('service-a',?,?,?,?,?,1,?)`).run(userId, state, assignee, timestamp(age), stamp, timestamp(age));
    }
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at)
      VALUES('service-b',905,'Default Threshold',-1001234567890,905,'open',?,?)`).run(stamp, stamp);
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,assigned_to,last_inbound_at,updated_at,notification_cycle,cycle_started_at)
      VALUES('service-b',905,'needs_reply',7,?,?,1,?)`).run(timestamp(40), stamp, timestamp(40));
    await f.press('mg:urgent', 8);
    const mine = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    assert.match(mine.text, /Ваши просроченные обращения/);
    const mineCases = mine.reply_markup.inline_keyboard.flat().filter(item => item.callback_data?.startsWith('mg:pw:'));
    assert.equal(mineCases.length, 1);
    assert.match(mineCases[0].text, /🔥 Service A · Old Client · 1 ч/);
    await f.press('mg:urgentall');
    const all = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(all.text, /Просроченные обращения команды/);
    assert.equal(all.reply_markup.inline_keyboard.flat().filter(item => item.callback_data?.startsWith('mg:pw:')).length, 3);
    const sentToOperator = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).length;
    await f.press('mg:urgentall', 8);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).length, sentToOperator);
  } finally { f.close(); }
});

test('urgent buttons and empty states distinguish my work from the whole team', async () => {
  const f = fixture();
  try {
    await f.send(f.input('/start'));
    const home = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(home.reply_markup.inline_keyboard.flat().some(item =>
      item.text === '🔥 Просроченные' && item.callback_data === 'mg:section:overdue'));
    assert.ok(!home.reply_markup.inline_keyboard.flat().some(item =>
      ['mg:urgent', 'mg:urgentall'].includes(item.callback_data)));
    await f.press('mg:section:overdue');
    const overdue = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.deepEqual(overdue.reply_markup.inline_keyboard.flat().slice(0, 2).map(item => item.callback_data),
      ['mg:urgent', 'mg:urgentall']);
    await f.press('mg:urgent');
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text,
      /за вами нет просроченных/);
    await f.press('mg:urgentall');
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text,
      /во всей команде/);
  } finally { f.close(); }
});

test('primary menu groups support bots, work, diagnostics and resources without hiding actions', async () => {
  const f = fixture();
  try {
    await f.send(f.input('/start'));
    const screen = () => f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const callbacks = () => screen().reply_markup.inline_keyboard.flat().map(item => item.callback_data).filter(Boolean);
    assert.ok(callbacks().includes('mg:section:bots'));
    assert.ok(callbacks().includes('mg:section:work'));
    assert.ok(callbacks().includes('mg:section:control'));
    assert.ok(callbacks().includes('mg:section:platform'));
    assert.ok(!callbacks().includes('mg:service:' + managementBotKey([config], config.id)));
    for (const [section, expected] of [
      ['bots', ['mg:service:' + managementBotKey([config], config.id), 'mg:addbot', 'mg:rxview:a']],
      ['work', ['mg:queue:a:needs:0', 'mg:problems:a:0', 'mg:drafts']],
      ['control', ['mg:metrics', 'mg:delivery:a', 'mg:health']],
      ['platform', ['mg:plan', 'mg:storage']],
    ]) {
      await f.press(`mg:section:${section}`);
      assert.deepEqual(callbacks(), [...expected, 'mg:home', 'mg:home']);
      assert.deepEqual(screen().reply_markup.inline_keyboard.at(-2), [{ text: '────────', disabled: {} }]);
      assert.deepEqual(screen().reply_markup.inline_keyboard.at(-1).map(item => item.text), ['← Назад', '🏠 Меню']);
      await f.press('mg:home');
      assert.ok(callbacks().includes(`mg:section:${section}`));
    }
  } finally { f.close(); }
});

test('operator list and transfer choices show current reply and total workload', async () => {
  const f = fixture();
  try {
    const stamp = new Date().toISOString();
    for (const userId of [8, 9]) {
      await f.send(f.input('/start', userId));
      f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
        VALUES(?,?,1,7,'Admin',?)`).run(userId, `Operator ${userId}`, stamp);
    }
    for (const [userId, assignee, state] of [[901, 8, 'needs_reply'], [902, 8, 'waiting'], [903, 9, 'resolved']]) {
      f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at)
        VALUES('service-a',?,'Client',-1001234567890,?,'open',?,?)`).run(userId, userId, stamp, stamp);
      f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,assigned_to,last_inbound_at,updated_at,notification_cycle)
        VALUES('service-a',?,?,?,?,?,1)`).run(userId, state, assignee, stamp, stamp);
    }
    await f.press('mg:operators');
    const roster = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const labels = roster.reply_markup.inline_keyboard.flat().map(item => item.text);
    assert.ok(labels.some(label => /Operator 8 · 1 ждут · 2 всего/.test(label)));
    assert.ok(labels.some(label => /Operator 9 · 0 ждут · 0 всего/.test(label)));
    await f.press('mg:mine', 8);
    const list = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    const cardButton = list.reply_markup.inline_keyboard.flat().find(item => /:901:\d+:[0-9a-z]+$/.test(item.callback_data || ''));
    await f.press(cardButton.callback_data, 8);
    const card = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    const transfer = card.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:transfer:'));
    await f.press(transfer.callback_data, 8);
    const choices = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    assert.ok(choices.reply_markup.inline_keyboard.flat().some(item => /Operator 8 · 1 ждут · 2 всего/.test(item.text)));
    assert.ok(choices.reply_markup.inline_keyboard.flat().some(item => /Operator 9 · 0 ждут · 0 всего/.test(item.text)));
  } finally { f.close(); }
});

test('administrator selects private alert recipients, group topic, and can disconnect the alert bot', async () => {
  const f = fixture();
  try {
    const stamp = new Date().toISOString();
    f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
      VALUES(8,'Operator',1,7,'Admin',?)`).run(stamp);
    f.db.sqlite.prepare(`INSERT INTO support_groups(group_id,title,created_at,updated_at)
      VALUES(-1001234567890,'Support',?,?)`).run(stamp, stamp);
    const status = { generation: 0, mode: 'group', username: 'alert_bot', chatId: -1001234567890,
      threadId: 3, recipients: [] };
    const switches = [];
    let removed = 0;
    f.env.ALERT_SETTINGS = {
      status: async () => ({ ...status }),
      switch: async options => {
        switches.push(options);
        assert.equal(options.expectedGeneration, status.generation);
        Object.assign(status, { generation: status.generation + 1, mode: options.mode,
          chatId: options.chatId || null, threadId: options.threadId || null,
          recipients: options.recipientIds || [] });
        return { oldNotified: true };
      },
      remove: async options => {
        assert.equal(options.expectedGeneration, status.generation);
        status.mode = 'disabled'; status.generation++; removed++;
        return { oldNotified: true };
      },
    };
    await f.press('mg:alert:home');
    const home = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(home.text, /топик 3 группы/);
    assert.ok(home.reply_markup.inline_keyboard.flat().some(item => item.text === 'Переключить в личку администратору и операторам'));
    assert.ok(home.reply_markup.inline_keyboard.flat().some(item => item.text === 'Переключить в топик группы'));
    assert.equal(home.reply_markup.inline_keyboard.flat()
      .find(item => item.callback_data === 'mg:alert:remove')?.style, 'danger');
    await f.press('mg:alert:private');
    const list = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const toggle = list.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:alert:toggle:'));
    assert.ok(toggle);
    await f.press(toggle.callback_data);
    const selected = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(selected.reply_markup.inline_keyboard.flat().some(item => item.text.includes('✅ Operator')));
    const confirm = selected.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:alert:privateok:'));
    assert.equal(confirm.style, 'success');
    await f.press(confirm.callback_data);
    assert.deepEqual(switches[0].recipientIds, [7, 8]);
    await f.press('mg:alert:group');
    const topicCommand = f.input('/alerts@manager_bot', 7, -1001234567890, 'supergroup');
    topicCommand.message.message_thread_id = 42;
    await f.send(topicCommand);
    assert.deepEqual({ mode: switches[1].mode, chatId: switches[1].chatId, threadId: switches[1].threadId },
      { mode: 'group', chatId: -1001234567890, threadId: 42 });
    await f.press('mg:alert:remove');
    const confirmation = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const remove = confirmation.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:alert:removeok:'));
    await f.press(remove.callback_data, 8);
    assert.equal(removed, 0, 'an operator cannot disconnect alerts');
    await f.press(remove.callback_data);
    assert.equal(removed, 1);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text,
      /не доставляются/);
  } finally { f.close(); }
});

test('alert token is consumed only in the administrator setup flow and deleted from the manager DM', async () => {
  const f = fixture();
  try {
    const token = '67890:' + 'B'.repeat(35);
    const status = { generation: 0, mode: 'disabled', username: null, recipients: [] };
    let connected = 0;
    f.env.ALERT_SETTINGS = {
      status: async () => ({ ...status }),
      connect: async options => {
        assert.deepEqual(options, { token, adminId: 7, expectedGeneration: 0 });
        connected++;
        Object.assign(status, { generation: 1, mode: 'private', username: 'new_alert_bot', recipients: [7] });
        return { username: 'new_alert_bot', oldNotified: false };
      },
    };
    await f.press('mg:alert:connect');
    const input = f.input(token);
    assert.equal((await f.send(input)).status, 200);
    assert.equal(connected, 1);
    assert.ok(f.calls.some(call => call.method === 'deleteMessage' && call.body.chat_id === 7 && call.body.message_id === input.message.message_id));
    assert.ok(!f.calls.some(call => call.method === 'sendMessage' && call.body.text?.includes(token)));
    assert.equal((await f.send(input)).status, 200);
    assert.equal(connected, 1);
  } finally { f.close(); }
});

test('manager closes the conversation identified by its group and topic, once', async () => {
  const f = fixture();
  const groupId = -1001234567890, stamp = new Date().toISOString();
  try {
    for (const [botId, userId, threadId] of [['service-a', 900, 42], ['service-b', 901, 43]]) {
      f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at)
        VALUES(?,?,'Client',?,?,'open',?,?)`).run(botId, userId, groupId, threadId, stamp, stamp);
    }
    const close = f.input('/close@manager_bot', 7, groupId, 'supergroup');
    close.message.message_thread_id = 42;
    assert.equal((await f.send(close)).status, 200);
    assert.deepEqual(f.calls.filter(call => call.method === 'closeForumTopic').map(call =>
      [call.token, Number(call.body.chat_id), call.body.message_thread_id]), [['100:MANAGER', groupId, 42]]);
    assert.deepEqual(f.db.sqlite.prepare('SELECT user_id,status,reply_epoch FROM conversations ORDER BY user_id').all().map(row => ({ ...row })), [
      { user_id: 900, status: 'closed', reply_epoch: 1 }, { user_id: 901, status: 'open', reply_epoch: 0 },
    ]);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM operator_audit WHERE action='conversation_close'").get().n, 1);
    const repeat = f.input('/close', 7, groupId, 'supergroup');
    repeat.message.message_thread_id = 42;
    assert.equal((await f.send(repeat)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT reply_epoch FROM conversations WHERE user_id=900").get().reply_epoch, 1);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM operator_audit WHERE action='conversation_close'").get().n, 1);
  } finally { f.close(); }
});

test('manager /case and /menu show a topic card even for a historical conversation without work state', async () => {
  const f = fixture();
  const groupId = -1001234567890;
  try {
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at)
      VALUES('service-a',910,'Historical',?,91,'open',?)`).run(groupId, new Date().toISOString());
    for (const command of ['/case@manager_bot', '/menu@manager_bot']) {
      const update = f.input(command, 7, groupId, 'supergroup');
      update.message.message_thread_id = 91;
      assert.equal((await f.send(update)).status, 200);
      const card = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === groupId).at(-1).body;
      assert.equal(card.message_thread_id, 91);
      assert.match(card.text, /\/delete@service_a_bot/);
      assert.match(card.text, /нет записи очереди/);
      assert.ok(card.reply_markup.inline_keyboard.flat().some(item => item.callback_data?.startsWith('mt:topic:close:')));
      assert.ok(card.reply_markup.inline_keyboard.flat().some(item => item.url?.includes(`?start=user_${managementBotKey([config], config.id)}_910`)));
      assert.ok(card.reply_markup.inline_keyboard.flat().some(item => item.url?.includes(`?start=history_${managementBotKey([config], config.id)}_910`)));
    }
    const key = managementBotKey([config], config.id);
    assert.equal((await f.send(f.input(`/start user_${key}_910`))).status, 200);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7).at(-1).body.text,
      /Historical · Service A/);
    assert.equal((await f.send(f.input(`/start history_${key}_910`))).status, 200);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7).at(-1).body.text,
      /История пользователя 910/);
    f.env.BOT_REGISTRY = JSON.stringify([{ ...config, enabled: false }]);
    assert.equal((await f.send(f.input(`/start user_${key}_910`))).status, 200);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7).at(-1).body.text,
      /только просмотр/);
    assert.equal((await f.send(f.input(`/start history_${key}_910`))).status, 200);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7).at(-1).body.text,
      /История пользователя 910/);
  } finally { f.close(); }
});

test('manager topic card reopens a closed conversation and refreshes its action', async () => {
  const f = fixture();
  const groupId = -1001234567890, threadId = 93, key = managementBotKey([config], config.id);
  try {
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at)
      VALUES('service-a',913,'Closed client',?,?,'closed',?)`).run(groupId, threadId, new Date().toISOString());
    const command = f.input('/case', 7, groupId, 'supergroup');
    command.message.message_thread_id = threadId;
    assert.equal((await f.send(command)).status, 200);
    const card = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === groupId).at(-1).body;
    const reopen = card.reply_markup.inline_keyboard.flat()
      .find(item => item.callback_data === `mt:topic:open:${key}:913`);
    assert.ok(reopen);
    const callback = { update_id: 91301, callback_query: { id: 'reopen-card', from: { id: 7 }, data: reopen.callback_data,
      message: { message_id: 501, chat: { id: groupId, type: 'supergroup' }, message_thread_id: threadId,
        from: { id: 100, is_bot: true, username: 'manager_bot' }, text: card.text } } };
    assert.equal((await f.send(callback)).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT status FROM conversations WHERE user_id=913').get().status, 'open');
    assert.ok(f.calls.some(call => call.method === 'reopenForumTopic' && call.body.message_thread_id === threadId));
    const refreshed = f.calls.filter(call => call.method === 'editMessageText' && Number(call.body.chat_id) === groupId).at(-1).body;
    assert.ok(refreshed.text.startsWith('Обращение · Service A · '));
    assert.match(refreshed.text, /Тема открыта/);
    assert.match(refreshed.text, /\/delete@service_a_bot/);
    const close = refreshed.reply_markup.inline_keyboard.flat()
      .find(item => item.callback_data === `mt:topic:close:${key}:913`);
    assert.ok(close);
    assert.equal((await f.send(callback)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM operator_audit WHERE user_id=913 AND action='conversation_open'").get().n, 1);
    assert.equal((await f.send({ update_id: 91302, callback_query: { ...callback.callback_query,
      id: 'close-card', data: close.callback_data, message: { ...callback.callback_query.message, text: refreshed.text } } })).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT status FROM conversations WHERE user_id=913').get().status, 'closed');
  } finally { f.close(); }
});

test('topic callbacks accept localized cards in every supported service locale', async () => {
  const f = fixture();
  const groupId = -1001234567890, key = managementBotKey([config], config.id);
  try {
    let updateId = 92500;
    for (const [index, locale] of ['ru', 'en', 'es', 'zh'].entries()) {
      const userId = 925 + index, threadId = 925 + index;
      f.env.BOT_REGISTRY = JSON.stringify([{ ...config, locale }]);
      f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at)
        VALUES('service-a',?,?,?,?,'closed',?)`).run(userId, `Client ${locale}`, groupId, threadId, new Date().toISOString());
      const command = f.input('/case', 7, groupId, 'supergroup');
      command.message.message_thread_id = threadId;
      assert.equal((await f.send(command)).status, 200);
      const card = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === groupId).at(-1).body;
      const open = card.reply_markup.inline_keyboard.flat().find(item => item.callback_data === `mt:topic:open:${key}:${userId}`);
      assert.ok(card.text.includes(messageDeletionWarning(locale, config.username)), `${locale} topic card explains native deletion`);
      assert.ok(open, `${locale} card includes its open action`);
      assert.equal((await f.send({ update_id: updateId++, callback_query: { id: `localized-${locale}`, from: { id: 7 },
        data: open.callback_data, message: { message_id: 700 + index, chat: { id: groupId, type: 'supergroup' },
          message_thread_id: threadId, from: { id: 100, is_bot: true, username: 'manager_bot' }, text: card.text } } })).status, 200);
      assert.equal(f.db.sqlite.prepare('SELECT status FROM conversations WHERE user_id=?').get(userId).status, 'open',
        `${locale} localized card remains authorized`);
    }
  } finally { f.close(); }
});

test('manager work card retains waiting, return-to-work and tomorrow actions', async () => {
  const f = fixture();
  const stamp = new Date().toISOString(), key = managementBotKey([config], config.id);
  try {
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at)
      VALUES('service-a',911,'Customer',-1001234567890,92,'open',?,?)`).run(stamp, stamp);
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,last_inbound_at,updated_at,notification_cycle)
      VALUES('service-a',911,'needs_reply',?,?,1)`).run(stamp, stamp);
    await f.press(`mg:work:${key}:911`);
    let card = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7).at(-1).body;
    const waiting = card.reply_markup.inline_keyboard.flat().find(item => item.text === 'Ждём клиента');
    assert.match(card.text, /Обычное удаление.*\/delete@service_a_bot/);
    assert.ok(waiting);
    await f.press(waiting.callback_data);
    assert.equal(f.db.sqlite.prepare("SELECT state FROM conversation_work WHERE bot_id='service-a' AND user_id=911").get().state, 'waiting');
    card = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7).at(-1).body;
    const needs = card.reply_markup.inline_keyboard.flat().find(item => item.text === 'Вернуть в работу');
    await f.press(needs.callback_data);
    assert.equal(f.db.sqlite.prepare("SELECT state FROM conversation_work WHERE bot_id='service-a' AND user_id=911").get().state, 'needs_reply');
    card = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7).at(-1).body;
    const tomorrow = card.reply_markup.inline_keyboard.flat().find(item => item.text === 'Завтра в 09:00');
    await f.press(tomorrow.callback_data);
    const row = f.db.sqlite.prepare("SELECT state,snoozed_until FROM conversation_work WHERE bot_id='service-a' AND user_id=911").get();
    assert.equal(row.state, 'snoozed');
    assert.ok(Date.parse(row.snoozed_until) > Date.now());
  } finally { f.close(); }
});

test('manager closes a completed test topic for the primary administrator', async () => {
  const f = fixture();
  const groupId = -1001234567890;
  try {
    f.db.sqlite.prepare(`INSERT INTO service_checks(nonce,bot_id,owner_id,group_id,stage,thread_id,expires_at)
      VALUES('test-close','service-a',7,?,'done',82,?)`).run(groupId, new Date(Date.now() + 60000).toISOString());
    const unauthorized = f.input('/close', 8, groupId, 'supergroup');
    unauthorized.message.message_thread_id = 82;
    assert.equal((await f.send(unauthorized)).status, 200);
    assert.equal(f.calls.filter(call => call.method === 'closeForumTopic').length, 0);
    const authorized = f.input('/close@manager_bot', 7, groupId, 'supergroup');
    authorized.message.message_thread_id = 82;
    assert.equal((await f.send(authorized)).status, 200);
    assert.deepEqual(f.calls.filter(call => call.method === 'closeForumTopic').map(call =>
      [call.token, call.body.message_thread_id]), [['100:MANAGER', 82]]);
    assert.ok(f.calls.some(call => call.token === '100:MANAGER' && call.method === 'sendMessage'
      && Number(call.body.chat_id) === 7 && call.body.text === 'Тестовая тема закрыта.'));
  } finally { f.close(); }
});

test('manager /open restores a closed customer topic without using a service-bot command', async () => {
  const f = fixture(), groupId = -1001234567890;
  try {
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at)
      VALUES('service-a',903,'Client',?,45,'closed','2026-01-01T00:00:00Z')`).run(groupId);
    const reopen = f.input('/open@manager_bot', 7, groupId, 'supergroup');
    reopen.message.message_thread_id = 45;
    assert.equal((await f.send(reopen)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT status FROM conversations WHERE bot_id='service-a' AND user_id=903").get().status, 'open');
    assert.ok(f.calls.some(call => call.token === '100:MANAGER' && call.method === 'reopenForumTopic'
      && call.body.message_thread_id === 45));
  } finally { f.close(); }
});

test('a failed manager topic close leaves the conversation open and shows the operator the error', async () => {
  const f = fixture({ managerPin: true, serviceTopics: true, failClose: true });
  const groupId = -1001234567890, stamp = new Date().toISOString();
  try {
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at)
      VALUES('service-a',903,'Client',?,45,'open',?,?)`).run(groupId, stamp, stamp);
    const close = f.input('/close@manager_bot', 7, groupId, 'supergroup');
    close.message.message_thread_id = 45;
    assert.equal((await f.send(close)).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT status,reply_epoch FROM conversations WHERE user_id=903').get().status, 'open');
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM operator_audit WHERE user_id=903 AND action='conversation_close'").get().n, 0);
    assert.ok(f.calls.some(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7
      && call.body.text.includes('Не удалось закрыть тему')));
  } finally { f.close(); }
});

test('an authorized operator closes a topic from the manager work card', async () => {
  const f = fixture();
  const stamp = new Date().toISOString();
  try {
    f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
      VALUES(8,'Operator',1,7,'Admin',?)`).run(stamp);
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at)
      VALUES('service-a',902,'Client',-1001234567890,44,'open',?,?)`).run(stamp, stamp);
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,assigned_to,last_inbound_at,updated_at,notification_cycle)
      VALUES('service-a',902,'needs_reply',8,?,?,1)`).run(stamp, stamp);
    assert.equal((await f.send(f.input('/mine', 8))).status, 200);
    const list = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 8).at(-1).body;
    const work = list.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:pw:'));
    assert.equal((await f.press(work.callback_data, 8)).status, 200);
    const card = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 8).at(-1).body;
    const close = card.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:topic:close:'));
    assert.ok(close);
    assert.equal((await f.press(close.callback_data, 8)).status, 200);
    assert.ok(f.calls.some(call => call.token === '100:MANAGER' && call.method === 'closeForumTopic'
      && call.body.message_thread_id === 44));
    assert.equal(f.db.sqlite.prepare('SELECT status FROM conversations WHERE user_id=902').get().status, 'closed');
    assert.equal(f.db.sqlite.prepare("SELECT operator_id FROM operator_audit WHERE user_id=902 AND action='conversation_close'").get().operator_id, 8);
    const closedCard = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 8).at(-1).body;
    const open = closedCard.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:topic:open:'));
    assert.ok(open);
    assert.equal((await f.press(open.callback_data, 8)).status, 200);
    assert.ok(f.calls.some(call => call.token === '100:MANAGER' && call.method === 'reopenForumTopic'
      && call.body.message_thread_id === 44));
    assert.equal(f.db.sqlite.prepare('SELECT status FROM conversations WHERE user_id=902').get().status, 'open');
    assert.equal(f.db.sqlite.prepare("SELECT operator_id FROM operator_audit WHERE user_id=902 AND action='conversation_open'").get().operator_id, 8);
  } finally { f.close(); }
});

test('a stale manager card cannot close a conversation after its topic moves', async () => {
  const f = fixture();
  const stamp = new Date().toISOString();
  try {
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at)
      VALUES('service-a',904,'Client',-1001234567890,46,'open',?,?)`).run(stamp, stamp);
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,assigned_to,last_inbound_at,updated_at,notification_cycle)
      VALUES('service-a',904,'needs_reply',7,?,?,1)`).run(stamp, stamp);
    assert.equal((await f.send(f.input('/mine'))).status, 200);
    const list = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7).at(-1).body;
    const work = list.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:pw:'));
    assert.equal((await f.press(work.callback_data)).status, 200);
    const card = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7).at(-1).body;
    const oldClose = card.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:topic:close:'));
    assert.ok(oldClose);
    assert.ok(Buffer.byteLength(oldClose.callback_data) <= 64);
    f.db.sqlite.prepare('UPDATE conversations SET support_group_id=-1003334445556,thread_id=47 WHERE user_id=904').run();
    assert.equal((await f.press(oldClose.callback_data)).status, 200);
    assert.equal(f.calls.filter(call => call.method === 'closeForumTopic').length, 0);
    assert.equal(f.db.sqlite.prepare('SELECT status FROM conversations WHERE user_id=904').get().status, 'open');
    assert.ok(f.calls.some(call => call.method === 'sendMessage' && call.body.text?.includes('Карточка устарела')));
  } finally { f.close(); }
});

test('manager topic card changes only its own conversation and stale actions are not repeated', async () => {
  const f = fixture();
  const groupId = -1001234567890, threadId = 42;
  try {
    const stamp = new Date().toISOString();
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at)
      VALUES('service-a',900,'Client',?,?, 'open',?,?)`).run(groupId, threadId, stamp, stamp);
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,last_inbound_at,updated_at,notification_cycle,cycle_started_at)
      VALUES('service-a',900,'needs_reply',?,?,1,?)`).run(stamp, stamp, stamp);
    const command = f.input('/case', 7, groupId, 'supergroup');
    command.message.message_thread_id = threadId;
    assert.equal((await f.send(command)).status, 200);
    const card = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === groupId).at(-1).body;
    assert.equal(card.message_thread_id, threadId);
    assert.match(card.text, /Обращение · Service A · Client/);
    assert.match(card.text, /Ответственный: не назначен/);
    assert.equal(card.reply_markup.inline_keyboard.flat().some(item => item.callback_data?.includes(':release:')), false);
    const take = card.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.includes(':take:')).callback_data;
    let callbackId = 50000;
    const pressTopic = (actor, topic, text = card.text) => f.send({ update_id: callbackId++, callback_query: {
      id: `topic-${callbackId}`, from: { id: actor }, data: take,
      message: { message_id: 501, chat: { id: groupId, type: 'supergroup' }, message_thread_id: topic,
        from: { id: 100, is_bot: true, username: 'manager_bot' }, text },
    } });
    assert.equal((await pressTopic(7, threadId + 1)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT revision FROM conversation_work WHERE bot_id='service-a' AND user_id=900").get().revision, 0);
    assert.equal((await pressTopic(8, threadId)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT revision FROM conversation_work WHERE bot_id='service-a' AND user_id=900").get().revision, 0);
    assert.equal((await pressTopic(7, threadId)).status, 200);
    assert.equal((await pressTopic(7, threadId)).status, 200);
    const work = f.db.sqlite.prepare("SELECT revision,assigned_to FROM conversation_work WHERE bot_id='service-a' AND user_id=900").get();
    assert.equal(work.revision, 1);
    assert.equal(work.assigned_to, 7);
    const updatedCard = f.calls.filter(call => call.method === 'editMessageText' && Number(call.body.chat_id) === groupId).at(-1).body;
    assert.match(updatedCard.text, /Ответственный: вы/);
    assert.ok(updatedCard.reply_markup.inline_keyboard.flat().some(item => item.callback_data?.includes(':release:')));
    assert.equal(updatedCard.reply_markup.inline_keyboard.flat().some(item => item.callback_data?.includes(':take:')), false);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS total FROM operator_audit WHERE bot_id='service-a' AND user_id=900").get().total, 1);
    assert.match(f.calls.filter(call => call.method === 'editMessageText' && Number(call.body.chat_id) === groupId).at(-1).body.text,
      /Состояние уже изменилось/);
    const fresh = f.calls.filter(call => call.method === 'editMessageText' && Number(call.body.chat_id) === groupId).at(-1).body;
    assert.ok(fresh.text.startsWith('Обращение · Service A · '));
    const release = fresh.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.includes(':release:'));
    assert.ok(release);
    assert.equal((await f.send({ update_id: callbackId++, callback_query: { id: `topic-${callbackId}`, from: { id: 7 },
      data: release.callback_data, message: { message_id: 501, chat: { id: groupId, type: 'supergroup' },
        message_thread_id: threadId, from: { id: 100, is_bot: true, username: 'manager_bot' }, text: fresh.text } } })).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT revision,assigned_to FROM conversation_work WHERE bot_id='service-a' AND user_id=900").get().assigned_to, null);
    assert.equal((await f.send(f.input('/start case_' + take.split(':')[3] + '_900'))).status, 200);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7).at(-1).body.text,
      /Service A · Client/);
  } finally { f.close(); }
});

test('a permanent topic-card edit error does not replay an operator action', async () => {
  const groupId = -1001234567890, threadId = 42;
  const f = fixture({ managerPin: true, serviceTopics: true, failMenuEditGroup: groupId });
  try {
    const stamp = new Date().toISOString();
    f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
      VALUES(8,'Operator',1,7,'Admin',?)`).run(stamp);
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at)
      VALUES('service-a',900,'Client',?,?,'open',?,?)`).run(groupId, threadId, stamp, stamp);
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,last_inbound_at,updated_at,notification_cycle,cycle_started_at)
      VALUES('service-a',900,'needs_reply',?,?,1,?)`).run(stamp, stamp, stamp);
    const command = f.input('/case', 8, groupId, 'supergroup');
    command.message.message_thread_id = threadId;
    assert.equal((await f.send(command)).status, 200);
    const card = f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === groupId).at(-1).body;
    const take = card.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.includes(':take:')).callback_data;
    const callback = { callback_query: { id: 'edit-failure', from: { id: 8 }, data: take,
      message: { message_id: 501, chat: { id: groupId, type: 'supergroup' }, message_thread_id: threadId,
        from: { id: 100, is_bot: true, username: 'manager_bot' }, text: card.text } } };
    assert.equal((await f.send({ update_id: 70001, ...callback })).status, 200);
    assert.equal((await f.send({ update_id: 70001, ...callback })).status, 200);
    const work = f.db.sqlite.prepare("SELECT revision,assigned_to FROM conversation_work WHERE bot_id='service-a' AND user_id=900").get();
    assert.equal(work.revision, 1);
    assert.equal(work.assigned_to, 8);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS total FROM operator_audit WHERE bot_id='service-a' AND user_id=900").get().total, 1);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 8).at(-1).body.text,
      /Откройте её командой \/case/);
    const refresh = f.input('/case', 8, groupId, 'supergroup');
    refresh.message.message_thread_id = threadId;
    assert.equal((await f.send(refresh)).status, 200);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === groupId).at(-1).body.text,
      /Ответственный: вы/);
  } finally { f.close(); }
});

test('an uncertain /case send asks for topic inspection without an automatic duplicate', async () => {
  const groupId = -1001234567890, threadId = 42;
  const rights = { managerPin: true, serviceTopics: true, uncertainMenuSend: true };
  const f = fixture(rights);
  try {
    const stamp = new Date().toISOString();
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at)
      VALUES('service-a',900,'Client',?,?,'open',?,?)`).run(groupId, threadId, stamp, stamp);
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,last_inbound_at,updated_at,notification_cycle,cycle_started_at)
      VALUES('service-a',900,'needs_reply',?,?,1,?)`).run(stamp, stamp, stamp);
    const command = f.input('/case', 7, groupId, 'supergroup');
    command.message.message_thread_id = threadId;
    assert.equal((await f.send(command)).status, 200);
    assert.equal((await f.send(command)).status, 200, 'the webhook can replay the same update');
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === groupId).length, 1);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && Number(call.body.chat_id) === 7).at(-1).body.text,
      /Проверьте тему перед повтором \/case/);
  } finally { f.close(); }
});

test('administrator adds and removes an operator who first opened the manager DM', async () => {
  const f = fixture();
  try {
    assert.equal((await f.send(f.input('/start', 8))).status, 200);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body.text,
      /Личный чат подключён/);
    await f.send(f.input('/start'));
    await f.press('mg:operators');
    const candidates = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const add = candidates.reply_markup.inline_keyboard.flat().find(item => item.callback_data === 'mg:opadd:8');
    assert.ok(add);
    await f.press(add.callback_data);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM support_operators WHERE user_id=8 AND active=1').get().count, 0);
    const addConfirmation = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const addConfirm = addConfirmation.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:opaddconfirm:8:'));
    assert.ok(addConfirm);
    await f.press(addConfirm.callback_data);
    assert.equal(f.db.sqlite.prepare('SELECT active FROM support_operators WHERE user_id=8').get().active, 1);
    const addedAt = f.db.sqlite.prepare('SELECT added_at FROM support_operators WHERE user_id=8').get().added_at;
    await f.press(addConfirm.callback_data);
    assert.equal(f.db.sqlite.prepare('SELECT added_at FROM support_operators WHERE user_id=8').get().added_at, addedAt);
    assert.equal((await f.send(f.input('/start', 8))).status, 200);
    const roster = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const operatorCard = roster.reply_markup.inline_keyboard.flat().find(item => item.callback_data === 'mg:opcard:8');
    assert.ok(operatorCard);
    await f.press(operatorCard.callback_data);
    const card = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(card.text, /Username:|Telegram ID: 8/);
    await f.press('mg:opremove:8');
    assert.equal(f.db.sqlite.prepare('SELECT active FROM support_operators WHERE user_id=8').get().active, 1);
    const confirm = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(confirm.text, /Удалить оператора\?/);
    const confirmButton = confirm.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:opconfirm:8:'));
    assert.ok(confirmButton);
    let alertRecipients = [7, 8];
    f.env.ALERT_SETTINGS = {
      status: async () => ({ generation: 2, mode: 'private', recipients: alertRecipients }),
      switch: async options => {
        assert.deepEqual(options, { expectedGeneration: 2, mode: 'private', recipientIds: [7] });
        alertRecipients = options.recipientIds;
        return { oldNotified: true };
      },
    };
    await f.press(confirmButton.callback_data);
    assert.deepEqual(alertRecipients, [7], 'removed operator stops receiving sensitive alerts first');
    assert.equal(f.db.sqlite.prepare('SELECT active FROM support_operators WHERE user_id=8').get().active, 0);
    assert.equal(f.db.sqlite.prepare('SELECT available FROM manager_dm_status WHERE operator_id=8').get().available, 0);
  } finally { f.close(); }
});

test('operator roster pages beyond the first twenty members', async () => {
  const f = fixture();
  try {
    const insert = f.db.sqlite.prepare(`INSERT INTO support_operators
      (user_id,first_name,active,added_by,added_by_name,added_at) VALUES(?,?,1,7,'Admin',?)`);
    for (let id = 8; id <= 32; id++) insert.run(id, `Person ${id}`, new Date().toISOString());
    await f.press('mg:operators');
    const first = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(first.text, /страница 1\/2/);
    assert.ok(first.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:operators:1:0'));
    await f.press('mg:operators:1:0');
    const second = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(second.text, /страница 2\/2/);
    assert.ok(second.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:opcard:32:1'));
    await f.press('mg:opcard:32:1');
    let card = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(card.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:operators:1:0'));
    await f.press('mg:opremove:32:1');
    card = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(card.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:opcard:32:1'));
    const firstIds = new Set(first.reply_markup.inline_keyboard.flat().map(item => item.callback_data)
      .filter(data => data?.startsWith('mg:opcard:')));
    const secondIds = second.reply_markup.inline_keyboard.flat().map(item => item.callback_data)
      .filter(data => data?.startsWith('mg:opcard:'));
    assert.equal(firstIds.size, 20);
    assert.equal(secondIds.length, 5);
    assert.ok(secondIds.every(data => !firstIds.has(data)));
  } finally { f.close(); }
});

test('stale operator removal confirmation cannot remove a newly re-added member', async () => {
  const f = fixture();
  try {
    const stamp = new Date().toISOString();
    f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
      VALUES(8,'Operator',1,7,'Admin',?)`).run(stamp);
    await f.press('mg:opremove:8');
    const confirmation = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const stale = confirmation.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:opconfirm:8:'));
    assert.ok(stale);
    f.db.sqlite.prepare('UPDATE support_operators SET added_at=? WHERE user_id=8')
      .run(new Date(Date.now() + 60_000).toISOString());
    await f.press(stale.callback_data);
    assert.equal(f.db.sqlite.prepare('SELECT active FROM support_operators WHERE user_id=8').get().active, 1);
  } finally { f.close(); }
});

test('stale operator add confirmation cannot use an old private-chat status', async () => {
  const f = fixture();
  try {
    assert.equal((await f.send(f.input('/start', 8))).status, 200);
    await f.press('mg:opadd:8');
    const confirmation = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const stale = confirmation.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:opaddconfirm:8:'));
    assert.ok(stale);
    f.db.sqlite.prepare('UPDATE manager_dm_status SET updated_at=? WHERE operator_id=8')
      .run(new Date(Date.now() + 60_000).toISOString());
    await f.press(stale.callback_data);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM support_operators WHERE user_id=8').get().count, 0);
  } finally { f.close(); }
});

test('administrator can reach candidates beyond the first twenty private chats', async () => {
  const f = fixture();
  try {
    const insert = f.db.sqlite.prepare(`INSERT INTO manager_dm_status(operator_id,first_name,started_at,updated_at)
      VALUES(?,?,?,?)`);
    const stamp = new Date().toISOString();
    for (let id = 100; id < 125; id++) insert.run(id, `Candidate ${id}`, stamp, stamp);
    await f.press('mg:operators');
    const first = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(first.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:operators:0:1'));
    await f.press('mg:operators:0:1');
    const second = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(second.text, /Ожидают добавления: 25 · страница 2\/2/);
    const firstIds = new Set(first.reply_markup.inline_keyboard.flat().map(item => item.callback_data)
      .filter(data => data?.startsWith('mg:opadd:')));
    const secondIds = second.reply_markup.inline_keyboard.flat().map(item => item.callback_data)
      .filter(data => data?.startsWith('mg:opadd:'));
    assert.equal(firstIds.size, 20);
    assert.equal(secondIds.length, 5);
    assert.ok(secondIds.every(data => !firstIds.has(data)));
    await f.press(secondIds[0]);
    const confirmation = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(confirmation.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:operators:0:1'));
    const add = confirmation.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:opaddconfirm:'));
    assert.ok(add?.callback_data.endsWith(':0:1'));
    await f.press(add.callback_data);
    const roster = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(roster.text, /Ожидают добавления: 24 · страница 2\/2/);
  } finally { f.close(); }
});

test('assignment checks current DM access and redirects open work when the operator blocked the bot', async () => {
  const rights = { managerPin: true, serviceTopics: true, blockedDmProbeIds: new Set([8]) };
  const f = fixture(rights);
  try {
    const stamp = new Date().toISOString();
    for (const id of [8, 9]) {
      await f.send(f.input('/start', id));
      f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
        VALUES(?,?,1,7,'Admin',?)`).run(id, `Operator ${id}`, stamp);
    }
    f.db.sqlite.prepare("INSERT INTO service_responsibility(bot_id,backup_id,updated_at) VALUES('service-a',9,?)").run(stamp);
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at)
      VALUES('service-a',900,'Client',-1001234567890,42,'open',?,?)`).run(stamp, stamp);
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,assigned_to,last_inbound_at,updated_at,notification_cycle,cycle_started_at)
      VALUES('service-a',900,'needs_reply',8,?,?,1,?)`).run(stamp, stamp, stamp);
    await f.send(f.input('/start'));
    await f.press('mg:section:bots');
    const service = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:service:'));
    await f.press(service.callback_data);
    const choose = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.includes('mg:choose:') && item.callback_data.endsWith(':p'));
    await f.press(choose.callback_data);
    const ownerChoices = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const select = ownerChoices.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:set:') && item.callback_data.endsWith(':p:8'));
    assert.ok(select);
    assert.match(select.text, /1 ждут · 1 всего/);
    assert.equal((await f.press(select.callback_data)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT primary_id FROM service_responsibility WHERE bot_id='service-a'").get().primary_id, null);
    assert.equal(f.db.sqlite.prepare('SELECT assigned_to FROM conversation_work WHERE user_id=900').get().assigned_to, 9);
    const contact = f.db.sqlite.prepare('SELECT available,unreachable_at FROM manager_dm_status WHERE operator_id=8').get();
    assert.equal(contact.available, 0);
    assert.ok(contact.unreachable_at);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text,
      /Назначение не изменено.*переданы резервному/);
    rights.blockedDmProbeIds.clear();
    await f.send(f.input('/start', 8));
    await f.press(select.callback_data);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text,
      /отключил доступность.*\/available/);
    assert.equal(f.calls.filter(call => call.method === 'sendChatAction' && call.body.chat_id === 8).length, 1);
    await f.send(f.input('/available', 8));
    await f.press(select.callback_data);
    assert.equal(f.db.sqlite.prepare("SELECT primary_id FROM service_responsibility WHERE bot_id='service-a'").get().primary_id, 8);
    assert.equal(f.calls.filter(call => call.method === 'sendChatAction' && call.body.chat_id === 8).length, 2);
    await f.press(select.callback_data.replace(':p:8', ':b:8'));
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text,
      /Основным и резервным не может быть один оператор/);
    assert.equal(f.db.sqlite.prepare("SELECT backup_id FROM service_responsibility WHERE bot_id='service-a'").get().backup_id, 9);
  } finally { f.close(); }
});

test('operator transfers an open conversation with a private note once and queues the new owner notice', async () => {
  const f = fixture();
  try {
    const stamp = new Date().toISOString();
    for (const id of [8, 9]) {
      f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
        VALUES(?,?,1,7,'Admin',?)`).run(id, `Operator ${id}`, stamp);
      await f.send(f.input('/start', id));
    }
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at)
      VALUES('service-a',900,'Client',-1001234567890,42,'open',?,?)`).run(stamp, stamp);
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,assigned_to,last_inbound_at,updated_at,notification_cycle,cycle_started_at)
      VALUES('service-a',900,'needs_reply',8,?,?,1,?)`).run(stamp, stamp, stamp);
    await f.press('mg:mine', 8);
    const list = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    const cardButton = list.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:pw:'));
    assert.ok(cardButton);
    await f.press(cardButton.callback_data, 8);
    const card = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    const transfer = card.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:transfer:'));
    assert.ok(transfer);
    await f.press(transfer.callback_data, 8);
    const targets = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    const toNine = targets.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.endsWith(':9'));
    assert.ok(toNine);
    await f.press(toNine.callback_data, 8);
    await f.send(f.input('Проверьте заказ клиента', 8));
    const confirmation = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    const commit = confirmation.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:commit:'));
    assert.ok(commit);
    assert.equal((await f.press(commit.callback_data, 8)).status, 200);
    assert.equal((await f.press(commit.callback_data, 8)).status, 200);
    const work = f.db.sqlite.prepare("SELECT assigned_to,note,revision FROM conversation_work WHERE bot_id='service-a' AND user_id=900").get();
    assert.deepEqual({ ...work }, { assigned_to: 9, note: 'Проверьте заказ клиента', revision: 1 });
    const notice = f.db.sqlite.prepare("SELECT recipient_id,kind,note,status FROM service_notification_outbox WHERE bot_id='service-a' AND user_id=900").all();
    assert.deepEqual(notice.map(row => ({ ...row })), [{ recipient_id: 9, kind: 'transfer', note: 'Проверьте заказ клиента', status: 'pending' }]);
  } finally { f.close(); }
});

test('administrator configures reminder and escalation thresholds per service', async () => {
  const f = fixture();
  try {
    await f.send(f.input('/start'));
    await f.press('mg:section:bots');
    const service = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:service:'));
    await f.press(service.callback_data);
    const timers = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:timers:'));
    await f.press(timers.callback_data);
    const preset = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.endsWith(':15:30'));
    assert.ok(preset);
    assert.equal((await f.press(preset.callback_data)).status, 200);
    assert.deepEqual({ ...f.db.sqlite.prepare('SELECT reminder_minutes,fallback_minutes FROM service_responsibility WHERE bot_id=?').get('service-a') },
      { reminder_minutes: 15, fallback_minutes: 30 });
  } finally { f.close(); }
});

test('administrator metrics count overdue conversations from the current unanswered cycle', async () => {
  const f = fixture();
  try {
    const old = new Date(Date.now() - 2 * 3600000).toISOString();
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,last_inbound_at,updated_at,notification_cycle,cycle_started_at)
      VALUES('service-a',901,'needs_reply',?,?,2,?)`).run(old, old, old);
    f.db.sqlite.prepare(`INSERT INTO service_notification_outbox
      (bot_id,user_id,notification_cycle,kind,recipient_id,group_id,thread_id,status,available_at,created_at)
      VALUES('service-a',901,2,'new',8,-1001234567890,42,'failed',?,?)`).run(old, old);
    f.db.sqlite.prepare(`INSERT INTO service_notification_outbox
      (bot_id,user_id,notification_cycle,kind,recipient_id,group_id,thread_id,status,available_at,created_at)
      VALUES('service-a',901,1,'new',8,-1001234567890,42,'failed',?,?)`).run(old, old);
    f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
      VALUES(8,'Operator',1,7,'Admin',?)`).run(old);
    f.db.sqlite.prepare(`INSERT INTO manager_dm_status(operator_id,started_at,available,unreachable_at,updated_at)
      VALUES(8,?,1,?,?)`).run(old, old, old);
    assert.equal((await f.send(f.input('/metrics'))).status, 200);
    const card = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(card.text, /Обращений старше первого порога без ответа: 1/);
    assert.match(card.text, /Неясных исходов личных уведомлений: 0/);
    assert.match(card.text, /Личных уведомлений с ошибкой в открытых обращениях: 1/);
    assert.match(card.text, /Недоступных операторов: 1/);
    assert.ok(card.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'mg:operators'));
    assert.equal((await f.press('mg:operators')).status, 200);
    const operators = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(operators.reply_markup.inline_keyboard.flat().some(button =>
      button.callback_data === 'mg:opcard:8' && button.text.includes('⚠️')));
  } finally { f.close(); }
});

test('manager drafts restore a saved bot message and hide settings from operators', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO bot_message_drafts(owner_id,bot_id,field,draft,expected_revision,updated_at)
      VALUES(7,'service-a','welcome_text','Привет, клиент!','','2026-01-01T00:00:00Z')`).run();
    assert.equal((await f.press('mg:drafts')).status, 200);
    const screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const restore = screen.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:msg:'));
    assert.ok(restore);
    assert.equal((await f.press(restore.callback_data)).status, 200);
    const preview = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(preview.text, /Привет, клиент!/);
    f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
      VALUES(8,'Operator',1,7,'Admin','2026-01-01T00:00:00Z')`).run();
    f.db.sqlite.prepare(`INSERT INTO bot_message_drafts(owner_id,bot_id,field,draft,expected_revision,updated_at)
      VALUES(8,'service-a','welcome_text','Операторский черновик','','2026-01-01T00:00:00Z')`).run();
    assert.equal((await f.press('mg:drafts', 8)).status, 200);
    const operatorScreen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    assert.equal(operatorScreen.reply_markup.inline_keyboard.flat().some(item => item.callback_data?.startsWith('mg:msg:')), false);
    assert.equal((await f.press('mg:draftmsg:forged', 8)).status, 200);
  } finally { f.close(); }
});

test('manager profile navigation and moderation work within a Free D1 invocation', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO pending_messages
      (bot_id,user_id,update_id,source_chat_id,source_message_id,source_first_name,created_at)
      VALUES('service-a',911,911,911,1,'Alice','2026-01-01T00:00:00Z')`).run();
    f.db.sqlite.prepare(`INSERT INTO banned_users(bot_id,user_id,reason,banned_at)
      VALUES('service-a',911,'spam','2026-01-01T00:00:00Z')`).run();
    assert.equal((await f.press('mu:home:a')).status, 200);
    assert.equal((await f.press('mu:list:a:x:0')).status, 200);
    const list = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const card = list.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mu:card:'));
    assert.ok(card);
    assert.equal((await f.press(card.callback_data)).status, 200);
    const profile = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const unban = profile.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mu:act:unban:'));
    assert.ok(unban);
    assert.equal((await f.press(unban.callback_data)).status, 200);
    assert.equal((await f.press('mu:resume')).status, 200);
    const confirmation = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const confirm = confirmation.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mu:confirm:'));
    assert.ok(confirm);
    assert.equal((await f.press(confirm.callback_data)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM banned_users WHERE bot_id='service-a' AND user_id=911").get().n, 0);
  } finally { f.close(); }
});

test('manager user card restores a filtered action history including system and operator reasons', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO pending_messages
      (bot_id,user_id,update_id,source_chat_id,source_message_id,source_first_name,created_at)
      VALUES('service-a',911,911,911,1,'Alice','2026-01-01T00:00:00Z')`).run();
    f.db.sqlite.prepare(`INSERT INTO operator_audit
      (bot_id,user_id,actor_type,operator_id,operator_name,action,reason,result,created_at)
      VALUES('service-a',911,'operator',7,'Admin','manual_ban','Повторный спам','success','2026-01-02T00:00:00Z')`).run();
    f.db.sqlite.prepare(`INSERT INTO abuse_events(bot_id,user_id,event_key,event_type,created_at)
      VALUES('service-a',911,'auto-mute-911','temporary_mute','2026-01-03T00:00:00Z')`).run();
    f.db.sqlite.prepare(`INSERT INTO operator_audit
      (bot_id,user_id,actor_type,operator_id,operator_name,action,reason,result,created_at)
      VALUES('service-a',912,'operator',7,'Admin','manual_ban','Другой клиент','success','2026-01-04T00:00:00Z')`).run();
    const key = managementBotKey([config], config.id);
    assert.equal((await f.press(`mu:card:${key}:911`)).status, 200);
    const card = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(card.text, /Последняя активность/);
    const history = card.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mu:audit:'));
    assert.ok(history);
    assert.equal((await f.press(history.callback_data)).status, 200);
    const screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(screen.text, /Повторный спам/);
    assert.match(screen.text, /Автоограничение/);
    assert.doesNotMatch(screen.text, /Другой клиент/);
    const technical = screen.reply_markup.inline_keyboard.flat().find(item => item.text === 'Технические коды');
    assert.ok(technical);
    await f.press(technical.callback_data);
    const details = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(details.text, /\[temporary_mute\]/);
  } finally { f.close(); }
});

test('manager queues expose resolved and scheduled work across services', async () => {
  const f = fixture();
  try {
    for (const id of [901, 902]) f.db.sqlite.prepare(`INSERT INTO conversations
      (bot_id,user_id,first_name,support_group_id,thread_id,status,created_at)
      VALUES('service-a',?,?,-1001234567890,?,'open','2026-01-01T00:00:00Z')`).run(id, `Client ${id}`, id);
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,updated_at)
      VALUES('service-a',901,'resolved','2026-01-01T00:00:00Z')`).run();
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,snoozed_until,updated_at)
      VALUES('service-a',902,'snoozed',?,'2026-01-01T00:00:00Z')`).run(new Date(Date.now() + 3600000).toISOString());
    assert.equal((await f.press('mg:queue:a:resolved:0')).status, 200);
    const resolved = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(resolved.text, /Client 901/);
    assert.doesNotMatch(resolved.text, /Client 902/);
    assert.ok(resolved.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:queue:a:today:0'));
    assert.equal((await f.press('mg:queuebots:today')).status, 200);
    const picker = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(picker.reply_markup.inline_keyboard.flat().some(item => item.callback_data?.includes(':today:0')));
    assert.equal((await f.press('mg:queue:a:all:0')).status, 200);
    const scheduled = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body
      .reply_markup.inline_keyboard.flat().find(item => /^mg:qw:[^:]+:902:/.test(item.callback_data || ''));
    assert.ok(scheduled);
    assert.equal((await f.press(scheduled.callback_data)).status, 200);
    assert.match(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text,
      /Вернуться: \d{2}\.\d{2}\.\d{4}/);
  } finally { f.close(); }
});

test('manager queue cards retain their source, advance across pages, and show reply timestamps', async () => {
  const f = fixture();
  try {
    for (let id = 901; id <= 906; id++) {
      const stamp = `2026-01-01T00:0${id - 901}:00Z`;
      f.db.sqlite.prepare(`INSERT INTO conversations
        (bot_id,user_id,first_name,support_group_id,thread_id,status,created_at)
        VALUES('service-a',?,?,-1001234567890,?,'open',?)`).run(id, `Client ${id}`, id, stamp);
      f.db.sqlite.prepare(`INSERT INTO conversation_work
        (bot_id,user_id,state,assigned_to,last_inbound_at,last_answer_at,updated_at)
        VALUES('service-a',?,'needs_reply',?,?,?,?)`).run(id, id === 901 ? 7 : null, stamp, '2026-01-01T00:00:00Z', stamp);
    }
    f.db.sqlite.prepare(`INSERT INTO operator_ui_sessions(operator_id,chat_id,thread_id,bot_id,route,updated_at)
      VALUES(7,7,1,'service-a','um:n:home','2026-01-01T00:00:00Z')`).run();
    const lastScreen = () => f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const hasButton = (screen, data) => screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === data);
    assert.equal((await f.press('mg:queue:a:needs:0')).status, 200);
    const first = lastScreen().reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:qw:'));
    assert.ok(first);
    assert.ok(Buffer.byteLength(first.callback_data) <= 64);
    const key = first.callback_data.split(':')[2];
    assert.equal((await f.press('mg:queue:a:needs:1')).status, 200);
    assert.equal((await f.press(first.callback_data)).status, 200);
    assert.match(lastScreen().text, /Client 901/);
    assert.match(lastScreen().text, /Ответственный: вы/);
    assert.match(lastScreen().text, /Последнее входящее: 01\.01\.2026/);
    assert.match(lastScreen().text, /Подтверждённый ответ: 01\.01\.2026/);
    assert.ok(hasButton(lastScreen(), `mg:workreturn:${key}:901`));
    assert.ok(hasButton(lastScreen(), `mg:worknext:${key}:901`));
    assert.equal((await f.press(`mg:workreturn:${key}:901`)).status, 200);
    assert.match(lastScreen().text, /страница 1/);
    assert.equal((await f.press(first.callback_data)).status, 200);
    const release = lastScreen().reply_markup.inline_keyboard.flat()
      .find(item => item.callback_data?.startsWith(`mg:act:release:${key}:901:`));
    assert.ok(release);
    assert.equal((await f.press(release.callback_data)).status, 200);
    assert.ok(hasButton(lastScreen(), `mg:workreturn:${key}:901`));
    for (let id = 901; id <= 905; id++) {
      assert.equal((await f.press(`mg:worknext:${key}:${id}`)).status, 200);
      assert.match(lastScreen().text, new RegExp(`Client ${id + 1}`));
    }
    assert.ok(hasButton(lastScreen(), `mg:workreturn:${key}:906`));
    assert.equal((await f.press(`mg:workreturn:${key}:906`)).status, 200);
    assert.match(lastScreen().text, /страница 2/);
    assert.ok(hasButton(lastScreen(), 'mg:queue:a:needs:0'));
    assert.equal((await f.press(`mg:work:${key}:901`)).status, 200);
    assert.equal(hasButton(lastScreen(), `mg:worknext:${key}:901`), false);
    assert.equal((await f.press(first.callback_data)).status, 200);
    assert.ok(hasButton(lastScreen(), `mg:worknext:${key}:901`));
    assert.equal((await f.send(f.input(`/start case_${key}_901`))).status, 200);
    assert.equal(hasButton(lastScreen(), `mg:worknext:${key}:901`), false);
    assert.equal(f.db.sqlite.prepare('SELECT bot_id,route FROM operator_ui_sessions WHERE operator_id=7').get().route, 'um:n:home');
  } finally { f.close(); }
});

test('manager lists delivery problems without knowing a customer ID', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO pending_messages
      (bot_id,user_id,update_id,source_chat_id,source_message_id,source_first_name,created_at)
      VALUES('service-a',915,915,915,1,'Delayed client','2026-01-01T00:00:00Z')`).run();
    assert.equal((await f.press('mg:problems:a:0')).status, 200);
    const screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(screen.text, /Service A · 915/);
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data?.startsWith('mg:diag:')));
  } finally { f.close(); }
});

test('delivery problems link directly to the correct service group topic', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at)
      VALUES('service-a',915,'Delayed client',-1001234567890,123,'open','now')`).run();
    f.db.sqlite.prepare(`INSERT INTO pending_messages
      (bot_id,user_id,update_id,source_chat_id,source_message_id,source_first_name,created_at)
      VALUES('service-a',915,916,915,1,'Delayed client','2026-01-01T00:00:00Z')`).run();
    await f.press('mg:problems:a:0');
    const rows = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat();
    assert.ok(rows.some(item => item.url === 'https://t.me/c/1234567890/123'));
  } finally { f.close(); }
});

test('an operator can inspect live service readiness and technical details in Adminushka', async () => {
  const f = fixture();
  try {
    await registerSupportGroup(f.db, -1001234567890);
    await commitGroupCutover(f.db, 'service-a', -1001234567890, null);
    f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
      VALUES(8,'Operator',1,7,'Admin','2026-01-01T00:00:00Z')`).run();
    const key = managementBotKey([config], config.id);
    assert.equal((await f.press(`mg:service:${key}`, 8)).status, 200);
    const service = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    assert.ok(service.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:ready:${key}:brief`));
    assert.equal((await f.press(`mg:ready:${key}:brief`, 8)).status, 200);
    const brief = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    assert.match(brief.text, /Готовность/);
    assert.equal((await f.press(`mg:ready:${key}:details`, 8)).status, 200);
    const details = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    assert.match(details.text, /Webhook:/);
    assert.match(details.text, /Очередь Telegram:/);
  } finally { f.close(); }
});

for (const [rights, warning] of [
  [{ managerPin: true, managerTopics: true, serviceTopics: true, servicePin: false }, null],
  [{ managerPin: false, managerTopics: true, serviceTopics: true }, /Право Админушки закреплять сообщения не подтверждено/],
  [{ managerPin: true, managerTopics: false, serviceTopics: true }, /Право Админушки управлять темами не подтверждено/],
]) test(`readiness checks each bot's current group role: ${warning || 'service needs no pin right'}`, async () => {
  const f = fixture(rights);
  try {
    await registerSupportGroup(f.db, -1001234567890);
    await commitGroupCutover(f.db, 'service-a', -1001234567890, null);
    const key = managementBotKey([config], config.id);
    await f.press(`mg:ready:${key}:details`);
    const screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(screen.text, /Сервисный бот · темы: право подтверждено/);
    assert.equal(/Право .* не подтверждено/.test(screen.text), Boolean(warning));
    if (warning) assert.match(screen.text, warning);
    else assert.match(screen.text, /Админушка · темы: право подтверждено · закрепление: право подтверждено/);
    assert.ok(f.wireCalls.some(call => call.token === '100:MANAGER' && call.method === 'getChatMember'
      && Number(call.body.user_id) === 100));
  } finally { f.close(); }
});

test('readiness distinguishes reviewed disabled messages and accepts a completed isolated exchange', async () => {
  const f = fixture();
  try {
    await registerSupportGroup(f.db, -1001234567890);
    await commitGroupCutover(f.db, 'service-a', -1001234567890, null);
    f.db.sqlite.prepare(`INSERT INTO bot_message_preferences
      (bot_id,welcome_enabled,auto_reply_enabled,welcome_reviewed,auto_reply_reviewed)
      VALUES('service-a',0,1,1,0)`).run();
    f.db.sqlite.prepare(`INSERT INTO service_checks
      (nonce,bot_id,owner_id,group_id,stage,outbound_at,expires_at)
      VALUES('completed-check','service-a',7,-1001234567890,'done','2026-01-01T00:00:00Z','2099-01-01T00:00:00Z')`).run();
    const key = managementBotKey([config], config.id);
    await f.press(`mg:ready:${key}:details`);
    const ready = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(ready.text, /Приветствие: выключено осознанно/);
    assert.match(ready.text, /Автоответ: не настроено/);
    assert.match(ready.text, /Главный администратор в группе: подтверждён/);
    assert.doesNotMatch(ready.text, /Обмен сообщениями в обе стороны ещё не подтверждён/);
    assert.ok(ready.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:test:${key}`));
    assert.ok(ready.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:msgs:${key}`));
    assert.ok(ready.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:rx:${key}`));
    await f.press(`mg:settings:${key}`);
    const settings = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body.text;
    assert.match(settings, /Приветствие: выключено/);
    assert.match(settings, /Автоответ: не настроено/);
  } finally { f.close(); }
});

test('the primary administrator has a reachable identity card in the team list', async () => {
  const f = fixture();
  try {
    await f.send(f.input('/start'));
    await f.press('mg:operators');
    const list = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(list.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:opprimary'));
    await f.press('mg:opprimary');
    const card = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(card.text, /Роль: главный администратор/);
    assert.match(card.text, /Telegram ID: 7/);
    assert.ok(card.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:operators'));
  } finally { f.close(); }
});

test('manager draft screen resumes a saved legacy handoff note through the current work revision', async () => {
  const f = fixture();
  try {
    const group = -1001234567890;
    await registerSupportGroup(f.db, group);
    await commitGroupCutover(f.db, 'service-a', group, null);
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,thread_id,support_group_id,status,created_at)
      VALUES('service-a',900,42,?,'open','2026-01-01T00:00:00Z')`).run(group);
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,revision,updated_at)
      VALUES('service-a',900,'needs_reply',0,'2026-01-01T00:00:00Z')`).run();
    f.db.sqlite.prepare(`INSERT INTO manager_dm_status(operator_id,started_at,available,updated_at)
      VALUES(7,'2026-01-01T00:00:00Z',1,'2026-01-01T00:00:00Z')`).run();
    f.db.sqlite.prepare(`INSERT INTO operator_note_drafts(operator_id,bot_id,user_id,target_operator,draft,updated_at)
      VALUES(7,'service-a',900,7,'Проверить заказ','2026-01-01T00:00:00Z')`).run();
    assert.equal((await f.press('mg:drafts')).status, 200);
    const screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const resume = screen.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:draftnote:'));
    assert.ok(resume);
    assert.equal((await f.press(resume.callback_data)).status, 200);
    const confirmation = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(confirmation.text, /Проверить заказ/);
    const commit = confirmation.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:commit:'));
    assert.ok(commit);
    assert.equal((await f.press(commit.callback_data)).status, 200);
    assert.equal(f.db.sqlite.prepare("SELECT note FROM conversation_work WHERE bot_id='service-a' AND user_id=900").get().note, 'Проверить заказ');
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM operator_note_drafts WHERE operator_id=7').get().n, 0);
  } finally { f.close(); }
});

test('administrator adds a service bot through manager DM and binds it to the chosen group before webhook activation', async () => {
  const f = fixture();
  try {
    f.env.BOT_ONBOARDING_ENABLED = 'true';
    f.env.BOT_REGISTRY_KEY = 'ab'.repeat(32);
    f.env.SUPPORT_GROUP_ID = '-1001234567890';
    await registerSupportGroup(f.db, -1001234567890, { title: 'Support group' });
    await commitGroupCutover(f.db, 'service-a', -1001234567890, null);
    f.db.sqlite.prepare("UPDATE support_groups SET menu_message_id=777,menu_state='ready',menu_services_json=? WHERE group_id=?")
      .run(JSON.stringify(['Service A']), -1001234567890);
    f.db.sqlite.prepare(`INSERT INTO bot_message_settings(bot_id,welcome_text,auto_reply_text,revision,updated_by,updated_at)
      VALUES('service-a','Welcome template','Request received','source-v1',7,'now')`).run();
    assert.equal((await f.send(f.input('/addbot'))).status, 200);
    const groupChoice = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard[0][0].callback_data;
    assert.match(groupChoice, /^mg:reggrp:/);
    assert.equal((await f.press(groupChoice)).status, 200);
    assert.equal(f.wireCalls.filter(call => ['sendMessage', 'editMessageText'].includes(call.method)
      && call.body.chat_id === 7).at(-1).method, 'editMessageText');
    const flow = () => f.db.sqlite.prepare('SELECT * FROM bot_registration_flow WHERE owner_id=7').get();
    assert.equal(flow().manager_bot_id, 'manager');
    const pressWizard = action => f.press(`br:${action}:${flow().nonce}:${flow().version}`);
    await pressWizard('existing');
    assert.equal(f.wireCalls.filter(call => ['sendMessage', 'editMessageText'].includes(call.method)
      && call.body.chat_id === 7).at(-1).method, 'editMessageText');
    await f.send(f.input(newServiceToken));
    assert.equal(flow().stage, 'group');
    await pressWizard('check');
    await f.send(f.input('New Service'));
    await f.send(f.input('NEW'));
    assert.equal(flow().stage, 'confirm');
    assert.equal((await pressWizard('connect')).status, 200);
    assert.equal(flow().stage, 'done', f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)?.body.text);
    const done = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(done.text, /обязательный шаг — проверка реакций/);
    const reactionCheck = done.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:rxtest:'));
    assert.ok(reactionCheck);
    const copy = done.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:copymsg:'));
    assert.ok(copy);
    await f.press(copy.callback_data);
    const chooser = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    const source = chooser.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:copypreview:'));
    assert.ok(source);
    await f.press(source.callback_data);
    const preview = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(preview.text, /Welcome template/);
    const apply = preview.reply_markup.inline_keyboard.flat().find(item => item.callback_data?.startsWith('mg:copyapply:'));
    await f.press(apply.callback_data);
    assert.equal(f.db.sqlite.prepare("SELECT auto_reply_text FROM bot_message_settings WHERE bot_id='bot-987654'").get().auto_reply_text,
      'Request received');
    assert.equal(done.reply_markup.inline_keyboard.flat().some(item => item.callback_data?.startsWith('br:another:')), false);
    await f.press(reactionCheck.callback_data);
    assert.equal(f.db.sqlite.prepare("SELECT state FROM reaction_checks WHERE bot_id='bot-987654'").get().state, 'waiting');
    assert.equal(f.db.sqlite.prepare('SELECT status FROM registered_bots WHERE bot_id=?').get('bot-987654').status, 'active');
    assert.equal(f.db.sqlite.prepare('SELECT group_id FROM service_group_routes WHERE bot_id=?').get('bot-987654').group_id, -1001234567890);
    assert.ok(f.calls.some(call => call.token === newServiceToken && call.method === 'setWebhook'));
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === -1001234567890).length, 0,
      'an existing pinned menu is edited, not duplicated');
    assert.equal(f.calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === -1001234567890).length, 1);
    assert.equal(f.db.sqlite.prepare('SELECT menu_message_id FROM support_groups WHERE group_id=?').get(-1001234567890).menu_message_id, 777);
  } finally { f.close(); }
});

test('administrator connects a new group and new service without entering a chat ID', async () => {
  const f = fixture();
  try {
    f.env.BOT_ONBOARDING_ENABLED = 'true';
    f.env.BOT_REGISTRY_KEY = 'ab'.repeat(32);
    f.env.SUPPORT_GROUP_ID = '-1001234567890';
    await f.send(f.input('/addbot'));
    const newGroup = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard.flat().find(item => item.callback_data === 'mg:newgrp').callback_data;
    assert.equal((await f.press(newGroup)).status, 200);
    const groupFlow = () => f.db.sqlite.prepare('SELECT * FROM manager_group_flows WHERE owner_id=7').get();
    assert.equal(groupFlow().stage, 'awaiting_group');
    const target = -100999888777;
    assert.equal((await f.send(f.input(`/connect ${groupFlow().code}`, 7, target, 'supergroup'))).status, 200);
    assert.equal(groupFlow().stage, 'registration_group');
    const beginRegistration = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)
      .body.reply_markup.inline_keyboard[0][0].callback_data;
    assert.equal((await f.press(beginRegistration)).status, 200);
    const flow = () => f.db.sqlite.prepare('SELECT * FROM bot_registration_flow WHERE owner_id=7').get();
    assert.equal(JSON.parse(flow().data_json).groupId, target);
    const pressWizard = action => f.press(`br:${action}:${flow().nonce}:${flow().version}`);
    await pressWizard('existing');
    await f.send(f.input(newServiceToken));
    await pressWizard('check');
    await f.send(f.input('New Service'));
    await f.send(f.input('NEW'));
    assert.equal((await pressWizard('connect')).status, 200);
    assert.equal(flow().stage, 'done');
    assert.equal(groupFlow().stage, 'done');
    assert.equal(f.db.sqlite.prepare('SELECT group_id FROM service_group_routes WHERE bot_id=?').get('bot-987654').group_id, target);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === target).length, 1);
    assert.equal(f.calls.filter(call => call.method === 'pinChatMessage' && call.body.chat_id === target).length, 1);
  } finally { f.close(); }
});

test('manager pauses, resumes and removes only a registered bot after unfinished work is cleared', async () => {
  const rights = { managerPin: true, serviceTopics: true };
  const f = fixture(rights);
  try {
    f.env.BOT_ONBOARDING_ENABLED = 'true';
    f.env.BOT_REGISTRY_KEY = 'ab'.repeat(32);
    f.env.SUPPORT_GROUP_ID = '-1001234567890';
    const group = -1001234567890;
    const dynamic = registeredConfig({ id: 987654, username: 'new_service_bot' }, 'New Service', 'NEW');
    await registerSupportGroup(f.db, group);
    await commitGroupCutover(f.db, dynamic.id, group, null);
    f.db.sqlite.prepare("UPDATE support_groups SET menu_message_id=777,menu_state='ready',menu_services_json=? WHERE group_id=?")
      .run(JSON.stringify(['New Service']), group);
    const credentials = await sealCredentials(f.env, dynamic.id,
      { token: newServiceToken, webhookSecret: 'new-secret' });
    f.db.sqlite.prepare(`INSERT INTO registered_bots(bot_id,telegram_id,config_json,credentials,status,owner_id,created_at,updated_at)
      VALUES(?,?,?,?, 'active',7,'now','now')`).run(dynamic.id, 987654, JSON.stringify(dynamic), credentials);
    const key = managementBotKey([config, dynamic], dynamic.id);
    const currentScreen = () => f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1)?.body;
    const serviceWebhook = 'https://support.example.workers.dev/tg/bot-987654';
    f.webhooks.set(newServiceToken, serviceWebhook);
    assert.equal((await f.press(`mg:service:${key}`)).status, 200);
    assert.ok(currentScreen().reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:lifecycle:${key}:pause`));
    assert.equal((await f.press(`mg:lifedo:${key}:pause`, 8)).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT status FROM registered_bots WHERE bot_id=?').get(dynamic.id).status, 'active');
    assert.equal((await f.press(`mg:lifecycle:${key}:pause`)).status, 200);
    assert.equal((await f.press(`mg:lifedo:${key}:pause`)).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT status FROM registered_bots WHERE bot_id=?').get(dynamic.id).status, 'paused');
    assert.ok(f.calls.some(call => call.token === newServiceToken && call.method === 'deleteWebhook'));
    assert.deepEqual(JSON.parse(f.db.sqlite.prepare('SELECT menu_services_json FROM support_groups WHERE group_id=?').get(group).menu_services_json), []);
    await f.press('mg:home');
    await f.press('mg:section:bots');
    assert.ok(currentScreen().reply_markup.inline_keyboard.flat().some(item => item.text.includes('New Service') && item.text.includes('⏸')));
    assert.equal((await f.press(`mg:lifecycle:${key}:resume`)).status, 200);
    assert.equal((await f.press(`mg:lifedo:${key}:resume`)).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT status FROM registered_bots WHERE bot_id=?').get(dynamic.id).status, 'active');
    assert.ok(f.calls.some(call => call.token === newServiceToken && call.method === 'setWebhook' && call.body.url === serviceWebhook));
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,thread_id,support_group_id,status,created_at)
      VALUES(?,?,42,?,'open','now')`).run(dynamic.id, 900, group);
    await f.press(`mg:lifedo:${key}:pause`);
    assert.equal((await f.press(`mg:lifecycle:${key}:remove`)).status, 200);
    assert.match(currentScreen().text, /открытые темы/);
    f.db.sqlite.prepare("UPDATE conversations SET status='closed' WHERE bot_id=?").run(dynamic.id);
    rights.pendingWebhookUpdates = 1;
    assert.equal((await f.press(`mg:lifedo:${key}:remove`)).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM registered_bots WHERE bot_id=?').get(dynamic.id).n, 1);
    rights.pendingWebhookUpdates = 0;
    assert.equal((await f.press(`mg:lifecycle:${key}:remove`)).status, 200);
    assert.equal((await f.press(`mg:lifedo:${key}:remove`)).status, 200);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM registered_bots WHERE bot_id=?').get(dynamic.id).n, 0);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM conversations WHERE bot_id=?').get(dynamic.id).n, 1);
    assert.equal(f.db.sqlite.prepare('SELECT group_id FROM service_group_routes WHERE bot_id=?').get(dynamic.id).group_id, group);
  } finally { f.close(); }
});

test('paused service offers read-only history and rejects old work action buttons', async () => {
  const f = fixture();
  try {
    f.env.BOT_REGISTRY = JSON.stringify([{ ...config, enabled: false }]);
    const key = managementBotKey([config], config.id);
    f.db.sqlite.prepare(`INSERT INTO registered_bots(bot_id,telegram_id,config_json,credentials,status,owner_id,created_at,updated_at)
      VALUES('service-a',200,?,'sealed','paused',7,'now','now')`).run(JSON.stringify(config));
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,thread_id,support_group_id,status,created_at)
      VALUES('service-a',42,123,-1001234567890,'open','now')`).run();
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,revision,updated_at)
      VALUES('service-a',42,'needs_reply',0,'now')`).run();
    await f.press(`mg:service:${key}`);
    const card = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(card.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mu:home:${key}`));
    assert.ok(card.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:audit:${key}:0`));
    assert.ok(card.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:problems:${key}:0`));
    await f.press(`mg:act:take:${key}:42:0`);
    await f.press(`mg:transfer:${key}:42:0`);
    await f.press(`mg:settimers:${key}:15:30`);
    await f.press(`mg:set:${key}:p:8`);
    await f.press(`mg:begin:${key}`);
    await f.press(`mg:testnew:${key}`);
    assert.equal(f.db.sqlite.prepare("SELECT revision,assigned_to FROM conversation_work WHERE bot_id='service-a' AND user_id=42").get().revision, 0);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM manager_work_flows').get().n, 0);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM service_responsibility WHERE bot_id='service-a'").get().n, 0);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM manager_group_flows').get().n, 0);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM service_checks').get().n, 0);
  } finally { f.close(); }
});

test('paused service keeps saved settings inspectable without exposing change buttons', async () => {
  const f = fixture();
  try {
    f.env.BOT_REGISTRY = JSON.stringify([{ ...config, enabled: false }]);
    const key = managementBotKey([config], config.id);
    f.db.sqlite.prepare(`INSERT INTO bot_message_settings(bot_id,welcome_text,auto_reply_text,revision,updated_by,updated_at)
      VALUES('service-a','Saved welcome','Saved reply','v1',7,'now')`).run();
    const screen = () => f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    await f.press(`mg:service:${key}`);
    assert.ok(screen().reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:settings:${key}`));
    await f.press(`mg:settings:${key}`);
    assert.match(screen().text, /только просмотр/);
    await f.press(`mg:msg:${key}:w:view`);
    assert.match(screen().text, /Saved welcome/);
    assert.ok(!screen().reply_markup.inline_keyboard.flat().some(item => item.callback_data?.endsWith(':edit')));
    await f.press(`mg:rx:${key}`);
    assert.ok(!screen().reply_markup.inline_keyboard.flat().some(item => item.callback_data?.startsWith('mg:rxset:')));
    await f.press(`mg:attack:${key}`);
    assert.ok(!screen().reply_markup.inline_keyboard.flat().some(item => item.callback_data?.startsWith('mg:attackset:')));
    await f.press(`mg:style:${key}`);
    assert.ok(!screen().reply_markup.inline_keyboard.flat().some(item => item.callback_data?.startsWith('mg:stylecolor:')));
    await f.press(`mg:msg:${key}:w:off`);
    assert.match(screen().text, /только для просмотра/);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM bot_message_preferences WHERE bot_id='service-a'").get().n, 0);
  } finally { f.close(); }
});

test('operator service card exposes read-only reaction and protection details', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
      VALUES(8,'Operator',1,7,'Admin','now')`).run();
    const key = managementBotKey([config], config.id);
    const screen = () => f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    await f.press(`mg:service:${key}`, 8);
    assert.ok(screen().reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:rxview:${key}`));
    await f.press(`mg:rxview:${key}`, 8);
    assert.match(screen().text, /только просмотр/);
    assert.ok(!screen().reply_markup.inline_keyboard.flat().some(item => item.callback_data?.startsWith('mg:rxset:')));
    await f.press(`mg:attackview:${key}`, 8);
    assert.match(screen().text, /Защита сервиса/);
    assert.ok(!screen().reply_markup.inline_keyboard.flat().some(item => item.callback_data?.startsWith('mg:attackset:')));
  } finally { f.close(); }
});

test('operator can reopen the card of a paused service assigned to them', async () => {
  const f = fixture();
  try {
    f.env.BOT_REGISTRY = JSON.stringify([{ ...config, enabled: false }]);
    f.db.sqlite.prepare(`INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at)
      VALUES(8,'Operator',1,7,'Admin','now')`).run();
    f.db.sqlite.prepare(`INSERT INTO service_responsibility(bot_id,primary_id,backup_id,reminder_minutes,fallback_minutes,updated_at)
      VALUES('service-a',8,7,30,60,'now')`).run();
    const key = managementBotKey([config], config.id);
    await f.press('mg:home', 8);
    const home = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    assert.ok(home.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:service:${key}`));
    await f.press(`mg:service:${key}`, 8);
    const card = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 8).at(-1).body;
    assert.match(card.text, /Подключение приостановлено|Сервис выключен/);
    assert.ok(card.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mu:home:${key}`));
  } finally { f.close(); }
});

test('all-service reaction overview remains reachable across pages and by command', async () => {
  const f = fixture();
  try {
    const services = Array.from({ length: 14 }, (_, index) => ({ ...config,
      id: `service-${index}`, displayName: `Service ${index}`,
      tokenBinding: `SERVICE_${index}_TOKEN`, webhookSecretBinding: `SERVICE_${index}_SECRET` }));
    f.env.BOT_REGISTRY = JSON.stringify(services);
    const screen = () => f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    await f.press('mg:rxview:a');
    assert.match(screen().text, /страница 1\/2/);
    assert.ok(screen().reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:rxview:a:1'));
    await f.press('mg:rxview:a:1');
    assert.match(screen().text, /страница 2\/2/);
    assert.ok(screen().reply_markup.inline_keyboard.flat().some(item => item.text.includes('Service 13')));
    await f.send(f.input('/reactions'));
    assert.match(screen().text, /Реакции всех сервисов/);
  } finally { f.close(); }
});

test('unreadable registered credentials offer reconnection instead of unusable lifecycle buttons', async () => {
  const f = fixture();
  try {
    f.env.BOT_ONBOARDING_ENABLED = 'true';
    f.env.BOT_REGISTRY_KEY = 'ab'.repeat(32);
    const dynamic = registeredConfig({ id: 987654, username: 'new_service_bot' }, 'New Service', 'NEW');
    f.db.sqlite.prepare(`INSERT INTO registered_bots(bot_id,telegram_id,config_json,credentials,status,owner_id,created_at,updated_at)
      VALUES(?,?,?,'broken','active',7,'now','now')`).run(dynamic.id, 987654, JSON.stringify(dynamic));
    const key = managementBotKey([config, dynamic], dynamic.id);
    assert.equal((await f.press(`mg:service:${key}`)).status, 200);
    const screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(screen.text, /Учётные данные бота недоступны/);
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:addbot'));
    assert.ok(!screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data?.startsWith('mg:lifecycle:')));
  } finally { f.close(); }
});

test('older saved notes remain reachable after the first drafts page', async () => {
  const f = fixture();
  try {
    for (let userId = 1; userId <= 10; userId++)
      f.db.sqlite.prepare(`INSERT INTO operator_note_drafts(operator_id,bot_id,user_id,target_operator,draft,updated_at)
        VALUES(7,'service-a',?,8,'Saved',?)`).run(userId, `2026-09-${String(userId).padStart(2, '0')}T00:00:00Z`);
    await f.press('mg:drafts');
    let screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:drafts:1'));
    const key = managementBotKey([config], config.id);
    assert.ok(!screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:draftnote:${key}:1`));
    await f.press('mg:drafts:1');
    screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === `mg:draftnote:${key}:1`));
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(item => item.callback_data === 'mg:drafts:0'));
  } finally { f.close(); }
});

test('work queues skip paused and removed service rows without breaking pagination', async () => {
  const f = fixture();
  try {
    f.env.BOT_REGISTRY = JSON.stringify([{ ...config, enabled: false }]);
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,thread_id,support_group_id,status,created_at)
      VALUES('service-a',42,123,-1001234567890,'open','now')`).run();
    f.db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,revision,updated_at)
      VALUES('service-a',42,'needs_reply',0,'now')`).run();
    await f.send(f.input('/all'));
    let list = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(list.text, /нет открытых обращений/);
    assert.ok(!list.reply_markup.inline_keyboard.flat().some(item => item.callback_data?.startsWith('mg:pw:')));
    f.env.BOT_REGISTRY = '[]';
    await f.send(f.input('/all'));
    list = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1).body;
    assert.match(list.text, /нет открытых обращений/);
  } finally { f.close(); }
});
