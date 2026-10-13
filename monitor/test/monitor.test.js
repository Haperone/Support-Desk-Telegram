import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stalledJsonResponse } from "../../test/helpers/stalled-response.js";
import {
  calculateTrend,
  fetchCloudflareUsage,
  formatLocalReset,
  handleApiFailure,
  handleApiSuccess,
  normalizeD1,
  normalizeKv,
  normalizeWorkers,
  sendTelegram,
  sendD1EmergencyAlerts,
  processUsageAlerts,
  reachedThresholds,
  selectAlertDecision,
} from "../worker.js";

class FakeStatement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) { return new FakeStatement(this.db, this.sql, bindings); }

  async first() {
    if (this.sql.includes("SELECT value FROM monitor_state")) {
      const value = this.db.state.get(this.bindings[0]);
      return value === undefined ? null : { value };
    }
    if (this.sql.includes("consecutive_api_failures") && this.sql.includes("RETURNING value")) {
      const value = String(Number(this.db.state.get("consecutive_api_failures") || 0) + 1);
      this.db.state.set("consecutive_api_failures", value);
      return { value };
    }
    if (this.sql.includes("INSERT INTO sent_alerts") && this.sql.includes("RETURNING alert_level")) {
      const [day, metric, level, sentAt, usageValue] = this.bindings;
      if (this.db.alerts.some((entry) => entry.day === day && entry.metric === metric && entry.level === level)) return null;
      this.db.alerts.push({ day, metric, level, sentAt, usageValue });
      return { alert_level: level };
    }
    if (this.sql.includes("INSERT INTO alert_claims") && this.sql.includes("RETURNING owner_token")) {
      const [day, metric, owner, expires, cutoff] = this.bindings;
      const key = `${day}:${metric}`;
      if (this.db.claims.has(key) && this.db.claims.get(key).expires > cutoff) return null;
      this.db.claims.set(key, { owner, expires });
      return { owner_token: owner };
    }
    if (this.sql.includes("SELECT owner_token, lease_expires_at FROM alert_claims")) { const [day,metric]=this.bindings; const x=this.db.claims.get(`${day}:${metric}`); return x?{owner_token:x.owner,lease_expires_at:x.expires}:null; }
    if (this.sql.includes("UPDATE alert_claims") && this.sql.includes("RETURNING owner_token")) { const [owner,expires,day,metric,old,cutoff]=this.bindings; const key=`${day}:${metric}`,x=this.db.claims.get(key); if(!x||x.owner!==old||x.expires>cutoff)return null; this.db.claims.set(key,{owner,expires}); return {owner_token:owner}; }
    return null;
  }

  async all() {
    if (this.sql.includes("SELECT metric, alert_level FROM sent_alerts")) {
      return { results: this.db.alerts.filter((entry) => entry.day === this.bindings[0]).map((entry) => ({ metric: entry.metric, alert_level: entry.level })) };
    }
    if (this.sql.includes("SELECT alert_level FROM sent_alerts")) {
      const [day, metric] = this.bindings;
      return {
        results: this.db.alerts
          .filter((entry) => entry.day === day && entry.metric === metric)
          .map((entry) => ({ alert_level: entry.level })),
      };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.includes("INSERT INTO monitor_state")) {
      const [key, value] = this.bindings;
      this.db.state.set(key, String(value));
    }
    if (this.sql.includes("INSERT INTO sent_alerts")) {
      const [day, metric, sentAt, usageValue, levelsJson] = this.bindings;
      for (const level of JSON.parse(levelsJson)) {
        if (!this.db.alerts.some((entry) => entry.day === day && entry.metric === metric && entry.level === level)) {
          this.db.alerts.push({ day, metric, level, sentAt, usageValue });
        }
      }
    }
    if (this.sql.includes("DELETE FROM alert_claims")) { const [day,metric,owner]=this.bindings; const key=`${day}:${metric}`,x=this.db.claims.get(key); if(x?.owner===owner)this.db.claims.delete(key); }
    if (this.sql.includes("DELETE FROM sent_alerts")) {
      const [day, metric, level] = this.bindings;
      this.db.alerts = this.db.alerts.filter((entry) => !(entry.day === day && entry.metric === metric && entry.level === level));
    }
    return { success: true, meta: { changes: 1 } };
  }
}

