import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { showManagerDeliveryDiagnostics, showManagerDeliveryProblems, showManagerHelp, showManagerSystemHealth } from '../manager-diagnostics.js';
import { managementBotKey } from '../worker.js';
import { translateManagerScreen } from '../manager-language.js';

const service = { id: 'service-a', username: 'service_a_bot', displayName: 'Service A', topicPrefix: 'A',
  tokenBinding: 'SERVICE_TOKEN', webhookSecretBinding: 'SERVICE_SECRET', enabled: true };
function fixture() {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  const env = { SUPPORT_DB: db, ADMIN_IDS: '7', SUPPORT_GROUP_ID: '-100123', BOT_REGISTRY: JSON.stringify([service]) };
  db.sqlite.prepare("INSERT INTO bots(id,display_name,topic_prefix,enabled,created_at) VALUES('service-a','Service A','A',1,'now')").run();
  db.sqlite.prepare(`INSERT INTO support_groups(group_id,title,menu_state,created_at,updated_at)
    VALUES(-100123,'Support','ready','now','now')`).run();
  db.sqlite.prepare(`INSERT INTO service_group_routes(bot_id,group_id,revision,source,updated_at)
    VALUES('service-a',-100123,1,'wizard','now')`).run();
  return { db, env, close: () => db.close() };
}
const capture = () => { let result; return { show: async (text, rows) => {
  const rendered = translateManagerScreen('ru', text, rows);
  result = { text: rendered.text, rows: rendered.markup };
  return result;
}, get: () => result }; };

test('manager help offers private diagnostics entry points with bounded content', async () => {
  const f = fixture();
  try {
    const output = capture();
    await showManagerHelp(f.env, f.db, 7, output.show);
    assert.match(output.get().text, /Справка Админушки/);
    assert.ok(output.get().rows.flat().some(item => item.callback_data === 'mg:health'));
    assert.ok(output.get().rows.flat().some(item => item.callback_data === 'mg:help:delivery'));
    assert.ok(output.get().text.length < 4096);
    await showManagerHelp(f.env, f.db, 7, output.show, 'delivery');
    assert.match(output.get().text, /неясном исходе/);
    await showManagerHelp(f.env, f.db, 7, output.show, 'commands');
    assert.match(output.get().text, /\/alerts и \/addbot/);
    await showManagerHelp(f.env, f.db, 8, output.show, 'commands');
    assert.doesNotMatch(output.get().text, /\/addbot/);
    await showManagerHelp(f.env, f.db, 8, output.show, 'drafts');
    assert.match(output.get().text, /следующим обычным сообщением/);
  } finally { f.close(); }
});

