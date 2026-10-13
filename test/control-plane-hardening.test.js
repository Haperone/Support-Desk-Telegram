import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { managementBotKey } from "../src/worker.js";
import { createWebhookDatabase } from "../src/recovery-budget.js";
import { stalledJsonResponse } from "./helpers/stalled-response.js";
import {
  claimGeneralControl,
  createControlPlaneWorker,
  createHardenedDatabase,
  stablePendingNonce,
} from "../src/control-plane-worker.js";
import { CONTROL_PLANE_CONTEXT } from "../src/control-plane-contract.js";

class D1Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new D1Statement(this.db, this.sql, params); }
  async first() { return this.db.prepare(this.sql).get(...this.params) || null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes || 0) } };
  }
}
class TestD1 {
  constructor() { this.sqlite = new DatabaseSync(":memory:"); }
  prepare(sql) { return new D1Statement(this.sqlite, sql); }
  async batch(statements) {
    const results = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  exec(sql) { this.sqlite.exec(sql); }
}

function setupDb() {
  const db = new TestD1();
  db.exec(`
    CREATE TABLE cloudflare_plan_settings (id INTEGER PRIMARY KEY, plan TEXT, billing_day INTEGER, revision TEXT);
    INSERT INTO cloudflare_plan_settings (id, revision) VALUES (1, 'initial');
    CREATE TABLE bots (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE general_message_claims (
      support_group_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      handler_bot_id TEXT NOT NULL,
      owner_token TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      dispatch_succeeded_at TEXT,
      PRIMARY KEY (support_group_id, message_id)
    );
    CREATE TABLE general_callback_recoveries (
      incoming_bot_id TEXT NOT NULL,
      update_id INTEGER NOT NULL,
      owner_token TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      delivery_started_at TEXT,
      delivery_uncertain_at TEXT,
      completed_at TEXT,
      outcome TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (incoming_bot_id, update_id)
    );
    CREATE TABLE operator_pending_actions (
      operator_id INTEGER PRIMARY KEY,
      operator_name TEXT NOT NULL,
      management_bot_id TEXT NOT NULL,
      target_bot_id TEXT,
      user_id INTEGER,
      action TEXT NOT NULL,
      stage TEXT NOT NULL,
      duration_seconds INTEGER,
      reason TEXT,
      chat_id INTEGER NOT NULL,
      thread_id INTEGER,
      flow_nonce TEXT NOT NULL,
      expected_state_key TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE support_operator_flows (owner_id INTEGER PRIMARY KEY, expires_at TEXT NOT NULL);
    CREATE TABLE support_operators (user_id INTEGER PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE conversations (bot_id TEXT NOT NULL, user_id INTEGER NOT NULL, support_group_id INTEGER, thread_id INTEGER, status TEXT, created_at TEXT);
    CREATE TABLE pending_messages (bot_id TEXT NOT NULL, user_id INTEGER NOT NULL);
    CREATE TABLE user_abuse_state (bot_id TEXT NOT NULL, user_id INTEGER NOT NULL);
    CREATE TABLE banned_users (bot_id TEXT NOT NULL, user_id INTEGER NOT NULL);
  `);
  db.sqlite.prepare("INSERT INTO bots (id, enabled) VALUES ('owner', 1), ('backup', 1)").run();
  return db;
}
function registry() {
  return JSON.stringify([
    { id: "owner", displayName: "Owner", topicPrefix: "Owner", tokenBinding: "OWNER_TOKEN", webhookSecretBinding: "OWNER_SECRET", locale: "en", enabled: true, groupCommandOwner: true },
    { id: "backup", displayName: "Backup", topicPrefix: "Backup", tokenBinding: "BACKUP_TOKEN", webhookSecretBinding: "BACKUP_SECRET", locale: "en", enabled: true },
  ]);
}
function envFor(db, extra = {}) {
  return {
    SUPPORT_DB: db,
    SUPPORT_GROUP_ID: "-1001234567890",
    ADMIN_IDS: "7",
    BOT_REGISTRY: registry(),
    OWNER_TOKEN: "owner-token",
    OWNER_SECRET: "owner-secret",
    BACKUP_TOKEN: "backup-token",
    BACKUP_SECRET: "backup-secret",
    GENERAL_OWNER_GRACE_MS: "0",
    GENERAL_CONTROL_LEASE_MS: "120",
    GENERAL_CONTROL_RENEW_MS: "25",
    TELEGRAM_TIMEOUT_MS: "50",
    ...extra,
  };
}
function groupRequest(botId, messageId, text = "/users", userId = 7, secret = `${botId}-secret`) {
  return new Request(`https://example.test/tg/${botId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({ update_id: messageId + 10000, message: { message_id: messageId, chat: { id: -1001234567890 }, from: { id: userId, first_name: "Op" }, text } }),
  });
}
function callbackRequest(botId, { updateId = 29000, id = "cb-1", data, messageId = 900, userId = 7 } = {}) {
  return new Request(`https://example.test/tg/${botId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": `${botId}-secret` },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: { id, from: { id: userId, first_name: "Op" }, data, message: { message_id: messageId, chat: { id: -1001234567890 } } },
    }),
  });
}
const pendingInsertSql = `INSERT INTO operator_pending_actions (
  operator_id, operator_name, management_bot_id, target_bot_id, user_id, action, stage,
  duration_seconds, reason, chat_id, thread_id, flow_nonce, expected_state_key, created_at, expires_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(operator_id) DO UPDATE SET operator_name = excluded.operator_name, management_bot_id = excluded.management_bot_id, target_bot_id = excluded.target_bot_id, user_id = excluded.user_id, action = excluded.action, stage = excluded.stage, duration_seconds = excluded.duration_seconds, reason = excluded.reason, chat_id = excluded.chat_id, thread_id = excluded.thread_id, flow_nonce = excluded.flow_nonce, expected_state_key = excluded.expected_state_key, created_at = excluded.created_at, expires_at = excluded.expires_at`;
