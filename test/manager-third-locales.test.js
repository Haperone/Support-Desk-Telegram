import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { createManagerWorker } from '../src/manager-bot.js';
import { managementBotKey } from '../src/worker.js';
import { handleManagerServiceSettings } from '../src/manager-service-settings.js';
import { showManagerServiceInspection, handleManagerPlan } from '../src/manager-service-settings.js';
import { translateManagerScreen } from '../src/manager-language.js';

const service = { id: 'service-a', username: 'service_a_bot', displayName: 'Service A', topicPrefix: 'A',
  tokenBinding: 'SERVICE_TOKEN', webhookSecretBinding: 'SERVICE_SECRET', enabled: true };

function fixture() {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  const env = { SUPPORT_DB: db, MANAGER_BOT_TOKEN: '100:MANAGER', MANAGER_WEBHOOK_SECRET: 'manager-secret',
    MANAGER_BOT_USERNAME: 'manager_bot', BOT_REGISTRY: JSON.stringify([service]), SERVICE_TOKEN: '200:SERVICE',
    SERVICE_SECRET: 'service-secret', ADMIN_IDS: '7', SUPPORT_GROUP_ID: '-100123' };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = String(url).split('/').at(-1), body = JSON.parse(init.body || '{}');
    calls.push({ method, body });
    if (method === 'getMe') return Response.json({ ok: true, result: { id: 200, username: 'service_a_bot', is_bot: true } });
    return Response.json({ ok: true, result: method === 'sendMessage' ? { message_id: 1 } : true });
  };
  const worker = createManagerWorker({ async fetch() { return new Response('base'); }, async scheduled() {} }, fetchImpl);
  let updateId = 1;
  const send = async update => worker.fetch(new Request('https://example.test/tg/manager', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': env.MANAGER_WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: updateId++, ...update }) }), env, {});
  const press = (data, actor = 7) => send({ callback_query: { id: `q${updateId}`, from: { id: actor },
    message: { message_id: 50, chat: { id: actor, type: 'private' } }, data } });
  return { db, env, calls, send, press, close: () => db.close() };
}

test('permanent manager errors are localized in the operator language at the raw webhook send sink', async () => {
  const expected = {
    en: 'Alert management has not yet been deployed to the monitor.',
    ru: 'Управление алертами ещё не опубликовано в мониторе.',
    es: 'La gestión de alertas aún no se ha publicado en el monitor.',
    zh: '警报管理尚未部署到监控服务。',
  };
  for (const locale of Object.keys(expected)) {
    const f = fixture();
    try {
      f.db.sqlite.prepare('INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,?,?)')
        .run(locale, new Date().toISOString());
      await f.press('mg:alert:home');
      const notice = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1);
      assert.equal(notice.body.text, expected[locale]);
    } finally { f.close(); }
  }
});

test('permanent service setup rejection uses the same four-locale webhook error path', async () => {
  const expected = {
    en: 'Connect the service group first.',
    ru: 'Сначала подключите группу сервиса.',
    es: 'Primero conecte el grupo del servicio.',
    zh: '请先连接服务群组。',
  };
  const key = managementBotKey([service], service.id);
  for (const locale of Object.keys(expected)) {
    const f = fixture();
    try {
      f.env.SUPPORT_GROUP_ID = '';
      f.db.sqlite.prepare('INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,?,?)')
        .run(locale, new Date().toISOString());
      await f.press(`mg:test:${key}`);
      const notice = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1);
      assert.ok(notice, JSON.stringify(f.calls));
      assert.equal(notice.body.text, expected[locale]);
    } finally { f.close(); }
  }
});

