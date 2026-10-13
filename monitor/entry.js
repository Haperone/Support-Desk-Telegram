import baseWorker, { sendTelegram } from "./worker.js";
import { runOperationalMonitor } from "./runner.js";
import { statusHttpResponse } from './status-http.js';

function dbFirst(db, sql, ...params) { return db.prepare(sql).bind(...params).first(); }
function dbRun(db, sql, ...params) { return db.prepare(sql).bind(...params).run(); }
function log(level, event, details = {}) {
  const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  writer(JSON.stringify({ level, event, ...details }));
}

const D1_TELEMETRY_COPY = Object.freeze({
  en: {
    unavailableTitle: "⚠️ Cloudflare D1 telemetry unavailable",
    unavailableDetails: (failures) => `D1 analytics has failed for ${failures} consecutive monitor runs while Workers/KV telemetry is still available.`,
    unavailableImpact: "D1 quota alerts cannot be trusted until this dataset recovers.",
    recovered: "✅ Cloudflare D1 telemetry recovered\n\nD1 quota monitoring is reliable again.",
  },
  ru: {
    unavailableTitle: "⚠️ Телеметрия Cloudflare D1 недоступна",
    unavailableDetails: (failures) => `Аналитика D1 не сработала ${failures} проверок монитора подряд, хотя телеметрия Workers/KV доступна.`,
    unavailableImpact: "До восстановления набора данных нельзя полагаться на уведомления о квотах D1.",
    recovered: "✅ Телеметрия Cloudflare D1 восстановлена\n\nМониторинг квот D1 снова работает надёжно.",
  },
  es: {
    unavailableTitle: "⚠️ La telemetría de Cloudflare D1 no está disponible",
    unavailableDetails: (failures) => `El análisis de D1 ha fallado durante ${failures} ejecuciones consecutivas del monitor, aunque la telemetría de Workers/KV sigue disponible.`,
    unavailableImpact: "No se puede confiar en las alertas de cuota de D1 hasta que se recupere este conjunto de datos.",
    recovered: "✅ Se recuperó la telemetría de Cloudflare D1\n\nLa supervisión de cuotas de D1 vuelve a ser fiable.",
  },
  zh: {
    unavailableTitle: "⚠️ Cloudflare D1 遥测不可用",
    unavailableDetails: (failures) => `D1 分析连续 ${failures} 次监控运行失败，但 Workers/KV 遥测仍可用。`,
    unavailableImpact: "此数据集恢复前，D1 配额警报不可靠。",
    recovered: "✅ Cloudflare D1 遥测已恢复\n\nD1 配额监控现已恢复可靠。",
  },
});
function d1TelemetryCopy(env) {
  const locale = Object.hasOwn(D1_TELEMETRY_COPY, env.MONITOR_LOCALE) ? env.MONITOR_LOCALE : "en";
  return D1_TELEMETRY_COPY[locale];
}
async function getState(db, key) {
  const row = await dbFirst(db, "SELECT value FROM monitor_state WHERE key = ?", key);
  return row?.value ?? null;
}
async function setState(db, key, value) {
  await dbRun(db, "INSERT INTO monitor_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(value));
}

export async function handleD1TelemetryHealth(env, result, now = new Date(), fetchImpl = fetch) {
  const db = env.MONITOR_DB;
  if (!db || !result?.ok || !result.usage) return;
  const unavailable = result.usage.breakdownStatus?.d1 === "unavailable";
  try {
    if (unavailable) {
      const row = await dbFirst(db, `INSERT INTO monitor_state (key, value)
        VALUES ('d1_analytics_consecutive_failures', '1')
        ON CONFLICT(key) DO UPDATE SET value = CAST(COALESCE(value, '0') AS INTEGER) + 1
        RETURNING value`);
      const failures = Number(row?.value || 1);
      log(failures >= 3 ? "warn" : "info", "d1_analytics_partial_failure", { failures });
      if (failures < 3 || await getState(db, "d1_analytics_alert_sent") === "1") return;
      const claimed = await dbRun(db, `INSERT INTO monitor_state (key, value)
        VALUES ('d1_analytics_alert_sent', '1')
        ON CONFLICT(key) DO UPDATE SET value = '1' WHERE value <> '1'`);
      if (claimed.meta?.changes !== 1) return;
      const copy = d1TelemetryCopy(env);
      const sent = await sendTelegram(env, [copy.unavailableTitle, "", copy.unavailableDetails(failures), copy.unavailableImpact].join("\n"), fetchImpl);
      if (!sent.ok) {
        await setState(db, "d1_analytics_alert_sent", "0");
        log("error", "d1_analytics_health_alert_failed", { description: sent.description });
      }
      return;
    }

    const previousFailures = Number(await getState(db, "d1_analytics_consecutive_failures") || 0);
    const alertSent = await getState(db, "d1_analytics_alert_sent") === "1";
    if (alertSent) {
      const sent = await sendTelegram(env, d1TelemetryCopy(env).recovered, fetchImpl);
      if (sent.ok) await setState(db, "d1_analytics_alert_sent", "0");
      else log("error", "d1_analytics_recovery_alert_failed", { description: sent.description });
    }
    if (previousFailures > 0) log("info", "d1_analytics_recovered", { previous_failures: previousFailures });
    await setState(db, "d1_analytics_consecutive_failures", "0");
    await setState(db, "d1_analytics_last_success", now.toISOString());
  } catch (error) {
    log("warn", "d1_analytics_health_state_unavailable", { reason: String(error?.message || error).slice(0, 800) });
  }
}

export default {
  scheduled(_controller, env, ctx) {
    if (ctx.exports?.UserAccessAlerts) ctx.waitUntil(ctx.exports.UserAccessAlerts.flush()
      .catch(error=>log('warn','user_access_alerts_deferred',{reason:String(error?.message||error).slice(0,300)})));
    const task = runOperationalMonitor(env, { handleD1TelemetryHealth })
      .catch((error) => {
        log("error", "monitor_check_failed", { reason: String(error?.message || error).slice(0, 800) });
        return { ok: false, error: String(error?.message || error) };
      });
    ctx.waitUntil(task);
    return task;
  },
  async fetch(request, env, ctx) {
    return await statusHttpResponse(request, env) || baseWorker.fetch(request, env, ctx);
  },
};
