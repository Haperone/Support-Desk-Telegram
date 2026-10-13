import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { createRegistrationWorker, handleBotRegistrationUpdate } from '../bot-onboarding.js';
import { openCredentials, registeredConfig, sealCredentials, withBotRegistry } from '../bot-registry.js';
import { supportServices } from '../support-health.js';
import { supportCommandList } from '../worker.js';
import { RESET_TABLES } from '../storage-reset.js';

const MAIN = '123456:' + 'M'.repeat(35);
const NEW = '987654:' + 'N'.repeat(35);
const NEW2 = '987654:' + 'R'.repeat(35);
const mainConfig = { id: 'main', username: 'main_bot', displayName: 'Main', topicPrefix: 'Main', locale: 'ru',
  tokenBinding: 'MAIN_TOKEN', webhookSecretBinding: 'MAIN_WEBHOOK', groupCommandOwner: true };
const me = { id: 987654, username: 'new_bot', first_name: 'New support', is_bot: true };

function fixture(locale = 'ru', managerLocale = null) {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url), 50);
  const env = { SUPPORT_DB: db, BOT_ONBOARDING_ENABLED: 'true', BOT_REGISTRY_KEY: 'ab'.repeat(32),
    BOT_REGISTRY: JSON.stringify([{ ...mainConfig, locale }]), MAIN_TOKEN: MAIN, MAIN_WEBHOOK: 'main-secret', ADMIN_IDS: '7', SUPPORT_GROUP_ID: '-1001234567890',
    PUBLIC_BASE_URL: 'https://support.example.workers.dev', RECOVERY_D1_PLAN: 'free', TELEGRAM_COOLDOWN_ENABLED: 'true', RETENTION_ENABLED: 'true', STORAGE_GUARD_ENABLED: 'true' };
  if (managerLocale) {
    env.MANAGER_BOT_TOKEN = MAIN;
    db.sqlite.prepare('INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,?,?)')
      .run(managerLocale, new Date().toISOString());
  }
  let id = 100; let msg = 1000;
  const calls = []; const delegated = [];
  const hooks = new Map([[MAIN, env.PUBLIC_BASE_URL + '/tg/main'], [NEW, '']]);
  const options = { rights: true, managed: true, failSet: false, afterSet: null };
  const fetchImpl = async (url, init) => {
    const [, token, method] = /bot([^/]+)\/(\w+)$/.exec(String(url));
    const body = JSON.parse(init.body);
    calls.push({ token, method, body });
    if (options.rejectMethod === method) return Response.json({ ok: false, error_code: 400,
      description: `Rejected https://api.telegram.org/bot${token}/${method}` }, { status: 400 });
    if (method === 'getMe') return Response.json({ ok: true, result: token === MAIN
      ? { id: 123456, username: 'main_bot', first_name: 'Main', is_bot: true, can_manage_bots: options.managed }
      : { ...me } });
    if (method === 'getManagedBotToken') return Response.json({ ok: true, result: options.rotated ? NEW2 : NEW });
    if (method === 'getChat') return Response.json({ ok: true, result: { id: Number(env.SUPPORT_GROUP_ID), type: 'supergroup', title: 'Поддержка', is_forum: true } });
    if (method === 'getChatMember') return Response.json({ ok: true, result: { status: 'administrator', can_manage_topics: options.rights, can_pin_messages: options.rights } });
    if (method === 'getWebhookInfo') return Response.json({ ok: true, result: { url: hooks.get(token) || '', allowed_updates: ['message'], pending_update_count: 9 } });
    if (method === 'setWebhook') {
      hooks.set(token, body.url);
      if (options.afterSet) await options.afterSet(token, body);
      if (options.failSet && token !== MAIN) throw new Error('simulated lost response');
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: true, result: { message_id: ++msg } });
  };
  const base = { async fetch(request, loaded) { delegated.push({ update: await request.json(), env: loaded }); return new Response('base'); },
    async scheduled(_c, loaded) { delegated.push({ cron: true, env: loaded }); } };
  const worker = createRegistrationWorker(base, fetchImpl);
  const request = (update, botId = 'main', secret = 'main-secret') => new Request(env.PUBLIC_BASE_URL + '/tg/' + botId,
    { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update) });
  const sendUpdate = async (update, botId, secret) => {
    db.queries = 0;
    const response = managerLocale
      ? new Response(await handleBotRegistrationUpdate({ id: 'manager', token: MAIN, locale: 'en' }, env, update, fetchImpl) ? 'OK' : 'base')
      : await worker.fetch(request(update, botId, secret), env, {});
    assert.ok(db.queries <= 50); return response;
  };
  const input = (text, user = 7, updateId = ++id) => ({ update_id: updateId, message: { message_id: updateId, from: { id: user, first_name: 'Admin' }, chat: { id: user, type: 'private' }, text } });
  const text = async (value, user, updateId) => sendUpdate(input(value, user, updateId));
  const flow = () => db.sqlite.prepare('SELECT * FROM bot_registration_flow').get();
  const callback = (action, value = flow()) => ({ update_id: ++id, callback_query: { id: 'q' + id, from: { id: 7 },
    message: { message_id: ++msg, chat: { id: 7, type: 'private' } }, data: `br:${action}:${value.nonce}:${value.version}` } });
  const press = action => sendUpdate(callback(action));
  const before = globalThis.fetch; globalThis.fetch = fetchImpl;
  return { db, env, worker, calls, delegated, hooks, options, text, input, sendUpdate, flow, callback, press, request,
    close() { globalThis.fetch = before; db.close(); } };
}

