// Best-effort telemetry must never turn a successful alert into a failed send.
export async function recordAlertDelivery(env, result, now = new Date()) {
  if (!env.STATUS_READ_TOKEN || result.disabled) return;
  const timestamp = now.toISOString();
  const kind = result.ok ? null : result.rateLimited ? 'rate_limited'
    : result.deliveryUncertain ? 'uncertain' : 'rejected';
  try {
    env.MONITOR_CONTEXT?.budget.checkpoint(1);
    await env.MONITOR_DB.prepare(`INSERT INTO monitor_state(key, value) VALUES
      ('alert_delivery_status', json_object('lastSuccessAt', ?, 'lastFailureAt', ?, 'lastFailureKind', ?))
      ON CONFLICT(key) DO UPDATE SET value = json_object(
        'lastSuccessAt', MAX(COALESCE(value ->> '$.lastSuccessAt', ''), COALESCE(excluded.value ->> '$.lastSuccessAt', '')),
        'lastFailureAt', MAX(COALESCE(value ->> '$.lastFailureAt', ''), COALESCE(excluded.value ->> '$.lastFailureAt', '')),
        'lastFailureKind', CASE WHEN COALESCE(excluded.value ->> '$.lastFailureAt', '') >= COALESCE(value ->> '$.lastFailureAt', '')
          THEN excluded.value ->> '$.lastFailureKind' ELSE value ->> '$.lastFailureKind' END)`)
      .bind(result.ok ? timestamp : null, result.ok ? null : timestamp, kind).run();
  } catch { /* Delivery and the Free invocation budget take priority. */ }
}