async function first(db, sql, ...params) { return db.prepare(sql).bind(...params).first(); }
function future(ms = 60_000) { return new Date(Date.now() + ms).toISOString(); }

test("stable pending nonce ignores executor identity but changes for a different logical update", () => {
  const params = [7, "Op", "backup", "owner", 42, "ban", "confirm", null, "reason", -1001234567890, null, "random", "state", future(), future()];
  const firstNonce = stablePendingNonce("m:-1001234567890:55:7", params);
  params[2] = "owner";
  assert.equal(firstNonce, stablePendingNonce("m:-1001234567890:55:7", params));
  assert.notEqual(firstNonce, stablePendingNonce("m:-1001234567890:56:7", params));
});

test("invalid Telegram secret is rejected before any D1 access", async () => {
  const poisonDb = { prepare() { throw new Error("D1 must not be touched before webhook authentication"); } };
  let baseCalls = 0;
  const worker = createControlPlaneWorker({ async fetch() { baseCalls += 1; return new Response("unexpected"); }, scheduled() {} }, fetch);
  const response = await worker.fetch(groupRequest("owner", 10, "/users", 7, "wrong-secret"), envFor(poisonDb), {});
  assert.equal(response.status, 403);
  assert.equal(baseCalls, 0);
});

test("legacy /webhook path is not a control-plane ingress", async () => {
  const poisonDb = { prepare() { throw new Error("D1 must not be touched by an unknown route"); } };
  let calls = 0;
  const base = { async fetch(request) { calls += 1; assert.equal(new URL(request.url).pathname, "/webhook/owner"); return new Response("Not found", { status: 404 }); }, scheduled() {} };
  const worker = createControlPlaneWorker(base, fetch);
  const response = await worker.fetch(new Request("https://example.test/webhook/owner", { method: "POST", body: "{}" }), envFor(poisonDb), {});
  assert.equal(response.status, 404);
  assert.equal(calls, 1);
});

