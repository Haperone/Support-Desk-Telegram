import { billingDay, normalizePlan } from "../src/cloudflare-plan.js";
import { billingDaySetupLocation, resolveMonitorEnvironment, usagePeriod } from "./plan.js";
import { GraphQlRequestError, retryAfterSeconds } from "../src/http-errors.js";
import { createMonitorContext, MonitorBudgetExhausted } from "./budget.js";
import { requestTelegram } from "../src/telegram-response.js";
import { deferredTelegramResult, recordTelegramCooldown } from "../src/telegram-cooldown.js";
import { readAlertRoute, sendAlert } from './alert-config.js';
import { recordAlertDelivery } from './status-telemetry.js';

// Cloudflare Free/Paid usage monitor.
// State is stored only in D1. This Worker intentionally has no Workers KV binding.

const CLOUDFLARE_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const SNAPSHOT_RETENTION_DAYS = 7;
const MAX_BREAKDOWN_ROWS = 100;
const MAX_CONFIGURED_KV_NAMESPACES = 25;
const ALERT_CLAIM_LEASE_MS = 2 * 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_NAMESPACE_QUERY_CONCURRENCY = 5;
const MAX_NAMESPACE_QUERY_CONCURRENCY = 6;

const PAID_LIMITS = Object.freeze({
  worker_requests: 10_000_000, d1_rows_read: 25_000_000_000, d1_rows_written: 50_000_000,
  kv_reads: 10_000_000, kv_writes: 1_000_000, kv_deletes: 1_000_000, kv_lists: 1_000_000,
});
const METRIC_LABELS = Object.freeze({
  en: Object.freeze({ worker_requests: "Workers requests", d1_rows_read: "D1 rows read", d1_rows_written: "D1 rows written", kv_reads: "KV Reads", kv_writes: "KV Writes", kv_deletes: "KV Deletes", kv_lists: "KV Lists" }),
  ru: Object.freeze({ worker_requests: "Запросы Workers", d1_rows_read: "Чтение строк D1", d1_rows_written: "Запись строк D1", kv_reads: "Чтения KV", kv_writes: "Записи KV", kv_deletes: "Удаления KV", kv_lists: "Списки KV" }),
  es: Object.freeze({ worker_requests: "Solicitudes de Workers", d1_rows_read: "Filas D1 leídas", d1_rows_written: "Filas D1 escritas", kv_reads: "Lecturas de KV", kv_writes: "Escrituras de KV", kv_deletes: "Eliminaciones de KV", kv_lists: "Listados de KV" }),
  zh: Object.freeze({ worker_requests: "Workers 请求数", d1_rows_read: "D1 读取行数", d1_rows_written: "D1 写入行数", kv_reads: "KV 读取次数", kv_writes: "KV 写入次数", kv_deletes: "KV 删除次数", kv_lists: "KV 列表次数" }),
});
function localizedBillingDayLocation(env, locale = 'en') {
  const locations = env.SUPPORT_PLAN
    ? { en: 'Adminushka → Plan and storage → Cloudflare plan', ru: 'Админушка → План и хранилище → План Cloudflare', es: 'Adminushka → Plan y almacenamiento → Plan de Cloudflare', zh: 'Adminushka → 套餐与存储 → Cloudflare 套餐' }
    : { en: 'General /plan', ru: 'General /plan', es: 'General /plan', zh: 'General /plan' };
  return locations[locale] || locations.en;
}
const METRICS = Object.freeze({
  worker_requests: { label: "Workers requests", limitEnv: "LIMIT_WORKER_REQUESTS", defaultLimit: 100_000, unit: "requests" },
  d1_rows_read: { label: "D1 rows read", limitEnv: "LIMIT_D1_ROWS_READ", defaultLimit: 5_000_000, unit: "rows" },
  d1_rows_written: { label: "D1 rows written", limitEnv: "LIMIT_D1_ROWS_WRITTEN", defaultLimit: 100_000, unit: "rows" },
  kv_reads: { label: "KV Reads", limitEnv: "LIMIT_KV_READS", defaultLimit: 100_000, unit: "reads" },
  kv_writes: { label: "KV Writes", limitEnv: "LIMIT_KV_WRITES", defaultLimit: 1_000, unit: "writes" },
  kv_deletes: { label: "KV Deletes", limitEnv: "LIMIT_KV_DELETES", defaultLimit: 1_000, unit: "deletes" },
  kv_lists: { label: "KV Lists", limitEnv: "LIMIT_KV_LISTS", defaultLimit: 1_000, unit: "lists" },
});

const WORKERS_QUERY_WITH_BREAKDOWN = `
query WorkersUsage($accountTag: string, $start: string, $end: string) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 1000
        filter: { datetime_geq: $start, datetime_lt: $end }
      ) {
        sum { requests }
        dimensions { scriptName }
      }
    }
  }
}`;

const WORKERS_QUERY_TOTAL_ONLY = `
query WorkersUsage($accountTag: string, $start: string, $end: string) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 1000
        filter: { datetime_geq: $start, datetime_lt: $end }
      ) { sum { requests } }
    }
  }
}`;

const D1_QUERY_TOTAL = `
query D1Usage($accountTag: string!, $start: Date, $end: Date) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(
        filter: { date_geq: $start, date_leq: $end }
        limit: 10000
      ) {
        sum { rowsRead rowsWritten }
        dimensions { databaseId }
      }
    }
  }
}`;

const KV_QUERY_TOTAL_ONLY = `
query KvUsage($accountTag: string!, $start: Date, $end: Date) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      kvOperationsAdaptiveGroups(
        filter: { date_geq: $start, date_leq: $end }
        limit: 10000
      ) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}`;

// Cloudflare exposes namespaceId as a filter, not as an output dimension.
const KV_QUERY_FOR_NAMESPACE = `
query KvNamespaceUsage($accountTag: string!, $namespaceId: string, $start: Date, $end: Date) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      kvOperationsAdaptiveGroups(
        filter: { namespaceId: $namespaceId, date_geq: $start, date_leq: $end }
        limit: 10000
      ) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}`;