class FakeD1 {
  constructor() {
    this.state = new Map();
    this.alerts = [];
    this.claims = new Map();
  }
  prepare(sql) { return new FakeStatement(this, sql); }
  async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); }
}

function env(db = new FakeD1()) {
  return {
    MONITOR_DB: db,
    CF_ACCOUNT_ID: "account-id",
    CF_ANALYTICS_TOKEN: "cf-secret",
    ALERT_BOT_TOKEN: "telegram-secret",
    ALERT_CHAT_ID: "-100123",
    DISPLAY_TIMEZONE: "Europe/Budapest",
  };
}

function emptyUsage(overrides = {}) {
  return {
    worker_requests: 0,
    d1_rows_read: 0,
    d1_rows_written: 0,
    kv_reads: 0,
    kv_writes: 0,
    kv_deletes: 0,
    kv_lists: 0,
    workerBreakdown: [],
    d1Breakdown: [],
    kvBreakdown: [],
    ...overrides,
  };
}

function telegramOk(counter) {
  return async (url) => {
    assert.match(url, /^https:\/\/api\.telegram\.org\/bottelegram-secret\/sendMessage$/);
    counter.count += 1;
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("threshold crossing returns every newly reached configured level", () => {
  assert.deepEqual(reachedThresholds(699, 1000, [70, 85, 95]), []);
  assert.deepEqual(reachedThresholds(700, 1000, [70, 85, 95]), ["70"]);
  assert.deepEqual(reachedThresholds(951, 1000, [70, 85, 95]), ["70", "85", "95"]);
  assert.deepEqual(selectAlertDecision({
    value: 860,
    limit: 1000,
    thresholds: [70, 85, 95],
    sentLevels: new Set(["70"]),
    trend: null,
    predictiveHours: 2,
  }), { level: "85", levelsToMark: ["85"] });
});

test("dedup is per metric and UTC day, so the next UTC day alerts again", async () => {
  const db = new FakeD1();
  const testEnv = env(db);
  const calls = { count: 0 };
  const usage = emptyUsage({ kv_writes: 704 });
  await processUsageAlerts(testEnv, usage, null, new Date("2026-08-31T23:50:00Z"), telegramOk(calls));
  await processUsageAlerts(testEnv, usage, null, new Date("2026-08-31T23:55:00Z"), telegramOk(calls));
  await processUsageAlerts(testEnv, usage, null, new Date("2026-09-01T00:05:00Z"), telegramOk(calls));
  assert.equal(calls.count, 2);
  assert.deepEqual(db.alerts.map((entry) => [entry.day, entry.metric, entry.level]), [
    ["2026-08-31", "kv_writes", "70"],
    ["2026-09-01", "kv_writes", "70"],
  ]);
});

test("failed Telegram send does not mark an alert and the next check retries", async () => {
  const db = new FakeD1();
  const testEnv = env(db);
  const usage = emptyUsage({ kv_writes: 710 });
  await processUsageAlerts(testEnv, usage, null, new Date("2026-09-01T10:00:00Z"), async () => (
    new Response(JSON.stringify({ ok: false, description: "temporary failure" }), { status: 429, headers: { "content-type": "application/json" } })
  ));
  assert.equal(db.alerts.length, 0);
  const calls = { count: 0 };
  await processUsageAlerts(testEnv, usage, null, new Date("2026-09-01T10:15:00Z"), telegramOk(calls));
  assert.equal(calls.count, 1);
  assert.equal(db.alerts.length, 1);
});

test("burn rate and ETA support predictive warnings only after 30 percent", () => {
  const trend = calculateTrend(700, 400, "2026-09-01T11:00:00Z", "2026-09-01T10:00:00Z", 1000);
  assert.equal(trend.burnRate, 300);
  assert.equal(trend.etaHours, 1);
  assert.equal(selectAlertDecision({
    value: 690,
    limit: 1000,
    thresholds: [70, 85, 95],
    sentLevels: new Set(),
    trend,
    predictiveHours: 2,
  }).level, "predictive");
  assert.equal(selectAlertDecision({
    value: 290,
    limit: 1000,
    thresholds: [70, 85, 95],
    sentLevels: new Set(),
    trend: { burnRate: 500, etaHours: 1.42 },
    predictiveHours: 2,
  }), null);
});

test("health alert fires on the third API failure and recovery fires once", async () => {
  const db = new FakeD1();
  const testEnv = env(db);
  db.state.set("last_successful_check", "2026-09-01T09:00:00.000Z");
  const calls = { count: 0 };
  const fetchImpl = telegramOk(calls);
  const now = new Date("2026-09-01T10:00:00Z");
  await handleApiFailure(testEnv, now, new Error("down"), fetchImpl);
  await handleApiFailure(testEnv, now, new Error("down"), fetchImpl);
  assert.equal(calls.count, 0);
  await handleApiFailure(testEnv, now, new Error("down"), fetchImpl);
  await handleApiFailure(testEnv, now, new Error("down"), fetchImpl);
  assert.equal(calls.count, 1);
  await handleApiSuccess(testEnv, new Date("2026-09-01T10:15:00Z"), fetchImpl);
  await handleApiSuccess(testEnv, new Date("2026-09-01T10:30:00Z"), fetchImpl);
  assert.equal(calls.count, 2);
  assert.equal(db.state.get("consecutive_api_failures"), "0");
  assert.equal(db.state.get("api_failure_alert_sent"), "0");
});

test("local reset time follows Budapest DST", () => {
  assert.match(formatLocalReset(new Date("2026-01-15T12:00:00Z"), "Europe/Budapest"), /^01:00/);
  assert.match(formatLocalReset(new Date("2026-07-15T12:00:00Z"), "Europe/Budapest"), /^02:00/);
});

test("normalizers aggregate Workers scripts and all KV operation types", () => {
  assert.deepEqual(normalizeWorkers([
    { sum: { requests: 10 }, dimensions: { scriptName: "support" } },
    { sum: { requests: 5 }, dimensions: { scriptName: "support" } },
    { sum: { requests: 3 }, dimensions: { scriptName: "monitor" } },
  ]), { total: 18, breakdown: [{ name: "support", value: 15 }, { name: "monitor", value: 3 }] });
  assert.deepEqual(normalizeD1([
    { sum: { rowsRead: 1200, rowsWritten: 30 }, dimensions: { databaseId: "support" } },
    { sum: { rowsRead: 300, rowsWritten: 5 }, dimensions: { databaseId: "support" } },
  ]), { totals: { rowsRead: 1500, rowsWritten: 35 }, breakdown: [{ name: "support", rowsRead: 1500, rowsWritten: 35 }] });
  assert.deepEqual(normalizeKv([
    { sum: { requests: 11 }, dimensions: { actionType: "read", namespaceId: "a" } },
    { sum: { requests: 7 }, dimensions: { actionType: "write", namespaceId: "a" } },
    { sum: { requests: 2 }, dimensions: { actionType: "delete", namespaceId: "b" } },
    { sum: { requests: 1 }, dimensions: { actionType: "list", namespaceId: "b" } },
  ], { a: "Folder Links" }).totals, { read: 11, write: 7, delete: 2, list: 1 });
});

test("GraphQL uses the hardcoded host and filters configured KV namespaces", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, authorization: options.headers.authorization, body });
    const query = body.query;
    if (query.includes("workersInvocationsAdaptive")) {
      return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
        { sum: { requests: 42 }, dimensions: { scriptName: "support" } },
      ] }] } } });
    }
    if (query.includes("d1AnalyticsAdaptiveGroups")) {
      return Response.json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [
        { sum: { rowsRead: 1200, rowsWritten: 34 }, dimensions: { databaseId: "support-db" } },
      ] }] } } });
    }
    if (body.variables.namespaceId === "ns-a") {
      return Response.json({ data: { viewer: { accounts: [{ kvOperationsAdaptiveGroups: [
        { sum: { requests: 3 }, dimensions: { actionType: "read" } },
        { sum: { requests: 2 }, dimensions: { actionType: "write" } },
      ] }] } } });
    }
    return Response.json({ data: { viewer: { accounts: [{ kvOperationsAdaptiveGroups: [
      { sum: { requests: 12 }, dimensions: { actionType: "read" } },
      { sum: { requests: 4 }, dimensions: { actionType: "write" } },
    ] }] } } });
  };
  const testEnv = env();
  testEnv.KV_NAMESPACE_NAMES = JSON.stringify({ "ns-a": "Folder Links" });
  const usage = await fetchCloudflareUsage(testEnv, new Date("2026-09-01T12:00:00Z"), fetchImpl);
  assert.equal(usage.worker_requests, 42);
  assert.equal(usage.d1_rows_read, 1200);
  assert.equal(usage.d1_rows_written, 34);
  assert.equal(usage.kv_reads, 12);
  assert.equal(usage.kv_writes, 4);
  assert.deepEqual(usage.kvBreakdown, [{ name: "Folder Links", read: 3, write: 2, delete: 0, list: 0 }]);
  assert.equal(usage.breakdownStatus.workers, "available");
  assert.equal(usage.breakdownStatus.d1, "available");
  assert.equal(usage.breakdownStatus.kv, "available");
  assert.equal(requests.length, 4);
  assert.equal(requests.some((request) => request.body.variables.namespaceId === "ns-a"), true);
  assert.ok(requests.every((request) => request.url === "https://api.cloudflare.com/client/v4/graphql"));
  assert.ok(requests.every((request) => request.authorization === "Bearer cf-secret"));
});

