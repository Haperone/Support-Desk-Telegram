import { graphQl } from "./worker.js";
import { observeIncident } from "./incidents.js";
import { monitorText } from "./incident-copy.js";

const STATUS_QUERY = `query RuntimeStatus($accountTag: string, $start: string, $end: string, $script: string) {
  viewer { accounts(filter: {accountTag: $accountTag}) {
    workersInvocationsAdaptive(limit: 100, filter: {scriptName: $script, datetime_geq: $start, datetime_leq: $end}) {
      dimensions { status datetimeFifteenMinutes } sum { requests errors }
    }
  } }
}`;
const cpuQuery = (p90) => `query RuntimeCpu($accountTag: string, $start: string, $end: string, $script: string) {
  viewer { accounts(filter: {accountTag: $accountTag}) {
    workersInvocationsAdaptive(limit: 10, filter: {scriptName: $script, datetime_geq: $start, datetime_leq: $end}) {
      dimensions { scriptName datetimeFifteenMinutes } sum { requests } quantiles { cpuTimeP99 ${p90 ? "cpuTimeP90" : ""} }
    }
  } }
}`;

export function summarizeRuntime(rows) {
  if (!Array.isArray(rows) || rows.length >= 100) return { quality: "unavailable" };
  const result = { requests: 0, exceptions: 0, exceededResources: 0, quality: "available" };
  const known = new Set(["success", "clientDisconnected", "scriptThrewException", "exceededResources", "internalError"]);
  for (const row of rows) {
    const count = row?.sum?.requests;
    const status = row?.dimensions?.status;
    if (!Number.isSafeInteger(count) || count < 0 || !known.has(status)) { result.quality = "partial"; continue; }
    result.requests += count;
    if (["scriptThrewException", "internalError"].includes(status)) result.exceptions += count;
    if (status === "exceededResources") result.exceededResources += count;
  }
  return result;
}

