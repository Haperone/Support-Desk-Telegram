const DAY_MS = 86_400_000;
import { monitorText } from "./incident-copy.js";

export async function observeIncident(db, observation, now = new Date()) {
  const { key, severity = 0, quality = "available", message = "", sample = now.toISOString() } = observation;
  return db.prepare(`INSERT INTO monitor_incidents(incident_key, severity, quality, message, first_seen, last_seen, last_sample)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(incident_key) DO UPDATE SET
    severity = CASE WHEN excluded.severity >= severity OR (excluded.quality = 'available' AND normal_samples >= 1 AND candidate_severity = excluded.severity)
      THEN excluded.severity ELSE severity END,
    normal_samples = CASE WHEN excluded.quality = 'available' AND excluded.severity < severity THEN CASE WHEN candidate_severity = excluded.severity THEN normal_samples + 1 ELSE 1 END ELSE 0 END,
    candidate_severity = CASE WHEN excluded.quality = 'available' AND excluded.severity < severity THEN excluded.severity ELSE NULL END,
    recovered_at = CASE WHEN severity > 0 AND excluded.severity = 0 AND excluded.quality = 'available' AND normal_samples >= 1 AND candidate_severity = 0
      THEN excluded.last_seen ELSE recovered_at END,
    quality = excluded.quality,
    message = CASE WHEN excluded.severity >= severity OR (excluded.quality = 'available' AND normal_samples >= 1 AND candidate_severity = excluded.severity)
      THEN excluded.message ELSE message END,
    last_seen = excluded.last_seen, last_sample = excluded.last_sample,
    first_seen = CASE WHEN severity = 0 AND excluded.severity > 0 THEN excluded.first_seen ELSE first_seen END
    WHERE monitor_incidents.last_sample IS NULL OR monitor_incidents.last_sample < excluded.last_sample
    RETURNING *`)
    .bind(key, severity, quality, String(message).slice(0, 600), now.toISOString(), now.toISOString(), sample).first();
}

export async function dispatchIncidents(env, now, send) {
  env.MONITOR_CONTEXT?.budget.checkpoint(3, 1);
  const owner = crypto.randomUUID();
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
  const rows = await env.MONITOR_DB.prepare(`UPDATE monitor_incidents SET owner_token = ?, lease_until = ?
    WHERE incident_key IN (SELECT incident_key FROM monitor_incidents
      WHERE (owner_token IS NULL OR lease_until <= ?) AND (
        severity > sent_severity OR (severity > 0 AND (last_sent IS NULL OR last_sent <= ?))
        OR (severity = 0 AND sent_severity > 0))
      ORDER BY severity DESC, COALESCE(last_sent, ''), incident_key LIMIT 5)
    RETURNING incident_key, severity, sent_severity, message, last_sample, quality`)
    .bind(owner, new Date(now.getTime() + 120_000).toISOString(), now.toISOString(), cutoff).all();
  const claimed = rows.results || [];
  if (!claimed.length) return 0;
  const text = claimed.map((item) => {
    const prefix = item.severity === 0 ? item.incident_key.startsWith('delivery:signals:') ? monitorText(env, "prefix_info") : monitorText(env, "prefix_recovered") : item.severity >= 95 ? monitorText(env, "prefix_attention") : monitorText(env, "prefix_warning");
    return `${prefix}\n${item.message}${item.quality !== "available" ? `\n${monitorText(env, "incomplete")}` : ""}`;
  }).join("\n\n");
  let result;
  try { result = await send(text); }
  catch (error) { result = { ok: false, description: error.message }; }
  if (result.ok) {
    await env.MONITOR_DB.prepare(`UPDATE monitor_incidents SET last_sent = ?, sent_severity = severity, owner_token = NULL, lease_until = NULL
      WHERE owner_token = ? AND EXISTS (SELECT 1 FROM json_each(?) item
        WHERE json_extract(item.value, '$.incident_key') = monitor_incidents.incident_key
          AND json_extract(item.value, '$.severity') = monitor_incidents.severity
          AND json_extract(item.value, '$.last_sample') = monitor_incidents.last_sample)`)
      .bind(now.toISOString(), owner, JSON.stringify(claimed)).run();
  }
  await env.MONITOR_DB.prepare("UPDATE monitor_incidents SET owner_token = NULL, lease_until = NULL WHERE owner_token = ?").bind(owner).run();
  return result.ok ? claimed.length : 0;
}

export function storageSeverity(bytes, limit, previous = 0) {
  if (!Number.isFinite(bytes) || !Number.isFinite(limit) || limit <= 0) return null;
  const percent = bytes / limit * 100;
  const reached = [70, 85, 95].filter((level) => percent >= level).at(-1) || 0;
  return reached < previous && percent >= previous - 5 ? previous : reached;
}