test("a per-namespace GraphQL failure preserves account totals", async () => {
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.query.includes("workersInvocationsAdaptive")) {
      return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } });
    }
    if (body.query.includes("d1AnalyticsAdaptiveGroups")) {
      return Response.json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } } });
    }
    if (body.variables.namespaceId) return Response.json({ errors: [{ message: "namespace unavailable" }] });
    return Response.json({ data: { viewer: { accounts: [{ kvOperationsAdaptiveGroups: [
      { sum: { requests: 9 }, dimensions: { actionType: "write" } },
    ] }] } } });
  };
  const testEnv = env();
  testEnv.KV_NAMESPACE_NAMES = JSON.stringify({ "ns-a": "Folder Links" });
  const usage = await fetchCloudflareUsage(testEnv, new Date("2026-09-01T12:00:00Z"), fetchImpl);
  assert.equal(usage.kv_writes, 9);
  assert.deepEqual(usage.kvBreakdown, []);
  assert.equal(usage.breakdownStatus.kv, "partial");
});

test("Wrangler config has the 15-minute cron, D1, and no KV binding", async () => {
  const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(config, /crons\s*=\s*\["\*\/15 \* \* \* \*"\]/);
  assert.match(config, /\[\[d1_databases\]\]/);
  assert.doesNotMatch(config, /\[\[kv_namespaces\]\]/);
});


