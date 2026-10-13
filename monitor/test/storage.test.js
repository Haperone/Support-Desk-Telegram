import test from "node:test";
import assert from "node:assert/strict";
import { SqliteD1 } from "../../test/helpers/sqlite-d1.js";
import { createMonitorContext } from "../budget.js";
import { collectStorage, storageForecast, storageLimits } from "../storage.js";
import { runOperationalMonitor } from "../runner.js";
import { dispatchIncidents, observeIncident } from "../incidents.js";

const database = () => new SqliteD1(new URL("../migrations/", import.meta.url));
const start = new Date("2026-09-08T12:00:00Z");
const envFor = (db) => ({ MONITOR_DB: db, CF_ACCOUNT_ID: "account", CF_ANALYTICS_TOKEN: "read", ALERT_BOT_TOKEN: "alert", ALERT_CHAT_ID: "123", MONITOR_HEALTH_ENABLED: "true" });

function storageFetch(databases, failed = new Set(), messages = []) {
  return async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.telegram.org") { messages.push(JSON.parse(init.body).text); return Response.json({ ok: true }); }
    if (parsed.pathname.endsWith("/graphql")) return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [], kvOperationsAdaptiveGroups: [], d1AnalyticsAdaptiveGroups: [] }] } } });
    if (parsed.pathname.endsWith("/database")) {
      const page = Number(parsed.searchParams.get("page"));
      return Response.json({ success: true, result: databases.slice((page - 1) * 100, page * 100).map(({ uuid, name }) => ({ uuid, name })),
        result_info: { page, per_page: 100, total_count: databases.length } });
    }
    const id = parsed.pathname.split("/").at(-1);
    if (failed.has(id)) return new Response("unavailable", { status: 503 });
    return Response.json({ success: true, result: databases.find((row) => row.uuid === id) });
  };
}

test("storage reads current details for every inventory database, including unrelated databases", async () => {
  const db = database();
  try {
    const data = [{ uuid: "support", name: "Support", file_size: 480_000_000 }, { uuid: "other-app", name: "Other app", file_size: 200_000_000 }];
    const context = createMonitorContext(envFor(db), storageFetch(data));
    const result = await collectStorage(context.env, start, context.fetch);
    assert.equal(result.quality, "available");
    assert.equal(result.bytes, 680_000_000);
    assert.equal(result.databases, 2);
    assert.equal(db.sqlite.prepare("SELECT severity FROM monitor_incidents WHERE incident_key = 'storage:support'").get().severity, 95);
    assert.equal(db.sqlite.prepare("SELECT bytes FROM storage_samples WHERE resource_id = 'account'").get().bytes, 680_000_000);
    assert.ok(context.budget.statements <= 50);
    assert.equal(context.budget.requests, 3);
    assert.equal(storageLimits({ RECOVERY_D1_PLAN: "paid" }).included, 5_000_000_000);
    assert.equal(storageLimits({ RECOVERY_D1_PLAN: "paid" }).account, 1_000_000_000_000);
  } finally { db.close(); }
});

test("missing size never becomes zero usage and account totals remain an explicit lower bound", async () => {
  const db = database();
  try {
    const data = [{ uuid: "known", name: "Known", file_size: 1234 }, { uuid: "missing", name: "Missing" }];
    const result = await collectStorage(envFor(db), start, storageFetch(data));
    assert.equal(result.quality, "partial");
    assert.equal(result.bytes, 1234);
    assert.equal(db.sqlite.prepare("SELECT bytes, quality FROM storage_inventory WHERE database_id = 'missing'").get().bytes, null);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM storage_samples WHERE resource_id = 'account'").get().count, 0);
  } finally { db.close(); }
});

test('a complete inventory retires storage and forecast alerts for removed databases, including already orphaned alerts', async () => {
  const db = database();
  try {
    const env = envFor(db);
    const data = [{ uuid: 'removed', name: 'Removed DB', file_size: 490_000_000 }];
    await collectStorage(env, start, storageFetch(data));
    await observeIncident(db, { key: 'forecast:removed', severity: 95, message: 'Removed DB forecast' }, new Date(start.getTime() + 1));
    await observeIncident(db, { key: 'storage:already-removed', severity: 95, message: 'Old orphaned warning' }, start);
    await dispatchIncidents(env, start, async () => ({ ok: true }));
    const later = new Date(start.getTime() + 2 * 86400000);
    await observeIncident(db, { key: 'delivery:unrelated', severity: 95, message: 'Delivery needs attention' }, later);
    const context = createMonitorContext(env, storageFetch([]));
    await collectStorage(context.env, later, context.fetch);
    assert.ok(context.budget.statements <= 50);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM storage_inventory').get().n, 0);
    const texts = [];
    await dispatchIncidents(env, later, async text => { texts.push(text); return { ok: true }; });
    assert.deepEqual(texts, ['🚨 Attention required\nDelivery needs attention']);
    for (const key of ['storage:removed', 'forecast:removed', 'storage:already-removed']) {
      assert.equal(db.sqlite.prepare('SELECT severity FROM monitor_incidents WHERE incident_key = ?').get(key).severity, 0);
      assert.equal(db.sqlite.prepare('SELECT sent_severity FROM monitor_incidents WHERE incident_key = ?').get(key).sent_severity, 0);
    }
    // A resource that reappears must be able to open and notify a new incident.
    const returned = new Date(later.getTime() + 86400000);
    await collectStorage(env, returned, storageFetch(data));
    await dispatchIncidents(env, returned, async text => { texts.push(text); return { ok: true }; });
    assert.match(texts.at(-1), /Removed DB/);
  } finally { db.close(); }
});

