import test from "node:test";
import assert from "node:assert/strict";
import { SqliteD1 } from "../../test/helpers/sqlite-d1.js";
import { createMonitorContext, MonitorBudgetExhausted } from "../budget.js";
import { createCloudflareFetch } from "../api.js";
import { dispatchIncidents, observeIncident, storageSeverity } from "../incidents.js";
import { graphQl } from "../worker.js";
import { retryAfterSeconds, retryDeadline } from "../../src/http-errors.js";

const database = () => new SqliteD1(new URL("../migrations/", import.meta.url));
const start = new Date("2026-09-08T23:45:00Z");

test("monitor counts failed statements, every batch member and HTTP calls across a reused context", async () => {
  const db = database();
  try {
    const ctx = createMonitorContext({ MONITOR_DB: db }, async () => Response.json({}));
    assert.equal(createMonitorContext(ctx.env), ctx);
    await assert.rejects(ctx.env.MONITOR_DB.prepare("SELECT * FROM missing_table").first());
    await ctx.env.MONITOR_DB.batch([ctx.env.MONITOR_DB.prepare("SELECT 1"), ctx.env.MONITOR_DB.prepare("SELECT 2")]);
    assert.equal(ctx.budget.statements, 3);
    for (let i = 3; i < 47; i++) await ctx.env.MONITOR_DB.prepare("SELECT 1").first();
    assert.throws(() => ctx.env.MONITOR_DB.prepare("SELECT 1").first(), MonitorBudgetExhausted);
    await ctx.env.MONITOR_DB.prepare('UPDATE monitor_scheduler SET owner_token = NULL, lease_until = NULL WHERE id = 1').run();
    assert.equal(ctx.budget.statements, 48);
    for (let i = 0; i < 50; i++) await ctx.fetch("https://example.test");
    assert.throws(() => ctx.fetch("https://example.test"), MonitorBudgetExhausted);
    assert.equal(ctx.budget.requests, 50);
    ctx.budget.setPlan("paid");
    await ctx.env.MONITOR_DB.prepare("SELECT 1").first();
    assert.equal(ctx.budget.statements, 49);
  } finally { db.close(); }
});

test("GraphQL preserves 429 metadata with invalid JSON, no schema fallback, and survives restart cooldown", async () => {
  const db = database();
  try {
    let calls = 0;
    const env = { MONITOR_DB: db, CF_ACCOUNT_ID: "account" };
    const upstream = async () => { calls++; return new Response("not json", { status: 429, headers: { "retry-after": "7200" } }); };
    const fetchImpl = createCloudflareFetch(env, upstream, start);
    await assert.rejects(graphQl("query {}", {}, "secret", fetchImpl), (error) => error.httpStatus === 429 && error.retryAfterSeconds === 7200 && !error.schemaRelated);
    await assert.rejects(graphQl("query {}", {}, "secret", createCloudflareFetch(env, upstream, new Date(start.getTime() + 60_000))), /waiting for retry_after/);
    assert.equal(calls, 1);
    assert.equal(db.sqlite.prepare("SELECT not_before FROM monitor_api_cooldowns").get().not_before, "2026-09-09T01:45:00.000Z");
    assert.equal(retryAfterSeconds("Wed, 09 Sep 2026 01:45:00 GMT", start.getTime()), 7200);
    assert.equal(retryDeadline(7200, start.getTime()), "2026-09-09T01:45:00.000Z");
  } finally { db.close(); }
});

test("incident state survives midnight, escalates, deduplicates samples and needs two complete recovery samples", async () => {
  const db = database();
  try {
    const env = { MONITOR_DB: db, MONITOR_LOCALE: "ru" };
    const texts = [];
    const send = async (text) => { texts.push(text); return { ok: true }; };
    const observation = (severity, quality, minutes) => observeIncident(db, { key: "storage:db", severity, quality, message: "База обращений" }, new Date(start.getTime() + minutes * 60_000));
    await observation(70, "available", 0);
    await dispatchIncidents(env, start, send);
    await observation(70, "available", 30);
    await dispatchIncidents(env, new Date(start.getTime() + 30 * 60_000), send);
    assert.equal(texts.length, 1);
    await observation(95, "partial", 31);
    await dispatchIncidents(env, new Date(start.getTime() + 31 * 60_000), send);
    assert.equal(texts.length, 2);
    await observation(0, "unavailable", 32);
    await observation(0, "available", 33);
    await observation(0, "available", 33);
    assert.equal(db.sqlite.prepare("SELECT severity FROM monitor_incidents").get().severity, 95);
    await observation(0, "available", 34);
    await dispatchIncidents(env, new Date(start.getTime() + 34 * 60_000), send);
    assert.match(texts.at(-1), /Восстановлено/);
    assert.equal(texts.length, 3);
    await observation(0, "available", 35);
    await dispatchIncidents(env, new Date(start.getTime() + 35 * 60_000), send);
    assert.equal(texts.length, 3);
  } finally { db.close(); }
});

test("failed alert remains pending; concurrent dispatchers claim a single incident batch", async () => {
  const db = database();
  try {
    await observeIncident(db, { key: "delivery:bot", severity: 95, message: "Доставка задержана" }, start);
    await dispatchIncidents({ MONITOR_DB: db }, start, async () => ({ ok: false }));
    assert.equal(db.sqlite.prepare("SELECT last_sent FROM monitor_incidents").get().last_sent, null);
    let sent = 0;
    await Promise.all([1, 2].map(() => dispatchIncidents({ MONITOR_DB: db }, start, async () => { sent++; return { ok: true }; })));
    assert.equal(sent, 1);
    assert.equal(storageSeverity(910, 1000, 95), 95);
    assert.equal(storageSeverity(890, 1000, 95), 85);
    assert.equal(storageSeverity(null, 1000), null);
  } finally { db.close(); }
});