test("cross-bot fallback uses /tg logical route and does not leak executor webhook secret into env", async () => {
  const db = setupDb();
  const env = envFor(db);
  let calls = 0;
  const base = {
    async fetch(request, delegatedEnv) {
      calls += 1;
      assert.equal(new URL(request.url).pathname, "/tg/owner");
      assert.equal(request.headers.get("x-telegram-bot-api-secret-token"), "owner-secret", "trusted internal request must use the logical webhook secret");
      assert.equal(delegatedEnv.OWNER_SECRET, "owner-secret", "executor secret must never replace logical webhook secret in env");
      assert.equal(delegatedEnv.OWNER_TOKEN, "owner-token", "logical service token must never be substituted");
      assert.equal(delegatedEnv.MANAGEMENT_UI_BOT_ID, "backup", "fallback executor is exposed only as the management UI bot");
      return new Response("OK", { status: 200 });
    }, scheduled() {},
  };
  const response = await createControlPlaneWorker(base, fetch).fetch(groupRequest("backup", 44), env, {});
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.ok((await first(db, "SELECT completed_at FROM general_message_claims WHERE message_id = 44"))?.completed_at);
});

for (const command of ["/topicstyle", "/plan"]) test(`${command} is claimed once by the control plane across duplicate bot deliveries`, async () => {
  const db = setupDb();
  const env = envFor(db);
  let calls = 0;
  const base = {
    async fetch(request) {
      calls += 1;
      const update = await request.json();
      assert.equal(update.message.text, command);
      return new Response("OK", { status: 200 });
    }, scheduled() {},
  };
  const worker = createControlPlaneWorker(base, fetch);
  assert.equal((await worker.fetch(groupRequest("owner", 45, command), env, {})).status, 200);
  assert.equal((await worker.fetch(groupRequest("backup", 45, command), env, {})).status, 200);
  assert.equal(calls, 1);
  assert.ok((await first(db, "SELECT completed_at FROM general_message_claims WHERE message_id = 45"))?.completed_at);
});

test("a General retry receives the same explicit delegation context", async () => {
  const db = setupDb();
  const env = envFor(db);
  const seen = [];
  let attempts = 0;
  const base = {
    async fetch(_request, delegatedEnv) {
      attempts += 1;
      seen.push({ ...delegatedEnv.SUPPORT_DB[CONTROL_PLANE_CONTEXT] });
      if (attempts === 1) throw new Error("injected failure");
      return new Response("OK", { status: 200 });
    }, scheduled() {},
  };
  const worker = createControlPlaneWorker(base, fetch);
  assert.equal((await worker.fetch(groupRequest("backup", 55, "/ban 42"), env, {})).status, 500);
  assert.equal(await first(db, "SELECT 1 AS present FROM general_message_claims WHERE message_id = 55"), null);
  assert.equal((await worker.fetch(groupRequest("backup", 55, "/ban 42"), env, {})).status, 200);
  assert.equal(attempts, 2);
  assert.equal(seen[0].stableSeed, seen[1].stableSeed);
  assert.equal(seen[0].managementUiBotId, "backup");
  assert.equal(seen[1].managementUiBotId, "backup");
});

test("busy General delivery returns 500 without consuming the secondary webhook", async () => {
  const db = setupDb();
  const env = envFor(db, { GENERAL_CONTROL_LEASE_MS: "5000" });
  assert.equal((await claimGeneralControl(db, env, 61, "owner")).status, "acquired");
  let calls = 0;
  const worker = createControlPlaneWorker({ async fetch() { calls += 1; return new Response("OK"); }, scheduled() {} }, fetch);
  assert.equal((await worker.fetch(groupRequest("backup", 61), env, {})).status, 500);
  assert.equal(calls, 0);
});

test("General heartbeat prevents reclaim while a command runs beyond the original lease", async () => {
  const db = setupDb();
  const env = envFor(db, { GENERAL_CONTROL_LEASE_MS: "70", GENERAL_CONTROL_RENEW_MS: "15" });
  let contender = null;
  const base = { async fetch() { await new Promise((resolve) => setTimeout(resolve, 105)); contender = await claimGeneralControl(db, env, 71, "contender"); return new Response("OK"); }, scheduled() {} };
  assert.equal((await createControlPlaneWorker(base, fetch).fetch(groupRequest("owner", 71), env, {})).status, 200);
  assert.equal(contender?.status, "busy");
});