test("failed recovery notification is retried on the next successful check", async () => {
  const db=new FakeD1(), e=env(db); db.state.set("consecutive_api_failures","3"); db.state.set("api_failure_alert_sent","1");
  await handleApiSuccess(e,new Date("2026-09-01T10:15:00Z"),async()=>new Response(JSON.stringify({ok:false}),{status:429,headers:{"content-type":"application/json"}}));
  assert.equal(db.state.get("api_failure_alert_sent"),"1"); const calls={count:0}; await handleApiSuccess(e,new Date("2026-09-01T10:30:00Z"),telegramOk(calls)); assert.equal(calls.count,1); assert.equal(db.state.get("api_failure_alert_sent"),"0");
});


test("overlapping health failures share one leased Telegram alert", async () => {
  const db = new FakeD1();
  const testEnv = env(db);
  db.state.set("consecutive_api_failures", "2");
  db.state.set("last_successful_check", "2026-09-01T09:00:00.000Z");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let sends = 0;
  const fetchImpl = async () => {
    sends += 1;
    await gate;
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const now = new Date("2026-09-01T10:00:00Z");
  const first = handleApiFailure(testEnv, now, new Error("down"), fetchImpl);
  await Promise.resolve();
  const second = handleApiFailure(testEnv, now, new Error("down"), fetchImpl);
  await Promise.resolve();
  release();
  await Promise.all([first, second]);
  assert.equal(sends, 1);
  assert.equal(db.state.get("api_failure_alert_sent"), "1");
});


test("a transport-uncertain usage alert is retried because quota alerts are at-least-once", async () => {
  const db = new FakeD1();
  const testEnv = env(db);
  const usage = emptyUsage({ kv_writes: 710 });
  let attempts = 0;
  await processUsageAlerts(testEnv, usage, null, new Date("2026-09-01T10:00:00Z"), async () => {
    attempts += 1;
    throw new Error("socket reset after write");
  });
  assert.equal(attempts, 1);
  assert.equal(db.alerts.length, 0);
  const calls = { count: 0 };
  await processUsageAlerts(testEnv, usage, null, new Date("2026-09-01T10:15:00Z"), telegramOk(calls));
  assert.equal(calls.count, 1);
  assert.equal(db.alerts.length, 1);
});


test("an HTTP 5xx usage alert is retried because quota alerts are at-least-once", async () => {
  const db = new FakeD1();
  const testEnv = env(db);
  const usage = emptyUsage({ kv_writes: 710 });
  await processUsageAlerts(testEnv, usage, null, new Date("2026-09-01T13:00:00Z"), async () => (
    new Response(JSON.stringify({ ok: false, error_code: 500, description: "server failure" }), { status: 500, headers: { "content-type": "application/json" } })
  ));
  assert.equal(db.alerts.length, 0);
  const calls = { count: 0 };
  await processUsageAlerts(testEnv, usage, null, new Date("2026-09-01T13:15:00Z"), telegramOk(calls));
  assert.equal(calls.count, 1);
  assert.equal(db.alerts.length, 1);
});


test("monitor GraphQL and Telegram requests are aborted at the configured timeout", async () => {
  const testEnv = env();
  testEnv.MONITOR_FETCH_TIMEOUT_MS = "25";
  const hangingFetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  await assert.rejects(fetchCloudflareUsage(testEnv, new Date("2026-09-01T12:00:00Z"), hangingFetch), /timed out/);
  const telegram = await sendTelegram(testEnv, "timeout test", hangingFetch);
  assert.equal(telegram.ok, false);
  assert.equal(telegram.deliveryUncertain, true);
  assert.match(telegram.description, /timed out/);
});

test("review regression: monitor timeouts include GraphQL and Telegram response bodies", { timeout: 2000 }, async () => {
  const testEnv = { ...env(), MONITOR_FETCH_TIMEOUT_MS: "20" };
  const bodyTimeout = async (_url, init) => stalledJsonResponse(init.signal);
  await assert.rejects(fetchCloudflareUsage(testEnv, new Date("2026-09-01T12:00:00Z"), bodyTimeout), /timed out/);
  const telegram = await sendTelegram(testEnv, "timeout test", bodyTimeout);
  assert.equal(telegram.ok, false);
  assert.equal(telegram.deliveryUncertain, true);
  assert.match(telegram.description, /timed out/);
});


test("emergency D1 alert bypasses unavailable monitor state", async () => {
  const brokenDb = {
    prepare() {
      return {
        bind() { return this; },
        async first() { throw new Error("D1 quota exhausted"); },
        async all() { throw new Error("D1 quota exhausted"); },
        async run() { throw new Error("D1 quota exhausted"); },
      };
    },
    async batch() { throw new Error("D1 quota exhausted"); },
  };
  const testEnv = env(brokenDb);
  const calls = { count: 0 };
  const usage = emptyUsage({ d1_rows_written: 100_000, d1Breakdown: [{ name: "support-db", rowsRead: 0, rowsWritten: 100_000 }] });
  await sendD1EmergencyAlerts(testEnv, usage, new Date("2026-09-01T12:00:00Z"), telegramOk(calls));
  assert.equal(calls.count, 1);
});

test("D1 migration leaves historical rows unknown so post-deploy trend is not fabricated", async () => {
  const sql = await readFile(new URL("../migrations/0005_initial_schema.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /d1_rows_(?:read|written) INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /d1_rows_read INTEGER CHECK/);
  assert.equal(calculateTrend(2_000_000, null, "2026-09-01T11:00:00Z", "2026-09-01T10:00:00Z", 5_000_000), null);
});