function log(level, event, details = {}) {
  const record = { level, event, ...details };
  const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  writer(JSON.stringify(record));
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function parseThreshold(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) throw new Error(`${name} must be between 0 and 100`);
  return parsed;
}

export function parseConfig(env) {
  const plan = normalizePlan(env.RECOVERY_D1_PLAN);
  // Do not silently treat calendar months as subscription billing periods.
  if (plan === "paid" && billingDay(env.WORKERS_BILLING_DAY) == null) throw new Error(`Set the Workers Paid renewal day in ${billingDaySetupLocation(env)} or WORKERS_BILLING_DAY`);
  const timezone = env.DISPLAY_TIMEZONE || "Europe/Budapest";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date()); }
  catch { throw new Error("DISPLAY_TIMEZONE must be a valid IANA timezone"); }

  const thresholds = [
    parseThreshold(env.ALERT_LEVEL_1, 70, "ALERT_LEVEL_1"),
    parseThreshold(env.ALERT_LEVEL_2, 85, "ALERT_LEVEL_2"),
    parseThreshold(env.ALERT_LEVEL_3, 95, "ALERT_LEVEL_3"),
  ];
  if (!(thresholds[0] < thresholds[1] && thresholds[1] < thresholds[2])) {
    throw new Error("Alert levels must be strictly increasing");
  }
  if (env.ALERT_THREAD_ID !== undefined && env.ALERT_THREAD_ID !== "") {
    positiveInteger(env.ALERT_THREAD_ID, null, "ALERT_THREAD_ID");
  }

  const limits = {};
  for (const [metric, definition] of Object.entries(METRICS)) {
    // Existing LIMIT_* values belong to Free; never carry them into Paid.
    const name = (plan === "paid" ? "PAID_" : "") + definition.limitEnv;
    limits[metric] = positiveInteger(env[name], plan === "paid" ? PAID_LIMITS[metric] : definition.defaultLimit, name);
  }

  let namespaceNames = {};
  if (env.KV_NAMESPACE_NAMES) {
    try { namespaceNames = JSON.parse(env.KV_NAMESPACE_NAMES); }
    catch { throw new Error("KV_NAMESPACE_NAMES must be valid JSON"); }
    if (!namespaceNames || Array.isArray(namespaceNames) || typeof namespaceNames !== "object") {
      throw new Error("KV_NAMESPACE_NAMES must be a JSON object");
    }
    const entries = Object.entries(namespaceNames);
    if (entries.length > MAX_CONFIGURED_KV_NAMESPACES || entries.some(([id, name]) => !String(id).trim() || typeof name !== "string" || !name.trim())) {
      throw new Error(`KV_NAMESPACE_NAMES must contain at most ${MAX_CONFIGURED_KV_NAMESPACES} non-empty string mappings`);
    }
  }

  return {
    plan,
    timezone,
    thresholds,
    limits,
    predictiveHours: positiveInteger(env.PREDICTIVE_WARNING_HOURS, 2, "PREDICTIVE_WARNING_HOURS"),
    namespaceNames,
  };
}

function requireBindings(env) {
  if (!env.MONITOR_DB) throw new Error("MONITOR_DB D1 binding is required");
  if (!env.CF_ACCOUNT_ID) throw new Error("CF_ACCOUNT_ID is required");
  if (!env.CF_ANALYTICS_TOKEN) throw new Error("CF_ANALYTICS_TOKEN secret is required");
  if (env.ALERT_CONFIG_REQUIRED === 'true' && !env.ALERT_CONFIG_KEY) throw new Error("ALERT_CONFIG_KEY secret is required");
  if (!env.ALERT_BOT_TOKEN && !env.ALERT_CONFIG_KEY) throw new Error("Alert bot configuration is required");
  if (env.ALERT_BOT_TOKEN && !env.ALERT_CHAT_ID && !env.ALERT_CONFIG_KEY) throw new Error("ALERT_CHAT_ID is required");
}

function utcDay(date) { return date.toISOString().slice(0, 10); }

function nextUtcReset(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

export function formatLocalReset(date, timezone) {
  const reset = nextUtcReset(date);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(reset);
}

function safeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function graphQlMessages(errors) {
  return (Array.isArray(errors) ? errors : []).map((entry) => String(entry?.message || "GraphQL error")).join("; ").slice(0, 800);
}

function looksLikeSchemaError(message) {
  return /cannot query field|unknown (argument|field|type)|validation error|undefined field|is not defined by type|has no field/i.test(message);
}

export async function graphQl(query, variables, token, fetchImpl, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await fetchImpl(CLOUDFLARE_GRAPHQL_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof GraphQlRequestError || error.name === "MonitorBudgetExhausted") throw error;
    throw new GraphQlRequestError(error?.name === "AbortError" ? "Cloudflare GraphQL request timed out" : "Cloudflare GraphQL network request failed", { category: "network" });
  }

  let payload;
  const details = { httpStatus: response.status, retryAfterSeconds: retryAfterSeconds(response.headers?.get("retry-after")) };
  try { payload = await response.json(); }
  catch { throw new GraphQlRequestError(controller.signal.aborted ? "Cloudflare GraphQL request timed out" : `Cloudflare GraphQL returned HTTP ${response.status} without JSON`, details); }
  finally { clearTimeout(timeout); }
  if (!response.ok) throw new GraphQlRequestError(`Cloudflare GraphQL returned HTTP ${response.status}`, details);
  if (payload?.errors?.length) {
    const message = graphQlMessages(payload.errors);
    throw new GraphQlRequestError(`Cloudflare GraphQL error: ${message}`, looksLikeSchemaError(message));
  }
  if (!payload?.data?.viewer?.accounts?.[0]) throw new GraphQlRequestError("Cloudflare GraphQL returned no account data");
  return payload.data.viewer.accounts[0];
}