async function prepare(f) {
  assert.equal((await f.text('/start addbot')).status, 200);
  await f.press('existing');
  assert.equal((await f.text(NEW)).status, 200);
  assert.equal(f.flow().stage, 'group');
  await f.press('check');
  await f.text('Shop');
  await f.text('SHOP');
  assert.equal(f.flow().stage, 'confirm');
}

test('complete onboarding screens and errors follow each supported language', async () => {
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const f = fixture(locale);
    try {
      // Names returned by Telegram are external content and stay as written.
      await f.text('/addbot');
      await f.press('existing');
      await f.text('987654:' + 'x'.repeat(10));
      await f.text(NEW);
      await f.press('check');
      await f.text('Shop');
      await f.text('SHOP');
      await f.press('connect');
      assert.equal(f.flow().stage, 'done');
      const cards = f.calls.filter(c => c.method === 'sendMessage' && c.body.chat_id === 7);
      const content = cards.map(c => [c.body.text,
        ...(c.body.reply_markup?.inline_keyboard?.flat().map(b => b.text) || []),
        ...(c.body.reply_markup?.keyboard?.flat().map(b => b.text) || [])].join('\n')).join('\n');
      // This fixture's Telegram group title is authored Russian text.
      const ui = content.replaceAll('Поддержка', 'Support');
      if (locale !== 'ru') assert.doesNotMatch(ui, /[А-Яа-яЁё]/, `${locale} onboarding leak`);
      if (locale === 'es') assert.match(content, /Comprobar conexión/);
      if (locale === 'zh') assert.match(content, /检查连接/);
    } finally { f.close(); }
  }
});

test('manager onboarding keeps personal language after typed name and prefix replies', async () => {
  const expected = { ru: 'Префикс топиков:', en: 'Topic prefix:', es: 'Prefijo de temas:', zh: '话题前缀：' };
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const f = fixture('en', locale);
    try {
      await f.text('/addbot'); await f.press('existing'); await f.text(NEW);
      await f.press('check'); await f.text('Мой магазин'); await f.text('SHOP');
      const card = f.calls.filter(c => c.method === 'sendMessage' && c.body.chat_id === 7).at(-1).body;
      assert.ok(card.text.includes(expected[locale]), `${locale}: ${card.text}`);
      assert.ok(card.text.includes('Мой магазин'));
      assert.ok(card.text.includes('SHOP'));
    } finally { f.close(); }
  }
});