test('partial inventory or failed size reads do not retire existing database alerts', async () => {
  const db = database();
  try {
    const env = envFor(db);
    const old = [{ uuid: 'z-last', name: 'Last DB', file_size: 490_000_000 }];
    await collectStorage(env, start, storageFetch(old));
    const data = [...Array.from({ length: 100 }, (_, i) => ({ uuid: `db-${i}`, name: `DB ${i}`, file_size: 100 })), ...old];
    const later = new Date(start.getTime() + 2 * 86400000);
    const partial = await collectStorage(env, later, storageFetch(data));
    assert.equal(partial.inventory.complete, false);
    assert.equal(db.sqlite.prepare("SELECT severity FROM monitor_incidents WHERE incident_key = 'storage:z-last'").get().severity, 95);
    const failed = await collectStorage(env, new Date(later.getTime() + 2 * 86400000), storageFetch(old, new Set(['z-last'])));
    assert.equal(failed.quality, 'partial');
    assert.equal(db.sqlite.prepare("SELECT severity FROM monitor_incidents WHERE incident_key = 'storage:z-last'").get().severity, 95);
  } finally { db.close(); }
});

test("paginated inventory and details resume after restart without falsely declaring completeness", async () => {
  const db = database();
  try {
    const data = Array.from({ length: 101 }, (_, i) => ({ uuid: `db-${String(i).padStart(3, "0")}`, name: `DB ${i}`, file_size: 1000 + i }));
    let result;
    for (let i = 0; i < 17; i++) {
      const context = createMonitorContext(envFor(db), storageFetch(data));
      result = await collectStorage(context.env, new Date(start.getTime() + i * 60_000), context.fetch);
      if (i === 0) { assert.equal(result.quality, "partial"); assert.equal(result.inventory.complete, false); }
      assert.ok(context.budget.statements <= 50);
      assert.ok(context.budget.requests <= 7);
    }
    assert.equal(result.quality, "available");
    assert.equal(result.databases, 101);
    assert.equal(result.bytes, data.reduce((sum, row) => sum + row.file_size, 0));
  } finally { db.close(); }
});

test("storage forecast needs seven distinct daily samples, resets after cleanup, and rejects stale observations", () => {
  const samples = Array.from({ length: 7 }, (_, index) => ({ measured_at: new Date(start.getTime() - (6 - index) * 86_400_000).toISOString(), bytes: 100 + index * 10 }));
  assert.equal(storageForecast(samples.slice(1), 200, start), null);
  assert.equal(storageForecast([...samples, samples[6]], 200, start).daysRemaining, 4);
  assert.equal(storageForecast(samples, 200, new Date(start.getTime() + 3 * 86_400_000)), null);
  assert.equal(storageForecast([...samples, { measured_at: new Date(start.getTime() + 86_400_000).toISOString(), bytes: 10 }], 200, new Date(start.getTime() + 86_400_000)), null);
});

test("full monitor entrypoint shares Free budget and fairly reaches storage and alerts across runs", async () => {
  const db = database();
  try {
    const messages = [];
    const data = Array.from({ length: 7 }, (_, i) => ({ uuid: `db-${i}`, name: `DB ${i}`, file_size: 490_000_000 }));
    const seen = new Set();
    for (let i = 0; i < 10; i++) {
      db.queries = 0; db.maxQueries = 50;
      const result = await runOperationalMonitor(envFor(db), { now: new Date(start.getTime() + i * 60_000), fetchImpl: storageFetch(data, new Set(), messages) });
      for (const job of result.jobs) if (!job.deferred && !job.error) seen.add(job.job);
      assert.ok(result.budget.statements <= 50);
      assert.ok(result.budget.requests <= 50);
    }
    assert.deepEqual([...seen].sort(), ["alerts", "maintenance", "storage", "usage"]);
    assert.ok(messages.some((text) => text.includes("DB 6")));
    assert.equal(db.sqlite.prepare("SELECT owner_token FROM monitor_scheduler").get().owner_token, null);
  } finally { db.close(); }
});

test('all monitor jobs including runtime and support RPC rotate within one shared Free budget', async () => {
  const db = database();
  try {
    let measuredAt;
    const seen = new Set();
    const health = { services: async () => [{ id: 'support', name: 'Support' }], snapshot: async () => ({ botId: 'support', measuredAt, pending: 0, oldestSeconds: 0, uncertain: 0, quality: 'available', signals: [], webhook: { quality: 'available', configured: true, matchesExpected: true, pending: 0 } }) };
    for (let n = 0; n < 15; n++) {
      const now = new Date(start.getTime() + n * 900000);
      measuredAt = now.toISOString();
      db.queries = 0; db.maxQueries = 50;
      const result = await runOperationalMonitor({ ...envFor(db), MONITOR_RUNTIME_ENABLED: 'true', SUPPORT_HEALTH: health }, { now, fetchImpl: storageFetch([{ uuid: 'db', name: 'DB', file_size: 100 }]) });
      for (const job of result.jobs) if (!job.error && !job.deferred) seen.add(job.job);
      assert.ok(result.budget.statements <= 50);
      assert.ok(result.budget.requests <= 50);
    }
    assert.deepEqual([...seen].sort(), ['alerts', 'delivery', 'maintenance', 'runtime', 'storage', 'usage']);
  } finally { db.close(); }
});
