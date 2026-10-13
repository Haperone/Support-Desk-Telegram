import test from "node:test";
import assert from "node:assert/strict";
import { createControlPlaneWorker } from "../control-plane-worker.js";

function registry() {
  return JSON.stringify([
    {
      id: "owner",
      displayName: "Owner",
      topicPrefix: "Owner",
      tokenBinding: "OWNER_TOKEN",
      webhookSecretBinding: "OWNER_SECRET",
      locale: "en",
      enabled: true,
      groupCommandOwner: true,
    },
    {
      id: "backup",
      displayName: "Backup",
      topicPrefix: "Backup",
      tokenBinding: "BACKUP_TOKEN",
      webhookSecretBinding: "BACKUP_SECRET",
      locale: "en",
      enabled: true,
    },
  ]);
}

function disabledBackupDb() {
  return {
    prepare(sql) {
      if (sql.includes("FROM cloudflare_plan_settings")) return { async first() { return { revision: "initial" }; } };
      assert.match(String(sql), /SELECT enabled FROM bots WHERE id = \?/);
      return {
        bind(botId) {
          assert.equal(botId, "backup");
          return { async first() { return { enabled: 0 }; } };
        },
      };
    },
  };
}

test("a D1-disabled bot never becomes the General fallback executor or legacy General handler", async () => {
  const env = {
    SUPPORT_DB: disabledBackupDb(),
    SUPPORT_GROUP_ID: "-1001234567890",
    BOT_REGISTRY: registry(),
    OWNER_TOKEN: "owner-token",
    OWNER_SECRET: "owner-secret",
    BACKUP_TOKEN: "backup-token",
    BACKUP_SECRET: "backup-secret",
  };
  let calls = 0;
  const baseWorker = {
    async fetch() {
      calls += 1;
      throw new Error("D1-disabled General messages must not bypass the hardened wrapper");
    },
    scheduled() {},
  };
  const worker = createControlPlaneWorker(baseWorker, fetch);
  const request = new Request("https://example.test/tg/backup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "backup-secret",
    },
    body: JSON.stringify({
      update_id: 12001,
      message: {
        message_id: 2001,
        chat: { id: -1001234567890 },
        from: { id: 7, first_name: "Op" },
        text: "/users",
      },
    }),
  });

  const response = await worker.fetch(request, env, { marker: "ctx-unused-for-disabled-message" });
  assert.equal(response.status, 200);
  assert.equal(calls, 0);
});
