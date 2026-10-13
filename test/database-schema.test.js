import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptionSql, baselines, legacy, preflightName, preflightSql, prepareUpgrade } from "../scripts/prepare-database-upgrade.mjs";

const root = new URL("../", import.meta.url);
const create = () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
};
const schema = db => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY type, name").all();
const baselineSql = kind => readFileSync(new URL(`${baselines[kind].directory}/${baselines[kind].name}`, root), "utf8");

// Wrangler records filenames and applies each pending migration transactionally.
function apply(db, entries) {
  db.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
  let count = 0;
  for (const entry of entries) {
    if (db.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").get(entry.name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(entry.sql);
      db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(entry.name);
      db.exec("COMMIT");
      count++;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return count;
}

for (const kind of Object.keys(baselines)) {
  test(`${kind}: one baseline exactly reproduces the archived schema and initial data`, () => {
    const old = create();
    const fresh = create();
    try {
      for (const entry of legacy[kind]) old.exec(entry.sql);
      const names = readdirSync(new URL(`${baselines[kind].directory}/`, root)).filter(name => name.endsWith(".sql")).sort();
      assert.ok(names.includes(baselines[kind].name));
      assert.ok(names.every(name => !legacy[kind].some(entry => entry.name === name)), "historical migrations must stay outside the active directory");
      fresh.exec(baselineSql(kind));
      assert.deepEqual(schema(fresh), schema(old));
      for (const { name } of old.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
        assert.deepEqual(fresh.prepare(`SELECT * FROM "${name}"`).all(), old.prepare(`SELECT * FROM "${name}"`).all(), name);
      }
      assert.deepEqual(fresh.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(fresh.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally { old.close(); fresh.close(); }
  });

  test(`${kind}: upgrade from every historical version preserves data and registers the baseline`, async t => {
    const adoption = { name: baselines[kind].name, sql: adoptionSql(kind) };
    const upgrade = [{ name: preflightName, sql: preflightSql(kind) }, ...legacy[kind], adoption];
    const canonical = create();
    canonical.exec(baselineSql(kind));
    try {
      for (let prefix = 1; prefix <= legacy[kind].length; prefix++) {
        await t.test(`after ${legacy[kind][prefix - 1].name}`, () => {
          const db = create();
          try {
            apply(db, legacy[kind].slice(0, prefix));
            if (kind === "support") {
              db.exec("INSERT INTO conversations(bot_id, user_id, support_group_id, thread_id, created_at) VALUES('test', 7, -1007, 77, '2026-01-01T00:00:00Z')");
              db.exec("INSERT INTO message_mappings(bot_id, user_id, thread_id, user_message_id, support_message_id, created_at) VALUES('test', 7, 77, 10, 20, '2026-01-01T00:00:00Z')");
              db.exec("INSERT INTO banned_users(bot_id, user_id, reason, banned_at) VALUES('test', 8, 'keep this ban', '2026-01-01T00:00:00Z')");
              if (prefix >= 18) db.exec("UPDATE cloudflare_plan_settings SET plan = 'paid', billing_day = 17, revision = 'custom'");
              if (prefix >= 21) db.exec("UPDATE storage_control SET retention_days = 365, generation = 4");
            } else {
              db.exec("INSERT INTO usage_snapshots(checked_at, day_utc, worker_requests, kv_reads, kv_writes, kv_deletes, kv_lists) VALUES('2026-01-01T00:00:00Z', '2026-01-01', 123, 2, 3, 4, 5)");
              db.exec("INSERT INTO monitor_state(key, value) VALUES('keep', 'saved')");
              if (prefix >= 3) db.exec("UPDATE usage_snapshots SET d1_rows_read = 42, d1_rows_written = 6");
            }
            assert.equal(apply(db, upgrade), legacy[kind].length - prefix + 2);
            assert.deepEqual(schema(db), schema(canonical));
            if (kind === "support") {
              assert.equal(db.prepare("SELECT thread_id FROM conversations WHERE user_id = 7").get().thread_id, 77);
              assert.equal(db.prepare("SELECT support_message_id FROM message_mappings WHERE user_message_id = 10").get().support_message_id, 20);
              assert.equal(db.prepare("SELECT reason FROM banned_users WHERE user_id = 8").get().reason, "keep this ban");
              if (prefix >= 18) assert.equal(db.prepare("SELECT revision FROM cloudflare_plan_settings").get().revision, "custom");
              if (prefix >= 21) assert.equal(db.prepare("SELECT retention_days FROM storage_control").get().retention_days, 365);
            } else {
              const row = db.prepare("SELECT * FROM usage_snapshots").get();
              assert.equal(row.worker_requests, 123);
              assert.equal(row.d1_rows_read, prefix >= 3 ? 42 : null);
              assert.equal(row.d1_rows_written, prefix >= 3 ? 6 : null);
              assert.equal(db.prepare("SELECT value FROM monitor_state WHERE key = 'keep'").get().value, "saved");
            }
            assert.equal(apply(db, upgrade), 0, "repeating an upgrade must be harmless");
            assert.equal(apply(db, [{ name: baselines[kind].name, sql: baselineSql(kind) }]), 0, "normal migrations must skip the adopted baseline");
            assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
          } finally { db.close(); }
        });
      }
    } finally { canonical.close(); }
  });

  test(`${kind}: uninitialized, incomplete or incompatible schemas cannot be adopted`, () => {
    for (const mutation of [null, "partial", "column", "index", ...(kind === "support" ? ["trigger", "trigger_body"] : [])]) {
      const db = create();
      try {
        if (mutation) for (const entry of mutation === "partial" ? legacy[kind].slice(0, 1) : legacy[kind]) db.exec(entry.sql);
        if (mutation === "column") db.exec(`ALTER TABLE ${kind === "support" ? "bots" : "monitor_state"} ADD COLUMN unexpected TEXT`);
        if (mutation === "index") db.exec(`DROP INDEX ${kind === "support" ? "conversations_reverse_idx" : "idx_usage_snapshots_day_checked"}`);
        if (mutation === "trigger") db.exec("DROP TRIGGER storage_conversation_removed");
        if (mutation === "trigger_body") db.exec("DROP TRIGGER storage_conversation_removed; CREATE TRIGGER storage_conversation_removed BEFORE DELETE ON conversations BEGIN SELECT 1; END");
        assert.throws(() => apply(db, [{ name: baselines[kind].name, sql: adoptionSql(kind) }]), /incompatible_database_schema/);
        assert.equal(db.prepare("SELECT COUNT(*) n FROM d1_migrations").get().n, 0);
        assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name = '__baseline_upgrade_guard'").get().n, 0);
      } finally { db.close(); }
    }
  });

  test(`${kind}: upgrade preflight refuses new, unjournaled and divergent databases`, () => {
    for (const state of ["empty", "new", "unjournaled", "gap", "unknown"]) {
      const db = create();
      try {
        if (state === "new") apply(db, [{ name: baselines[kind].name, sql: baselineSql(kind) }]);
        if (state === "unjournaled") db.exec(legacy[kind][0].sql);
        if (state === "gap" || state === "unknown") {
          apply(db, legacy[kind].slice(0, 2));
          if (state === "gap") db.prepare("DELETE FROM d1_migrations WHERE name = ?").run(legacy[kind][0].name);
          else db.exec("INSERT INTO d1_migrations(name) VALUES('custom.sql')");
        }
        const before = schema(db);
        assert.throws(() => apply(db, [{ name: preflightName, sql: preflightSql(kind) }]), /expected_contiguous_legacy_migration_history|NOT NULL/);
        assert.deepEqual(schema(db), before, "preflight must not change application schema");
      } finally { db.close(); }
    }
  });

  test(`${kind}: preparation creates only local files with the original migration identities`, () => {
    const parent = mkdtempSync(join(tmpdir(), "telegram-upgrade-test-"));
    try {
      const result = prepareUpgrade(kind, { parent });
      const config = readFileSync(result.config, "utf8");
      assert.match(config, /^main = "(?:[A-Z]:\/|\/).*\.js"$/m);
      assert.ok(config.includes(result.migrations.replaceAll("\\", "/")));
      assert.equal(readdirSync(result.migrations).length, legacy[kind].length + 2);
      for (const entry of legacy[kind]) assert.equal(readFileSync(join(result.migrations, entry.name), "utf8"), entry.sql);
      assert.equal(readFileSync(join(result.migrations, baselines[kind].name), "utf8"), adoptionSql(kind));
      assert.notEqual(prepareUpgrade(kind, { parent }).directory, result.directory, "preparation never overwrites a previous run");
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
}