test("callback recovery is update-idempotent and quarantines uncertain fresh-panel delivery", async () => {
  const db = setupDb();
  const env = envFor(db);
  await db.prepare(pendingInsertSql).bind(
    7, "Op", "owner", "owner", 42, "ban", "confirm", null, "reason",
    -1001234567890, null, "nonce-old", "state", new Date().toISOString(), future(),
  ).run();
  let telegramCalls = 0;
  const uncertainFetch = async () => { telegramCalls += 1; throw new Error("socket closed after request write"); };
  const worker = createControlPlaneWorker({ async fetch() { throw new Error("recovery must not delegate stale callback"); }, scheduled() {} }, uncertainFetch);
  const request = () => callbackRequest("backup", { updateId: 29991, data: "um:pa:confirm:nonce-old" });
  assert.equal((await worker.fetch(request(), env, {})).status, 200);
  assert.equal((await worker.fetch(request(), env, {})).status, 200);
  assert.equal(telegramCalls, 1, "uncertain recovery delivery must never be replayed automatically");
  const recovery = await first(db, "SELECT delivery_uncertain_at FROM general_callback_recoveries WHERE incoming_bot_id = 'backup' AND update_id = 29991");
  assert.ok(recovery?.delivery_uncertain_at);
});

test("hardened database exposes delegation context without rewriting SQL binds", async () => {
  const db = setupDb();
  const hardened = createHardenedDatabase(db, { stableSeed: "m:x", managementUiBotId: "backup", generalOwnerToken: "outer-owner" });
  assert.deepEqual({ ...hardened[CONTROL_PLANE_CONTEXT] }, {
    generalOwnerToken: "outer-owner",
    stableSeed: "m:x",
    managementUiBotId: "backup",
  });
  const params = [7, "Op", "owner", "owner", 42, "ban", "reason", null, null, -1001234567890, null, "random", "state", new Date().toISOString(), future()];
  await hardened.prepare(pendingInsertSql).bind(...params).run();
  const row = await first(db, "SELECT management_bot_id, flow_nonce FROM operator_pending_actions WHERE operator_id = 7");
  assert.deepEqual({ ...row }, { management_bot_id: "owner", flow_nonce: "random" });
});


test("General bot-state lookup failure is fail-closed and never bypasses the hardened wrapper", async () => {
  const poisonDb = { prepare() { throw new Error("transient D1 lookup failure"); } };
  let baseCalls = 0;
  const base = { async fetch() { baseCalls += 1; return new Response("legacy"); }, scheduled() {} };
  const response = await createControlPlaneWorker(base, fetch).fetch(groupRequest("owner", 801), envFor(poisonDb), {});
  assert.equal(response.status, 500);
  assert.equal(baseCalls, 0);
});

test("enabled fallback callbacks stay on the Telegram bot that owns the keyboard", async () => {
  const db = setupDb();
  const env = envFor(db);
  let baseCalls = 0;
  const base = {
    async fetch(request, delegatedEnv) {
      baseCalls += 1;
      assert.equal(new URL(request.url).pathname, "/tg/backup");
      assert.equal(request.headers.get("x-telegram-bot-api-secret-token"), "backup-secret");
      assert.equal(delegatedEnv.BOT_REGISTRY, env.BOT_REGISTRY);
      assert.equal(delegatedEnv.SUPPORT_DB.invocationBudget, "webhook");
      return new Response("OK", { status: 200 });
    }, scheduled() {},
  };
  const response = await createControlPlaneWorker(base, fetch).fetch(
    callbackRequest("backup", { updateId: 29801, data: "um:g:home:a" }), env, {},
  );
  assert.equal(response.status, 200);
  assert.equal(baseCalls, 1);
});