test('topic delivery status header and refresh button localize through the real negative-chat call path', async () => {
  const expected = {
    en: ['Delivery status for message #81', 'Refresh status'],
    ru: ['Статус доставки сообщения #81', 'Обновить статус'],
    es: ['Estado de entrega del mensaje #81', 'Actualizar estado'],
    zh: ['消息 #81 的投递状态', '刷新状态'],
  };
  for (const [locale, phrases] of Object.entries(expected)) {
    const f = fixture();
    try {
      f.db.sqlite.prepare('INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,?,?)')
        .run(locale, new Date().toISOString());
      f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,status,created_at)
        VALUES('service-a',77,-100123,22,'open',?)`).run(new Date().toISOString());
      f.db.sqlite.prepare(`INSERT INTO manager_dm_status(operator_id,started_at,available,updated_at)
        VALUES(7,?,1,?)`).run(new Date().toISOString(), new Date().toISOString());
      await f.send({ message: { message_id: 82, from: { id: 7 }, chat: { id: -100123, type: 'supergroup' },
        message_thread_id: 22, text: '/status', reply_to_message: { message_id: 81 } } });
      const card = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === -100123).at(-1);
      assert.ok(card, `${locale}: no delivery status was sent`);
      assert.ok(card.body.text.includes(phrases[0]), `${locale}: ${card.body.text}`);
      assert.equal(card.body.reply_markup.inline_keyboard[0][0].text, phrases[1]);
      assert.equal(card.body.reply_markup.inline_keyboard[0][0].callback_data, 'ds:81');
    } finally { f.close(); }
  }
});

test('multiline transfer notes remain authored text when they contain catalog labels', async () => {
  const note = 'First line\nПользователи\nFinal line';
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const f = fixture();
    try {
      f.db.sqlite.prepare('INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,?,?)')
        .run(locale, new Date().toISOString());
      f.db.sqlite.prepare(`INSERT INTO manager_work_flows
        (operator_id,bot_id,user_id,expected_revision,target_id,stage,nonce,expires_at,updated_at)
        VALUES(7,'service-a',77,0,8,'note','transfer-note',?,'now')`)
        .run(new Date(Date.now() + 600000).toISOString());
      await f.send({ message: { message_id: 1, from: { id: 7 }, chat: { id: 7, type: 'private' }, text: note } });
      const screen = f.calls.filter(call => call.method === 'sendMessage' && call.body.chat_id === 7).at(-1);
      assert.ok(screen.body.text.includes(note), `${locale}: ${screen.body.text}`);
      assert.equal(f.db.sqlite.prepare('SELECT note FROM manager_work_flows WHERE operator_id=7').get().note, note);
    } finally { f.close(); }
  }
});

test('empty welcome and automatic reply previews show localized fallback text', async () => {
  const expected = {
    en: 'No text has been set.',
    ru: 'Текст пока не задан.',
    es: 'Aún no se ha definido el texto.',
    zh: '尚未设置文本。',
  };
  const key = managementBotKey([service], service.id);
  for (const locale of Object.keys(expected)) {
    const f = fixture();
    try {
      const config = { ...service, locale: 'ru' };
      f.env.BOT_REGISTRY = JSON.stringify([config]);
      for (const field of ['w', 'a']) {
        let screen;
        await handleManagerServiceSettings(f.env, f.db, 7, ['msg', key, field, 'view'], (text, markup) => {
          const rendered = translateManagerScreen(locale, text, markup);
          screen = { text: rendered.text, markup: rendered.markup };
        });
        assert.ok(screen.text.includes(expected[locale]), `${locale}/${field}: ${screen.text}`);
      }
    } finally { f.close(); }
  }
});

test('missing manager and service usernames use translated, non-handle fallback labels in group setup', async () => {
  const expected = {
    en: ['manager bot', 'service bot'],
    ru: ['управляющего бота', 'бота сервиса'],
    es: ['bot administrador', 'bot de soporte'],
    zh: ['管理机器人', '服务机器人'],
  };
  const key = managementBotKey([service], service.id);
  for (const [locale, phrases] of Object.entries(expected)) {
    const f = fixture();
    try {
      f.env.MANAGER_BOT_USERNAME = '';
      f.env.BOT_REGISTRY = JSON.stringify([{ ...service, username: '' }]);
      f.db.sqlite.prepare('INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,?,?)')
        .run(locale, new Date().toISOString());
      await f.press(`mg:begin:${key}`);
      const screen = f.calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === 7).at(-1);
      assert.ok(screen, `${locale}: no group setup screen`);
      for (const phrase of phrases) assert.ok(screen.body.text.includes(phrase), `${locale}: ${screen.body.text}`);
      assert.doesNotMatch(screen.body.text, /@(?:manager bot|bot administrador|管理机器人|управляющего бота|бота сервиса)/u);
    } finally { f.close(); }
  }
});

test('missing service username uses a localized fallback in the manager service card', async () => {
  const expected = { en: 'not specified', ru: 'не указан', es: 'no especificado', zh: '未指定' };
  const key = managementBotKey([service], service.id);
  for (const [locale, phrase] of Object.entries(expected)) {
    const f = fixture();
    try {
      f.env.BOT_REGISTRY = JSON.stringify([{ ...service, username: '' }]);
      f.db.sqlite.prepare('INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,?,?)')
        .run(locale, new Date().toISOString());
      await f.press(`mg:service:${key}`);
      const screen = f.calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === 7).at(-1);
      assert.ok(screen, `${locale}: no service screen`);
      assert.ok(screen.body.text.includes(phrase), `${locale}: ${screen.body.text}`);
      assert.doesNotMatch(screen.body.text, /@(?:не указан|not specified|no especificado|未指定)/u);
    } finally { f.close(); }
  }
});

test('real service settings, style, reactions, attack, and plan screens translate all built-in scaffold in four locales', async () => {
  const key = managementBotKey([service], service.id);
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const f = fixture();
    try {
      f.env.BOT_REGISTRY = JSON.stringify([{ ...service, topicPrefix: 'Topic A', locale,
        antispamEnabled: true, verificationMode: 'managed', burstLimit: 4, minuteLimit: 20,
        absoluteLimit: 50, riskTurnstileThreshold: 5, riskMuteThreshold: 8 }]);
      f.db.sqlite.prepare('INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,?,?)')
        .run(locale, new Date().toISOString());
      for (const action of ['settings', 'msgs', 'msg', 'rx', 'rxset', 'style', 'stylecolors', 'styleicons', 'attack', 'attackconfirm']) {
        let rendered;
        await handleManagerServiceSettings(f.env, f.db, 7,
          action === 'msg' ? [action, key, 'w', 'view'] : action === 'rxset'
            ? [action, key, '0', 'on'] : [action, key, '0'],
          (text, markup) => { rendered = translateManagerScreen(locale, text, markup); },
          async (url, init) => {
            const method = String(url).split('/').at(-1);
            return Response.json({ ok: true, result: method === 'getForumTopicIconStickers'
              ? [{ custom_emoji_id: '123456789', emoji: '✨' }] : true });
          });
        assert.ok(rendered?.text, `${locale}/${action}: no text rendered`);
        if (locale !== 'ru') assert.doesNotMatch(rendered.text, /[\u0400-\u04ff]/u, `${locale}/${action}: ${rendered.text}`);
        if (action === 'style') {
          assert.match(rendered.text, /Topic A/u);
          if (locale === 'en') assert.match(rendered.text, /Example: 💬 Topic A · Anna \(42\)/u);
        }
        if (action === 'msg') assert.match(rendered.text, ({ en: /No text has been set\./u,
          ru: /Текст пока не задан\./u, es: /Aún no se ha definido el texto\./u, zh: /尚未设置文本/u })[locale]);
        if (rendered.markup?.inline_keyboard) for (const row of rendered.markup.inline_keyboard)
          for (const item of row) if (item.text && locale !== 'ru') assert.doesNotMatch(item.text, /[\u0400-\u04ff]/u, `${locale}/${action} button: ${item.text}`);
      }
      for (const kind of ['rx', 'attack']) {
        let rendered;
        await showManagerServiceInspection(f.env, f.db, key, kind,
          (text, markup) => { rendered = translateManagerScreen(locale, text, markup); });
        assert.ok(rendered?.text, `${locale}/inspection-${kind}: no text`);
        if (locale !== 'ru') assert.doesNotMatch(rendered.text, /[\u0400-\u04ff]/u, `${locale}/inspection-${kind}: ${rendered.text}`);
      }
      let plan;
      await handleManagerPlan(f.env, f.db, 7, ['home'], (text, markup) => { plan = translateManagerScreen(locale, text, markup); });
      if (locale !== 'ru') assert.doesNotMatch(plan.text, /[\u0400-\u04ff]/u, `${locale}/plan: ${plan.text}`);
    } finally { f.close(); }
  }
});

test('paused service settings stay read-only and keep authored message contents intact', async () => {
  const key = managementBotKey([service], service.id);
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const f = fixture();
    try {
      f.env.BOT_REGISTRY = JSON.stringify([{ ...service, enabled: false, topicPrefix: 'Topic A', locale }]);
      f.db.sqlite.prepare('INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,?,?)')
        .run(locale, new Date().toISOString());
      f.db.sqlite.prepare(`INSERT INTO bot_message_settings(bot_id,welcome_text,auto_reply_text,revision,updated_by,updated_at)
        VALUES('service-a','My authored message: Приветствие: keep intact','Authored reply', 'rev1',7,?)`)
        .run(new Date().toISOString());
      for (const action of ['settings', 'msgs', 'msg', 'rx', 'style', 'attack']) {
        let rendered;
        await handleManagerServiceSettings(f.env, f.db, 7,
          action === 'msg' ? [action, key, 'w', 'view'] : [action, key, '0'],
          (text, markup) => { rendered = translateManagerScreen(locale, text, markup); });
        assert.ok(rendered?.text, `${locale}/${action}: no screen`);
        if (action === 'msg') assert.ok(rendered.text.includes('My authored message: Приветствие: keep intact'), `${locale}: ${rendered.text}`);
        if (action === 'settings' || action === 'msgs' || action === 'rx' || action === 'style' || action === 'attack') {
          if (rendered.markup?.inline_keyboard) for (const row of rendered.markup.inline_keyboard) for (const item of row)
            assert.ok(!/^mg:(?:msg:.*:(?:edit|clear|restore|on|off)|copymsg:|rxtest:|stylecolors:|styleicons:|stylereset:|attackset:|attackconfirm:)/u.test(item.callback_data || ''),
              `${locale}/${action}: mutating button ${item.callback_data}`);
        }
        if (locale !== 'ru') {
          const scaffold = action === 'msg' ? rendered.text.replace('My authored message: Приветствие: keep intact', '') : rendered.text;
          assert.doesNotMatch(scaffold, /[\u0400-\u04ff]/u, `${locale}/${action}: ${rendered.text}`);
        }
      }
    } finally { f.close(); }
  }
});
