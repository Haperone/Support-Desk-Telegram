import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runMonitor } from "../worker.js";
import { switchAlertRoute } from "../alert-config.js";
import { handleD1TelemetryHealth } from "../entry.js";
import { readCloudflarePlan } from "../../cloudflare-plan.js";

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  execute(method) {
    assert.ok(++this.db.queries <= 50, `Monitor exceeded Free query limit: ${this.sql}`);
    return this.db.sqlite.prepare(this.sql)[method](...this.params);
  }
  async first() { return this.execute("get") || null; }
  async all() { return { results: this.execute("all") }; }
  async run() { return { meta: { changes: Number(this.execute("run").changes) } }; }
}

class D1 {
  constructor(directory = new URL("../migrations/", import.meta.url)) {
    this.queries = 0;
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
    }
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); }
}

test("linked monitor reads the durable plan each run and separates billing periods, trends and dedupe", async () => {
  const db = new D1();
  const planDb = new D1(new URL("../../migrations/", import.meta.url));
  try {
    const env = {
      MONITOR_DB: db, CF_ACCOUNT_ID: "account", CF_ANALYTICS_TOKEN: "analytics", ALERT_BOT_TOKEN: "bot", ALERT_CHAT_ID: "123",
      SUPPORT_PLAN: { getPlan: () => readCloudflarePlan(planDb, { RECOVERY_D1_PLAN: "free", WORKERS_BILLING_DAY: 17 }) },
      LIMIT_WORKER_REQUESTS: "1000", PAID_LIMIT_WORKER_REQUESTS: "1000",
    };
    const messages = [];
    const requests = [];
    let amount = 750;
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).includes("api.telegram.org")) {
        messages.push(body.text);
        return Response.json({ ok: true });
      }
      requests.push(body);
      return Response.json({ data: { viewer: { accounts: [{
        workersInvocationsAdaptive: [{ sum: { requests: amount }, dimensions: { scriptName: "support" } }],
        d1AnalyticsAdaptiveGroups: [], kvOperationsAdaptiveGroups: [],
      }] } } });
    };
    const run = async (timestamp) => {
      db.queries = 0;
      planDb.queries = 0;
      const now = new Date(timestamp);
      const result = await runMonitor(env, { now, fetchImpl });
      await handleD1TelemetryHealth(env, result, now, fetchImpl);
      assert.equal(result.ok, true);
      assert.ok(db.queries + planDb.queries <= 50);
      return result;
    };
    assert.equal((await run("2026-09-06T23:00:00Z")).usage.period.plan, "free");
    assert.equal(messages.length, 1);
    planDb.sqlite.exec("UPDATE cloudflare_plan_settings SET plan = 'paid', billing_day = 17, revision = 'paid'");
    assert.equal((await run("2026-09-06T23:01:00Z")).usage.period.key, "paid:2026-08-17");
    assert.equal(messages.length, 2);
    assert.doesNotMatch(messages[1], /Current rate/); // No trend against the old Free snapshot.
    assert.match(messages[1], /monthly|Monthly/);
    amount = 870;
    await run("2026-09-07T00:01:00Z");
    assert.equal(messages.length, 3);
    assert.match(messages[2], /Current rate: \+120\/hour/); // Paid trend survives UTC midnight.
    await run("2026-09-08T00:01:00Z");
    assert.equal(messages.length, 3); // Daily reset must not resend monthly thresholds.
    await run("2026-09-17T00:01:00Z");
    assert.equal(messages.length, 4);
    assert.match(messages[3], /2026-09-17 → 2026-10-17/);
    assert.doesNotMatch(messages[3], /Current rate/);
    planDb.sqlite.exec("UPDATE cloudflare_plan_settings SET plan = 'free', revision = 'free'");
    const back = await run("2026-09-17T00:02:00Z");
    assert.equal(back.usage.period.key, "2026-09-17");
    assert.equal(messages.length, 5);
    const lastWorkers = requests.filter(r => r.query.includes("workersInvocationsAdaptive")).at(-1);
    assert.equal(lastWorkers.variables.start, "2026-09-17T00:00:00.000Z");
    const keys = db.sqlite.prepare("SELECT DISTINCT day_utc FROM sent_alerts ORDER BY day_utc").all().map(r => r.day_utc);
    assert.deepEqual(keys, ["2026-09-06", "2026-09-17", "paid:2026-08-17", "paid:2026-09-17"]);
  } finally { db.sqlite.close(); planDb.sqlite.close(); }
});

