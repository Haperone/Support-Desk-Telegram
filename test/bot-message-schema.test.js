import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1 } from "./helpers/sqlite-d1.js";
import { resolveInvocationDatabase } from "../src/recovery-budget.js";
import { RESET_TABLES } from "../src/storage-reset.js";

const baseline = readFileSync(new URL("../migrations/0023_initial_schema.sql", import.meta.url), "utf8");
const upgrade = readFileSync(new URL("../migrations/0024_bot_messages_and_navigation.sql", import.meta.url), "utf8");
const now = () => new Date().toISOString();

function operatorFirstFixture(kind, db) {
  db.exec("INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,created_at) VALUES('bot',1,-100,50,'now')");
  db.exec("INSERT INTO bot_message_settings VALUES('bot','','Configured','v1',7,'now')");
  if (kind === 'single') {
    db.exec("INSERT INTO message_delivery_attempts(bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at) VALUES('bot','support_to_user',-100,30,1,50,1,'copyMessage','now')");
  } else {
    db.exec("INSERT INTO media_groups(bot_id,direction,media_group_id,source_chat_id,target_chat_id,thread_id,user_id,last_received_at,created_at,operator_id) VALUES('bot','support_to_user','album',-100,1,50,1,0,'now',7)");
    db.exec("INSERT INTO media_group_items(bot_id,direction,media_group_id,source_chat_id,message_id,media_type,file_id,received_at) VALUES('bot','support_to_user','album',-100,30,'photo','file-a',0),('bot','support_to_user','album',-100,31,'photo','file-b',0)");
  }
  return {
    state: () => db.prepare("SELECT state FROM conversation_auto_replies WHERE bot_id='bot' AND user_id=1").get().state,
    complete: () => db.exec(kind === 'single'
      ? "UPDATE message_delivery_attempts SET completed_at='now',target_message_id=20 WHERE direction='support_to_user'"
      : "UPDATE media_group_items SET delivered_at='now',target_message_id=20+message_id-30 WHERE direction='support_to_user'"),
  };
}
const inboundQueues = {
  single: id => `INSERT INTO message_delivery_attempts(bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at) VALUES('bot','user_to_support',1,${id},1,50,-100,'forwardMessage','now')`,
  pending: id => `INSERT INTO pending_messages(bot_id,user_id,update_id,source_chat_id,source_message_id,created_at) VALUES('bot',1,${id},1,${id},'now')`,
  reopen: id => `INSERT INTO reopen_business_messages(bot_id,user_id,update_id,source_chat_id,source_message_id,created_at) VALUES('bot',1,${id},1,${id},'now')`,
  album: id => `INSERT INTO media_group_items(bot_id,direction,media_group_id,source_chat_id,message_id,media_type,file_id,received_at) VALUES('bot','user_to_support','inbound',1,${id},'photo','file',0)`,
};
for (const kind of ['single', 'album']) {
  for (const [queue, input] of Object.entries(inboundQueues)) for (const inputId of [10, 25]) {
    test(`operator-first receipt: ${kind} compares private-chat IDs with ${queue} input ${inputId} before delayed completion`, () => {
      const raw = new SqliteD1(new URL('../migrations/', import.meta.url));
      try {
        const fixture = operatorFirstFixture(kind, raw.sqlite);
        assert.equal(fixture.state(), 'waiting', 'Preparation is not a confirmed operator message');
        raw.sqlite.exec(input(inputId));
        fixture.complete();
        assert.equal(fixture.state(), inputId < 20 ? 'waiting' : 'disabled');
      } finally { raw.close(); }
    });
  }
  test(`operator-first receipt: late ${kind} completion cannot silence a newer cycle`, () => {
    const raw = new SqliteD1(new URL('../migrations/', import.meta.url));
    try {
      const fixture = operatorFirstFixture(kind, raw.sqlite);
      raw.sqlite.exec("UPDATE conversations SET reply_epoch=reply_epoch+1,status='closed'");
      fixture.complete();
      assert.equal(fixture.state(), 'waiting');
    } finally { raw.close(); }
  });
  for (const state of ['ready', 'started', 'sent']) test(`operator-first receipt: ${kind} only cancels an unsent later reply (${state})`, () => {
    const raw = new SqliteD1(new URL('../migrations/', import.meta.url));
    try {
      const fixture = operatorFirstFixture(kind, raw.sqlite);
      raw.sqlite.prepare("UPDATE conversation_auto_replies SET state=?,source_message_id=25,text='Configured'").run(state);
      fixture.complete();
      assert.equal(fixture.state(), state === 'ready' ? 'disabled' : state);
    } finally { raw.close(); }
  });
}
test('operator-first receipt migration preserves existing cycles and unknown legacy attempts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(directory).filter(file => file.endsWith('.sql') && file < '0036').sort()) {
      db.exec(readFileSync(new URL(file, directory), 'utf8'));
    }
    const fixture = operatorFirstFixture('single', db);
    db.exec(readFileSync(new URL('0036_operator_initiated_auto_reply.sql', directory), 'utf8'));
    assert.equal(fixture.state(), 'waiting');
    assert.equal(db.prepare('SELECT auto_reply_cycle FROM message_delivery_attempts').get().auto_reply_cycle, null);
    fixture.complete();
    assert.equal(fixture.state(), 'waiting', 'Do not assign old attempts to a guessed cycle');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});


