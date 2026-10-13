import { cloudflareRest } from "./api.js";
import { observeIncident, storageSeverity } from "./incidents.js";
import { monitorText } from "./incident-copy.js";

const DAY = 86_400_000;
const STATE_KEY = "storage_inventory_v1";
const uuidPattern = /^[a-zA-Z0-9-]{1,80}$/;

export function storageLimits(env) {
  const paid = env.RECOVERY_D1_PLAN === "paid";
  const read = (key, fallback) => {
    const value = Number(env[key] || fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be positive bytes`);
    return value;
  };
  return {
    database: read(paid ? "D1_PAID_DATABASE_BYTES" : "D1_FREE_DATABASE_BYTES", paid ? 10_000_000_000 : 500_000_000),
    account: read(paid ? "D1_PAID_ACCOUNT_BYTES" : "D1_FREE_ACCOUNT_BYTES", paid ? 1_000_000_000_000 : 5_000_000_000),
    included: paid ? read("D1_PAID_INCLUDED_BYTES", 5_000_000_000) : null,
  };
}

export function storageForecast(samples, limit, now = new Date()) {
  const days = new Map();
  for (const row of samples) {
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || !Number.isFinite(Date.parse(row.measured_at))) continue;
    if (Date.parse(row.measured_at) > now.getTime() || Date.parse(row.measured_at) < now.getTime() - 30 * DAY) continue;
    const day = row.measured_at.slice(0, 10);
    if (!days.has(day) || days.get(day).measured_at < row.measured_at) days.set(day, row);
  }
  let ordered = [...days.values()].sort((a, b) => a.measured_at.localeCompare(b.measured_at));
  // Start a new trend after cleanup; a falling file size is not negative demand.
  for (let i = ordered.length - 1; i > 0; i--) {
    if (ordered[i].bytes < ordered[i - 1].bytes * 0.95) { ordered = ordered.slice(i); break; }
  }
  if (ordered.length < 7) return null;
  const last = ordered.at(-1);
  if (now.getTime() - Date.parse(last.measured_at) > 2 * DAY) return null;
  const calculate = (points) => {
    const span = (Date.parse(points.at(-1).measured_at) - Date.parse(points[0].measured_at)) / DAY;
    if (points.length < 7 || span < 6) return null;
    const meanX = points.reduce((sum, row) => sum + (Date.parse(row.measured_at) - Date.parse(points[0].measured_at)) / DAY, 0) / points.length;
    const meanY = points.reduce((sum, row) => sum + row.bytes, 0) / points.length;
    let numerator = 0; let denominator = 0;
    for (const row of points) {
      const x = (Date.parse(row.measured_at) - Date.parse(points[0].measured_at)) / DAY - meanX;
      numerator += x * (row.bytes - meanY); denominator += x * x;
    }
    const rate = numerator / denominator;
    return rate > 0 ? rate : null;
  };
  const short = calculate(ordered.slice(-7));
  const long = calculate(ordered);
  if (!short || !long) return null;
  const bytesPerDay = Math.max(short, long);
  return { bytesPerDay, daysRemaining: Math.max(0, (limit - last.bytes) / bytesPerDay), days: ordered.length };
}

async function readInventory(env, now, fetchImpl) {
  const db = env.MONITOR_DB;
  const saved = await db.prepare("SELECT value FROM monitor_state WHERE key = ?").bind(STATE_KEY).first();
  let state = saved?.value ? JSON.parse(saved.value) : null;
  if (!state || state.invalid || now.getTime() - Date.parse(state.startedAt) >= DAY) {
    state = { generation: crypto.randomUUID(), page: 1, startedAt: now.toISOString(), complete: false, cursor: "",
      fingerprint: state?.fingerprint ?? null, accountTrendStart: state?.accountTrendStart ?? null };
  }
  if (!state.complete) {
    const payload = await cloudflareRest(env, `d1/database?page=${state.page}&per_page=100`, fetchImpl, now);
    if (!Array.isArray(payload.result)) throw new Error("D1 inventory response contains no database list");
    const rows = payload.result;
    if (rows.some((row) => typeof row.uuid !== "string" || !uuidPattern.test(row.uuid))) throw new Error("D1 inventory contains an invalid database identifier");
    const info = payload.result_info;
    if (info?.page != null && info.page !== state.page) throw new Error("D1 inventory returned a different page");
    if (state.total != null && info?.total_count != null && state.total !== info.total_count) state.invalid = true;
    state.total = Number.isSafeInteger(info?.total_count) && info.total_count >= 0 ? info.total_count : state.total;
    await db.prepare(`INSERT INTO storage_inventory(database_id, name, inventory_id)
      SELECT json_extract(value, '$.uuid'), json_extract(value, '$.name'), ? FROM json_each(?) WHERE true
      ON CONFLICT(database_id) DO UPDATE SET name = excluded.name, inventory_id = excluded.inventory_id`)
      .bind(state.generation, JSON.stringify(rows.map((row) => ({ uuid: row.uuid, name: String(row.name || row.uuid).slice(0, 160) })))).run();
    const count = await db.prepare("SELECT COUNT(*) AS count FROM storage_inventory WHERE inventory_id = ?").bind(state.generation).first();
    const pageSize = Number.isSafeInteger(info?.per_page) && info.per_page > 0 ? info.per_page : 100;
    const ended = state.total != null ? state.page * pageSize >= state.total : rows.length < pageSize;
    state.complete = ended && !state.invalid && (state.total == null || count.count === state.total);
    if (ended && !state.complete) state.invalid = true;
    if (state.complete) {
      state.completedAt = now.toISOString();
      const ids = await db.prepare("SELECT database_id FROM storage_inventory WHERE inventory_id = ? ORDER BY database_id").bind(state.generation).all();
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify((ids.results || []).map((row) => row.database_id))));
      const fingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (state.fingerprint && state.fingerprint !== fingerprint) state.accountTrendStart = now.toISOString().slice(0, 10);
      state.fingerprint = fingerprint;
    }
    state.page += 1;
  }
  return state;
}

export async function collectStorage(env, now, fetchImpl, emergencySend) {
  env.MONITOR_CONTEXT?.budget.checkpoint(40, 8);
  const db = env.MONITOR_DB;
  const state = await readInventory(env, now, fetchImpl);
  if (state.complete && !state.invalid) await db.batch([
    // Retire warnings even if an earlier version already removed the inventory
    // row. Disappearance is not a healthy size sample or a recovery notification.
    db.prepare(`UPDATE monitor_incidents SET severity = 0, sent_severity = 0, normal_samples = 0,
      candidate_severity = NULL, owner_token = NULL, lease_until = NULL, quality = 'unavailable',
      message = ?,
      recovered_at = ?, last_seen = ?, last_sample = ?
      WHERE incident_key IN (SELECT incident_key FROM monitor_incidents
        WHERE ((incident_key LIKE 'storage:%' AND incident_key NOT IN ('storage:account', 'storage:telemetry'))
          OR (incident_key LIKE 'forecast:%' AND incident_key <> 'forecast:account'))
          AND (severity <> 0 OR sent_severity <> 0 OR owner_token IS NOT NULL)
          AND NOT EXISTS(SELECT 1 FROM storage_inventory WHERE inventory_id = ?
            AND database_id = substr(monitor_incidents.incident_key, instr(monitor_incidents.incident_key, ':') + 1))
        ORDER BY incident_key LIMIT 100)`)
      .bind(monitorText(env, "storage_missing"), now.toISOString(), now.toISOString(), now.toISOString(), state.generation),
    db.prepare(`DELETE FROM storage_inventory WHERE database_id IN
      (SELECT database_id FROM storage_inventory WHERE inventory_id <> ? ORDER BY database_id LIMIT 100)`).bind(state.generation),
  ]);
  const limits = storageLimits(env);
  const batch = await db.prepare(`SELECT * FROM storage_inventory WHERE inventory_id = ? AND database_id > ?
    ORDER BY database_id LIMIT 6`).bind(state.generation, state.cursor).all();
  const measured = [];
  for (const row of batch.results || []) {
    const value = { ...row, quality: "unavailable", measured_at: now.toISOString(), bytes: null };
    try {
      const payload = await cloudflareRest(env, `d1/database/${encodeURIComponent(row.database_id)}`, fetchImpl, now);
      if (payload.result?.uuid && payload.result.uuid !== row.database_id) throw new Error("D1 details identity mismatch");
      const bytes = payload.result?.file_size;
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("D1 details omitted the current file_size");
      value.bytes = bytes; value.quality = "available";
    } catch (error) {
      if (error.name === "MonitorBudgetExhausted") throw error;
      if (error.httpStatus === 404) state.invalid = true;
      value.reason = error.category || "unavailable";
    }
    measured.push(value);
    state.cursor = row.database_id;
  }
  if ((batch.results || []).length < 6) state.cursor = "";
  await db.prepare(`UPDATE storage_inventory SET
    bytes = (SELECT json_extract(value, '$.bytes') FROM json_each(?) WHERE json_extract(value, '$.database_id') = storage_inventory.database_id),
    measured_at = ?, quality = (SELECT json_extract(value, '$.quality') FROM json_each(?) WHERE json_extract(value, '$.database_id') = storage_inventory.database_id)
    WHERE database_id IN (SELECT json_extract(value, '$.database_id') FROM json_each(?))`)
    .bind(JSON.stringify(measured), now.toISOString(), JSON.stringify(measured), JSON.stringify(measured)).run();
  await db.prepare("INSERT INTO monitor_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(STATE_KEY, JSON.stringify(state)).run();
  const cutoff = new Date(now.getTime() - 60 * 60_000).toISOString();
  const totals = await db.prepare(`SELECT COUNT(*) AS count,
    SUM(CASE WHEN quality = 'available' AND measured_at >= ? THEN 1 ELSE 0 END) AS fresh_count,
    COALESCE(SUM(CASE WHEN quality = 'available' AND measured_at >= ? THEN bytes ELSE 0 END), 0) AS bytes
    FROM storage_inventory WHERE inventory_id = ?`).bind(cutoff, cutoff, state.generation).first();
  const complete = state.complete && !state.invalid && totals.count === Number(totals.fresh_count || 0);
  const observations = measured.map((row) => ({ ...row, resource_id: row.database_id, limit: limits.database }));
  observations.push({ resource_id: "account", name: monitorText(env, "storage_account"), bytes: totals.bytes,
    measured_at: now.toISOString(), quality: complete ? "available" : "partial", limit: limits.account });
  const valid = observations.filter((row) => row.quality === "available");
  await db.prepare(`INSERT OR IGNORE INTO storage_samples(resource_id, measured_at, bytes, quality)
    SELECT json_extract(value, '$.resource_id'), ?, json_extract(value, '$.bytes'), 'available' FROM json_each(?)`)
    .bind(now.toISOString(), JSON.stringify(valid)).run();
  await db.prepare(`INSERT INTO storage_daily_samples(resource_id, day_utc, measured_at, bytes)
    SELECT json_extract(value, '$.resource_id'), ?, ?, json_extract(value, '$.bytes') FROM json_each(?) WHERE true
    ON CONFLICT(resource_id, day_utc) DO UPDATE SET measured_at = excluded.measured_at, bytes = excluded.bytes
    WHERE measured_at < excluded.measured_at`).bind(now.toISOString().slice(0, 10), now.toISOString(), JSON.stringify(valid)).run();
  const prior = await db.prepare("SELECT incident_key, severity FROM monitor_incidents WHERE incident_key LIKE 'storage:%'").all();
  const severities = new Map((prior.results || []).map((row) => [row.incident_key, row.severity]));
  for (const row of observations) {
    env.MONITOR_CONTEXT?.budget.checkpoint(3);
    const key = `storage:${row.resource_id}`;
    const severity = row.bytes == null ? 0 : storageSeverity(row.bytes, row.limit, severities.get(key) || 0);
    let message = row.bytes == null ? monitorText(env, "storage_unmeasured", { name: row.name })
      : monitorText(env, "storage_size", { name: row.name, partial: row.quality === "partial" ? monitorText(env, "storage_partial") : "", bytes: (row.bytes / 1_000_000).toFixed(1), limit: (row.limit / 1_000_000).toFixed(0), percent: (row.bytes / row.limit * 100).toFixed(1) });
    if (row.quality === "available") {
      const history = await db.prepare("SELECT measured_at, bytes FROM storage_daily_samples WHERE resource_id = ? AND day_utc >= ? ORDER BY day_utc")
        .bind(row.resource_id, [new Date(now.getTime() - 30 * DAY).toISOString().slice(0, 10), row.resource_id === "account" ? state.accountTrendStart || "" : ""].sort().at(-1)).all();
      const forecast = storageForecast(history.results || [], row.limit, now);
      message += forecast ? monitorText(env, "storage_forecast", { days: Math.ceil(forecast.daysRemaining) }) : monitorText(env, "storage_forecast_unknown");
      await observeIncident(db, { key: `forecast:${row.resource_id}`, severity: forecast && forecast.daysRemaining <= 7 ? 95 : forecast && forecast.daysRemaining <= 30 ? 70 : 0,
        quality: forecast ? "available" : "unavailable", message }, now);
    }
    if (row.resource_id === "account" && limits.included) message += monitorText(env, "storage_paid", { included: (limits.included / 1_000_000_000).toFixed(1) });
    if (severity >= 85) message += monitorText(env, "storage_admin");
    try { await observeIncident(db, { key, severity: severity || 0, quality: row.quality, message }, now); }
    catch (error) {
      if (severity >= 95 && emergencySend) await emergencySend(`🚨 ${message}\n${monitorText(env, "emergency_save")}`);
      throw error;
    }
  }
  await observeIncident(db, { key: "storage:telemetry", severity: complete ? 0 : 70, message: complete ? monitorText(env, "storage_recovered") : monitorText(env, "storage_telemetry_bad"), quality: complete ? "available" : "partial" }, now);
  return { quality: complete ? "available" : "partial", databases: totals.count, measured: Number(totals.fresh_count || 0), bytes: totals.bytes, inventory: state };
}

// No monitor-state writes are required for this bounded emergency inspection.
export async function inspectStorageEmergency(env, now, fetchImpl, send) {
  const limits = storageLimits(env);
  const payload = await cloudflareRest(env, "d1/database?page=1&per_page=100", fetchImpl, now);
  if (!Array.isArray(payload.result)) return;
  const rows = payload.result.slice(0, 6).filter((row) => typeof row.uuid === "string" && uuidPattern.test(row.uuid));
  const critical = [];
  for (const row of rows) {
    const detail = await cloudflareRest(env, `d1/database/${encodeURIComponent(row.uuid)}`, fetchImpl, now);
    const bytes = detail.result?.file_size;
    if (Number.isSafeInteger(bytes) && bytes >= limits.database * 0.95) {
      critical.push(monitorText(env, "emergency_used", { name: String(row.name || row.uuid).slice(0, 120), percent: (bytes / limits.database * 100).toFixed(1) }));
    }
  }
  if (critical.length) await send(`🚨 ${monitorText(env, "emergency_full")}\n${critical.join("\n")}\n${monitorText(env, "emergency_partial")}`);
}
