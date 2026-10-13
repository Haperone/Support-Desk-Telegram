import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { managementBotKey } from '../src/worker.js';
import { translateManagerScreen } from '../src/manager-language.js';
import { showManagerUserHome, showManagerUserList, showManagerUserSearch, showManagerUserCard,
  handleManagerUserAction, handleManagerUserText } from '../src/manager-user-management.js';

const config = { id: 'service-a', username: 'service_a_bot', displayName: 'Service A', topicPrefix: 'A',
  locale: 'ru', tokenBinding: 'SERVICE_TOKEN', webhookSecretBinding: 'SERVICE_SECRET', enabled: true };

function fixture() {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  const env = { SUPPORT_DB: db, BOT_REGISTRY: JSON.stringify([config]), SERVICE_TOKEN: '200:SERVICE',
    SERVICE_SECRET: 'secret', ADMIN_IDS: '7', SUPPORT_GROUP_ID: '-1001234567890' };
  const key = managementBotKey([config], config.id);
  const actor = { id: 7, first_name: 'Admin' };
  let shown;
  const show = (text, rows = []) => {
    const rendered = translateManagerScreen('ru', text, rows);
    shown = { text: rendered.text, rows: rendered.markup };
    return shown;
  };
  const profile = (userId, identity = 'Alice') => db.sqlite.prepare(`INSERT INTO pending_messages
    (bot_id,user_id,update_id,source_chat_id,source_message_id,source_first_name,created_at)
    VALUES('service-a',?,?,?,?,?,'2026-01-01T00:00:00.000Z')`).run(userId, userId, userId, userId, identity);
  return { db, env, key, actor, show, profile, get shown() { return shown; }, close: () => db.close() };
}

test('manager lists and searches profiles before a conversation topic exists', async () => {
  const f = fixture();
  try {
    f.profile(101, 'Alice');
    f.db.sqlite.prepare(`INSERT INTO banned_users(bot_id,user_id,reason,banned_at)
      VALUES('service-a',101,'spam','2026-01-02T00:00:00.000Z')`).run();
    await showManagerUserHome(f.env, f.db, 7, f.show);
    assert.match(f.shown.text, /Заблокированы: 1/);
    await showManagerUserList(f.env, f.db, 7, 'a', 'b', 0, f.show);
    assert.match(f.shown.text, /Alice.*101/);
    assert.ok(f.shown.rows.flat().some(row => row.callback_data === `mu:card:${f.key}:101`));
    await showManagerUserSearch(f.env, f.db, 7, '@missing', f.show);
    assert.match(f.shown.text, /Профиль не найден/);
    await showManagerUserSearch(f.env, f.db, 7, 'Alice', f.show);
    assert.match(f.shown.text, /Поиск: Alice/);
    assert.ok(f.shown.rows.flat().some(row => row.callback_data === `mu:card:${f.key}:101`));
    assert.ok(f.shown.rows.flat().some(row => row.callback_data === 'mu:search'));
    await showManagerUserCard(f.env, f.db, 7, f.key, 101, f.show);
    assert.match(f.shown.text, /тема ещё не создана/);
    assert.ok(f.shown.rows.flat().some(row => row.callback_data?.startsWith('mu:act:unban:')));
    assert.ok(f.shown.rows.flat().some(row => row.callback_data === `mu:home:${f.key}`));
  } finally { f.close(); }
});

test('search explains the twenty-profile limit so the operator can refine the query', async () => {
  const f = fixture();
  try {
    for (let id = 200; id < 221; id++) f.profile(id, 'Shared name');
    await showManagerUserSearch(f.env, f.db, 7, 'Shared', f.show);
    assert.match(f.shown.text, /Поиск: Shared/);
    assert.match(f.shown.text, /Найдено профилей: 20\+/);
    assert.match(f.shown.text, /Показаны первые 20/);
    assert.equal(f.shown.rows.filter(row => row[0]?.callback_data?.startsWith('mu:card:')).length, 20);
  } finally { f.close(); }
});

test('all-services list identifies each service and displays username when stored name is a dash', async () => {
  const f = fixture();
  try {
    const other = { ...config, id: 'service-b', username: 'service_b_bot', displayName: 'Service B',
      tokenBinding: 'SERVICE_B_TOKEN', webhookSecretBinding: 'SERVICE_B_SECRET' };
    f.env.BOT_REGISTRY = JSON.stringify([config, other]);
    f.profile(101, '-');
    f.db.sqlite.prepare("UPDATE pending_messages SET source_username='example_customer' WHERE user_id=101").run();
    f.db.sqlite.prepare(`INSERT INTO pending_messages
      (bot_id,user_id,update_id,source_chat_id,source_message_id,source_first_name,created_at)
      VALUES('service-b',101,102,101,2,'-', '2026-01-01T00:00:00Z')`).run();
    await showManagerUserList(f.env, f.db, 7, 'a', 'x', 0, f.show);
    assert.match(f.shown.text, /Найдено профилей: 2/);
    assert.match(f.shown.text, /Один пользователь может иметь профиль в нескольких сервисах/);
    assert.match(f.shown.text, /@example_customer · Service A · 101/);
    assert.match(f.shown.text, /101 · Service B/);
    assert.doesNotMatch(f.shown.text, /\n- ·/);
    await showManagerUserCard(f.env, f.db, 7, f.key, 101, f.show);
    assert.match(f.shown.text, /^@example_customer · Service A/);
  } finally { f.close(); }
});

