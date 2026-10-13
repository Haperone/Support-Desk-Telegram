import { retryDeadline } from "./http-errors.js";

export function telegramBotKey(bot) {
  const prefix = String(bot.token || "").split(":")[0];
  return /^\d+$/.test(prefix) ? `telegram:${prefix}` : `service:${bot.id}`;
}

export class TelegramCooldownError extends Error {
  constructor(notBefore) { super(`Telegram sending is paused until ${notBefore}`); this.name = "TelegramCooldownError"; this.notBefore = notBefore; }
}

export function assertTelegramReady(db, bot, now = new Date()) {
  const notBefore = db?.telegramCooldowns?.[telegramBotKey(bot)];
  if (notBefore && notBefore > now.toISOString()) throw new TelegramCooldownError(notBefore);
}

export function telegramRequestGate(db, bot, now = new Date()) {
  if (!db?.telegramCooldownEnabled) return { sql: "", params: [] };
  return { sql: " AND NOT EXISTS (SELECT 1 FROM telegram_cooldowns WHERE bot_key = ? AND not_before > ?)",
    params: [telegramBotKey(bot), now.toISOString()] };
}

export function deferredTelegramResult(db, bot, now = new Date()) {
  try { assertTelegramReady(db, bot, now); return null; }
  catch (error) {
    return { ok: false, retryable: true, deliveryUncertain: false, deferred: true, rateLimited: false,
      retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(error.notBefore) - now.getTime()) / 1000)), description: error.message };
  }
}

export async function recordTelegramCooldown(db, bot, method, result, now = new Date()) {
  if (!result.rateLimited || !db) return;
  const key = telegramBotKey(bot);
  const notBefore = retryDeadline(result.retryAfterSeconds, now.getTime());
  db.telegramCooldowns ??= {};
  db.telegramCooldowns[key] = [db.telegramCooldowns[key], notBefore].filter(Boolean).sort().at(-1);
  await db.prepare(`INSERT INTO telegram_cooldowns(bot_key, not_before, last_method, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(bot_key) DO UPDATE SET not_before = MAX(not_before, excluded.not_before),
    failures = failures + 1, last_method = excluded.last_method, updated_at = excluded.updated_at`)
    .bind(key, notBefore, method, now.toISOString()).run();
}
