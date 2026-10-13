import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handleD1TelemetryHealth } from "../entry.js";

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  async first() { return this.db.prepare(this.sql).get(...this.params) || null; }
  async run() { const info = this.db.prepare(this.sql).run(...this.params); return { success: true, meta: { changes: Number(info.changes || 0) } }; }
}
class D1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("CREATE TABLE monitor_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  prepare(sql) { return new Statement(this.sqlite, sql); }
}
function result(status) {
  return { ok: true, usage: { breakdownStatus: { workers: "available", kv: "available", d1: status } } };
}

test("three consecutive D1 analytics failures alert once and recovery is announced", async () => {
  const db = new D1();
  const env = { MONITOR_DB: db, ALERT_BOT_TOKEN: "alert-token", ALERT_CHAT_ID: "123", MONITOR_FETCH_TIMEOUT_MS: "100" };
  const messages = [];
  const fetchImpl = async (_url, init) => {
    messages.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: messages.length } }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await handleD1TelemetryHealth(env, result("unavailable"), new Date("2026-09-05T12:00:00Z"), fetchImpl);
  await handleD1TelemetryHealth(env, result("unavailable"), new Date("2026-09-05T12:15:00Z"), fetchImpl);
  assert.equal(messages.length, 0);
  await handleD1TelemetryHealth(env, result("unavailable"), new Date("2026-09-05T12:30:00Z"), fetchImpl);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /D1 telemetry unavailable/i);
  await handleD1TelemetryHealth(env, result("unavailable"), new Date("2026-09-05T12:45:00Z"), fetchImpl);
  assert.equal(messages.length, 1, "sustained outage must not spam duplicate alerts");

  await handleD1TelemetryHealth(env, result("available"), new Date("2026-09-05T13:00:00Z"), fetchImpl);
  assert.equal(messages.length, 2);
  assert.match(messages[1], /D1 telemetry recovered/i);
  assert.equal(db.sqlite.prepare("SELECT value FROM monitor_state WHERE key = 'd1_analytics_consecutive_failures'").get().value, "0");
  assert.equal(db.sqlite.prepare("SELECT value FROM monitor_state WHERE key = 'd1_analytics_alert_sent'").get().value, "0");
});

test("D1 analytics outage and recovery notices use the configured monitor locale", async () => {
  const expected = {
    en: ["Cloudflare D1 telemetry unavailable", "D1 quota alerts cannot be trusted", "Cloudflare D1 telemetry recovered", "D1 quota monitoring is reliable again"],
    ru: ["Телеметрия Cloudflare D1 недоступна", "нельзя полагаться на уведомления о квотах D1", "Телеметрия Cloudflare D1 восстановлена", "Мониторинг квот D1 снова работает надёжно"],
    es: ["La telemetría de Cloudflare D1 no está disponible", "No se puede confiar en las alertas de cuota de D1", "Se recuperó la telemetría de Cloudflare D1", "La supervisión de cuotas de D1 vuelve a ser fiable"],
    zh: ["Cloudflare D1 遥测不可用", "D1 配额警报不可靠", "Cloudflare D1 遥测已恢复", "D1 配额监控现已恢复可靠"],
  };
  for (const [locale, phrases] of Object.entries(expected)) {
    const db = new D1();
    try {
      const env = { MONITOR_DB: db, MONITOR_LOCALE: locale, ALERT_BOT_TOKEN: "alert-token", ALERT_CHAT_ID: "123" };
      const messages = [];
      const fetchImpl = async (_url, init) => {
        messages.push(JSON.parse(init.body).text);
        return Response.json({ ok: true, result: { message_id: messages.length } });
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        await handleD1TelemetryHealth(env, result("unavailable"), new Date(`2026-09-05T12:${String(attempt * 15).padStart(2, "0")}:00Z`), fetchImpl);
      }
      assert.equal(messages.length, 1);
      assert.ok(phrases[0] && messages[0].includes(phrases[0]), `${locale} outage title`);
      assert.ok(messages[0].includes("3"), `${locale} consecutive failure count`);
      assert.ok(messages[0].includes(phrases[1]), `${locale} outage impact`);

      await handleD1TelemetryHealth(env, result("available"), new Date("2026-09-05T13:00:00Z"), fetchImpl);
      assert.equal(messages.length, 2);
      assert.ok(messages[1].includes(phrases[2]), `${locale} recovery title`);
      assert.ok(messages[1].includes(phrases[3]), `${locale} recovery details`);
    } finally { db.sqlite.close(); }
  }
});