test('paused service keeps user profiles and history readable without moderation controls', async () => {
  const f = fixture();
  try {
    f.profile(108, 'Paused client');
    f.env.BOT_REGISTRY = JSON.stringify([{ ...config, enabled: false }]);
    f.db.sqlite.prepare(`INSERT INTO operator_audit(bot_id,user_id,actor_type,operator_id,operator_name,action,result,created_at)
      VALUES('service-a',108,'operator',7,'Admin','manual_ban','success','2026-01-01T00:00:00Z')`).run();
    await showManagerUserHome(f.env, f.db, 7, f.show);
    assert.ok(f.shown.rows.flat().some(item => item.text?.includes('⏸ Service A')));
    await showManagerUserList(f.env, f.db, 7, f.key, 'x', 0, f.show);
    assert.match(f.shown.text, /Paused client/);
    await showManagerUserCard(f.env, f.db, 7, f.key, 108, f.show);
    assert.match(f.shown.text, /сервис приостановлен \(только просмотр\)/);
    assert.ok(f.shown.rows.flat().some(item => item.callback_data?.startsWith('mu:audit:')));
    assert.ok(!f.shown.rows.flat().some(item => item.callback_data?.startsWith('mu:act:')));
    await handleManagerUserAction(f.env, f.db, f.actor, `mu:audit:${f.key}:108:0`, f.show);
    assert.match(f.shown.text, /Пользователь заблокирован/);
  } finally { f.close(); }
});

test('profile, counters and suspicious filter agree on decayed risk without altering stored abuse state', async () => {
  const f = fixture();
  try {
    f.profile(109, 'Risk client');
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    f.db.sqlite.prepare(`INSERT INTO user_abuse_state(bot_id,user_id,risk_score,last_risk_at,created_at,updated_at)
      VALUES('service-a',109,5,?,?,?)`).run(old, old, old);
    await showManagerUserCard(f.env, f.db, 7, f.key, 109, f.show);
    assert.match(f.shown.text, /Риск сейчас: 1/);
    assert.match(f.shown.text, /Состояние: обычный/);
    await showManagerUserHome(f.env, f.db, 7, f.show);
    assert.match(f.shown.text, /подозрительные: 0/);
    await showManagerUserList(f.env, f.db, 7, f.key, 's', 0, f.show);
    assert.match(f.shown.text, /Найдено профилей: 0/);
    assert.equal(f.db.sqlite.prepare("SELECT risk_score FROM user_abuse_state WHERE bot_id='service-a' AND user_id=109").get().risk_score, 5);
  } finally { f.close(); }
});

test('user list identifies the service and card shows simultaneous access restrictions', async () => {
  const f = fixture();
  try {
    f.profile(104, 'Alice');
    f.db.sqlite.prepare(`INSERT INTO banned_users(bot_id,user_id,reason,banned_at)
      VALUES('service-a',104,'spam','2026-01-02T00:00:00.000Z')`).run();
    f.db.sqlite.prepare(`INSERT INTO user_abuse_state(bot_id,user_id,muted_until,manual_restricted_until,
      verification_required,created_at,updated_at)
      VALUES('service-a',104,'2099-01-01T00:00:00Z','2099-02-01T00:00:00Z',1,'now','now')`).run();
    await showManagerUserList(f.env, f.db, 7, 'a', 'b', 0, f.show);
    assert.match(f.shown.text, /Alice · Service A · 104\n  без username · заблокирован · обращение: нет темы/);
    assert.match(f.shown.text, /без username/);
    await showManagerUserCard(f.env, f.db, 7, f.key, 104, f.show);
    assert.match(f.shown.text, /Блокировка оператором/);
    assert.match(f.shown.text, /Ручное ограничение до/);
    assert.match(f.shown.text, /Автоограничение до/);
    assert.match(f.shown.text, /Требуется CAPTCHA/);
  } finally { f.close(); }
});

test('manager moderation requires matching profile state, reason and explicit confirmation', async () => {
  const f = fixture();
  try {
    f.profile(102);
    await showManagerUserCard(f.env, f.db, 7, f.key, 102, f.show);
    const ban = f.shown.rows.flat().find(row => row.callback_data?.startsWith('mu:act:ban:')).callback_data;
    await handleManagerUserAction(f.env, f.db, f.actor, ban, f.show);
    assert.match(f.shown.text, /причину блокировки/);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM banned_users').get().n, 0);
    assert.equal(await handleManagerUserText(f.env, f.db, f.actor, 'x', f.show), true);
    assert.match(f.shown.text, /от 3 до 500/);
    await handleManagerUserText(f.env, f.db, f.actor, 'Повторный спам', f.show);
    const confirm = f.shown.rows.flat().find(row => row.callback_data?.startsWith('mu:confirm:')).callback_data;
    assert.match(f.shown.text, /Недоставленные сообщения будут удалены/);
    const pending = f.db.sqlite.prepare('SELECT stage,reason FROM operator_pending_actions WHERE operator_id=7').get();
    assert.equal(pending.stage, 'confirm');
    assert.equal(pending.reason, 'Повторный спам');
    await handleManagerUserAction(f.env, f.db, f.actor, confirm.replace('mu:confirm:', 'mu:cancel:'), f.show);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM banned_users').get().n, 0);
    await handleManagerUserAction(f.env, f.db, f.actor, confirm, f.show);
    assert.match(f.shown.text, /устарело/);
  } finally { f.close(); }
});