test("plan lookup failure keeps critical Free references available even when both D1 bindings fail", async () => {
  const messages = [];
  const failed = { prepare() { throw new Error("D1 daily read cap"); } };
  const env = {
    MONITOR_DB: failed, CF_ACCOUNT_ID: "account", CF_ANALYTICS_TOKEN: "analytics", ALERT_BOT_TOKEN: "bot", ALERT_CHAT_ID: "123",
    SUPPORT_PLAN: { getPlan: async () => { throw new Error("D1 daily read cap"); } },
  };
  const result = await runMonitor(env, { now: new Date("2026-09-06T12:00:00Z"), fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes("api.telegram.org")) {
      messages.push(body.text);
      return Response.json({ ok: true });
    }
    return Response.json({ data: { viewer: { accounts: [{
      workersInvocationsAdaptive: [], kvOperationsAdaptiveGroups: [],
      d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 5_000_000, rowsWritten: 100_000 }, dimensions: { databaseId: "support" } }],
    }] } } });
  } });
  assert.equal(result.ok, false);
  assert.equal(messages.length, 2);
  assert.ok(messages.every(text => text.includes("current account plan is unconfirmed")));
});

for (const value of [850, 990]) test(`Free monitor: 100 breakdowns, all metrics at ${value / 10}%, stale claims and health recovery`, async () => {
  const db = new D1();
  try {
    const now = new Date();
    now.setUTCHours(12, 0, 0, 0);
    const day = now.toISOString().slice(0, 10);
    const metrics = ["worker_requests", "d1_rows_read", "d1_rows_written", "kv_reads", "kv_writes", "kv_deletes", "kv_lists"];
    for (const key of ["api_failure_alert_sent", "d1_analytics_alert_sent", "d1_analytics_consecutive_failures"]) {
      db.sqlite.prepare("INSERT INTO monitor_state (key, value) VALUES (?, '1')").run(key);
    }
    for (const metric of [...metrics, "__api_health_recovery__"]) {
      db.sqlite.prepare("INSERT INTO alert_claims (day_utc, metric, owner_token, lease_expires_at) VALUES (?, ?, 'stale', ?)")
        .run(day, metric, new Date(now.getTime() - 60_000).toISOString());
    }
    const env = {
      MONITOR_DB: db, CF_ACCOUNT_ID: "account", CF_ANALYTICS_TOKEN: "analytics", ALERT_BOT_TOKEN: "bot", ALERT_CHAT_ID: "123",
      SUPPORT_PLAN: { async getPlan() { assert.ok(++db.queries <= 50); return { plan: "free", billingDay: null }; } },
      KV_NAMESPACE_NAMES: JSON.stringify({ ns: "namespace" }),
      LIMIT_WORKER_REQUESTS: "1000", LIMIT_D1_ROWS_READ: "1000", LIMIT_D1_ROWS_WRITTEN: "1000",
      LIMIT_KV_READS: "1000", LIMIT_KV_WRITES: "1000", LIMIT_KV_DELETES: "1000", LIMIT_KV_LISTS: "1000",
    };
    if (value === 990) {
      env.ALERT_CONFIG_KEY = 'a'.repeat(64);
      await switchAlertRoute(env, { expectedGeneration: 0, mode: 'private', recipientIds: [7] },
        async () => Response.json({ ok: true, result: { message_id: 1 } }));
      db.queries = 0;
    }
    const messages = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).includes("api.telegram.org")) {
        messages.push(body.text);
        return Response.json({ ok: true, result: { message_id: messages.length } });
      }
      let account;
      if (body.query.includes("workersInvocationsAdaptive")) {
        account = { workersInvocationsAdaptive: Array.from({ length: 100 }, (_, index) => ({
          sum: { requests: index === 99 ? value - 792 : 8 }, dimensions: { scriptName: `worker-${index}` },
        })) };
      } else if (body.query.includes("d1AnalyticsAdaptiveGroups")) {
        account = { d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: value, rowsWritten: value }, dimensions: { databaseId: "db" } }] };
      } else {
        account = { kvOperationsAdaptiveGroups: ["read", "write", "delete", "list"].map((actionType) => ({ sum: { requests: value }, dimensions: { actionType } })) };
      }
      return Response.json({ data: { viewer: { accounts: [account] } } });
    };
    const result = await runMonitor(env, { now, fetchImpl });
    await handleD1TelemetryHealth(env, result, now, fetchImpl);
    assert.equal(result.ok, true);
    assert.ok(db.queries <= 50);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM usage_breakdowns").get().n, 100);
    assert.equal(db.sqlite.prepare("SELECT COUNT(DISTINCT metric) AS n FROM sent_alerts").get().n, 7);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM alert_claims WHERE owner_token <> 'stale'").get().n, 0);
    assert.equal(messages.length, 9);
    // Same-day retries retain dedupe after the bulk insert and lease takeover.
    db.queries = 0;
    const later = new Date(now.getTime() + 1_000);
    await handleD1TelemetryHealth(env, await runMonitor(env, { now: later, fetchImpl }), later, fetchImpl);
    assert.equal(messages.length, 9);
    assert.ok(db.queries <= 50);
  } finally { db.sqlite.close(); }
});