test('registration: credentials use authenticated encryption and are bound to their bot / session', async () => {
  const env = { BOT_REGISTRY_KEY: '01'.repeat(32) };
  const cipher = await sealCredentials(env, 'bot-1', { token: NEW });
  assert.ok(!cipher.includes(NEW));
  assert.deepEqual(await openCredentials(env, 'bot-1', cipher), { token: NEW });
  await assert.rejects(openCredentials(env, 'bot-2', cipher));
  await assert.rejects(openCredentials({ BOT_REGISTRY_KEY: '02'.repeat(32) }, 'bot-1', cipher));
  await assert.rejects(openCredentials(env, 'bot-1', cipher.slice(0, -5) + 'AAAA='));
});

test('registration: reconnects a bot whose stored credentials cannot be decrypted', async () => {
  const f = fixture();
  try {
    const config = registeredConfig(me, 'Shop', 'SHOP');
    f.db.sqlite.prepare(`INSERT INTO registered_bots(bot_id,telegram_id,config_json,credentials,status,owner_id,created_at,updated_at)
      VALUES(?,?,?,'broken','active',7,'now','now')`).run(config.id, me.id, JSON.stringify(config));
    const before = await withBotRegistry(f.env);
    assert.equal(before.DYNAMIC_BOT_STATES[config.id], 'credentials_unavailable');
    await prepare(f);
    assert.equal((await f.press('connect')).status, 200);
    const row = f.db.sqlite.prepare('SELECT * FROM registered_bots WHERE bot_id=?').get(config.id);
    assert.equal(row.status, 'active');
    assert.equal(row.telegram_id, me.id);
    const restored = await openCredentials(f.env, config.id, row.credentials);
    assert.equal(restored.token, NEW);
    assert.equal(f.calls.find(call => call.method === 'setWebhook' && call.token === NEW).body.secret_token,
      restored.webhookSecret);
  } finally { f.close(); }
});

test('registration: managed token refresh repairs unreadable credentials without silently activating webhook', async () => {
  const f = fixture();
  try {
    const config = registeredConfig(me, 'Shop', 'SHOP');
    f.db.sqlite.prepare(`INSERT INTO registered_bots(bot_id,telegram_id,config_json,credentials,status,manager_bot_id,owner_id,created_at,updated_at)
      VALUES(?,?,?,'broken','active','main',7,'now','now')`).run(config.id, me.id, JSON.stringify(config));
    f.options.rotated = true;
    const response = await f.sendUpdate({ update_id: 500, managed_bot: { user: { id: 7 }, bot: me } });
    assert.equal(response.status, 200);
    const row = f.db.sqlite.prepare('SELECT * FROM registered_bots WHERE bot_id=?').get(config.id);
    assert.equal(row.status, 'paused');
    assert.equal((await openCredentials(f.env, config.id, row.credentials)).token, NEW2);
    assert.ok(!f.calls.some(call => call.method === 'setWebhook' && call.token === NEW2));
  } finally { f.close(); }
});

test('legacy General menu callback points to the dedicated manager after cutover', async () => {
  const f = fixture();
  try {
    f.env.MANAGER_BOT_TOKEN = '100:manager-token';
    f.env.MANAGER_BOT_USERNAME = 'manager_bot';
    const response = await f.sendUpdate({ update_id: 800, callback_query: { id: 'old-menu', from: { id: 7 },
      message: { message_id: 321, message_thread_id: 1, chat: { id: Number(f.env.SUPPORT_GROUP_ID), type: 'supergroup' } },
      data: 'um:n:home' } });
    assert.equal(response.status, 200);
    assert.equal(f.delegated.length, 0);
    const edit = f.calls.find(call => call.method === 'editMessageText' && call.body.message_id === 321);
    assert.ok(edit);
    assert.match(edit.body.reply_markup.inline_keyboard[0][0].url, /manager_bot/);
  } finally { f.close(); }
});

test('legacy menu redirect follows the service language', async () => {
  const f = fixture();
  try {
    f.env.BOT_REGISTRY = JSON.stringify([{ ...mainConfig, locale: 'es' }]);
    f.env.MANAGER_BOT_TOKEN = '100:manager-token';
    f.env.MANAGER_BOT_USERNAME = 'manager_bot';
    const response = await f.sendUpdate({ update_id: 802, callback_query: { id: 'old-menu-es', from: { id: 7 },
      message: { message_id: 323, message_thread_id: 1, chat: { id: Number(f.env.SUPPORT_GROUP_ID), type: 'supergroup' } },
      data: 'um:n:home' } });
    assert.equal(response.status, 200);
    const edit = f.calls.find(call => call.method === 'editMessageText' && call.body.message_id === 323);
    assert.match(edit.body.text, /menú de soporte/);
    assert.match(edit.body.reply_markup.inline_keyboard[0][0].text, /Abrir menú de soporte/);
  } finally { f.close(); }
});

