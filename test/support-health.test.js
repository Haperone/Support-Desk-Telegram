import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { supportHealthSnapshot, recordOperationalSignal } from '../support-health.js';
import { resolveInvocationDatabase } from '../recovery-budget.js';
const now = new Date('2026-09-09T12:00:00.000Z');
const old = '2026-09-09T11:00:00.000Z';
const environment = (db) => ({ SUPPORT_DB: db, SUPPORT_GROUP_ID: '-100', BOT_REGISTRY: JSON.stringify([{ id: 'bot', tokenBinding: 'TOKEN', enabled: true }]), TOKEN: '123:secret', PUBLIC_BASE_URL: 'https://support.test' });

test('health distinguishes uncertain work, intentionally blocked users and broken Telegram ingress', async () => {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  try {
    db.sqlite.prepare(`INSERT INTO message_delivery_attempts(bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at,request_started_at)
      VALUES ('bot','user_to_support',1,1,1,51,-100,'forwardMessage',?,?)`).run(old, old);
    db.sqlite.prepare(`INSERT INTO user_abuse_state(bot_id,user_id,verification_required,created_at,updated_at) VALUES ('bot',2,1,?,?)`).run(old, old);
    db.sqlite.prepare(`INSERT INTO reopen_business_messages(bot_id,user_id,update_id,source_chat_id,source_message_id,created_at) VALUES ('bot',2,2,2,2,?)`).run(old);
    const result = await supportHealthSnapshot(environment(db), { botId: 'bot', now, fetchImpl: async () => Response.json({ ok: true, result: { url: 'https://wrong.test/tg/bot', pending_update_count: 3, last_error_date: now.getTime() / 1000 } }) });
    assert.equal(result.pending, 1);
    assert.equal(result.uncertain, 1);
    assert.equal(result.oldestSeconds, 3600);
    assert.equal(result.webhook.matchesExpected, false);
    assert.equal(result.webhook.pending, 3);
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.ok(!JSON.stringify(result).includes('wrong.test'));
  } finally { db.close(); }
});

test('missing webhook data is unavailable and 429 deadline prevents another RPC sending', async () => {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  try {
    // The plan lookup filters cooldowns with SQLite's real clock, so this
    // integration scenario must not use a fixed date that eventually expires.
    const now = new Date();
    const env = { ...environment(db), TELEGRAM_COOLDOWN_ENABLED: 'true' };
    let count = 0;
    const fetchImpl = async () => { count++; return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 3600 } }, { status: 429 }); };
    const first = await supportHealthSnapshot(env, { botId: 'bot', now, fetchImpl });
    assert.equal(first.webhook.quality, 'unavailable');
    const next = await supportHealthSnapshot(env, { botId: 'bot', now: new Date(now.getTime() + 1000), fetchImpl });
    assert.equal(next.webhook.quality, 'unavailable');
    assert.equal(count, 1);
  } finally { db.close(); }
});

test('operational telemetry caps durable writes and never throws when its budget or database fails', async () => {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  try {
    const wrapped = await resolveInvocationDatabase(db, {});
    const env = { ...environment(wrapped), OPERATIONAL_HEALTH_ENABLED: 'true' };
    await recordOperationalSignal(env, 'bot', 'test_failure', now);
    await recordOperationalSignal(env, 'bot', 'test_failure', now);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM operational_signals').get().n, 1);
    db.sqlite.prepare('UPDATE operational_signal_budget SET used = 1000, day_utc = ?').run(now.toISOString().slice(0, 10));
    await recordOperationalSignal(env, 'bot', 'another_failure', now);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM operational_signals').get().n, 1);
    db.maxQueries = db.queries;
    await recordOperationalSignal(env, 'bot', 'database_failure', now);
  } finally { db.close(); }
});
