import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { createManagerWorker } from '../manager-bot.js';
import { managementBotKey } from '../worker.js';

test('manager main menus, operator cards, work queues and alert setup render in every locale', async () => {
  const service = { id: 'service-a', username: 'service_a_bot', displayName: 'Service A', topicPrefix: 'A',
    tokenBinding: 'SERVICE_TOKEN', webhookSecretBinding: 'SERVICE_SECRET', enabled: true };
  const key = managementBotKey([service], service.id);
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const db = new SqliteD1(new URL('../migrations/', import.meta.url));
    try {
      const stamp = new Date().toISOString();
      db.sqlite.prepare('INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,?,?)').run(locale, stamp);
      db.sqlite.prepare('INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at) VALUES(8,?,1,7,?,?)').run('Operator Eight', 'Admin Seven', stamp);
      db.sqlite.prepare('INSERT INTO manager_dm_status(operator_id,started_at,available,updated_at,first_name) VALUES(7,?,1,?,?)').run(stamp, stamp, 'Admin Seven');
      db.sqlite.prepare('INSERT INTO manager_dm_status(operator_id,started_at,available,updated_at,first_name) VALUES(8,?,1,?,?)').run(stamp, stamp, 'Operator Eight');
      db.sqlite.prepare("INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at) VALUES('service-a',77,'Customer',-100123,22,'open',?,?)").run(stamp, stamp);
      db.sqlite.prepare("INSERT INTO conversation_work(bot_id,user_id,assigned_to,note,updated_at) VALUES('service-a',77,7,'Author note',?)").run(stamp);
      const older = new Date(Date.now() - 2 * 3600000).toISOString();
      db.sqlite.prepare("UPDATE conversation_work SET notification_cycle=1,cycle_started_at=?,last_inbound_at=? WHERE user_id=77").run(older, older);
      for (const [userId, state] of [[78, 'waiting'], [79, 'snoozed'], [80, 'resolved']]) {
        db.sqlite.prepare("INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at,last_message_at) VALUES('service-a',?,'Other customer',-100123,?,'closed',?,?)").run(userId, userId, stamp, stamp);
        db.sqlite.prepare("INSERT INTO conversation_work(bot_id,user_id,state,assigned_to,note,updated_at,last_inbound_at,last_answer_at,snoozed_until) VALUES('service-a',?,?,8,'Author note',?,?,?,?)")
          .run(userId, state, stamp, older, stamp, state === 'snoozed' ? new Date(Date.now() + 3600000).toISOString() : null);
      }
      db.sqlite.prepare('INSERT INTO support_groups(group_id,title,created_at,updated_at) VALUES(-100123,?,?,?)').run('Support group', stamp, stamp);
      const calls = [];
      const env = { SUPPORT_DB: db, MANAGER_BOT_TOKEN: '100:MANAGER', MANAGER_WEBHOOK_SECRET: 'manager-secret',
        MANAGER_BOT_USERNAME: 'manager_bot', BOT_REGISTRY: JSON.stringify([service]), SERVICE_TOKEN: '200:SERVICE',
        SERVICE_SECRET: 'service-secret', ADMIN_IDS: '7', SUPPORT_GROUP_ID: '-100123',
        ALERT_SETTINGS: { status: async () => ({ generation: 0, mode: 'group', username: 'alert_bot', chatId: -100123, threadId: 42, recipients: [] }) } };
      const worker = createManagerWorker({ async fetch() {}, async scheduled() {} }, async (url, init) => {
        const method = String(url).split('/').at(-1), body = JSON.parse(init.body || '{}');
        calls.push({ method, body });
        let result = true;
        if (method === 'sendMessage') result = { message_id: 900 };
        if (method === 'getMe') result = { id: 100, username: 'manager_bot', is_bot: true };
        if (method === 'getChat') result = { id: -100123, title: 'Support group', type: 'supergroup', is_forum: true };
        if (method === 'getChatMember') result = { status: 'administrator', can_manage_topics: true, can_pin_messages: true };
        if (method === 'getWebhookInfo') result = { url: 'https://example.test/tg/service-a', pending_update_count: 0 };
        return Response.json({ ok: true, result });
      });
      let updateId = 1;
      const untranslated = [];
      const routes = ['mg:home', 'mg:section:urgent', 'mg:section:work', 'mg:section:bots', 'mg:section:control',
        'mg:section:platform', 'mg:queuebots:needs', 'mg:mine', 'mg:all', 'mg:urgent', 'mg:urgentall',
        'mg:metrics', 'mg:drafts', 'mg:operators', 'mg:opprimary', 'mg:opcard:8',
        `mg:service:${key}`, ...[77, 78, 79, 80].map(id => `mg:work:${key}:${id}`), `mg:choose:${key}:p`, `mg:choose:${key}:b`, `mg:timers:${key}`,
        'mg:addbot', 'mg:alert:home', 'mg:alert:private', 'mg:alert:group', 'mg:alert:remove', 'mg:newgrp',
        ...['needs', 'mine', 'waiting', 'today', 'resolved', 'all'].map(filter => `mg:queue:a:${filter}:0`)];
      for (const route of routes) {
        calls.length = 0;
        const response = await worker.fetch(new Request('https://example.test/tg/manager', { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'manager-secret' },
          body: JSON.stringify({ update_id: updateId++, callback_query: { id: `q${updateId}`, from: { id: 7 },
            data: route, message: { message_id: 50, chat: { id: 7, type: 'private' } } } }) }), env, {});
        assert.equal(response.status, 200, `${locale}:${route}`);
        const screen = calls.filter(call => ['sendMessage', 'editMessageText'].includes(call.method)).at(-1)?.body;
        assert.ok(screen, `${locale}:${route} rendered a screen`);
        if (locale !== 'ru') {
          const values = [...screen.text.split('\n'), ...(screen.reply_markup?.inline_keyboard || []).flat().map(button => button.text)]
            .filter(value => /[А-Яа-яЁё]/u.test(value));
          if (values.length) untranslated.push({ locale, route, values });
        }
      }
      assert.equal(untranslated.length, 0, JSON.stringify(untranslated));
    } finally { db.close(); }
  }
});