async function queryWithSchemaFallback(primary, fallback, variables, token, fetchImpl, dataset, timeoutMs) {
  try {
    return { account: await graphQl(primary, variables, token, fetchImpl, timeoutMs), breakdownAvailable: true };
  } catch (error) {
    if (!(error instanceof GraphQlRequestError) || !error.schemaRelated) throw error;
    log("warn", "graphql_schema_fallback", { dataset, reason: error.message });
    return { account: await graphQl(fallback, variables, token, fetchImpl, timeoutMs), breakdownAvailable: false };
  }
}

function normalizeAction(value) {
  const action = String(value || "").toLowerCase();
  if (["read", "get"].includes(action)) return "read";
  if (["write", "put"].includes(action)) return "write";
  if (["delete", "remove"].includes(action)) return "delete";
  if (["list"].includes(action)) return "list";
  return null;
}

export function normalizeWorkers(rows = []) {
  const scripts = new Map();
  let total = 0;
  for (const row of rows) {
    const requests = safeCount(row?.sum?.requests);
    total += requests;
    const script = row?.dimensions?.scriptName;
    if (script) scripts.set(script, (scripts.get(script) || 0) + requests);
  }
  return {
    total,
    breakdown: [...scripts].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
  };
}

export function normalizeD1(rows = []) {
  const totals = { rowsRead: 0, rowsWritten: 0 };
  const databases = new Map();
  for (const row of rows) {
    const rowsRead = safeCount(row?.sum?.rowsRead);
    const rowsWritten = safeCount(row?.sum?.rowsWritten);
    totals.rowsRead += rowsRead;
    totals.rowsWritten += rowsWritten;
    const databaseId = row?.dimensions?.databaseId;
    if (!databaseId) continue;
    const current = databases.get(databaseId) || { name: String(databaseId), rowsRead: 0, rowsWritten: 0 };
    current.rowsRead += rowsRead;
    current.rowsWritten += rowsWritten;
    databases.set(databaseId, current);
  }
  return { totals, breakdown: [...databases.values()] };
}

export function normalizeKv(rows = [], namespaceNames = {}) {
  const totals = { read: 0, write: 0, delete: 0, list: 0 };
  const namespaces = new Map();
  for (const row of rows) {
    const action = normalizeAction(row?.dimensions?.actionType);
    if (!action) continue;
    const requests = safeCount(row?.sum?.requests);
    totals[action] += requests;
    const namespaceId = row?.dimensions?.namespaceId;
    if (!namespaceId) continue;
    const name = String(namespaceNames[namespaceId] || namespaceId);
    const current = namespaces.get(name) || { name, read: 0, write: 0, delete: 0, list: 0 };
    current[action] += requests;
    namespaces.set(name, current);
  }
  return { totals, breakdown: [...namespaces.values()] };
}

export async function fetchCloudflareUsage(env, now = new Date(), fetchImpl = fetch) {
  const config = parseConfig(env);
  const timeoutMs = Math.min(positiveInteger(env.MONITOR_FETCH_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS, "MONITOR_FETCH_TIMEOUT_MS"), MAX_FETCH_TIMEOUT_MS);
  const namespaceConcurrency = Math.min(positiveInteger(env.MONITOR_NAMESPACE_CONCURRENCY, DEFAULT_NAMESPACE_QUERY_CONCURRENCY, "MONITOR_NAMESPACE_CONCURRENCY"), MAX_NAMESPACE_QUERY_CONCURRENCY);
  const shared = { accountTag: env.CF_ACCOUNT_ID };
  const period = usagePeriod(env, now);
  const workerVariables = { ...shared, start: period.start, end: now.toISOString() };
  const dayVariables = { ...shared, start: period.start.slice(0, 10), end: utcDay(now) };
  const [workersResult, kvAccount, d1Result] = await Promise.all([
    queryWithSchemaFallback(WORKERS_QUERY_WITH_BREAKDOWN, WORKERS_QUERY_TOTAL_ONLY, workerVariables, env.CF_ANALYTICS_TOKEN, fetchImpl, "workersInvocationsAdaptive", timeoutMs),
    graphQl(KV_QUERY_TOTAL_ONLY, dayVariables, env.CF_ANALYTICS_TOKEN, fetchImpl, timeoutMs),
    graphQl(D1_QUERY_TOTAL, dayVariables, env.CF_ANALYTICS_TOKEN, fetchImpl, timeoutMs)
      .then((account) => ({ ok: true, account }))
      .catch((error) => ({ ok: false, error })),
  ]);
  const workers = normalizeWorkers(workersResult.account.workersInvocationsAdaptive || []);
  const kv = normalizeKv(kvAccount.kvOperationsAdaptiveGroups || []);
  const d1 = d1Result.ok ? normalizeD1(d1Result.account.d1AnalyticsAdaptiveGroups || []) : null;
  if (!d1Result.ok) {
    log("warn", "d1_usage_fetch_failed_partial", { reason: String(d1Result.error?.message || d1Result.error).slice(0, 800) });
  }
  const namespaceEntries = Object.entries(config.namespaceNames);
  const namespaceResults = await mapWithConcurrency(namespaceEntries, namespaceConcurrency, async ([namespaceId, configuredName]) => {
    try {
      const account = await graphQl(
        KV_QUERY_FOR_NAMESPACE,
        { ...dayVariables, namespaceId },
        env.CF_ANALYTICS_TOKEN,
        fetchImpl,
        timeoutMs,
      );
      const totals = normalizeKv(account.kvOperationsAdaptiveGroups || []).totals;
      return { ok: true, item: { name: configuredName, ...totals } };
    } catch (error) {
      log("warn", "kv_namespace_breakdown_failed", { namespace_id: namespaceId, reason: String(error?.message || error).slice(0, 800) });
      return { ok: false };
    }
  });
  const kvBreakdown = namespaceResults.filter((result) => result.ok).map((result) => result.item);
  const failedNamespaces = namespaceResults.filter((result) => !result.ok).length;
  return {
    period,
    worker_requests: workers.total,
    d1_rows_read: d1 ? d1.totals.rowsRead : null,
    d1_rows_written: d1 ? d1.totals.rowsWritten : null,
    kv_reads: kv.totals.read,
    kv_writes: kv.totals.write,
    kv_deletes: kv.totals.delete,
    kv_lists: kv.totals.list,
    workerBreakdown: workersResult.breakdownAvailable ? workers.breakdown : [],
    d1Breakdown: d1 ? d1.breakdown : [],
    kvBreakdown,
    breakdownStatus: {
      workers: workersResult.breakdownAvailable ? "available" : "schema_fallback",
      d1: d1 ? "available" : "unavailable",
      kv: namespaceEntries.length === 0 ? "not_configured" : failedNamespaces === 0 ? "available" : "partial",
    },
  };
}

