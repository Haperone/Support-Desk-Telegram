import { createMonitorContext, MonitorBudgetExhausted } from "./budget.js";
import { createCloudflareFetch } from "./api.js";
import { collectStorage, inspectStorageEmergency } from "./storage.js";
import { dispatchIncidents, observeIncident } from "./incidents.js";
import { resolveMonitorEnvironment } from "./plan.js";
import { runMonitor, sendTelegram } from "./worker.js";
import { telegramBotKey } from "../telegram-cooldown.js";
import { collectRuntime } from "./runtime-health.js";
import { collectDeliveryHealth } from "./delivery-health.js";
import { readAlertRoute } from './alert-config.js';
import { monitorLocale, monitorText } from "./incident-copy.js";

const MONITOR_JOB_NAMES = Object.freeze({
  usage: { en: "usage monitoring", ru: "мониторинг использования", es: "supervisión del uso", zh: "用量监控" },
  storage: { en: "storage monitoring", ru: "мониторинг хранилища", es: "monitoreo del almacenamiento", zh: "存储监控" },
  runtime: { en: "execution monitoring", ru: "мониторинг выполнения", es: "supervisión de ejecución", zh: "运行监控" },
  delivery: { en: "message delivery", ru: "доставка сообщений", es: "entrega de mensajes", zh: "消息投递" },
  alerts: { en: "incident alerts", ru: "уведомления об инцидентах", es: "alertas de incidentes", zh: "事件警报" },
  maintenance: { en: "data maintenance", ru: "обслуживание данных", es: "mantenimiento de datos", zh: "数据维护" },
});

export function monitorJobName(env, key) {
  const locale = monitorLocale(env);
  return MONITOR_JOB_NAMES[key]?.[locale] || key;
}