export async function collectRuntime(env, now, fetchImpl) {
  env.MONITOR_CONTEXT?.budget.checkpoint(13, 3);
  const scripts = JSON.parse(env.RUNTIME_SCRIPT_NAMES || '["telegram-private-chatbot","telegram-support-usage-monitor"]');
  if (!Array.isArray(scripts) || scripts.length === 0 || scripts.length > 100 || scripts.some((value) => typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))) throw new Error("Invalid RUNTIME_SCRIPT_NAMES");
  const cursor = await env.MONITOR_DB.prepare(`INSERT INTO monitor_state(key, value) VALUES ('runtime_cursor', '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value`).first();
  const script = scripts[(Number(cursor.value) - 1) % scripts.length];
  const endMs = Math.floor((now.getTime() - 5 * 60_000) / (15 * 60_000)) * 15 * 60_000;
  const end = new Date(endMs).toISOString();
  // Re-read an overlapping lookback so a rotated/deferred job does not silently
  // miss the intervals between polls. Percentiles stay inside each 15m bucket.
  const start = new Date(endMs - 2 * 60 * 60_000).toISOString();
  const variables = { accountTag: env.CF_ACCOUNT_ID, script, start, end: new Date(endMs - 1).toISOString() };
  const status = await graphQl(STATUS_QUERY, variables, env.CF_ANALYTICS_TOKEN, fetchImpl);
  const windows = new Map();
  const validWindow = (value) => Number.isFinite(Date.parse(value)) && Date.parse(value) % 900000 === 0
    && Date.parse(value) >= Date.parse(start) && Date.parse(value) < endMs;
  const statusRows = status.workersInvocationsAdaptive;
  if (!Array.isArray(statusRows) || statusRows.length >= 100 || statusRows.some((row) => !validWindow(row.dimensions?.datetimeFifteenMinutes))) throw new Error('Runtime time buckets are unavailable or truncated');
  for (const row of statusRows) {
    const key = new Date(row.dimensions.datetimeFifteenMinutes).toISOString();
    if (!windows.has(key)) windows.set(key, []);
    windows.get(key).push(row);
  }
  const summaries = [...windows.values()].map(summarizeRuntime);
  const measuredWindows=[...windows].map(([window_start,rows])=>({window_start,...summarizeRuntime(rows)}));
  if(measuredWindows.length)await env.MONITOR_DB.prepare(`INSERT INTO statistics_runtime_windows(script_name,window_start,requests,exceptions,resource_failures,quality)
    SELECT ?1,json_extract(value,'$.window_start'),json_extract(value,'$.requests'),json_extract(value,'$.exceptions'),json_extract(value,'$.exceededResources'),json_extract(value,'$.quality')
    FROM json_each(?2) WHERE 1 ON CONFLICT(script_name,window_start) DO UPDATE SET requests=excluded.requests,exceptions=excluded.exceptions,resource_failures=excluded.resource_failures,quality=excluded.quality`)
    .bind(script,JSON.stringify(measuredWindows)).run();
  const severityOf = (row) => row.exceptions >= 10 && row.exceptions / Math.max(1, row.requests) >= 0.05 ? 95
    : row.exceptions >= 5 || row.requests >= 100 && row.exceptions / row.requests >= 0.01 ? 70 : 0;
  const summary = summaries.sort((a, b) => severityOf(b) - severityOf(a) || b.exceptions - a.exceptions)[0] || summarizeRuntime([]);
  const resourceFailures = summaries.reduce((sum, row) => sum + row.exceededResources, 0);
  summary.quality = summaries.some((row) => row.quality !== 'available') ? 'partial' : 'available';
  let cpu = null;
  let cpuWindows = [];
  let cpuQuality = "unavailable";
  try {
    let response;
    try { response = await graphQl(cpuQuery(env.RUNTIME_CPU_P90 === "true"), variables, env.CF_ANALYTICS_TOKEN, fetchImpl); }
    catch (error) {
      if (!error.schemaRelated || env.RUNTIME_CPU_P90 !== "true") throw error;
      response = await graphQl(cpuQuery(false), variables, env.CF_ANALYTICS_TOKEN, fetchImpl);
    }
    const rows = response.workersInvocationsAdaptive;
    const scale = env.RUNTIME_CPU_UNIT === "microseconds" ? 0.001 : env.RUNTIME_CPU_UNIT === "milliseconds" ? 1 : null;
    if (scale && Array.isArray(rows) && rows.length > 0 && rows.length < 10 && rows.every((row) => row.dimensions?.scriptName === script && validWindow(row.dimensions?.datetimeFifteenMinutes)
      && Number.isFinite(row.quantiles?.cpuTimeP99) && row.quantiles.cpuTimeP99 >= 0 && Number.isSafeInteger(row.sum?.requests) && row.sum.requests >= 0)) {
      cpuWindows = rows.map((row) => ({ p99: row.quantiles.cpuTimeP99 * scale,
        p90: Number.isFinite(row.quantiles.cpuTimeP90) ? row.quantiles.cpuTimeP90 * scale : null,
        requests: row.sum.requests, window: row.dimensions.datetimeFifteenMinutes })).sort((a, b) => a.window.localeCompare(b.window));
      if (new Set(cpuWindows.map((row) => row.window)).size !== cpuWindows.length) throw new Error('Duplicate CPU buckets');
      cpu = [...cpuWindows].sort((a, b) => b.p99 - a.p99)[0];
      cpuQuality = 'available';
    }
  } catch (error) { if (error.name === "MonitorBudgetExhausted") throw error; }
  const limits = JSON.parse(env.RUNTIME_CPU_LIMITS_MS || "{}");
  const limit = env.RECOVERY_D1_PLAN === "paid" ? Number(limits[script]) : 10;
  const above = (row) => Number.isFinite(limit) && limit > 0 && row.requests >= 100 && row.p99 >= limit * 0.8;
  const cpuAbove = cpuQuality === 'available' && cpuWindows.some((row, index) => index > 0 && above(row) && above(cpuWindows[index - 1])
    && Date.parse(row.window) - Date.parse(cpuWindows[index - 1].window) === 900000);
  await env.MONITOR_DB.prepare(`INSERT INTO runtime_samples(script_name, window_end, payload, quality) VALUES (?, ?, ?, ?)
    ON CONFLICT(script_name, window_end) DO UPDATE SET payload = excluded.payload, quality = excluded.quality`)
    .bind(script, end, JSON.stringify({ ...summary, cpu, cpuWindows, cpuQuality, cpuAbove, start, end }), summary.quality).run();
  const exceptionSeverity = severityOf(summary);
  await observeIncident(env.MONITOR_DB, { key: `runtime:resources:${script}`, severity: resourceFailures > 0 ? 95 : 0,
    quality: summary.quality, sample: end, message: monitorText(env, "runtime_resources", { script, count: resourceFailures, extra: resourceFailures ? monitorText(env, "runtime_extra") : "" }) }, now);
  await observeIncident(env.MONITOR_DB, { key: `runtime:exceptions:${script}`, severity: exceptionSeverity,
    quality: summary.quality, sample: end, message: monitorText(env, "runtime_exceptions", { script, errors: summary.exceptions || 0, requests: summary.requests || 0 }) }, now);
  await observeIncident(env.MONITOR_DB, { key: `runtime:cpu:${script}`, severity: cpuAbove ? 70 : 0,
    quality: cpuQuality === "available" && Number.isFinite(limit) && cpu.requests >= 100 ? "available" : "unavailable", sample: end,
    message: cpu ? monitorText(env, "runtime_cpu", { script, cpu: cpu.p99.toFixed(2), limit: Number.isFinite(limit) ? monitorText(env, "runtime_limit", { limit }) : monitorText(env, "runtime_no_limit") }) : monitorText(env, "runtime_cpu_unknown", { script }) }, now);
  await observeIncident(env.MONITOR_DB, { key: `runtime:telemetry:${script}`, severity: summary.quality === "available" ? 0 : 70,
    quality: summary.quality, sample: end, message: `${script}: ${monitorText(env, summary.quality === "available" ? "runtime_available" : "runtime_partial")}.` }, now);
  await observeIncident(env.MONITOR_DB, { key: `runtime:cpu-check:${script}`, severity: cpuQuality === 'available' && Number.isFinite(limit) && limit > 0 ? 0 : 70,
    quality: cpuQuality, sample: end, message: `${script}: ${cpuQuality === 'available' && limit > 0 ? monitorText(env, "runtime_cpu_available") : monitorText(env, "runtime_cpu_check")}.` }, now);
  return { script, quality: summary.quality, cpuQuality };
}
