import test from "node:test";
import assert from "node:assert/strict";
import { SqliteD1 } from "./helpers/sqlite-d1.js";
import { guardStorageGeneration } from "../storage-generation.js";
import { resolveInvocationDatabase } from "../recovery-budget.js";

test("old invocations cannot read, rebuild or alter conversation data after the reset generation changes", async () => {
  const raw = new SqliteD1(new URL("../migrations/", import.meta.url));
  try {
    const db = await resolveInvocationDatabase(raw, { RETENTION_ENABLED: "true" });
    await db.prepare("INSERT INTO conversations(bot_id, user_id, support_group_id, thread_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("bot", 1, -100, 50, "2026-09-01T00:00:00.000Z").run();
    assert.equal((await db.prepare("SELECT * FROM conversations WHERE user_id = ?").bind(1).first()).thread_id, 50);
    raw.sqlite.exec("UPDATE storage_control SET generation = 1");
    await db.prepare("UPDATE conversations SET thread_id = ? WHERE user_id = ? OR user_id = ? RETURNING id").bind(60, 1, 2).all();
    assert.equal(raw.sqlite.prepare("SELECT thread_id FROM conversations").get().thread_id, 50);
    assert.equal(await db.prepare("SELECT * FROM conversations").first(), null);
    await db.prepare("INSERT OR IGNORE INTO message_mappings(bot_id,user_id,thread_id,created_at) VALUES (?, ?, ?, ?)").bind("bot", 1, 50, "now").run();
    assert.equal(raw.sqlite.prepare("SELECT COUNT(*) AS n FROM message_mappings").get().n, 0);
    await db.prepare("DELETE FROM conversations WHERE user_id = ? OR user_id = ?").bind(1, 2).run();
    assert.equal(raw.sqlite.prepare("SELECT COUNT(*) AS n FROM conversations").get().n, 1);
    for (const [table, columns, values] of [
      ['service_notification_outbox', 'bot_id,user_id,notification_cycle,kind,recipient_id,group_id,thread_id,available_at,created_at',
        ['bot', 1, 1, 'new', 42, -100, 50, 'now', 'now']],
      ['manager_work_flows', 'operator_id,bot_id,user_id,expected_revision,stage,nonce,expires_at,updated_at',
        [42, 'bot', 1, 0, 'note', 'draft', 'now', 'now']],
      ['manager_work_navigation', 'operator_id,list_route,card_route,updated_at',
        [42, 'mg:queue:a:needs:0', 'mg:work:a:1', 'now']],
      ['manager_home_screens', 'operator_id,update_id,requested_at', [42, 500, 'now']],
      ['service_topic_history', 'bot_id,user_id,support_group_id,thread_id,conversation_id,status,created_at,archived_at,replacement_group_id',
        ['bot', 1, -100, 49, 999, 'closed', 'now', 'now', -100]],
    ]) {
      await db.prepare(`INSERT INTO ${table}(${columns}) VALUES(${values.map(() => '?').join(',')})`).bind(...values).run();
      assert.equal(raw.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
    const current = await resolveInvocationDatabase(raw, { RETENTION_ENABLED: "true" });
    await current.prepare("UPDATE conversations SET thread_id = ? WHERE user_id = ?").bind(60, 1).run();
    assert.equal(raw.sqlite.prepare("SELECT thread_id FROM conversations").get().thread_id, 60);
  } finally { raw.close(); }
});

test("guarded SQL preserves nested WHERE/ON keywords, bindings, upserts and returning", async () => {
  const raw = new SqliteD1(new URL("../migrations/", import.meta.url));
  try {
    const sql = `INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,created_at)
      SELECT 'bot', 1, -100, 50, 'ON CONFLICT WHERE' FROM (SELECT 1) a JOIN (SELECT 1) b ON 1 = 1
      WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE user_id = 1)
      ON CONFLICT(bot_id,user_id) DO UPDATE SET thread_id = excluded.thread_id RETURNING thread_id`;
    assert.equal(raw.sqlite.prepare(guardStorageGeneration(sql, 0)).get().thread_id, 50);
    const update = "UPDATE conversations SET first_name = (SELECT 'WHERE RETURNING') WHERE user_id IN (SELECT user_id FROM conversations) RETURNING first_name";
    assert.equal(raw.sqlite.prepare(guardStorageGeneration(update, 0)).get().first_name, "WHERE RETURNING");
    raw.sqlite.exec("UPDATE storage_control SET mode = 'reset'");
    assert.equal(raw.sqlite.prepare(guardStorageGeneration("SELECT * FROM conversations", 0)).get(), undefined);
  } finally { raw.close(); }
});
