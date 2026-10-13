import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createControlPlaneWorker } from "../control-plane-worker.js";

class D1Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new D1Statement(this.db, this.sql, params); }
  async first() { return this.db.prepare(this.sql).get(...this.params) || null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes || 0), last_row_id: Number(info.lastInsertRowid || 0) } };
  }
}
class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const migrations = resolve(root, "migrations");
    for (const name of readdirSync(migrations).filter((entry) => entry.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(resolve(migrations, name), "utf8"));
    }
  }
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
}

const registry = JSON.stringify([{
  id: "owner",
  displayName: "Owner",
  topicPrefix: "Owner",
  tokenBinding: "OWNER_TOKEN",
  webhookSecretBinding: "OWNER_SECRET",
  locale: "en",
  enabled: true,
  groupCommandOwner: true,
}]);

test("real legacy worker is reached through authenticated /tg ingress and outer General fencing", async () => {
  const db = new TestD1();
  const env = {
    SUPPORT_DB: db,
    SUPPORT_GROUP_ID: "-1001234567890",
    ADMIN_IDS: "7",
    BOT_REGISTRY: registry,
    OWNER_TOKEN: "12345:owner-token",
    OWNER_SECRET: "owner-secret",
    GENERAL_OWNER_GRACE_MS: "0",
    PUBLIC_BASE_URL: "https://example.test",
  };
  const telegramCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    telegramCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const worker = createControlPlaneWorker();
    const response = await worker.fetch(new Request("https://example.test/tg/owner", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "owner-secret" },
      body: JSON.stringify({
        update_id: 40001,
        message: {
          message_id: 31001,
          chat: { id: -1001234567890, type: "supergroup" },
          from: { id: 7, first_name: "Primary" },
          text: "/bots",
        },
      }),
    }), env, {});

    assert.equal(response.status, 200);
    assert.equal(telegramCalls.length, 1);
    assert.match(telegramCalls[0].url, /\/bot12345:owner-token\/sendMessage$/);
    const general = db.sqlite.prepare("SELECT completed_at FROM general_message_claims WHERE support_group_id = ? AND message_id = ?").get(-1001234567890, 31001);
    assert.ok(general?.completed_at, "outer General claim must be completed");
    const processed = db.sqlite.prepare("SELECT state FROM processed_updates WHERE bot_id = 'owner' AND update_id = -1000000031001").get();
    assert.equal(processed?.state, "completed", "legacy shared General idempotency must run on the synthetic message key");
  } finally {
    globalThis.fetch = originalFetch;
    db.sqlite.close();
  }
});


test("real legacy worker deduplicates the same General message across two webhook bots after outer marker loss", async () => {
  const db = new TestD1();
  const env = {
    SUPPORT_DB: db,
    SUPPORT_GROUP_ID: "-1001234567890",
    ADMIN_IDS: "7",
    BOT_REGISTRY: JSON.stringify([
      {
        id: "owner", displayName: "Owner", topicPrefix: "Owner",
        tokenBinding: "OWNER_TOKEN", webhookSecretBinding: "OWNER_SECRET",
        locale: "en", enabled: true, groupCommandOwner: true,
      },
      {
        id: "backup", displayName: "Backup", topicPrefix: "Backup",
        tokenBinding: "BACKUP_TOKEN", webhookSecretBinding: "BACKUP_SECRET",
        locale: "en", enabled: true,
      },
    ]),
    OWNER_TOKEN: "12345:owner-token",
    OWNER_SECRET: "owner-secret",
    BACKUP_TOKEN: "23456:backup-token",
    BACKUP_SECRET: "backup-secret",
    GENERAL_OWNER_GRACE_MS: "0",
    PUBLIC_BASE_URL: "https://example.test",
  };
  const telegramCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    telegramCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 888 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const request = (botId, secret, updateId) => new Request(`https://example.test/tg/${botId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: 32001,
        chat: { id: -1001234567890, type: "supergroup" },
        from: { id: 7, first_name: "Primary" },
        text: "/bots",
      },
    }),
  });
  try {
    const worker = createControlPlaneWorker();
    const firstResponse = await worker.fetch(request("backup", "backup-secret", 50001), env, {});
    assert.equal(firstResponse.status, 200);
    assert.equal(telegramCalls.length, 1, "first logical execution must emit one Telegram management response");
    assert.match(telegramCalls[0].url, /\/bot23456:backup-token\/sendMessage$/, "fallback UI must be sent by the live executor bot");

    const syntheticId = -1_000_000_000_000 - 32001;
    const processed = db.sqlite.prepare("SELECT state FROM processed_updates WHERE bot_id = 'owner' AND update_id = ?").get(syntheticId);
    assert.equal(processed?.state, "completed");

    // Simulate losing the outer post-dispatch marker. The inner shared processed_updates
    // record must still prevent another bot delivery from replaying the logical side effect.
    db.sqlite.prepare("UPDATE general_message_claims SET completed_at = NULL, dispatch_succeeded_at = NULL, lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE support_group_id = ? AND message_id = ?")
      .run(-1001234567890, 32001);

    const secondResponse = await worker.fetch(request("owner", "owner-secret", 50002), env, {});
    assert.equal(secondResponse.status, 200);
    assert.equal(telegramCalls.length, 1, "cross-bot replay must be stopped by the real legacy processed_updates barrier");
    const outer = db.sqlite.prepare("SELECT completed_at FROM general_message_claims WHERE support_group_id = ? AND message_id = ?").get(-1001234567890, 32001);
    assert.ok(outer?.completed_at, "the replaying webhook may repair the outer completion marker without replaying the side effect");
  } finally {
    globalThis.fetch = originalFetch;
    db.sqlite.close();
  }
});
