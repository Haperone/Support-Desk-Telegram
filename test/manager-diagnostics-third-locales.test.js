import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { managementBotKey } from '../worker.js';
import { showManagerAudit } from '../manager-audit.js';
import { showManagerDeliveryProblems, showManagerReadiness, showManagerSystemHealth } from '../manager-diagnostics.js';
import { translateManagerScreen } from '../manager-language.js';

const service = { id: 'service-a', username: 'service_a_bot', displayName: 'Service A', topicPrefix: 'A',
  tokenBinding: 'SERVICE_TOKEN', webhookSecretBinding: 'SERVICE_SECRET', enabled: true };
const localeList = ['en', 'ru', 'es', 'zh'];
const russian = /[А-Яа-яЁё]/u;
const leaks = [];

function fixture() {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  const env = { SUPPORT_DB: db, ADMIN_IDS: '7', SUPPORT_GROUP_ID: '-100123', BOT_REGISTRY: JSON.stringify([service]),
    SERVICE_TOKEN: 'service-token', MANAGER_BOT_TOKEN: 'manager-token', PUBLIC_BASE_URL: 'https://support.example' };
  db.sqlite.prepare("INSERT INTO bots(id,display_name,topic_prefix,enabled,created_at) VALUES('service-a','Service A','A',1,'2026-09-30')").run();
  db.sqlite.prepare(`INSERT INTO support_groups(group_id,title,menu_state,created_at,updated_at)
    VALUES(-100123,'Support team','ready','2026-09-30','2026-09-30')`).run();
  db.sqlite.prepare(`INSERT INTO service_group_routes(bot_id,group_id,revision,source,updated_at)
    VALUES('service-a',-100123,1,'wizard','2026-09-30')`).run();
  return { db, env, close: () => db.close() };
}

function outputFor(locale) {
  let output;
  const show = async (text, markup = []) => {
    const rendered = translateManagerScreen(locale, text, markup);
    output = { text: rendered.text, markup: rendered.markup };
    return output;
  };
  return { show, get: () => output };
}

function assertLocalized(output, locale, scenario) {
  if (locale === 'ru') return;
  for (const line of output.text.split('\n'))
    if (russian.test(line)) leaks.push(`${locale}/${scenario} text: ${line}`);
  for (const row of output.markup) for (const button of row)
    if (russian.test(button.text)) leaks.push(`${locale}/${scenario} button: ${button.text}`);
}

function telegramFetch({ healthy }) {
  return async (url, init) => {
    const method = new URL(url).pathname.split('/').at(-1);
    const body = JSON.parse(init.body);
    if (method === 'getMe') return Response.json({ ok: true, result: { id: url.includes('manager-token') ? 300 : 200, is_bot: true } });
    if (method === 'getWebhookInfo') return Response.json({ ok: true, result: {
      url: healthy ? 'https://support.example/tg/service-a' : 'https://other.example/tg/service-a',
      pending_update_count: healthy ? 0 : 2,
    } });
    if (method === 'getChatMember') {
      const result = Number(body.user_id) === 7 ? { status: 'member' }
        : { status: 'administrator', can_manage_topics: healthy, can_pin_messages: healthy };
      return Response.json({ ok: true, result });
    }
    throw new Error(`Unexpected Telegram method ${method}`);
  };
}

test('actual system health, readiness, delivery-problem, and audit screens localize empty and populated states', async () => {
  for (const [localeIndex, locale] of localeList.entries()) {
    const f = fixture();
    try {
    const key = managementBotKey([service], service.id);
    const timestamp = '2026-09-30T10:00:00.000Z';
      const output = outputFor(locale);
      await showManagerSystemHealth(f.env, f.db, 7, null, output.show);
      assertLocalized(output.get(), locale, 'health empty');

      await showManagerDeliveryProblems(f.env, f.db, 7, key, 0, output.show);
      assertLocalized(output.get(), locale, 'delivery problems empty');

      await showManagerReadiness(f.env, f.db, 7, service, true, output.show, telegramFetch({ healthy: false }));
      assertLocalized(output.get(), locale, 'readiness degraded details');

      await showManagerAudit(f.env, f.db, {}, output.show);
      assertLocalized(output.get(), locale, 'audit empty');

      f.db.sqlite.prepare(`INSERT INTO service_checks(nonce,bot_id,owner_id,group_id,stage,expires_at,outbound_at)
        VALUES(?, 'service-a',7,-100123,'done','2099-01-01',?) ON CONFLICT(nonce) DO NOTHING`).run(`check-${locale}`, timestamp);
      f.db.sqlite.prepare(`INSERT INTO message_delivery_attempts(bot_id,direction,source_chat_id,source_message_id,
        user_id,thread_id,target_chat_id,method,started_at,request_started_at,failure_code)
        VALUES('service-a','user_to_support',55,?,55,22,-100123,'copyMessage',?,?,?)`)
        .run(66 + localeIndex, timestamp, timestamp, 'telegram_delivery_outcome_unknown');
      f.db.sqlite.prepare(`INSERT INTO operator_audit(bot_id,user_id,actor_type,operator_id,operator_name,action,result,reason,created_at)
        VALUES('service-a',55,'operator',7,'Morgan','manual_ban','success','Support A',?)`).run(timestamp);

      await showManagerSystemHealth(f.env, f.db, 7, null, output.show);
      assertLocalized(output.get(), locale, 'health populated');
      assert.ok(output.get().text.includes('Service A'), 'authored service name stays intact');

      await showManagerDeliveryProblems(f.env, f.db, 7, key, 0, output.show);
      assertLocalized(output.get(), locale, 'delivery problems populated');
      assert.ok(output.get().text.includes('Service A'), 'authored service name stays intact');

      await showManagerReadiness(f.env, f.db, 7, service, true, output.show, telegramFetch({ healthy: true }));
      assertLocalized(output.get(), locale, 'readiness healthy details');
      assert.ok(output.get().text.includes('Service A'), 'authored service name stays intact');

      await showManagerAudit(f.env, f.db, { details: true }, output.show);
      assertLocalized(output.get(), locale, 'audit populated technical details');
      assert.ok(output.get().text.includes('Morgan'), 'authored operator name stays intact');
      assert.ok(output.get().text.includes('Support A'), 'authored audit reason stays intact');
    } finally { f.close(); }
  }
  assert.deepEqual(leaks, []);
});