test('system health reports configured service route and latest delivery backlog boundedly', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO service_checks(nonce,bot_id,owner_id,group_id,stage,expires_at)
      VALUES('check','service-a',7,-100123,'done','2099-01-01')`).run();
    f.db.sqlite.prepare(`INSERT INTO message_delivery_attempts(bot_id,direction,source_chat_id,source_message_id,
      user_id,thread_id,target_chat_id,method,started_at,request_started_at,failure_code)
      VALUES('service-a','user_to_support',55,66,55,22,-100123,'copyMessage','now','now','telegram_delivery_outcome_unknown')`).run();
    const output = capture();
    await showManagerSystemHealth(f.env, f.db, 7, null, output.show);
    assert.match(output.get().text, /Service A/);
    assert.match(output.get().text, /меню готово/);
    assert.match(output.get().text, /проверка: done/);
    assert.match(output.get().text, /Неясный исход: 1/);
    assert.ok(output.get().text.length < 4096);
  } finally { f.close(); }
});

test('system health can page through every connected service', async () => {
  const f = fixture();
  try {
    f.env.BOT_REGISTRY = JSON.stringify(Array.from({ length: 14 }, (_, index) => ({ ...service,
      id: `service-${index}`, username: `service_${index}_bot`, displayName: `Service ${index}`,
      tokenBinding: `TOKEN_${index}`, webhookSecretBinding: `SECRET_${index}` })));
    const output = capture();
    await showManagerSystemHealth(f.env, f.db, 7, null, output.show);
    assert.match(output.get().text, /страница 1\/2/);
    assert.ok(output.get().rows.flat().some(item => item.callback_data === 'mg:healthpage:1'));
    await showManagerSystemHealth(f.env, f.db, 7, null, output.show, 1);
    assert.match(output.get().text, /Service 12/);
    assert.match(output.get().text, /Service 13/);
    assert.ok(output.get().rows.flat().some(item => item.callback_data === 'mg:healthpage:0'));
  } finally { f.close(); }
});

test('paused service remains visible in health and delivery diagnostics', async () => {
  const f = fixture();
  try {
    const paused = { ...service, enabled: false };
    f.env.BOT_REGISTRY = JSON.stringify([paused]);
    f.db.sqlite.prepare("UPDATE bots SET enabled=0 WHERE id='service-a'").run();
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,support_group_id,thread_id,status,created_at)
      VALUES('service-a',55,'Waiting client',-100123,22,'open','now')`).run();
    f.db.sqlite.prepare(`INSERT INTO pending_messages(bot_id,user_id,update_id,source_chat_id,source_message_id,source_first_name,created_at)
      VALUES('service-a',55,55,55,1,'Waiting client','now')`).run();
    const output = capture(), key = managementBotKey([paused], paused.id);
    await showManagerSystemHealth(f.env, f.db, 7, null, output.show);
    assert.match(output.get().text, /Service A · выключен/);
    await showManagerDeliveryProblems(f.env, f.db, 7, key, 0, output.show);
    assert.match(output.get().text, /бот выключен/);
    assert.ok(output.get().rows.flat().some(item => item.callback_data?.startsWith(`mg:diag:${key}:55:`)));
    await showManagerDeliveryDiagnostics(f.env, f.db, 7, paused, 55, 0, output.show);
    assert.match(output.get().text, /Waiting client/);
  } finally { f.close(); }
});

test('per-user diagnostics show conversation, uncertain delivery, and a bounded Telegram topic link', async () => {
  const f = fixture();
  try {
    f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,username,first_name,last_name,support_group_id,
      thread_id,status,created_at,last_message_at) VALUES('service-a',55,'alice','Alice','A',-100123,22,'open','now','now')`).run();
    f.db.sqlite.prepare(`INSERT INTO operator_audit(bot_id,user_id,actor_type,operator_id,action,result,created_at)
      VALUES('service-a',55,'operator',7,'take','success','now')`).run();
    f.db.sqlite.prepare(`INSERT INTO message_delivery_attempts(bot_id,direction,source_chat_id,source_message_id,
      user_id,thread_id,target_chat_id,method,started_at,request_started_at,failure_code)
      VALUES('service-a','user_to_support',55,66,55,22,-100123,'copyMessage','now','now','telegram_delivery_outcome_unknown')`).run();
    const output = capture();
    await showManagerDeliveryDiagnostics(f.env, f.db, 7, service, 55, 0, output.show);
    assert.match(output.get().text, /Alice A/);
    assert.match(output.get().text, /исход неясен/);
    assert.match(output.get().text, /take/);
    assert.equal(output.get().rows[0][0].url, 'https://t.me/c/123/22');
    assert.ok(output.get().text.length < 4096);
  } finally { f.close(); }
});

test('help and per-user diagnostics allow an already-authorized operator; system health stays primary-only', async () => {
  const f = fixture();
  try {
    await showManagerHelp(f.env, f.db, 8, async () => {});
    await showManagerDeliveryDiagnostics(f.env, f.db, 8, service, 55, 0, async () => {});
    await assert.rejects(showManagerSystemHealth(f.env, f.db, 8, null, async () => {}), /primary administrator/);
    await assert.rejects(showManagerSystemHealth(f.env, f.db, 7, { id: 'unknown' }, async () => {}), /not in the manager registry/);
  } finally { f.close(); }
});
