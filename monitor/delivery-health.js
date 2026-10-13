import { observeIncident } from "./incidents.js";
import { monitorText } from "./incident-copy.js";

async function timed(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Support health timed out")), 15_000); })]); }
  finally { clearTimeout(timer); }
}

export async function collectDeliveryHealth(env, now) {
  env.MONITOR_CONTEXT?.budget.checkpoint(12);
  if (!env.SUPPORT_HEALTH) throw new Error("SUPPORT_HEALTH service binding is required");
  env.MONITOR_CONTEXT?.budget.request();
  const services = await timed(env.SUPPORT_HEALTH.services());
  if (!Array.isArray(services) || services.length > 1000) throw new Error("Invalid support service list");
  if (!services.length) return { quality: "available", empty: true };
  const next = await env.MONITOR_DB.prepare(`INSERT INTO monitor_state(key, value) VALUES ('delivery_health_cursor', '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value`).first();
  const service = services[(Number(next.value) - 1) % services.length];
  env.MONITOR_CONTEXT?.budget.request();
  const snapshot = await timed(env.SUPPORT_HEALTH.snapshot({ botId: service.id }));
  if (snapshot?.botId !== service.id || !Number.isFinite(snapshot.pending) || !Number.isFinite(snapshot.oldestSeconds)) throw new Error("Invalid support health response");
  const stale = !Number.isFinite(Date.parse(snapshot.measuredAt)) || Math.abs(now.getTime() - Date.parse(snapshot.measuredAt)) > 5 * 60_000;
  if (stale) throw new Error("Support health sample is stale");
  if (snapshot.disabled || snapshot.maintenance) return { quality: snapshot.quality, disabled: snapshot.disabled, maintenance: snapshot.maintenance };
  const threshold = Math.max(60, Number(env.DELIVERY_WARNING_SECONDS) || 600);
  const blocked = snapshot.pending > 0 && snapshot.oldestSeconds >= threshold;
  const previousKey = `delivery_progress:${service.id}`;
  const previous = await env.MONITOR_DB.prepare("SELECT value FROM monitor_state WHERE key = ?").bind(previousKey).first();
  const prior = previous?.value ? JSON.parse(previous.value) : null;
  const stuck = blocked && prior?.oldestAt === snapshot.oldestAt && now.getTime() - Date.parse(prior.measuredAt) >= threshold * 1000;
  if (!prior || prior.oldestAt !== snapshot.oldestAt) await env.MONITOR_DB.prepare("INSERT INTO monitor_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(previousKey, JSON.stringify({ oldestAt: snapshot.oldestAt, measuredAt: now.toISOString() })).run();
  const count = `${snapshot.quality === "partial" ? monitorText(env, "queue_partial") : ""}${snapshot.pending}`;
  await observeIncident(env.MONITOR_DB, { key: `delivery:queue:${service.id}`, severity: stuck ? 95 : blocked ? 70 : 0,
    quality: snapshot.quality, message: blocked
      ? `${monitorText(env, "queue_blocked", { name: service.name, count: snapshot.quality === "partial" ? `${monitorText(env, "queue_partial")}${snapshot.pending}` : snapshot.pending, minutes: Math.floor(snapshot.oldestSeconds / 60) })}${monitorText(env, stuck ? "queue_stuck" : "queue_retry")}`
      : monitorText(env, "queue_recovered", { name: service.name }) }, now);
  await observeIncident(env.MONITOR_DB, { key: `delivery:uncertain:${service.id}`, severity: snapshot.uncertain > 0 ? 95 : 0,
    quality: snapshot.quality, message: snapshot.uncertain > 0
      ? monitorText(env, "uncertain", { name: service.name, count: snapshot.uncertain })
      : monitorText(env, "uncertain_none", { name: service.name }) }, now);
  const webhook = snapshot.webhook;
  const receiveBroken = webhook?.quality !== "unavailable" && (!webhook.configured || webhook.matchesExpected === false || (webhook.pending > 0 && webhook.recentError));
  await observeIncident(env.MONITOR_DB, { key: `delivery:ingress:${service.id}`, severity: receiveBroken ? 95 : webhook?.pending > 0 ? 70 : 0,
    quality: webhook?.quality || "unavailable", message: receiveBroken
      ? monitorText(env, "ingress_bad", { name: service.name, pending: webhook.pending })
      : webhook?.pending > 0 ? monitorText(env, "ingress_pending", { name: service.name, pending: webhook.pending }) : monitorText(env, "ingress_empty", { name: service.name }) }, now);
  await observeIncident(env.MONITOR_DB, { key: `delivery:checks:${service.id}`, severity: webhook?.quality === "available" ? 0 : 70,
    quality: webhook?.quality || "unavailable", message: webhook?.quality === "available" ? monitorText(env, "receive_ok", { name: service.name }) : monitorText(env, "receive_bad", { name: service.name }) }, now);
  const signals = (snapshot.signals || []).map((row) => row.kind).slice(0, 30);
  if (signals.length) {
    const failure = signals.some((kind) => /failed|unavailable|telegram_429/.test(kind));
    await observeIncident(env.MONITOR_DB, { key: `delivery:signals:${service.id}`, severity: failure ? 85 : 70, quality: "partial",
      message: monitorText(env, "signals_bad", { name: service.name, reason: monitorText(env, failure ? "signal_failures" : "signal_rate") }) }, now);
  } else {
    await observeIncident(env.MONITOR_DB, { key: `delivery:signals:${service.id}`, severity: 0, quality: 'available',
      message: monitorText(env, "signals_ok", { name: service.name }) }, now);
  }
  return { quality: snapshot.quality, service: service.id };
}
