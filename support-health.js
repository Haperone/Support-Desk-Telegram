import { requestTelegram } from "./telegram-response.js";
import { resolveInvocationDatabase } from './recovery-budget.js';
import { deferredTelegramResult, recordTelegramCooldown } from './telegram-cooldown.js';

const WINDOW_MS = 5 * 60_000;
const recentSignals = new Map();
export async function recordOperationalSignal(env, botId, kind, now = new Date()) {
  if (env.OPERATIONAL_HEALTH_ENABLED !== "true" || !env.SUPPORT_DB?.invocationBudget) return;
  const bucket = new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS).toISOString();
  const key = `${env.SUPPORT_GROUP_ID}:${botId}:${kind}`;
  if (recentSignals.get(key) === bucket) return;
  if (recentSignals.size > 256) recentSignals.clear();
  recentSignals.set(key, bucket);
  try {
    await env.SUPPORT_DB.recoveryBackgroundRun("INSERT OR IGNORE INTO operational_signals(bot_id, bucket, kind) VALUES (?, ?, ?)",
      String(botId || "all").slice(0, 100), bucket, kind);
  } catch { /* Signals are a lower bound; observing a failure must not change delivery. */ }
}

export async function supportHealthSnapshot(env, { botId, now = new Date(), fetchImpl = fetch, webhook = true } = {}) {
  const configs = JSON.parse(env.BOT_REGISTRY || "[]");
  const config = configs.find((bot) => bot.id === botId && bot.enabled !== false);
  if (!config) throw new Error("Unknown or disabled support service");
  if (!env.SUPPORT_DB) throw new Error("Support database unavailable");
  const db = await resolveInvocationDatabase(env.SUPPORT_DB, env);
  if (db.storageMode === 'reset') return { botId, name: config.displayName || botId, measuredAt: now.toISOString(), quality: 'partial', pending: 0, oldestSeconds: 0, uncertain: 0, maintenance: true, webhook: { quality: 'unavailable' } };
  const persisted = await db.prepare('SELECT enabled FROM bots WHERE id = ?').bind(botId).first();
  if (persisted?.enabled === 0) return { botId, measuredAt: now.toISOString(), quality: 'available', disabled: true, pending: 0, oldestSeconds: 0, uncertain: 0 };
  const cutoff = new Date(now.getTime() - 15 * 60_000).toISOString();
  const rows = await db.prepare(`SELECT 'delivery' AS kind, started_at AS created_at,
      CASE WHEN request_started_at IS NOT NULL OR failure_code IS NOT NULL THEN 1 ELSE 0 END AS uncertain
      FROM (SELECT * FROM message_delivery_attempts WHERE bot_id = ? AND completed_at IS NULL ORDER BY started_at LIMIT 101)
    UNION ALL SELECT 'pending', created_at, CASE WHEN failure_code = 'telegram_delivery_outcome_unknown' THEN 1 ELSE 0 END
      FROM (SELECT p.* FROM pending_messages p LEFT JOIN user_abuse_state s ON s.bot_id = p.bot_id AND s.user_id = p.user_id
        WHERE p.bot_id = ? AND p.delivered_at IS NULL AND (p.failed_at IS NULL OR p.failure_code = 'telegram_delivery_outcome_unknown')
          AND COALESCE(s.verification_required, 0) = 0 AND COALESCE(s.muted_until, '') <= ?
          AND COALESCE(s.manual_restricted_until, '') <= ?
          AND NOT EXISTS(SELECT 1 FROM banned_users b WHERE b.bot_id = p.bot_id AND b.user_id = p.user_id)
        ORDER BY p.created_at LIMIT 101)
    UNION ALL SELECT 'reopen', created_at, CASE WHEN failure_code IS NULL THEN 0 ELSE 1 END
      FROM (SELECT b.* FROM reopen_business_messages b LEFT JOIN user_abuse_state s ON s.bot_id = b.bot_id AND s.user_id = b.user_id
        WHERE b.bot_id = ? AND b.delivered_at IS NULL AND COALESCE(s.verification_required, 0) = 0
          AND COALESCE(s.muted_until, '') <= ? AND COALESCE(s.manual_restricted_until, '') <= ?
          AND NOT EXISTS(SELECT 1 FROM banned_users u WHERE u.bot_id = b.bot_id AND u.user_id = b.user_id) ORDER BY b.created_at LIMIT 101)
    UNION ALL SELECT 'album', strftime('%Y-%m-%dT%H:%M:%fZ', last_received_at / 1000.0, 'unixepoch'),
      CASE WHEN delivery_uncertain_at IS NULL THEN 0 ELSE 1 END
      FROM (SELECT g.* FROM media_groups g LEFT JOIN user_abuse_state s ON s.bot_id = g.bot_id AND s.user_id = g.user_id
        WHERE g.bot_id = ? AND g.delivery_completed_at IS NULL AND COALESCE(s.verification_required, 0) = 0
          AND COALESCE(s.muted_until, '') <= ? AND COALESCE(s.manual_restricted_until, '') <= ?
          AND NOT EXISTS(SELECT 1 FROM banned_users u WHERE u.bot_id = g.bot_id AND u.user_id = g.user_id) ORDER BY g.last_received_at LIMIT 101)`)
    .bind(botId, botId, now.toISOString(), now.toISOString(), botId, now.toISOString(), now.toISOString(), botId, now.toISOString(), now.toISOString()).all();
  const selected = rows.results || [];
  const counts = {};
  for (const row of selected) counts[row.kind] = (counts[row.kind] || 0) + 1;
  const quality = Object.values(counts).some((count) => count >= 101) ? "partial" : "available";
  const signals = await db.prepare("SELECT kind, COUNT(*) AS affected_windows FROM operational_signals WHERE (bot_id = ? OR bot_id = 'all') AND bucket >= ? GROUP BY kind LIMIT 30")
    .bind(botId, new Date(now.getTime() - 2 * 60 * 60_000).toISOString()).all();
  const oldest = selected.map((row) => row.created_at).filter(Boolean).sort()[0];
  const result = { botId, name: String(config.displayName || botId), measuredAt: now.toISOString(), quality,
    pending: selected.length, uncertain: selected.filter((row) => row.uncertain && row.created_at <= cutoff).length,
    oldestAt: oldest || null, oldestSeconds: oldest ? Math.max(0, Math.floor((now.getTime() - Date.parse(oldest)) / 1000)) : 0,
    signals: signals.results || [], signalQuality: "partial", webhook: { quality: "unavailable" } };
  if (webhook) {
    const token = env[config.tokenBinding];
    if (typeof token !== "string" || !token) return result;
    const bot = { id: botId, token };
    const reply = deferredTelegramResult(db, bot, now) || await requestTelegram({ token, method: "getWebhookInfo", body: {}, fetchImpl, timeoutMs: 10_000 });
    if (reply.rateLimited && env.TELEGRAM_COOLDOWN_ENABLED === 'true') await recordTelegramCooldown(db, bot, 'getWebhookInfo', reply, now);
    const info = reply.result;
    if (reply.ok && Number.isSafeInteger(info?.pending_update_count) && typeof info?.url === "string") {
      let expected = null;
      try { expected = new URL(`/tg/${encodeURIComponent(botId)}`, env.PUBLIC_BASE_URL).href; } catch { /* Configuration is reported as unverified. */ }
      result.webhook = { quality: expected ? "available" : "partial", pending: info.pending_update_count,
        configured: Boolean(info.url), matchesExpected: expected ? info.url === expected : null,
        recentError: Number(info.last_error_date || 0) * 1000 >= now.getTime() - 30 * 60_000 };
    }
  }
  return result;
}

export function supportServices(env) {
  const values = JSON.parse(env.BOT_REGISTRY || "[]");
  return values.filter((row) => row.enabled !== false).map((row) => ({ id: row.id, name: row.displayName || row.id }));
}