test("a D1-disabled old bot can recover a pending callback with a fresh current-owner panel", async () => {
  const db = setupDb();
  db.sqlite.prepare("UPDATE bots SET enabled = 0 WHERE id = 'backup'").run();
  const env = envFor(db);
  await db.prepare(pendingInsertSql).bind(
    7, "Op", "owner", "owner", 42, "ban", "confirm", null, "reason",
    -1001234567890, null, "nonce-disabled", "state", new Date().toISOString(), future(),
  ).run();
  const urls = [];
  const telegramFetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const base = { async fetch() { throw new Error("disabled stale callback must not enter legacy worker"); }, scheduled() {} };
  const response = await createControlPlaneWorker(base, telegramFetch).fetch(
    callbackRequest("backup", { updateId: 29802, data: "um:pa:confirm:nonce-disabled" }), env, {},
  );
  assert.equal(response.status, 200);
  assert.match(urls[0], /botowner-token\/sendMessage$/);
  assert.ok(urls.some((url) => /botbackup-token\/answerCallbackQuery$/.test(url)));
  assert.ok(urls.some((url) => /botbackup-token\/editMessageReplyMarkup$/.test(url)));
  const pending = await first(db, "SELECT management_bot_id, flow_nonce FROM operator_pending_actions WHERE operator_id = 7");
  assert.equal(pending.management_bot_id, "owner");
  assert.equal(pending.flow_nonce, "nonce-disabled");
});