test('historical topic callback acknowledges the button and points to the current group', async () => {
  const f = fixture();
  try {
    f.env.MANAGER_BOT_TOKEN = '100:manager-token';
    const oldGroup = Number(f.env.SUPPORT_GROUP_ID), newGroup = -1009991234567;
    const stamp = '2026-09-26T10:00:00.000Z';
    f.db.sqlite.prepare("INSERT INTO bots(id,display_name,topic_prefix,created_at) VALUES('main','Main','Main',?)").run(stamp);
    f.db.sqlite.prepare('INSERT INTO support_groups(group_id,created_at,updated_at) VALUES(?,?,?)').run(newGroup,stamp,stamp);
    f.db.sqlite.prepare("INSERT INTO service_group_routes(bot_id,group_id,source,updated_at) VALUES('main',?,'wizard',?)").run(newGroup,stamp);
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,created_at)
      VALUES('main',42,?,77,?)`).run(newGroup,stamp);
    f.db.sqlite.prepare(`INSERT INTO service_topic_history(bot_id,user_id,support_group_id,thread_id,
      conversation_id,status,created_at,archived_at,replacement_group_id,replacement_thread_id)
      VALUES('main',42,?,41,1,'closed',?,?,?,77)`).run(oldGroup,stamp,stamp,newGroup);
    const response = await f.sendUpdate({ update_id: 801, callback_query: { id: 'old-topic', from: { id: 7 },
      message: { message_id: 322, message_thread_id: 41, chat: { id: oldGroup, type: 'supergroup' } },
      data: 'um:w:card:main:42' } });
    assert.equal(response.status, 200);
    assert.equal(f.delegated.length, 0);
    assert.ok(f.calls.some(call => call.method === 'answerCallbackQuery' && call.body.callback_query_id === 'old-topic'));
    assert.ok(f.calls.some(call => call.method === 'editMessageText' && call.body.chat_id === oldGroup
      && call.body.message_id === 322 && call.body.text.includes('https://t.me/c/9991234567/77')));
  } finally { f.close(); }
});

test('registration: complete private wizard, preserved pending queue, empty texts, immediate General reminder and dynamic routing', async () => {
  const f = fixture(); try {
    await prepare(f);
    const cipher = f.flow().credentials;
    assert.ok(!cipher.includes(NEW));
    assert.ok(!f.flow().data_json.includes(NEW));
    assert.equal(f.delegated.length, 0, 'setup messages never become support messages');
    assert.ok(f.calls.some(c => c.method === 'deleteMessage'));
    assert.equal((await f.press('connect')).status, 200);
    assert.equal(f.flow().stage, 'done');
    assert.equal(f.flow().credentials, null);
    const row = f.db.sqlite.prepare('SELECT * FROM registered_bots').get();
    assert.equal(row.status, 'active');
    const creds = await openCredentials(f.env, row.bot_id, row.credentials);
    assert.equal(creds.token, NEW);
    const set = f.calls.find(c => c.token === NEW && c.method === 'setWebhook');
    assert.equal(set.body.drop_pending_updates, false);
    assert.equal(set.body.secret_token, creds.webhookSecret);
    assert.ok(set.body.allowed_updates.includes('managed_bot'));
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM bot_message_settings').get().n, 0);
    assert.ok(f.calls.some(c => c.method === 'sendMessage' && c.body.chat_id === Number(f.env.SUPPORT_GROUP_ID) && /Configure messages for Shop/.test(c.body.text)));
    assert.equal((await f.sendUpdate(f.input('Customer', 10), row.bot_id, creds.webhookSecret)).status, 200);
    assert.equal(f.delegated[0].env.REGISTERED_987654_TOKEN, NEW);
    assert.ok(supportServices(f.delegated[0].env).some(c => c.id === row.bot_id));
    await f.text('Ordinary support message');
    assert.equal(f.delegated.length, 2, 'finishing setup restores ordinary admin-as-customer messages');
    f.db.queries = 0;
    await f.worker.scheduled({}, f.env, {});
    assert.equal(f.delegated.at(-1).env.REGISTERED_987654_TOKEN, NEW);
  } finally { f.close(); }
});

test('registration: unavailable permissions do not configure webhook; invalid token and old buttons cannot advance a newer step', async () => {
  const f = fixture(); try {
    await f.text('/addbot'); const old = f.callback('existing');
    await f.sendUpdate(old); await f.text(NEW);
    await f.sendUpdate(old);
    assert.equal(f.flow().stage, 'group');
    f.options.rights = false;
    await f.press('check');
    assert.equal(f.flow().stage, 'group');
    assert.equal(f.calls.filter(c => c.method === 'setWebhook').length, 0);
    assert.ok(f.calls.at(-1).body.text.includes('Выдайте боту права'));
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM registered_bots').get().n, 0);
    f.options.rights = true;
    await f.press('check');
    const value = f.input('Shop'); await f.sendUpdate(value); await f.sendUpdate(value);
    assert.equal(f.flow().stage, 'prefix', 'replayed name is not reused as prefix');
  } finally { f.close(); }
});

test('registration: non-primary users, cross-chat callbacks, expired flows and wrong webhook secrets cannot use setup or forward a token', async () => {
  const f = fixture(); try {
    await f.text('/addbot', 8); await f.text(NEW, 8);
    assert.equal(f.flow(), undefined); assert.equal(f.delegated.length, 0);
    await f.text('/addbot'); await f.press('existing');
    const callback = f.callback('create'); callback.callback_query.message.chat = { id: Number(f.env.SUPPORT_GROUP_ID), type: 'supergroup' };
    await f.sendUpdate(callback); assert.equal(f.flow().stage, 'token');
    f.db.sqlite.exec("UPDATE bot_registration_flow SET expires_at = '2000-01-01'");
    await f.text(NEW);
    assert.equal(f.flow(), undefined); assert.equal(f.delegated.length, 0);
    f.db.queries = 0;
    assert.equal((await f.worker.fetch(f.request(f.input('/addbot'), 'main', 'wrong'), f.env, {})).status, 403);
    assert.ok(f.db.queries > 0, 'managed static routes are resolved from D1 before secret authentication');
  } finally { f.close(); }
});

test('adopted static bot authenticates with its managed secret and stays hidden after removal', async () => {
  const f = fixture();
  try {
    const cipher = await sealCredentials(f.env, 'main', { token: MAIN, webhookSecret: 'managed-secret' });
    f.db.sqlite.prepare(`INSERT INTO adopted_static_bots(bot_id,telegram_id,config_json,adopted_at)
      VALUES('main',123456,?,'now')`).run(JSON.stringify(mainConfig));
    f.db.sqlite.prepare(`INSERT INTO registered_bots(bot_id,telegram_id,config_json,credentials,status,owner_id,created_at,updated_at)
      VALUES('main',123456,?,?,'active',7,'now','now')`).run(JSON.stringify(mainConfig), cipher);
    assert.equal((await f.sendUpdate(f.input('hello'), 'main', 'main-secret')).status, 403);
    assert.equal((await f.sendUpdate(f.input('hello'), 'main', 'managed-secret')).status, 200);
    assert.equal(f.delegated.length, 1);
    f.env.BOT_REGISTRY = '[]';
    assert.equal((await f.sendUpdate(f.input('hello'), 'main', 'managed-secret')).status, 200,
      'managed LIC remains available after removal from wrangler.toml');
    assert.equal(f.delegated.length, 2);
    f.db.sqlite.prepare("UPDATE registered_bots SET status='paused' WHERE bot_id='main'").run();
    assert.equal((await f.sendUpdate(f.input('hello'), 'main', 'managed-secret')).status, 503);
    f.db.sqlite.prepare("DELETE FROM registered_bots WHERE bot_id='main'").run();
    assert.equal((await f.sendUpdate(f.input('hello'), 'main', 'main-secret')).status, 404);
  } finally { f.close(); }
});

test('registration: changing existing webhook requires review again and lost setWebhook response is safely resumed', async () => {
  const f = fixture(); try {
    f.hooks.set(NEW, 'https://old.example/secret-path');
    await prepare(f);
    assert.ok(f.calls.at(-1).body.text.includes('old.example'));
    assert.ok(!f.calls.at(-1).body.text.includes('secret-path'));
    f.hooks.set(NEW, 'https://changed.example/other-secret');
    await f.press('connect');
    assert.equal(f.flow().stage, 'confirm');
    assert.equal(f.calls.filter(c => c.token === NEW && c.method === 'setWebhook').length, 0);
    assert.ok(f.calls.at(-1).body.text.includes('changed.example'));
    f.options.failSet = true;
    let earlyResponse;
    f.options.afterSet = async (token, body) => {
      if (token === NEW) earlyResponse = await f.worker.fetch(f.request(f.input('Arrived during setup', 20), 'bot-987654', body.secret_token), f.env, {});
    };
    await f.press('connect');
    assert.equal(earlyResponse.status, 503, 'never discard messages arriving before activation');
    assert.equal(f.flow().stage, 'connecting');
    assert.equal(f.db.sqlite.prepare('SELECT status FROM registered_bots').get().status, 'connecting');
    f.options.failSet = false; f.options.afterSet = null;
    const callback = f.callback('connect');
    assert.equal((await f.sendUpdate(callback)).status, 200);
    await f.sendUpdate(callback);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM registered_bots').get().n, 1);
    assert.equal(f.flow().stage, 'done');
    const hooks = f.calls.filter(c => c.token === NEW && c.method === 'setWebhook');
    assert.equal(hooks.length, 2);
    assert.equal(hooks[0].body.secret_token, hooks[1].body.secret_token);
    assert.ok(hooks.every(c => c.body.drop_pending_updates === false));
  } finally { f.close(); }
});

test('registration: webhook failures identify the step in every language, log no credentials and remain resumable', async () => {
  for (const locale of ['ru', 'en', 'es', 'zh']) for (const method of ['setWebhook', 'getWebhookInfo']) {
    const f = fixture(locale);
    const warnings = [];
    const previousWarn = console.warn;
    try {
      await prepare(f);
      if (method === 'setWebhook') f.options.rejectMethod = method;
      else f.options.afterSet = () => { f.options.rejectMethod = method; };
      console.warn = value => warnings.push(value);
      await f.press('connect');
      assert.equal(f.flow().stage, 'connecting');
      const card = f.calls.filter(c => c.method === 'sendMessage' && c.body.chat_id === 7).at(-1).body;
      assert.ok(card.reply_markup.inline_keyboard.flat().some(b => b.callback_data.includes('br:connect:')));
      assert.doesNotMatch(JSON.stringify(card), /api\.telegram\.org|987654:/);
      if (locale !== 'ru') assert.doesNotMatch(card.text, /[А-Яа-яЁё]/);
      if (locale === 'ru') assert.match(card.text, method === 'setWebhook' ? /установку адреса доставки/ : /получить состояние адреса доставки/);
      assert.deepEqual(warnings.map(value => JSON.parse(value)), [{ event: 'bot_onboarding_telegram_failed',
        method, http_status: 400, error_code: 400, outcome_uncertain: false, retry_after_seconds: null }]);
      f.options.rejectMethod = null; f.options.afterSet = null;
      await f.press('connect');
      assert.equal(f.flow().stage, 'done');
      assert.ok(f.calls.filter(c => c.method === 'setWebhook').every(c => c.body.drop_pending_updates === false));
    } finally { console.warn = previousWarn; f.close(); }
  }
});

test('registration: existing static bot is rejected, repeated dynamic connection preserves IDs, texts and stable webhook secret', async () => {
  const f = fixture(); try {
    await f.text('/addbot'); await f.press('existing'); await f.text(MAIN);
    assert.equal(f.flow().stage, 'token');
    assert.match(f.calls.at(-1).body.text, /уже подключён/);
    await f.text(NEW); await f.press('check'); await f.text('Shop'); await f.text('S'); await f.press('connect');
    const before = f.db.sqlite.prepare('SELECT * FROM registered_bots').get();
    const creds = await openCredentials(f.env, before.bot_id, before.credentials);
    f.db.sqlite.exec("INSERT INTO bot_message_settings(bot_id,welcome_text,auto_reply_text,revision,updated_by,updated_at) VALUES('bot-987654','Hello','Thanks','1',7,'now')");
    await f.press('another');
    await prepare(f); await f.press('connect');
    const after = f.db.sqlite.prepare('SELECT * FROM registered_bots').get();
    assert.equal(after.sequence, before.sequence);
    assert.equal(after.bot_id, before.bot_id);
    assert.equal((await openCredentials(f.env, after.bot_id, after.credentials)).webhookSecret, creds.webhookSecret);
    assert.equal(f.db.sqlite.prepare('SELECT welcome_text FROM bot_message_settings').get().welcome_text, 'Hello');
    assert.ok(!RESET_TABLES.includes('registered_bots'));
  } finally { f.close(); }
});

test('registration: managed creation requires BotFather mode; duplicate creation and token rotation never duplicate a bot', async () => {
  const f = fixture(); try {
    await f.text('/addbot'); f.options.managed = false; await f.press('create');
    assert.equal(f.flow().stage, 'choose'); assert.match(f.calls.at(-1).body.text, /Bot Management Mode/);
    f.options.managed = true; await f.press('create'); assert.equal(f.flow().stage, 'create');
    assert.ok(f.calls.at(-1).body.reply_markup.keyboard[0][0].request_managed_bot);
    const created = { update_id: 200, managed_bot: { user: { id: 7 }, bot: me } };
    await f.sendUpdate(created); await f.sendUpdate(created);
    assert.equal(f.flow().stage, 'group');
    await f.press('check'); await f.text('Shop', 7, 201); await f.text('S', 7, 202); await f.press('connect');
    assert.equal(f.flow().stage, 'done');
    f.options.rotated = true;
    await f.sendUpdate({ ...created, update_id: 300 });
    const row = f.db.sqlite.prepare('SELECT * FROM registered_bots').get();
    assert.equal((await openCredentials(f.env, row.bot_id, row.credentials)).token, NEW2);
    assert.equal(row.manager_bot_id, 'main');
    await f.sendUpdate({ ...created, update_id: 301, managed_bot: { user: { id: 8 }, bot: me } });
    assert.equal(f.db.sqlite.prepare('SELECT status FROM registered_bots').get().status, 'paused');
    await f.sendUpdate({ ...created, update_id: 299 });
    assert.equal(f.db.sqlite.prepare('SELECT managed_update_id FROM registered_bots').get().managed_update_id, 301);
  } finally { f.close(); }
});

test('registration: lease contention is bounded and a broken credential leaves static bots working', async () => {
  const f = fixture(); try {
    await f.text('/addbot');
    f.db.sqlite.prepare('UPDATE bot_registration_flow SET lease_token=?,lease_until=?').run('other', new Date(Date.now()+60000).toISOString());
    assert.equal((await f.press('existing')).status, 503);
    assert.ok(f.db.queries < 8); assert.equal(f.flow().lease_token, 'other');
    f.db.sqlite.exec("UPDATE bot_registration_flow SET lease_until='2000-01-01'");
    assert.equal((await f.press('existing')).status, 200);
    const config = registeredConfig(me, 'Shop', 'S');
    f.db.sqlite.prepare("INSERT INTO registered_bots(bot_id,telegram_id,config_json,credentials,status,owner_id,created_at,updated_at) VALUES(?,?,?,'broken','active',7,'now','now')")
      .run(config.id, me.id, JSON.stringify(config));
    f.db.queries = 0;
    const env = await withBotRegistry(f.env);
    assert.equal(env.MAIN_TOKEN, MAIN); assert.equal(env.DYNAMIC_BOT_STATES[config.id], 'credentials_unavailable');
    assert.equal((await f.text('Normal message', 88)).status, 200);
    assert.equal(f.delegated.length, 1);
    assert.ok(supportCommandList('ru', true, true).some(c => c.command === 'addbot'));
    assert.ok(!supportCommandList('ru', false, true).some(c => c.command === 'addbot'));
  } finally { f.close(); }
});

test('registration: group token paste never reaches a user or a settings draft, and cancelled flow remains private', async () => {
  const f = fixture(); try {
    const update = f.input(NEW);
    update.message.chat = { id: Number(f.env.SUPPORT_GROUP_ID), type: 'supergroup' };
    update.message.message_thread_id = 55;
    await f.sendUpdate(update);
    assert.equal(f.delegated.length, 0);
    assert.ok(f.calls.some(c => c.method === 'deleteMessage' && c.body.message_id === update.message.message_id));
    assert.ok(f.calls.every(c => !JSON.stringify(c.body).includes(NEW)));
    await f.text('/addbot'); await f.press('existing'); await f.text('/cancel');
    assert.equal(f.flow(), undefined);
    await f.text(NEW); assert.equal(f.delegated.length, 0);
    await f.text('Normal question'); assert.equal(f.delegated.length, 1);
  } finally { f.close(); }
});

test('registration: unfinished connection can be closed and resumed with a rotated token without new identity', async () => {
  const f = fixture(); try {
    await prepare(f); f.options.failSet = true; await f.press('connect');
    assert.equal(f.flow().stage, 'connecting');
    const firstRow = f.db.sqlite.prepare('SELECT * FROM registered_bots').get();
    await f.text('/cancel'); assert.equal(f.flow(), undefined);
    await f.text('/addbot'); await f.press('existing'); await f.text(NEW2);
    await f.press('check'); await f.press('defaultname'); await f.press('defaultprefix');
    f.options.failSet = false; await f.press('connect');
    assert.equal(f.flow().stage, 'done');
    const row = f.db.sqlite.prepare('SELECT * FROM registered_bots').get();
    assert.equal(row.sequence, firstRow.sequence);
    assert.equal((await openCredentials(f.env, row.bot_id, row.credentials)).token, NEW2);
    assert.equal(row.status, 'active');
  } finally { f.close(); }
});

test('registration: managed token rotation refreshes unfinished credentials and exposes the created bot to customers', async () => {
  const f = fixture(); try {
    await f.text('/addbot'); await f.press('create');
    await f.sendUpdate({ update_id: 120, managed_bot: { user: { id: 7 }, bot: me } });
    await f.press('check'); await f.text('Shop', 7, 121); await f.text('S', 7, 122);
    f.options.failSet = true; await f.press('connect');
    assert.equal(f.flow().stage, 'connecting');
    f.options.rotated = true;
    await f.sendUpdate({ update_id: 150, managed_bot: { user: { id: 7 }, bot: me } });
    const saved = await openCredentials(f.env, 'flow:' + f.flow().nonce, f.flow().credentials);
    assert.equal(saved.token, NEW2);
    f.options.failSet = false; await f.press('connect');
    assert.equal(f.flow().stage, 'done');
    assert.ok(f.calls.some(c => c.method === 'setManagedBotAccessSettings' && c.token === MAIN && c.body.user_id === me.id && c.body.is_access_restricted === false));
    assert.ok(f.calls.some(c => c.method === 'setWebhook' && c.token === NEW2));
  } finally { f.close(); }
});

test('registration: encryption key misconfiguration and reset cannot consume secret input or mark setup complete', async () => {
  const f = fixture(); try {
    f.env.BOT_REGISTRY_KEY = '';
    await f.text('/addbot'); await f.text(NEW);
    assert.equal(f.flow(), undefined); assert.equal(f.delegated.length, 0);
    f.env.BOT_REGISTRY_KEY = 'ab'.repeat(32);
    f.db.sqlite.exec("UPDATE storage_control SET mode='reset', generation=generation+1");
    await f.text('/addbot');
    assert.equal(f.flow(), undefined, 'reset does not create a setup flow');
    assert.equal(f.delegated.at(-1).env.SUPPORT_DB.storageMode, 'reset');
  } finally { f.close(); }
});