test('confirmation lets an operator revise the reason before applying moderation', async () => {
  const f = fixture();
  try {
    f.profile(105);
    await showManagerUserCard(f.env, f.db, 7, f.key, 105, f.show);
    const ban = f.shown.rows.flat().find(row => row.callback_data?.startsWith('mu:act:ban:')).callback_data;
    await handleManagerUserAction(f.env, f.db, f.actor, ban, f.show);
    await handleManagerUserText(f.env, f.db, f.actor, 'Первая причина', f.show);
    const revise = f.shown.rows.flat().find(row => row.callback_data?.startsWith('mu:revise:')).callback_data;
    await handleManagerUserAction(f.env, f.db, f.actor, revise, f.show);
    assert.match(f.shown.text, /новую внутреннюю причину/);
    await handleManagerUserText(f.env, f.db, f.actor, 'Уточнённая причина', f.show);
    assert.equal(f.db.sqlite.prepare('SELECT reason FROM operator_pending_actions WHERE operator_id=7').get().reason,
      'Уточнённая причина');
  } finally { f.close(); }
});

test('restriction offers quick durations and a custom duration before the reason', async () => {
  const f = fixture();
  try {
    f.profile(106);
    await showManagerUserCard(f.env, f.db, 7, f.key, 106, f.show);
    const choose = f.shown.rows.flat().find(row => row.callback_data?.startsWith('mu:restrict:')).callback_data;
    await handleManagerUserAction(f.env, f.db, f.actor, choose, f.show);
    const quick = f.shown.rows.flat().find(row => row.text === '15 минут').callback_data;
    assert.ok(f.shown.rows.flat().some(row => row.text === 'Другой срок'));
    await handleManagerUserAction(f.env, f.db, f.actor, quick, f.show);
    assert.match(f.shown.text, /внутреннюю причину/);
    assert.deepEqual({ ...f.db.sqlite.prepare('SELECT stage,duration_seconds FROM operator_pending_actions WHERE operator_id=7').get() },
      { stage: 'reason', duration_seconds: 900 });
  } finally { f.close(); }
});

test('risk reset confirmation states its effects before the operator applies it', async () => {
  const f = fixture();
  try {
    f.profile(107);
    await showManagerUserCard(f.env, f.db, 7, f.key, 107, f.show);
    const reset = f.shown.rows.flat().find(row => row.callback_data?.startsWith('mu:act:riskreset:')).callback_data;
    await handleManagerUserAction(f.env, f.db, f.actor, reset, f.show);
    assert.match(f.shown.text, /Риск станет 0, автомьют и CAPTCHA будут сняты/);
    assert.ok(f.shown.rows.flat().some(row => row.callback_data?.startsWith('mu:confirm:')));
  } finally { f.close(); }
});

test('confirmed unblock uses the existing fenced service moderation path', async () => {
  const f = fixture();
  try {
    f.profile(103);
    f.db.sqlite.prepare(`INSERT INTO banned_users(bot_id,user_id,reason,banned_at)
      VALUES('service-a',103,'spam','2026-01-02T00:00:00.000Z')`).run();
    await showManagerUserCard(f.env, f.db, 7, f.key, 103, f.show);
    const action = f.shown.rows.flat().find(row => row.callback_data?.startsWith('mu:act:unban:')).callback_data;
    await handleManagerUserAction(f.env, f.db, f.actor, action, f.show);
    const confirm = f.shown.rows.flat().find(row => row.callback_data?.startsWith('mu:confirm:')).callback_data;
    const pending = f.db.sqlite.prepare('SELECT stage,management_bot_id,flow_nonce FROM operator_pending_actions WHERE operator_id=7').get();
    assert.equal(pending.stage, 'confirm', JSON.stringify(pending));
    assert.equal(pending.management_bot_id, '__manager__', JSON.stringify(pending));
    assert.equal(confirm, `mu:confirm:${pending.flow_nonce}`);
    await handleManagerUserAction(f.env, f.db, f.actor, confirm, f.show);
    const after = f.db.sqlite.prepare('SELECT stage,flow_nonce FROM operator_pending_actions WHERE operator_id=7').get();
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM banned_users WHERE user_id=103').get().n, 0, `${f.shown.text} ${JSON.stringify(after)}`);
    assert.match(f.shown.text, /разблокирован/);
  } finally { f.close(); }
});
