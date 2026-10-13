import test from "node:test";
import assert from "node:assert/strict";
import { SqliteD1 } from "./helpers/sqlite-d1.js";
import {
  formatOperatorMessageDeliveryStatus,
  getOperatorMessageDeliveryStatus,
  operatorMessageDeliveryRefreshAction,
} from "../src/delivery-status.js";

const migrations = new URL("../migrations/", import.meta.url);
function fixture() { return new SqliteD1(migrations); }
function insertAttempt(db, values) {
  db.sqlite.prepare(`INSERT INTO message_delivery_attempts
    (bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at,request_started_at,completed_at,target_message_id,failure_code)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    values.botId ?? "service", "support_to_user", values.sourceChatId ?? -1001,
    values.sourceMessageId, values.userId ?? 23, 8, values.targetChatId ?? 23, "sendMessage",
    values.startedAt ?? "2026-09-26T10:00:00.000Z", values.requestStartedAt ?? null,
    values.completedAt ?? null, values.targetMessageId ?? null, values.failureCode ?? null,
  );
}

test("reports confirmed Telegram delivery for the exact source message", async () => {
  const db = fixture();
  try {
    insertAttempt(db, { sourceMessageId: 101, completedAt: "2026-09-26T10:00:01Z", targetMessageId: 404 });
    const status = await getOperatorMessageDeliveryStatus(db, { botId: "service", sourceChatId: -1001, sourceMessageId: 101 });
    assert.equal(status.status, "confirmed");
    assert.equal(status.targetMessageId, 404);
    assert.match(formatOperatorMessageDeliveryStatus(status, 'ru'), /прочтение клиентом не подтверждается/);
  } finally { db.close(); }
});

test("distinguishes safe retry, definite failure, and unknown external outcome", async () => {
  const db = fixture();
  try {
    insertAttempt(db, { sourceMessageId: 102 });
    insertAttempt(db, { sourceMessageId: 103, failureCode: "telegram_chat_not_found" });
    insertAttempt(db, { sourceMessageId: 104, requestStartedAt: "2026-09-26T10:01:00Z", failureCode: "telegram_delivery_outcome_unknown" });
    const lookup = (sourceMessageId) => getOperatorMessageDeliveryStatus(db, { botId: "service", sourceChatId: -1001, sourceMessageId });
    assert.equal((await lookup(102)).status, "retryable");
    assert.equal((await lookup(103)).status, "failed");
    assert.equal((await lookup(104)).status, "unknown");
    assert.match(formatOperatorMessageDeliveryStatus(await lookup(104), 'ru'), /автоматический повтор запрещён/);
  } finally { db.close(); }
});

test("uses per-item album delivery records and reports missing evidence as unknown", async () => {
  const db = fixture();
  try {
    db.sqlite.prepare(`INSERT INTO media_groups
      (bot_id,direction,media_group_id,source_chat_id,target_chat_id,thread_id,user_id,last_received_at,created_at)
      VALUES('service','support_to_user','album-a',-1001,23,8,23,1790416800000,'2026-09-26T10:00:00Z')`).run();
    db.sqlite.prepare(`INSERT INTO media_group_items
      (bot_id,direction,media_group_id,source_chat_id,message_id,media_type,file_id,received_at,delivered_at,target_message_id)
      VALUES('service','support_to_user','album-a',-1001,105,'photo','f1',1790416800000,'2026-09-26T10:00:02Z',405)`).run();
    const input = { botId: "service", sourceChatId: -1001, sourceMessageId: 105 };
    assert.equal((await getOperatorMessageDeliveryStatus(db, input)).status, "confirmed");
    const missing = await getOperatorMessageDeliveryStatus(db, { ...input, sourceMessageId: 999 });
    assert.equal(missing.status, "unknown");
    assert.equal(missing.reasonCode, "delivery_record_missing");
    assert.deepEqual(operatorMessageDeliveryRefreshAction(input), {
      action: "delivery_status_refresh", botId: "service", sourceChatId: -1001, sourceMessageId: 105,
    });
  } finally { db.close(); }
});

test('delivery status card has distinct copy in all supported languages', () => {
  const values = ['en', 'ru', 'es', 'zh'].map(locale => formatOperatorMessageDeliveryStatus({ status: 'unknown' }, locale));
  assert.equal(new Set(values).size, 4);
  assert.equal(formatOperatorMessageDeliveryStatus({ status: 'confirmed' }),
    formatOperatorMessageDeliveryStatus({ status: 'confirmed' }, 'en'));
  for (const locale of ['en', 'es', 'zh']) assert.doesNotMatch(
    formatOperatorMessageDeliveryStatus({ status: 'failed' }, locale), /[А-Яа-яЁё]/);
});
