import test from "node:test";
import assert from "node:assert/strict";
import { fetchCloudflareUsage, sendD1EmergencyAlerts, sendCoreEmergencyAlerts } from "../worker.js";

function baseEnv(overrides = {}) {
  return {
    CF_ACCOUNT_ID: "account-1",
    CF_ANALYTICS_TOKEN: "cf-token",
    ALERT_BOT_TOKEN: "alert-token",
    ALERT_CHAT_ID: "123",
    DISPLAY_TIMEZONE: "Europe/Budapest",
    ...overrides,
  };
}

function graphQlResponse(account) {
  return new Response(JSON.stringify({ data: { viewer: { accounts: [account] } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("D1 analytics failure is partial and preserves Workers plus KV usage", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const query = String(body.query || "");
    if (query.includes("workersInvocationsAdaptive")) {
      return graphQlResponse({ workersInvocationsAdaptive: [{ sum: { requests: 321 }, dimensions: { scriptName: "support" } }] });
    }
    if (query.includes("d1AnalyticsAdaptiveGroups")) {
      return new Response(JSON.stringify({ errors: [{ message: "D1 analytics temporarily unavailable" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (query.includes("kvOperationsAdaptiveGroups")) {
      return graphQlResponse({ kvOperationsAdaptiveGroups: [
        { sum: { requests: 45 }, dimensions: { actionType: "read" } },
        { sum: { requests: 7 }, dimensions: { actionType: "write" } },
      ] });
    }
    throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
  };

  const usage = await fetchCloudflareUsage(baseEnv(), new Date("2026-09-05T12:00:00Z"), fetchImpl);
  assert.equal(usage.worker_requests, 321);
  assert.equal(usage.kv_reads, 45);
  assert.equal(usage.kv_writes, 7);
  assert.equal(usage.d1_rows_read, null);
  assert.equal(usage.d1_rows_written, null);
  assert.equal(usage.breakdownStatus.d1, "unavailable");
});


test("D1 emergency path uses the configured critical threshold even when monitor D1 state is unavailable", async () => {
  const unavailableDb = {
    prepare() { throw new Error("monitor D1 unavailable"); },
    batch() { throw new Error("monitor D1 unavailable"); },
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const usage = {
    worker_requests: 0,
    d1_rows_read: 0,
    d1_rows_written: 95_000,
    kv_reads: 0,
    kv_writes: 0,
    kv_deletes: 0,
    kv_lists: 0,
    workerBreakdown: [],
    d1Breakdown: [],
    kvBreakdown: [],
    breakdownStatus: { workers: "available", d1: "available", kv: "not_configured" },
  };

  await sendD1EmergencyAlerts(baseEnv({ MONITOR_DB: unavailableDb, ALERT_LEVEL_3: "90" }), { ...usage, d1_rows_written: 90_000 }, new Date("2026-09-05T12:00:00Z"), fetchImpl);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /botalert-token\/sendMessage$/);
  assert.match(calls[0].body.text, /90\.0%/);
  assert.match(calls[0].body.text, /at least 90%/i);
});


test("D1 emergency path stays silent below 95 percent and skips unavailable metrics", async () => {
  const unavailableDb = { prepare() { throw new Error("must not touch state"); }, batch() { throw new Error("must not touch state"); } };
  let sends = 0;
  const fetchImpl = async () => { sends += 1; return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  const common = {
    worker_requests: 0, kv_reads: 0, kv_writes: 0, kv_deletes: 0, kv_lists: 0,
    workerBreakdown: [], d1Breakdown: [], kvBreakdown: [],
  };
  await sendD1EmergencyAlerts(baseEnv({ MONITOR_DB: unavailableDb }), { ...common, d1_rows_read: null, d1_rows_written: 94_999 }, new Date("2026-09-05T12:00:00Z"), fetchImpl);
  assert.equal(sends, 0);
});


test("KV namespace breakdown limits concurrent GraphQL requests", async () => {
  const namespaceNames = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`ns-${index}`, `Namespace ${index}`]));
  let activeNamespaces = 0;
  let maxActiveNamespaces = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const query = String(body.query || "");
    if (query.includes("workersInvocationsAdaptive")) {
      return graphQlResponse({ workersInvocationsAdaptive: [{ sum: { requests: 1 }, dimensions: { scriptName: "support" } }] });
    }
    if (query.includes("d1AnalyticsAdaptiveGroups")) {
      return graphQlResponse({ d1AnalyticsAdaptiveGroups: [] });
    }
    if (query.includes("kvOperationsAdaptiveGroups") && body.variables?.namespaceId) {
      activeNamespaces += 1;
      maxActiveNamespaces = Math.max(maxActiveNamespaces, activeNamespaces);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeNamespaces -= 1;
      return graphQlResponse({ kvOperationsAdaptiveGroups: [{ sum: { requests: 1 }, dimensions: { actionType: "read" } }] });
    }
    if (query.includes("kvOperationsAdaptiveGroups")) {
      return graphQlResponse({ kvOperationsAdaptiveGroups: [] });
    }
    throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
  };
  const usage = await fetchCloudflareUsage(baseEnv({
    KV_NAMESPACE_NAMES: JSON.stringify(namespaceNames),
    MONITOR_NAMESPACE_CONCURRENCY: "4",
  }), new Date("2026-09-05T12:00:00Z"), fetchImpl);
  assert.equal(usage.kvBreakdown.length, 12);
  assert.ok(maxActiveNamespaces <= 4, `expected <=4 active namespace requests, saw ${maxActiveNamespaces}`);
});


test("Workers critical alert is sent before monitor state D1 is writable", async () => {
  const unavailableDb = { prepare() { throw new Error("monitor D1 unavailable"); }, batch() { throw new Error("monitor D1 unavailable"); } };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const usage = {
    worker_requests: 95_000,
    d1_rows_read: 0, d1_rows_written: 0,
    kv_reads: 0, kv_writes: 0, kv_deletes: 0, kv_lists: 0,
    workerBreakdown: [], d1Breakdown: [], kvBreakdown: [],
  };
  await sendCoreEmergencyAlerts(baseEnv({ MONITOR_DB: unavailableDb }), usage, new Date("2026-09-05T12:00:00Z"), fetchImpl);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /Workers requests/);
  assert.match(calls[0].body.text, /95\.0%/);
});

test("emergency critical alert metric labels are localized for every metric and locale", async () => {
  const unavailableDb = { prepare() { throw new Error("monitor D1 unavailable"); }, batch() { throw new Error("monitor D1 unavailable"); } };
  const labels = {
    en: { worker_requests: "Workers requests", d1_rows_read: "D1 rows read", d1_rows_written: "D1 rows written", kv_reads: "KV Reads", kv_writes: "KV Writes", kv_deletes: "KV Deletes", kv_lists: "KV Lists" },
    ru: { worker_requests: "Запросы Workers", d1_rows_read: "Чтение строк D1", d1_rows_written: "Запись строк D1", kv_reads: "Чтения KV", kv_writes: "Записи KV", kv_deletes: "Удаления KV", kv_lists: "Списки KV" },
    es: { worker_requests: "Solicitudes de Workers", d1_rows_read: "Filas D1 leídas", d1_rows_written: "Filas D1 escritas", kv_reads: "Lecturas de KV", kv_writes: "Escrituras de KV", kv_deletes: "Eliminaciones de KV", kv_lists: "Listados de KV" },
    zh: { worker_requests: "Workers 请求数", d1_rows_read: "D1 读取行数", d1_rows_written: "D1 写入行数", kv_reads: "KV 读取次数", kv_writes: "KV 写入次数", kv_deletes: "KV 删除次数", kv_lists: "KV 列表次数" },
  };
  const keys = Object.keys(labels.en);
  const usage = Object.fromEntries(keys.map((key) => [key, 1_000_000_000_000]));
  Object.assign(usage, { workerBreakdown: [], d1Breakdown: [], kvBreakdown: [] });

  for (const [locale, translations] of Object.entries(labels)) {
    const calls = [];
    const fetchImpl = async (_url, init) => {
      calls.push(JSON.parse(init.body).text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), { status: 200 });
    };
    const env = baseEnv({ MONITOR_DB: unavailableDb, MONITOR_LOCALE: locale });
    await sendD1EmergencyAlerts(env, usage, new Date("2026-09-05T12:00:00Z"), fetchImpl);
    await sendCoreEmergencyAlerts(env, usage, new Date("2026-09-05T12:00:00Z"), fetchImpl);
    assert.equal(calls.length, keys.length, `${locale} should send one alert for each metric`);
    for (const key of keys) {
      const alert = calls.find((text) => text.includes(translations[key]));
      assert.ok(alert, `${locale} should include ${translations[key]} for ${key}`);
      const marker = /(?:Emergency path:|Аварийное уведомление:|Aviso de emergencia:|紧急通道：)/;
      const markerIndex = alert.search(marker);
      assert.notEqual(markerIndex, -1, `${locale} emergency supplement is missing for ${key}`);
      const supplement = alert.slice(markerIndex);
      assert.ok(supplement.includes(translations[key]), `${locale} emergency supplement should label ${key} as ${translations[key]}`);
      if (locale === "es" || locale === "zh") assert.ok(!supplement.includes(labels.en[key]), `${locale} emergency supplement leaked English label for ${key}`);
    }
  }
});