test("durable General dispatch marker prevents cross-bot replay when outer completion fails", async () => {
  const realDb = setupDb();
  const gate = { failCompletion: true };
  const flakyDb = new Proxy(realDb, {
    get(target, property) {
      if (property === "prepare") {
        return (sql) => {
          const source = String(sql);
          if (gate.failCompletion && source.includes("owner_token = ?") && source.includes("dispatch_succeeded_at IS NOT NULL") && source.includes("SET completed_at")) {
            return { bind: () => ({ async run() { throw new Error("injected outer completion failure"); } }) };
          }
          return target.prepare(source);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const env = envFor(flakyDb);
  let baseCalls = 0;
  const base = { async fetch() { baseCalls += 1; return new Response("OK", { status: 200 }); }, scheduled() {} };
  const worker = createControlPlaneWorker(base, fetch);
  assert.equal((await worker.fetch(groupRequest("backup", 803), env, {})).status, 500);
  assert.equal(baseCalls, 1);
  const afterFailure = realDb.sqlite.prepare("SELECT dispatch_succeeded_at, completed_at FROM general_message_claims WHERE message_id = 803").get();
  assert.ok(afterFailure.dispatch_succeeded_at);
  assert.equal(afterFailure.completed_at, null);
  gate.failCompletion = false;
  assert.equal((await worker.fetch(groupRequest("owner", 803), env, {})).status, 200);
  assert.equal(baseCalls, 1, "another bot must not replay a General update after durable dispatch");
  assert.ok(realDb.sqlite.prepare("SELECT completed_at FROM general_message_claims WHERE message_id = 803").get().completed_at);
});


test("fallback pending recovery keeps the actionable panel on the live executor bot", async () => {
  const db = setupDb();
  const env = envFor(db);
  await db.prepare(pendingInsertSql).bind(
    7, "Op", "owner", "owner", 42, "ban", "confirm", null, "reason",
    -1001234567890, null, "nonce-fallback-ui", "state", new Date().toISOString(), future(),
  ).run();
  const urls = [];
  const telegramFetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let delegated = 0;
  const base = {
    async fetch(request) {
      delegated += 1;
      assert.equal(new URL(request.url).pathname, "/tg/backup");
      return new Response("OK", { status: 200 });
    }, scheduled() {},
  };
  const worker = createControlPlaneWorker(base, telegramFetch);
  const firstCallback = callbackRequest("backup", { updateId: 29810, data: "um:pa:confirm:nonce-fallback-ui" });
  assert.equal((await worker.fetch(firstCallback, env, {})).status, 200);
  assert.match(urls[0], /botbackup-token\/sendMessage$/);
  assert.equal((await first(db, "SELECT management_bot_id FROM operator_pending_actions WHERE operator_id = 7")).management_bot_id, "backup");
  assert.equal(delegated, 0, "the stale fallback panel is recovered before executing the action");

  const secondCallback = callbackRequest("backup", { updateId: 29811, id: "cb-2", data: "um:pa:confirm:nonce-fallback-ui", messageId: 901 });
  assert.equal((await worker.fetch(secondCallback, env, {})).status, 200);
  assert.equal(delegated, 1, "the refreshed backup-owned panel is handled by the backup webhook without another recovery loop");
});


test("all bot deliveries of one General message share the same synthetic legacy update id", async () => {
  const db = setupDb();
  const env = envFor(db, { GENERAL_OWNER_GRACE_MS: "0" });
  const seen = [];
  const base = {
    async fetch(request, delegatedEnv) {
      const body = await request.json();
      seen.push({ updateId: body.update_id, ownerToken: delegatedEnv.OWNER_TOKEN, uiBot: delegatedEnv.MANAGEMENT_UI_BOT_ID });
      return new Response("OK", { status: 200 });
    }, scheduled() {},
  };
  const worker = createControlPlaneWorker(base, fetch);
  assert.equal((await worker.fetch(groupRequest("backup", 9901, "/users"), env, {})).status, 200);
  db.sqlite.prepare("UPDATE general_message_claims SET completed_at = NULL, dispatch_succeeded_at = NULL, lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE message_id = 9901").run();
  assert.equal((await worker.fetch(groupRequest("owner", 9901, "/users"), env, {})).status, 200);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].updateId, seen[1].updateId);
  assert.ok(seen[0].updateId < 0);
  assert.equal(seen[0].ownerToken, "owner-token", "logical service token must never be substituted");
  assert.equal(seen[0].uiBot, "backup", "fallback executor must be exposed only as UI owner");
});

test("service-stage recovery only renders services where the user actually has a managed profile", async () => {
  const db = setupDb();
  const env = envFor(db);
  db.sqlite.prepare("INSERT INTO conversations (bot_id, user_id, support_group_id, thread_id, status, created_at) VALUES ('owner', 42, -1001234567890, 77, 'open', ?)").run(new Date().toISOString());
  await db.prepare(pendingInsertSql).bind(
    7, "Op", "owner", null, 42, "ban", "service", null, null,
    -1001234567890, null, "nonce-service-exact", null, new Date().toISOString(), future(),
  ).run();
  const bodies = [];
  const telegramFetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const worker = createControlPlaneWorker({ async fetch() { throw new Error("must recover before legacy callback"); }, scheduled() {} }, telegramFetch);
  assert.equal((await worker.fetch(callbackRequest("backup", { updateId: 29921, data: "um:pa:service:0:nonce-service-exact" }), env, {})).status, 200);
  const keyboard = bodies[0].reply_markup.inline_keyboard.flat();
  assert.ok(keyboard.some((button) => button.text === "Owner"));
  assert.ok(!keyboard.some((button) => button.text === "Backup"));
  assert.equal(keyboard.find((button) => button.text === "Owner").callback_data,
    `um:pa:service:${managementBotKey(JSON.parse(env.BOT_REGISTRY), "owner")}:nonce-service-exact`);
});

test("malformed Telegram HTTP 200 during callback recovery is quarantined as uncertain", async () => {
  const db = setupDb();
  const env = envFor(db);
  await db.prepare(pendingInsertSql).bind(
    7, "Op", "owner", "owner", 42, "ban", "confirm", null, "reason",
    -1001234567890, null, "nonce-malformed-200", "state", new Date().toISOString(), future(),
  ).run();
  let calls = 0;
  const malformed = async () => { calls += 1; return new Response("not-json", { status: 200 }); };
  const worker = createControlPlaneWorker({ async fetch() { throw new Error("must not delegate"); }, scheduled() {} }, malformed);
  const request = () => callbackRequest("backup", { updateId: 29922, data: "um:pa:confirm:nonce-malformed-200" });
  assert.equal((await worker.fetch(request(), env, {})).status, 200);
  assert.equal((await worker.fetch(request(), env, {})).status, 200);
  assert.equal(calls, 1);
  const row = await first(db, "SELECT delivery_uncertain_at FROM general_callback_recoveries WHERE incoming_bot_id = 'backup' AND update_id = 29922");
  assert.ok(row?.delivery_uncertain_at);
});

test("review regression: callback recovery aborts a stalled Telegram response body", { timeout: 2000 }, async () => {
  const db = setupDb();
  const env = envFor(db, { TELEGRAM_TIMEOUT_MS: "20" });
  await db.prepare(pendingInsertSql).bind(
    7, "Op", "owner", "owner", 42, "ban", "confirm", null, "reason",
    -1001234567890, null, "nonce-body-timeout", "state", new Date().toISOString(), future(),
  ).run();
  let calls = 0;
  const bodyTimeout = async (_url, init) => { calls++; return stalledJsonResponse(init.signal); };
  const worker = createControlPlaneWorker({ async fetch() { throw new Error("must not delegate"); }, scheduled() {} }, bodyTimeout);
  const request = () => callbackRequest("backup", { updateId: 29923, data: "um:pa:confirm:nonce-body-timeout" });
  assert.equal((await worker.fetch(request(), env, {})).status, 200);
  assert.equal((await worker.fetch(request(), env, {})).status, 200);
  assert.equal(calls, 1);
  assert.ok((await first(db, "SELECT delivery_uncertain_at FROM general_callback_recoveries WHERE update_id = 29923")).delivery_uncertain_at);
});

test("Free callback recovery never marks an unsent panel uncertain at any budget boundary", async () => {
  let deferred = 0;
  let delivered = 0;
  for (let spent = 0; spent <= 44; spent++) {
    const db = setupDb();
    try {
      const env = envFor(db);
      await db.prepare(pendingInsertSql).bind(
        7, "Op", "owner", "owner", 42, "ban", "confirm", null, "reason",
        -1001234567890, null, "nonce-budget", "state", new Date().toISOString(), future(),
      ).run();
      env.SUPPORT_DB = createWebhookDatabase(db);
      for (let index = 0; index < spent; index++) await env.SUPPORT_DB.prepare("SELECT 1").all();
      let sends = 0;
      const fetchImpl = async (url) => {
        if (String(url).endsWith("/sendMessage")) sends++;
        return Response.json({ ok: true, result: { message_id: 1 } });
      };
      const worker = createControlPlaneWorker({ async fetch() { throw new Error("must not delegate"); }, scheduled() {} }, fetchImpl);
      const response = await worker.fetch(callbackRequest("backup", { updateId: 29924, data: "um:pa:confirm:nonce-budget" }), env, {});
      const row = await first(db, "SELECT * FROM general_callback_recoveries WHERE update_id = 29924");
      assert.ok(env.SUPPORT_DB.used <= 50);
      assert.ok(!row?.delivery_uncertain_at, `False uncertainty with ${spent} statements already spent`);
      if (sends) {
        delivered++;
        assert.equal(response.status, 200);
        assert.ok(row.completed_at);
      } else {
        deferred++;
        assert.ok(response.status >= 500);
        assert.ok(!row?.delivery_started_at);
      }
    } finally { db.sqlite.close(); }
  }
  assert.ok(deferred > 0 && delivered > 0);
});

for (const [plan, work, total] of [["free", 44, 50], ["paid", 990, 1000]]) test(`${plan}: General completion uses its reserve after delegated work fills the budget`, async () => {
  const db = setupDb();
  try {
    const env = envFor(db, { RECOVERY_D1_PLAN: plan });
    const budget = createWebhookDatabase(db, plan);
    let delegated = 0;
    const worker = createControlPlaneWorker({
      async fetch(_request, delegatedEnv) {
        delegated++;
        const shared = delegatedEnv.SUPPORT_DB;
        while (shared.used < work) await shared.prepare("SELECT 1").all();
        return new Response("OK");
      }, scheduled() {},
    });
    assert.equal((await worker.fetch(groupRequest("owner", 65200, "/users"), { ...env, SUPPORT_DB: budget }, {})).status, 200);
    assert.ok(budget.used > work && budget.used <= total);
    assert.ok((await first(db, "SELECT completed_at FROM general_message_claims WHERE message_id = 65200")).completed_at);
    assert.equal((await worker.fetch(groupRequest("owner", 65200, "/users"), env, {})).status, 200);
    assert.equal(delegated, 1);
  } finally { db.sqlite.close(); }
});
