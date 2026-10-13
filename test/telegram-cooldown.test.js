import test from "node:test";
import assert from "node:assert/strict";
import { requestTelegram } from "../telegram-response.js";
import { recordTelegramCooldown, telegramBotKey, deferredTelegramResult } from "../telegram-cooldown.js";
import { resolveInvocationDatabase } from "../recovery-budget.js";
import { SqliteD1 } from "./helpers/sqlite-d1.js";
import { prepareTelegramCleanup, settleTelegramCleanup, isConfirmedMessageDeletion } from '../telegram-cleanup.js';

test('idempotent message cleanup survives a 429 and restart without replaying business delivery', async () => {
  const raw = new SqliteD1(new URL('../migrations/', import.meta.url));
  try {
    const bot = { id: 'support' }, body = { chat_id: -100, message_id: 44 };
    let db = await resolveInvocationDatabase(raw, {});
    await prepareTelegramCleanup(db, bot, body);
    await settleTelegramCleanup(db, bot, body, { ok: false, retryable: true, rateLimited: true, description: '429' });
    assert.equal(raw.sqlite.prepare('SELECT completed_at FROM telegram_cleanup_jobs').get().completed_at, null);
    db = await resolveInvocationDatabase(raw, {});
    await prepareTelegramCleanup(db, bot, body);
    await settleTelegramCleanup(db, bot, body, { ok: false, errorCode: 400, description: 'Bad Request: message to delete not found' });
    assert.ok(raw.sqlite.prepare('SELECT completed_at FROM telegram_cleanup_jobs').get().completed_at);
    assert.equal(raw.sqlite.prepare('SELECT COUNT(*) AS n FROM telegram_cleanup_jobs').get().n, 1);
  } finally { raw.close(); }
});

test('message deletion confirms only success or a definite Telegram 400 not-found rejection', () => {
  const missing = { ok: false, errorCode: 400, description: 'Bad Request: message to delete not found' };
  assert.equal(isConfirmedMessageDeletion({ ok: true }), true);
  assert.equal(isConfirmedMessageDeletion(missing), true);
  for (const override of [{ errorCode: 503 }, { errorCode: 429 }, { deliveryUncertain: true },
    { retryable: true }, { rateLimited: true }, { deferred: true }, { errorCode: undefined },
    { description: 'Proxy error: message to delete not found' }]) {
    assert.equal(isConfirmedMessageDeletion({ ...missing, ...override }), false);
  }
});

for (const scenario of [
  { name: "HTTP 429 with invalid JSON", status: 429, body: "not-json", headers: { "retry-after": "7200" }, wait: 7200 },
  { name: "JSON 429 over HTTP 200", status: 200, body: { ok: false, error_code: 429, parameters: { retry_after: 9000 } }, wait: 9000 },
  { name: "longer header deadline", status: 429, body: { ok: false, parameters: { retry_after: 30 } }, headers: { "retry-after": "3600" }, wait: 3600 },
  { name: "missing retry_after", status: 429, body: { ok: false, error_code: 429 }, wait: null },
]) test(`Telegram response: ${scenario.name} is a known rejection, not uncertain delivery`, async () => {
  const result = await requestTelegram({ token: "token", method: "sendMessage", body: {}, fetchImpl: async () => new Response(
    typeof scenario.body === "string" ? scenario.body : JSON.stringify(scenario.body), { status: scenario.status, headers: scenario.headers }) });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.deliveryUncertain, false);
  assert.equal(result.rateLimited, true);
  assert.equal(result.retryAfterSeconds, scenario.wait);
});

test("cooldown is loaded with the existing plan lookup, survives a renamed service and never shortens", async () => {
  const db = new SqliteD1(new URL("../migrations/", import.meta.url));
  try {
    const now = new Date();
    const bot = { id: "old-name", token: "12345:secret" };
    await recordTelegramCooldown(db, bot, "sendMessage", { rateLimited: true, retryAfterSeconds: 7200 }, now);
    await recordTelegramCooldown(db, bot, "sendMediaGroup", { rateLimited: true, retryAfterSeconds: 30 }, now);
    const raw = db.sqlite.prepare("SELECT * FROM telegram_cooldowns").get();
    assert.equal(raw.not_before, new Date(now.getTime() + 7200_000).toISOString());
    assert.equal(raw.bot_key, "telegram:12345");
    db.queries = 0;
    const invocation = await resolveInvocationDatabase(db, { TELEGRAM_COOLDOWN_ENABLED: "true" });
    assert.equal(db.queries, 1);
    assert.equal(invocation.used, 1);
    const renamed = { id: "new-name", token: "12345:rotated-secret" };
    assert.equal(telegramBotKey(bot), telegramBotKey(renamed));
    assert.equal(deferredTelegramResult(invocation, renamed, now).deferred, true);
    assert.equal(deferredTelegramResult(invocation, { id: "other", token: "98765:different" }, now), null);
    assert.equal(deferredTelegramResult(invocation, renamed, new Date(now.getTime() + 7201_000)), null);
  } finally { db.close(); }
});