test("verification notice migration preserves passed legacy challenges and queued messages without inventing prompt IDs", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(baseline);
    db.exec(upgrade);
    for (const file of ['0025_bot_setup_notices.sql', '0026_manual_delivery_runs.sql']) db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
    db.exec("INSERT INTO verification_challenges(bot_id,user_id,token_hash,status,created_at,expires_at,verified_at,notice_sent_at) VALUES('bot',1,'preserve-token','passed','created','expires','verified','sent')");
    db.exec("INSERT INTO pending_messages(bot_id,user_id,update_id,source_chat_id,source_message_id,challenge_id,created_at) VALUES('bot',1,10,1,20,1,'created')");
    db.exec(readFileSync(new URL('../migrations/0027_verification_notice_status.sql', import.meta.url), 'utf8'));
    const row = db.prepare('SELECT * FROM verification_challenges').get();
    assert.equal(row.status, 'passed');
    assert.equal(row.token_hash, 'preserve-token');
    assert.equal(row.verified_at, 'verified');
    assert.equal(row.notice_sent_at, 'sent');
    assert.equal(row.notice_message_id, null);
    assert.equal(row.notice_resolved_at, null);
    assert.equal(row.notice_retry_at, null);
    assert.equal(db.prepare('SELECT source_message_id FROM pending_messages').get().source_message_id, 20);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test("bot message migration preserves live data, seeds existing open cases as silent, and supplies no texts", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(baseline);
    db.exec("INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,status,created_at) VALUES('bot',1,-100,50,'open','now'),('bot',2,-100,51,'closed','now')");
    db.exec("INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES('bot',1,50,10,20,'now')");
    db.exec("INSERT INTO banned_users(bot_id,user_id,reason,banned_at) VALUES('bot',3,'keep','now')");
    db.exec(upgrade);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM bot_message_settings").get().n, 0);
    assert.equal(db.prepare("SELECT state FROM conversation_auto_replies WHERE user_id=1").get().state, "disabled");
    assert.equal(db.prepare("SELECT state FROM conversation_auto_replies WHERE user_id=2").get().state, "waiting");
    assert.equal(db.prepare("SELECT support_message_id FROM message_mappings").get().support_message_id, 20);
    assert.equal(db.prepare("SELECT reason FROM banned_users").get().reason, "keep");
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("auto-reply cycles exclude old queued deliveries and stay silent after an operator-first message", () => {
  const db = new SqliteD1(new URL("../migrations/", import.meta.url));
  try {
    db.sqlite.exec("INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,created_at) VALUES('bot',1,-100,50,'now')");
    db.sqlite.exec("INSERT INTO bot_message_settings VALUES('bot','','Configured','v1',7,'now')");
    db.sqlite.exec("INSERT INTO pending_messages(bot_id,user_id,update_id,source_chat_id,source_message_id,created_at) VALUES('bot',1,10,1,10,'now')");
    db.sqlite.exec("UPDATE conversations SET reply_epoch = reply_epoch + 1, status='closed'");
    db.sqlite.exec("UPDATE conversations SET status='open'");
    db.sqlite.exec("UPDATE pending_messages SET delivery_completed_at='now',target_message_id=20");
    assert.equal(db.sqlite.prepare("SELECT state FROM conversation_auto_replies").get().state, "waiting");
    db.sqlite.exec("INSERT INTO message_delivery_attempts(bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at) VALUES('bot','support_to_user',-100,30,1,50,1,'copyMessage','now')");
    db.sqlite.exec("UPDATE message_delivery_attempts SET completed_at='now',target_message_id=31");
    assert.equal(db.sqlite.prepare("SELECT state FROM conversation_auto_replies").get().state, "disabled");
    db.sqlite.exec("INSERT INTO message_delivery_attempts(bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at) VALUES('bot','user_to_support',1,32,1,50,-100,'forwardMessage','now')");
    db.sqlite.exec("UPDATE message_delivery_attempts SET completed_at='now',target_message_id=33 WHERE direction='user_to_support'");
    assert.equal(db.sqlite.prepare("SELECT state FROM conversation_auto_replies").get().state, "disabled");
    db.sqlite.exec("UPDATE conversations SET reply_epoch=reply_epoch+1,status='closed'");
    db.sqlite.exec("UPDATE conversations SET status='open'");
    db.sqlite.exec("INSERT INTO pending_messages(bot_id,user_id,update_id,source_chat_id,source_message_id,created_at) VALUES('bot',1,40,1,40,'now')");
    db.sqlite.exec("UPDATE pending_messages SET delivery_completed_at='now',target_message_id=50 WHERE source_message_id=40");
    assert.equal(db.sqlite.prepare("SELECT state FROM conversation_auto_replies").get().state, "ready");
    db.sqlite.exec("UPDATE bot_message_settings SET auto_reply_text=''");
    assert.equal(db.sqlite.prepare("SELECT state FROM conversation_auto_replies").get().state, "disabled");
    assert.equal(db.sqlite.prepare("SELECT text FROM conversation_auto_replies").get().text, "");
  } finally { db.close(); }
});

test("full reset forgets conversation auto-reply state but preserves per-bot texts; stale invocations stay fenced", async () => {
  const raw = new SqliteD1(new URL("../migrations/", import.meta.url));
  try {
    raw.sqlite.exec("INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,created_at) VALUES('bot',1,-100,50,'now')");
    raw.sqlite.exec("INSERT INTO bot_message_settings VALUES('bot','Hello','Received','v1',7,'now')");
    const old = await resolveInvocationDatabase(raw, { RETENTION_ENABLED: "true" });
    raw.sqlite.exec("UPDATE storage_control SET generation=1");
    await old.prepare("UPDATE conversation_auto_replies SET state='sent' WHERE user_id=1").run();
    assert.equal(raw.sqlite.prepare("SELECT state FROM conversation_auto_replies").get().state, "waiting");
    await old.prepare("INSERT INTO bot_welcome_attempts VALUES('bot',1,?)").bind(now()).run();
    assert.equal(raw.sqlite.prepare("SELECT COUNT(*) n FROM bot_welcome_attempts").get().n, 0);
    for (const table of RESET_TABLES) raw.sqlite.exec("DELETE FROM " + table);
    assert.equal(raw.sqlite.prepare("SELECT COUNT(*) n FROM conversation_auto_replies").get().n, 0);
    assert.equal(raw.sqlite.prepare("SELECT auto_reply_text FROM bot_message_settings").get().auto_reply_text, "Received");
    raw.sqlite.exec("INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,created_at) VALUES('bot',1,-100,51,'now')");
    assert.equal(raw.sqlite.prepare("SELECT state FROM conversation_auto_replies").get().state, "waiting");
  } finally { raw.close(); }
});