function dbFirst(db, sql, ...params) { return db.prepare(sql).bind(...params).first(); }
function dbRun(db, sql, ...params) { return db.prepare(sql).bind(...params).run(); }

async function getState(db, key) {
  const row = await dbFirst(db, "SELECT value FROM monitor_state WHERE key = ?", key);
  return row?.value ?? null;
}

async function setState(db, key, value) {
  await dbRun(db, "INSERT INTO monitor_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(value));
}

async function saveSnapshot(db, now, usage) {
  // Keep the existing schema: day_utc stores a date on Free or paid:<period start>.
  await dbRun(db, `INSERT INTO usage_snapshots (
    checked_at, day_utc, worker_requests, d1_rows_read, d1_rows_written, kv_reads, kv_writes, kv_deletes, kv_lists
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  now.toISOString(), usage.period?.key || utcDay(now), usage.worker_requests, usage.d1_rows_read, usage.d1_rows_written, usage.kv_reads, usage.kv_writes, usage.kv_deletes, usage.kv_lists);
}

async function saveBreakdowns(db, now, usage) {
  const rows = [];
  for (const item of usage.workerBreakdown.slice(0, MAX_BREAKDOWN_ROWS)) {
    rows.push(["worker", item.name, "requests", item.value]);
  }
  for (const item of usage.kvBreakdown) {
    for (const operation of ["read", "write", "delete", "list"]) {
      if (item[operation] > 0) rows.push(["kv_namespace", item.name, operation, item[operation]]);
    }
  }
  rows.sort((a, b) => b[3] - a[3]);
  const limited = rows.slice(0, MAX_BREAKDOWN_ROWS);
  if (limited.length === 0) return;
  await dbRun(db, `INSERT INTO usage_breakdowns (checked_at, resource_kind, resource_name, operation, usage_value)
    SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]')
    FROM json_each(?)`, now.toISOString(), JSON.stringify(limited));
}

async function previousSnapshot(db, now, period) {
  const before = new Date(now.getTime() - 45 * 60_000).toISOString();
  const after = new Date(now.getTime() - 2 * 60 * 60_000).toISOString();
  return dbFirst(db, `SELECT checked_at, worker_requests, d1_rows_read, d1_rows_written, kv_reads, kv_writes, kv_deletes, kv_lists
    FROM usage_snapshots
    WHERE day_utc = ? AND checked_at <= ? AND checked_at >= ?
    ORDER BY checked_at DESC LIMIT 1`, period?.key || utcDay(now), before, after);
}

export function calculateTrend(current, previous, currentTime, previousTime, limit) {
  if (previous === null || previous === undefined || !previousTime) return null;
  const hours = (new Date(currentTime).getTime() - new Date(previousTime).getTime()) / 3_600_000;
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const burnRate = (current - Number(previous)) / hours;
  if (!Number.isFinite(burnRate) || burnRate <= 0) return { burnRate: 0, etaHours: null };
  const remaining = Math.max(0, limit - current);
  return { burnRate, etaHours: remaining / burnRate };
}

export function reachedThresholds(value, limit, thresholds) {
  const percent = limit > 0 ? (value / limit) * 100 : 0;
  return thresholds.filter((threshold) => percent >= threshold).map(String);
}

export function selectAlertDecision({ value, limit, thresholds, sentLevels, trend, predictiveHours }) {
  const reached = reachedThresholds(value, limit, thresholds);
  const unsentThresholds = reached.filter((level) => !sentLevels.has(level));
  const predictive = value >= limit * 0.3
    && trend?.burnRate > 0
    && trend?.etaHours !== null
    && trend.etaHours <= predictiveHours
    && !sentLevels.has("predictive");
  if (unsentThresholds.length === 0 && !predictive) return null;
  return {
    level: unsentThresholds.at(-1) || "predictive",
    levelsToMark: [...unsentThresholds, ...(predictive ? ["predictive"] : [])],
  };
}

function duration(hours, locale='en') {
  if (hours === null || !Number.isFinite(hours)) return ({en:'unknown',ru:'неизвестно',es:'desconocido',zh:'未知'})[locale]||'unknown';
  const minutes = Math.max(0, Math.round(hours * 60));
  if (minutes < 60) return `~${minutes}${locale==='zh'?'分钟':'m'}`;
  const wholeHours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return locale==='zh'?`约${wholeHours}小时${remainder?` ${remainder}分钟`:''}`:`~${wholeHours}${locale==='es'?' h':'h'}${remainder ? ` ${remainder}${locale==='es'?' min':'m'}` : ""}`;
}

function formatNumber(number, locale='en') { return Math.round(number).toLocaleString(({en:'en-US',ru:'ru-RU',es:'es-ES',zh:'zh-CN'})[locale]||'en-US'); }

function topBreakdown(metric, usage, locale='en') {
  if (metric === "worker_requests") {
    return usage.workerBreakdown.slice(0, 3).map((item) => `${item.name}: ${formatNumber(item.value,locale)}`);
  }
  if (metric === "d1_rows_read" || metric === "d1_rows_written") {
    const field = metric === "d1_rows_read" ? "rowsRead" : "rowsWritten";
    return usage.d1Breakdown
      .map((item) => ({ name: item.name, value: item[field] || 0 }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3)
      .map((item) => `${item.name}: ${formatNumber(item.value,locale)}`);
  }
  const operation = metric.replace("kv_", "").replace(/s$/, "");
  return usage.kvBreakdown
    .map((item) => ({ name: item.name, value: item[operation] || 0 }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((item) => `${item.name}: ${formatNumber(item.value,locale)}`);
}

export function formatUsageAlert(metric, value, limit, level, trend, usage, now, timezone, period = usage.period || usagePeriod({}, now), requestedLocale='en') {
  const locale = ['ru','en','es','zh'].includes(requestedLocale) ? requestedLocale : 'en';
  const words = {
    en: {metrics:METRIC_LABELS.en, paid:'Cloudflare Paid included usage',critical:'CLOUDFLARE LIMIT CRITICAL',predictive:'Cloudflare predictive warning',usage:'Cloudflare usage',remaining:'Remaining',rate:'Current rate',exhaustion:'Estimated exhaustion',top:'Top contributors',billing:'Billing period',paidNote:'Monthly included usage; additional usage is billed, not blocked.',reset:'Reset',unverified:'Plan lookup failed. These are daily Free reference thresholds; the current account plan is unconfirmed.'},
    ru: {metrics:METRIC_LABELS.ru,paid:'Включённый объём Cloudflare Paid',critical:'КРИТИЧЕСКИЙ ЛИМИТ CLOUDFLARE',predictive:'Прогноз использования Cloudflare',usage:'Использование Cloudflare',remaining:'Осталось',rate:'Текущий темп',exhaustion:'Ожидаемое исчерпание',top:'Основные источники',billing:'Расчётный период',paidNote:'Месячный включённый объём; дополнительное использование оплачивается, но не блокируется.',reset:'Сброс',unverified:'Не удалось проверить тариф. Показаны дневные ориентиры Free; текущий тариф аккаунта не подтверждён.'},
    es: {metrics:METRIC_LABELS.es,paid:'Uso incluido de Cloudflare Paid',critical:'LÍMITE CRÍTICO DE CLOUDFLARE',predictive:'Aviso predictivo de Cloudflare',usage:'Uso de Cloudflare',remaining:'Restante',rate:'Ritmo actual',exhaustion:'Agotamiento estimado',top:'Principales contribuyentes',billing:'Período de facturación',paidNote:'Uso mensual incluido; el uso adicional se factura, no se bloquea.',reset:'Restablecimiento',unverified:'No se pudo consultar el plan. Estos son límites diarios de referencia de Free; el plan actual no está confirmado.'},
    zh: {metrics:METRIC_LABELS.zh,paid:'Cloudflare Paid 套餐包含的用量',critical:'CLOUDFLARE 用量达到严重限制',predictive:'Cloudflare 用量预测警告',usage:'Cloudflare 用量',remaining:'剩余',rate:'当前速率',exhaustion:'预计耗尽时间',top:'主要来源',billing:'计费周期',paidNote:'月度包含用量；超出部分会计费，不会被阻止。',reset:'重置时间',unverified:'无法查询套餐。以下为 Free 每日参考阈值；当前账户套餐尚未确认。'},
  }[locale];
  const definition = METRICS[metric];
  const percent = limit > 0 ? (value / limit) * 100 : 0;
  const icon = level === "predictive" ? "⚠️" : Number(level) >= 95 ? "🔴" : Number(level) >= 85 ? "🟠" : "🟡";
  const title = period.plan === "paid" ? words.paid : Number(level) >= 95 ? words.critical : level === "predictive" ? words.predictive : words.usage;
  const lines = [
    `${icon} ${title}`,
    "",
    words.metrics[metric] || definition.label,
    `${Number(value).toLocaleString(locale === 'zh' ? 'zh-CN' : locale === 'ru' ? 'ru-RU' : locale === 'es' ? 'es-ES' : 'en-US')} / ${Number(limit).toLocaleString(locale === 'zh' ? 'zh-CN' : locale === 'ru' ? 'ru-RU' : locale === 'es' ? 'es-ES' : 'en-US')}`,
    `${percent.toLocaleString(locale === 'zh' ? 'zh-CN' : locale === 'ru' ? 'ru-RU' : locale === 'es' ? 'es-ES' : 'en-US',{minimumFractionDigits:1,maximumFractionDigits:1})}%`,
    "",
    `${words.remaining}: ${Number(Math.max(0, limit - value)).toLocaleString(locale === 'zh' ? 'zh-CN' : locale === 'ru' ? 'ru-RU' : locale === 'es' ? 'es-ES' : 'en-US')}`,
  ];
  if (trend?.burnRate > 0) {
    const perHour={en:'/hour',ru:'/ч',es:'/h',zh:'/小时'}[locale];
    lines.push("", `${words.rate}: +${formatNumber(trend.burnRate,locale)}${perHour}`, `${words.exhaustion}: ${duration(trend.etaHours,locale)}`);
  }
  const breakdown = topBreakdown(metric, usage, locale);
  if (breakdown.length) lines.push("", `${words.top}:`, ...breakdown);
  if (period.plan === "paid") {
    lines.push("", `${words.billing}: ${period.start.slice(0, 10)} → ${period.end.slice(0, 10)} (UTC)`, words.paidNote);
  } else lines.push("", `${words.reset}: 00:00 UTC / ${formatLocalReset(now, timezone)} ${timezone}`);
  if (period.unverified) lines.push("", words.unverified);
  return lines.join("\n");
}

export async function sendTelegram(env, text, fetchImpl = fetch) {
  const route = await readAlertRoute(env);
  if (!route) return { ok: false, disabled: true, description: 'Alert delivery disabled' };
  const timeoutMs = Math.min(positiveInteger(env.MONITOR_FETCH_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS, "MONITOR_FETCH_TIMEOUT_MS"), MAX_FETCH_TIMEOUT_MS);
  const bot = { id: "monitor-alerts", token: route.token };
  const deferred = deferredTelegramResult(env.MONITOR_DB, bot);
  if (deferred) return deferred;
  const result = await sendAlert(env, text, fetchImpl, route, timeoutMs);
  await recordAlertDelivery(env, result);
  if (env.MONITOR_HEALTH_ENABLED === "true" && result.rateLimited) {
    try { await recordTelegramCooldown(env.MONITOR_DB, bot, "sendMessage", result); }
    catch { log("error", "telegram_cooldown_not_saved", { bot_id: "monitor-alerts" }); }
  }
  return result.ok ? { ok: true } : result;
}

async function sentLevels(db, day, metric) {
  const result = await db.prepare("SELECT alert_level FROM sent_alerts WHERE day_utc = ? AND metric = ?").bind(day, metric).all();
  return new Set((result.results || []).map((row) => String(row.alert_level)));
}

async function claimMetricAlert(db, day, metric, now) {
  const owner = crypto.randomUUID();
  const expires = new Date(now.getTime() + ALERT_CLAIM_LEASE_MS).toISOString();
  const row = await dbFirst(db, `INSERT INTO alert_claims (day_utc, metric, owner_token, lease_expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(day_utc, metric) DO UPDATE SET owner_token = excluded.owner_token, lease_expires_at = excluded.lease_expires_at
    WHERE alert_claims.lease_expires_at <= ? RETURNING owner_token`, day, metric, owner, expires, now.toISOString());
  return row?.owner_token || null;
}
async function releaseMetricAlert(db, day, metric, owner) { await dbRun(db, "DELETE FROM alert_claims WHERE day_utc = ? AND metric = ? AND owner_token = ?", day, metric, owner); }
async function markSent(db, day, metric, levels, now, value) {
  if (!levels.length) return;
  await dbRun(db, `INSERT INTO sent_alerts (day_utc, metric, alert_level, sent_at, usage_value)
    SELECT ?, ?, value, ?, ? FROM json_each(?) WHERE true
    ON CONFLICT(day_utc, metric, alert_level) DO NOTHING`, day, metric, now.toISOString(), value, JSON.stringify(levels));
}

async function unmarkSent(db, day, metric, levels) {
  const statements = levels.map((level) => db.prepare("DELETE FROM sent_alerts WHERE day_utc = ? AND metric = ? AND alert_level = ?").bind(day, metric, level));
  if (statements.length) await db.batch(statements);
}

export async function processUsageAlerts(env, usage, previous, now = new Date(), fetchImpl = fetch) {
  const config = parseConfig(env);
  const period = usagePeriod(env, now);
  const day = period.key;
  const initial = await env.MONITOR_DB.prepare("SELECT metric, alert_level FROM sent_alerts WHERE day_utc = ?").bind(day).all();
  for (const [metric] of Object.entries(METRICS)) {
    const value = usage[metric];
    if (value === null || value === undefined || !Number.isFinite(Number(value))) continue;
    const limit = config.limits[metric];
    const trend = calculateTrend(value, previous?.[metric], now, previous?.checked_at, limit);
    let sent = new Set((initial.results || []).filter((row) => row.metric === metric).map((row) => String(row.alert_level)));
    let decision = selectAlertDecision({ value, limit, thresholds: config.thresholds, sentLevels: sent, trend, predictiveHours: config.predictiveHours });
    if (!decision) continue;
    if (env.MONITOR_HEALTH_ENABLED === "true") {
      try { env.MONITOR_CONTEXT?.budget.checkpoint(6, 1); }
      catch (error) { if (error instanceof MonitorBudgetExhausted) break; throw error; }
    }
    const owner = await claimMetricAlert(env.MONITOR_DB, day, metric, now);
    if (!owner) continue;
    try {
      sent = await sentLevels(env.MONITOR_DB, day, metric);
      decision = selectAlertDecision({ value, limit, thresholds: config.thresholds, sentLevels: sent, trend, predictiveHours: config.predictiveHours });
      if (!decision) continue;
      const message = formatUsageAlert(metric, value, limit, decision.level, trend, usage, now, config.timezone, period, env.MONITOR_LOCALE || 'en');
      const result = await sendTelegram(env, message, fetchImpl);
      if (!result.ok) {
        log("error", "telegram_usage_alert_failed", { metric, alert_level: decision.level, description: result.description, delivery_uncertain: result.deliveryUncertain === true });
        continue;
      }
      await markSent(env.MONITOR_DB, day, metric, decision.levelsToMark, now, value);
      log("info", "usage_alert_sent", { metric, alert_level: decision.level, usage_value: value });
    } finally { await releaseMetricAlert(env.MONITOR_DB, day, metric, owner); }
  }
}

export async function handleApiFailure(env, now, error, fetchImpl = fetch) {
  const row = await dbFirst(env.MONITOR_DB, `INSERT INTO monitor_state (key, value)
    VALUES ('consecutive_api_failures', '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(COALESCE(value, '0') AS INTEGER) + 1
    RETURNING value`);
  const failures = Number(row?.value || 1);
  log(failures >= 2 ? "warn" : "info", "cloudflare_usage_fetch_failed", { failures, reason: String(error?.message || "Unknown error").slice(0, 800) });
  if (failures < 3 || await getState(env.MONITOR_DB, "api_failure_alert_sent") === "1") return;
  const day = utcDay(now);
  const owner = await claimMetricAlert(env.MONITOR_DB, day, "__api_health_failure__", now);
  if (!owner) return;
  try {
    if (await getState(env.MONITOR_DB, "api_failure_alert_sent") === "1") return;
    const currentFailures = Number(await getState(env.MONITOR_DB, "consecutive_api_failures") || 0);
    if (currentFailures < 3) return;
    const lastSuccess = await getState(env.MONITOR_DB, "last_successful_check");
    const result = await sendTelegram(env, [
      ({en:"⚠️ Cloudflare Monitor problem",ru:"⚠️ Проблема монитора Cloudflare",es:"⚠️ Problema del monitor de Cloudflare",zh:"⚠️ Cloudflare 监控出现问题"}[env.MONITOR_LOCALE] || "⚠️ Cloudflare Monitor problem"),
      "",
      ({en:`Failed to retrieve usage metrics ${currentFailures} times in a row.`,ru:`Не удалось получить метрики использования ${currentFailures} раз подряд.`,es:`No se pudieron obtener las métricas de uso ${currentFailures} veces seguidas.`,zh:`连续 ${currentFailures} 次未能获取用量指标。`}[env.MONITOR_LOCALE] || `Failed to retrieve usage metrics ${currentFailures} times in a row.`),
      "",
      ({en:`Last successful check: ${lastSuccess || "never"}`,ru:`Последняя успешная проверка: ${lastSuccess || "никогда"}`,es:`Última comprobación correcta: ${lastSuccess || "nunca"}`,zh:`上次成功检查：${lastSuccess || "从未"}`}[env.MONITOR_LOCALE] || `Last successful check: ${lastSuccess || "never"}`),
      "",
      ({en:`Check CF_ANALYTICS_TOKEN, the GraphQL API, SUPPORT_PLAN and the renewal day in ${localizedBillingDayLocation(env, 'en')}.`,ru:`Проверьте CF_ANALYTICS_TOKEN, GraphQL API, SUPPORT_PLAN и дату продления в ${localizedBillingDayLocation(env, 'ru')}.`,es:`Revisa CF_ANALYTICS_TOKEN, la API GraphQL, SUPPORT_PLAN y el día de renovación en ${localizedBillingDayLocation(env, 'es')}.`,zh:`请检查 CF_ANALYTICS_TOKEN、GraphQL API、SUPPORT_PLAN，以及 ${localizedBillingDayLocation(env, 'zh')} 中的续费日期。`}[env.MONITOR_LOCALE] || `Check CF_ANALYTICS_TOKEN, the GraphQL API, SUPPORT_PLAN and the renewal day in ${localizedBillingDayLocation(env, 'en')}.`),
    ].join("\n"), fetchImpl);
    if (!result.ok) {
      log("error", "telegram_health_alert_failed", { description: result.description, delivery_uncertain: result.deliveryUncertain === true });
    } else {
      await setState(env.MONITOR_DB, "api_failure_alert_sent", "1");
    }
  } finally {
    await releaseMetricAlert(env.MONITOR_DB, day, "__api_health_failure__", owner);
  }
}

export async function handleApiSuccess(env, now, fetchImpl = fetch) {
  const failureAlertSent = await getState(env.MONITOR_DB, "api_failure_alert_sent") === "1";
  if (failureAlertSent) {
    const day = utcDay(now);
    const owner = await claimMetricAlert(env.MONITOR_DB, day, "__api_health_recovery__", now);
    if (owner) {
      try {
        if (await getState(env.MONITOR_DB, "api_failure_alert_sent") === "1") {
          const result = await sendTelegram(env, ({en:"✅ Cloudflare Monitor recovered\n\nUsage monitoring is working again.",ru:"✅ Монитор Cloudflare восстановлен\n\nМониторинг использования снова работает.",es:"✅ Monitor de Cloudflare recuperado\n\nLa supervisión del uso vuelve a funcionar.",zh:"✅ Cloudflare 监控已恢复\n\n用量监控已重新运行。"}[env.MONITOR_LOCALE] || "✅ Cloudflare Monitor recovered\n\nUsage monitoring is working again."), fetchImpl);
          if (!result.ok) {
            log("error", "telegram_recovery_alert_failed", { description: result.description, delivery_uncertain: result.deliveryUncertain === true });
          } else {
            await setState(env.MONITOR_DB, "api_failure_alert_sent", "0");
            await setState(env.MONITOR_DB, "last_recovery_alert", now.toISOString());
          }
        }
      } finally {
        await releaseMetricAlert(env.MONITOR_DB, day, "__api_health_recovery__", owner);
      }
    }
  }
  await setState(env.MONITOR_DB, "consecutive_api_failures", "0");
  await setState(env.MONITOR_DB, "last_successful_check", now.toISOString());
}

async function pruneSnapshots(db, now) {
  const day = utcDay(now);
  if (await getState(db, "last_snapshot_prune_day") === day) return;
  await dbRun(db, `DELETE FROM usage_snapshots WHERE checked_at < datetime('now', '-${SNAPSHOT_RETENTION_DAYS} days')`);
  await setState(db, "last_snapshot_prune_day", day);
}

async function sendPreStateCriticalAlerts(env, usage, metrics, now = new Date(), fetchImpl = fetch) {
  const config = parseConfig(env);
  if (config.plan === "paid") return; // Paid inclusion thresholds are not hard D1 outages.
  const period = usagePeriod(env, now);
  const day = period.key;
  const criticalLevel = config.thresholds[config.thresholds.length - 1];
  for (const metric of metrics) {
    const rawValue = usage[metric];
    if (rawValue === null || rawValue === undefined || !Number.isFinite(Number(rawValue))) continue;
    const value = Number(rawValue);
    const limit = config.limits[metric];
    if (value < limit * criticalLevel / 100) continue;
    const reached = reachedThresholds(value, limit, config.thresholds);
    const markerLevels = [...new Set([...reached, "emergency"])];
    let alreadySent = false;
    try {
      const sent = await sentLevels(env.MONITOR_DB, day, metric);
      alreadySent = sent.has("emergency") || sent.has(String(criticalLevel));
    } catch (error) {
      log("warn", "prestate_critical_dedupe_unavailable", { metric, reason: String(error?.message || error).slice(0, 800) });
    }
    if (alreadySent) continue;
    const locale = ['ru','en','es','zh'].includes(env.MONITOR_LOCALE) ? env.MONITOR_LOCALE : 'en';
    const label = METRIC_LABELS[locale]?.[metric] || METRICS[metric].label;
    const text = formatUsageAlert(metric, value, limit, String(criticalLevel), null, usage, now, config.timezone, period, locale)
      + ({en:`\n\nEmergency path: ${label} reached at least ${criticalLevel}% of its daily quota; this critical alert does not depend on monitor state being writable.`,ru:`\n\nАварийное уведомление: ${label} достигло ${criticalLevel}% дневного лимита. Для отправки этого уведомления не требуется запись состояния монитора.`,es:`\n\nAviso de emergencia: ${label} alcanzó al menos el ${criticalLevel}% de la cuota diaria. Esta alerta no depende de que se pueda guardar el estado del monitor.`,zh:`\n\n紧急通道：${label} 已达到每日配额的 ${criticalLevel}%。发送此严重警报无需写入监控状态。`}[locale]);
    const result = await sendTelegram(env, text, fetchImpl);
    if (!result.ok) {
      log("error", "telegram_prestate_critical_alert_failed", { metric, description: result.description, delivery_uncertain: result.deliveryUncertain === true });
      continue;
    }
    try { await markSent(env.MONITOR_DB, day, metric, markerLevels, now, value); }
    catch (error) { log("warn", "prestate_critical_mark_unavailable", { metric, reason: String(error?.message || error).slice(0, 800) }); }
    log("warn", "prestate_critical_alert_sent", { metric, alert_level: criticalLevel, usage_value: value, limit });
  }
}

export async function sendD1EmergencyAlerts(env, usage, now = new Date(), fetchImpl = fetch) {
  return sendPreStateCriticalAlerts(env, usage, ["d1_rows_read", "d1_rows_written"], now, fetchImpl);
}

export async function sendCoreEmergencyAlerts(env, usage, now = new Date(), fetchImpl = fetch) {
  return sendPreStateCriticalAlerts(env, usage, ["worker_requests", "kv_reads", "kv_writes", "kv_deletes", "kv_lists"], now, fetchImpl);
}

export async function runMonitor(env, options = {}) {
  requireBindings(env);
  const now = options.now || new Date();
  const context = createMonitorContext(env, options.fetchImpl || fetch);
  env = context.env;
  const fetchImpl = context.fetch;
  try {
    env = env.MONITOR_PLAN_RESOLVED ? env : await resolveMonitorEnvironment(env);
    context.budget.setPlan(env.RECOVERY_D1_PLAN);
    parseConfig(env);
  } catch (error) {
    if (error instanceof MonitorBudgetExhausted) throw error;
    log("error", "monitor_plan_unavailable", { reason: error.message });
    // A read-cap outage can disable the plan provider as well as monitor D1.
    // Preserve critical Free reference alerts without inventing a confirmed plan
    // or poisoning the normal period's dedupe/trend history.
    const fallback = { ...env, RECOVERY_D1_PLAN: "free", MONITOR_PLAN_UNVERIFIED: true };
    try {
      const usage = await fetchCloudflareUsage(fallback, now, fetchImpl);
      await sendD1EmergencyAlerts(fallback, usage, now, fetchImpl);
      await sendCoreEmergencyAlerts(fallback, usage, now, fetchImpl);
    } catch (fallbackError) { log("error", "monitor_plan_fallback_failed", { reason: fallbackError.message }); }
    try { await handleApiFailure(fallback, now, error, fetchImpl); }
    catch (stateError) { log("warn", "monitor_plan_health_state_unavailable", { reason: stateError.message }); }
    return { ok: false, error: error.message };
  }
  let usage;
  try {
    usage = await fetchCloudflareUsage(env, now, fetchImpl);
  } catch (error) {
    await handleApiFailure(env, now, error, fetchImpl);
    return { ok: false, error: error.message };
  }

  // D1 can become unavailable at the hard daily cap. Send a critical alert at 95%
  // before ordinary monitor-state reads/writes; D1-backed dedupe is best effort only.
  await sendD1EmergencyAlerts(env, usage, now, fetchImpl);
  await sendCoreEmergencyAlerts(env, usage, now, fetchImpl);

  // Reset Cloudflare API health immediately after the required Workers/KV API reads.
  // A D1 analytics-only failure is partial degradation and must not suppress them.
  await handleApiSuccess(env, now, fetchImpl);

  const previous = await previousSnapshot(env.MONITOR_DB, now, usage.period);
  await saveSnapshot(env.MONITOR_DB, now, usage);
  await saveBreakdowns(env.MONITOR_DB, now, usage);
  await processUsageAlerts(env, usage, previous, now, fetchImpl);
  await pruneSnapshots(env.MONITOR_DB, now);
  log("info", "monitor_check_complete", {
    plan: usage.period.plan,
    period_start: usage.period.start,
    period_end: usage.period.end,
    day_utc: utcDay(now),
    worker_requests: usage.worker_requests,
    d1_rows_read: usage.d1_rows_read,
    d1_rows_written: usage.d1_rows_written,
    kv_reads: usage.kv_reads,
    kv_writes: usage.kv_writes,
    kv_deletes: usage.kv_deletes,
    kv_lists: usage.kv_lists,
    breakdown_status: usage.breakdownStatus,
  });
  return { ok: true, usage };
}

export default {
  scheduled(_controller, env, ctx) {
    const task = runMonitor(env).catch((error) => log("error", "monitor_check_failed", { reason: String(error?.message || error).slice(0, 800) }));
    ctx.waitUntil(task);
    return task;
  },
  fetch() {
    return new Response("Cloudflare usage monitor is active.\n", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