export async function runOperationalMonitor(rawEnv, options = {}) {
  const now = options.now || new Date();
  const context = createMonitorContext(rawEnv, options.fetchImpl || fetch);
  let env = context.env;
  const health = options.handleD1TelemetryHealth;
  if (env.MONITOR_HEALTH_ENABLED !== "true") {
    const result = await runMonitor(env, { now });
    if (health) await health(env, result, now, context.fetch);
    return result;
  }
  try {
    env = { ...await resolveMonitorEnvironment(env), MONITOR_PLAN_RESOLVED: true };
    context.budget.setPlan(env.RECOVERY_D1_PLAN);
    context.env = env;
  } catch {
    // Preserve the existing emergency path when the plan provider is unavailable.
    return runMonitor(env, { now });
  }
  context.fetch = createCloudflareFetch(env, context.fetch, now);
  const owner = crypto.randomUUID();
  const alertRoute = await readAlertRoute(env);
  const alertBotKey = alertRoute ? telegramBotKey({ id: "monitor-alerts", token: alertRoute.token }) : null;
  let scheduler;
  try {
    scheduler = await env.MONITOR_DB.prepare(`UPDATE monitor_scheduler SET owner_token = ?, lease_until = ?
      WHERE id = 1 AND (owner_token IS NULL OR lease_until <= ?) RETURNING next_job,
        (SELECT not_before FROM telegram_cooldowns WHERE bot_key = ?) AS alert_cooldown`)
      .bind(owner, new Date(now.getTime() + 300_000).toISOString(), now.toISOString(), alertBotKey).first();
  } catch {
    try { await inspectStorageEmergency(env, now, context.fetch, (text) => sendTelegram(env, text, context.fetch)); }
    catch { /* The independent quota emergency path remains useful if storage cannot be read. */ }
    return runMonitor(env, { now });
  }
  if (!scheduler) return { ok: true, busy: true };
  env.MONITOR_DB.telegramCooldowns = scheduler.alert_cooldown ? { [alertBotKey]: scheduler.alert_cooldown } : {};
  const send = (text) => sendTelegram(env, text, context.fetch);
  const jobs = [
    { key: "usage", run: async () => {
      const result = await runMonitor(env, { now });
      if (health) { context.budget.checkpoint(7, 1); await health(env, result, now, context.fetch); }
      return result;
    } },
    { key: "storage", run: () => collectStorage(env, now, context.fetch, send) },
    ...(env.MONITOR_RUNTIME_ENABLED === "true" ? [{ key: "runtime", run: () => collectRuntime(env, now, context.fetch) }] : []),
    ...(env.SUPPORT_HEALTH ? [{ key: "delivery", run: () => collectDeliveryHealth(env, now) }] : []),
    { key: "alerts", run: () => dispatchIncidents(env, now, send) },
    { key: "maintenance", run: async () => {
      context.budget.checkpoint(8);
      const day = (days) => new Date(now.getTime() - days * 86_400_000).toISOString();
      const sqls = [
        ["DELETE FROM storage_samples WHERE measured_at < ?", day(7)],
        ["DELETE FROM runtime_samples WHERE window_end < ?", day(7)],
        ["DELETE FROM statistics_runtime_windows WHERE window_start < ? OR (SELECT CAST(value AS INTEGER)>=49900 FROM monitor_state WHERE key='statistics_runtime_count') ORDER BY window_start", day(400)],
        ["DELETE FROM storage_daily_samples WHERE day_utc < ?", day(90).slice(0, 10)],
        ["DELETE FROM monitor_incidents WHERE severity = 0 AND sent_severity = 0 AND last_seen < ?", day(180)],
        ["DELETE FROM monitor_api_cooldowns WHERE not_before < ?", day(7)],
        ["DELETE FROM telegram_cooldowns WHERE not_before < ?", day(7)],
        ["DELETE FROM monitor_incidents WHERE incident_key NOT LIKE 'monitor:%' AND last_seen < ?", day(180)],
      ];
      for (const [sql, cutoff] of sqls) {
        const [, table, predicate] = sql.match(/^DELETE FROM (\w+) WHERE (.*)$/);
        await env.MONITOR_DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${predicate} LIMIT 100)`).bind(cutoff).run();
      }
    } },
  ];
  const results = [];
  try {
    for (let visited = 0; visited < jobs.length; visited++) {
      context.budget.checkpoint(7, 1);
      const index = (Number(scheduler.next_job) + visited) % jobs.length;
      // Advance before attempting the job: a persistent failure cannot starve peers.
      await env.MONITOR_DB.prepare("UPDATE monitor_scheduler SET next_job = ?, lease_until = ? WHERE id = 1 AND owner_token = ?")
        .bind((index + 1) % jobs.length, new Date(now.getTime() + 300_000).toISOString(), owner).run();
      try {
        const result = await jobs[index].run();
        results.push({ job: jobs[index].key, result });
        context.budget.checkpoint(1);
        await observeIncident(env.MONITOR_DB, { key: `monitor:${jobs[index].key}`, severity: result?.ok === false ? 85 : 0,
          quality: result?.quality && result.quality !== "available" || result?.ok === false ? "unavailable" : "available",
          message: monitorText(env, result?.ok === false ? "job_unavailable" : "job_available", { job: monitorJobName(env, jobs[index].key) }) }, now);
      }
      catch (error) {
        if (error instanceof MonitorBudgetExhausted) {
          // A later job deserves a fresh invocation. A first job that repeatedly
          // fails must still allow the following jobs to run on the next tick.
          if (visited > 0) await env.MONITOR_DB.prepare("UPDATE monitor_scheduler SET next_job = ? WHERE id = 1 AND owner_token = ?").bind(index, owner).run();
          results.push({ job: jobs[index].key, deferred: true }); break;
        }
        results.push({ job: jobs[index].key, error: error.message });
        try {
          context.budget.checkpoint(1);
          await observeIncident(env.MONITOR_DB, { key: `monitor:${jobs[index].key}`, severity: 85,
            message: monitorText(env, "job_details", { job: monitorJobName(env, jobs[index].key) }), quality: "unavailable" }, now);
        } catch { /* Keep other checks and lease cleanup possible after state failure. */ }
      }
    }
  } catch (error) {
    if (!(error instanceof MonitorBudgetExhausted)) throw error;
  } finally {
    await env.MONITOR_DB.prepare("UPDATE monitor_scheduler SET owner_token = NULL, lease_until = NULL WHERE id = 1 AND owner_token = ?").bind(owner).run();
  }
  return { ok: true, jobs: results, budget: { statements: context.budget.statements, requests: context.budget.requests } };
}
