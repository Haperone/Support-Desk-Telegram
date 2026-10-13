import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { resolveActiveGroup, registerSupportGroup, listGroupServices, findTopicByGroup,
  inspectGroupCutover, commitGroupCutover, archiveConversationForNewGroup } from '../src/service-groups.js';

const create = () => new SqliteD1(new URL('../migrations/', import.meta.url));
const addConversation = (db, bot, user, group, thread) => db.sqlite.prepare(`INSERT INTO conversations
  (bot_id,user_id,support_group_id,thread_id,created_at) VALUES(?,?,?,?,?)`)
  .run(bot, user, group, thread, '2026-09-26T00:00:00.000Z');

test('legacy services share a group and keep independent routes', async () => {
  const db = create();
  try {
    assert.equal(await resolveActiveGroup(db, 'lic', { SUPPORT_GROUP_ID: '-1001' }), -1001);
    assert.equal(await resolveActiveGroup(db, 'new', { SUPPORT_GROUP_ID: '-1001' }), -1001);
    assert.equal(await resolveActiveGroup(db, 'lic', { SUPPORT_GROUP_ID: '-1002' }), -1001);
    assert.deepEqual((await listGroupServices(db, -1001)).map(row => row.bot_id), ['lic', 'new']);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM support_groups').get().n, 1);
  } finally { db.close(); }
});

test('first connection creates a route without a legacy group and safely retries', async () => {
  const db = create();
  try {
    assert.equal(await resolveActiveGroup(db,'fresh',{}),null);
    await registerSupportGroup(db,-1002,{title:'Fresh service'});
    db.sqlite.prepare(`INSERT INTO pending_messages(bot_id,user_id,update_id,source_chat_id,
      source_message_id,created_at,request_started_at) VALUES('fresh',7,1,7,1,'now','now')`).run();
    assert.deepEqual((await inspectGroupCutover(db,'fresh',-1002)).blockers,['pending_send_unresolved']);
    await assert.rejects(commitGroupCutover(db,'fresh',-1002,null),/group_cutover_blocked/);
    db.sqlite.prepare(`DELETE FROM pending_messages WHERE bot_id='fresh'`).run();
    assert.deepEqual(await inspectGroupCutover(db,'fresh',-1002),
      {ready:true,blockers:[],currentGroupId:null,revision:null,targetGroupId:-1002});
    assert.deepEqual(await commitGroupCutover(db,'fresh',-1002,null),
      {changed:true,groupId:-1002,revision:0});
    assert.deepEqual(await commitGroupCutover(db,'fresh',-1002,null),
      {changed:false,groupId:-1002,revision:0});
    assert.equal(await resolveActiveGroup(db,'fresh',{}),-1002);
    await registerSupportGroup(db,-1003);
    await assert.rejects(commitGroupCutover(db,'fresh',-1003,null),/group_route_changed/);
  } finally { db.close(); }
});

test('separate groups can reuse topic numbers without mixing history and mappings', async () => {
  const db = create();
  try {
    await resolveActiveGroup(db, 'a', '-1001');
    await resolveActiveGroup(db, 'b', '-1001');
    await registerSupportGroup(db, -1002, { title: 'Service B' });
    await commitGroupCutover(db, 'b', -1002, -1001);
    addConversation(db, 'a', 7, -1001, 42);
    addConversation(db, 'b', 8, -1002, 42);
    db.sqlite.prepare(`INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,
      support_message_id,created_at) VALUES(?,?,?,?,?,?)`).run('a',7,42,11,21,'now');
    db.sqlite.prepare(`INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,
      support_message_id,created_at) VALUES(?,?,?,?,?,?)`).run('b',8,42,12,21,'now');
    assert.equal((await findTopicByGroup(db,-1001,42)).bot_id, 'a');
    assert.equal((await findTopicByGroup(db,-1002,42)).bot_id, 'b');
    assert.equal((await findTopicByGroup(db,-1003,42)), null);
    assert.deepEqual(db.sqlite.prepare(`SELECT bot_id,support_group_id FROM message_mappings
      ORDER BY bot_id`).all().map(row => [row.bot_id,row.support_group_id]), [['a',-1001],['b',-1002]]);
    assert.deepEqual((await listGroupServices(db,-1001)).map(row => row.bot_id),['a']);
  } finally { db.close(); }
});

test('cutover is idempotent and archives old topic before a returning user gets a new one', async () => {
  const db = create();
  try {
    await resolveActiveGroup(db,'a','-1001');
    addConversation(db,'a',7,-1001,42);
    db.sqlite.prepare(`INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,
      support_message_id,created_at) VALUES(?,?,?,?,?,?)`).run('a',7,42,11,21,'now');
    await registerSupportGroup(db,-1002);
    assert.equal((await inspectGroupCutover(db,'a',-1002)).ready,true);
    assert.deepEqual(await commitGroupCutover(db,'a',-1002,-1001),
      {changed:true,groupId:-1002,revision:1});
    assert.deepEqual(await commitGroupCutover(db,'a',-1002,-1001),
      {changed:false,groupId:-1002,revision:1});
    assert.equal(await archiveConversationForNewGroup(db,'a',7,-1002),true);
    assert.equal(await archiveConversationForNewGroup(db,'a',7,-1002),false);
    addConversation(db,'a',7,-1002,42);
    db.sqlite.prepare(`INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,
      support_message_id,created_at) VALUES(?,?,?,?,?,?)`).run('a',7,42,12,21,'later');
    assert.equal((await findTopicByGroup(db,-1001,42)).historical,1);
    assert.equal((await findTopicByGroup(db,-1002,42)).historical,0);
    assert.equal(db.sqlite.prepare('SELECT support_group_id FROM message_mappings WHERE user_message_id=11').get().support_group_id,-1001);
    assert.equal(db.sqlite.prepare('SELECT support_group_id FROM message_mappings WHERE user_message_id=12').get().support_group_id,-1002);
  } finally { db.close(); }
});

test('moving a service to another group invalidates reaction proof from the previous group', async () => {
  const db = create();
  try {
    await resolveActiveGroup(db, 'a', '-1001');
    await registerSupportGroup(db, -1002);
    db.sqlite.prepare(`INSERT INTO reaction_settings(bot_id,enabled,support_to_user_enabled,user_to_support_enabled,
      support_to_user_verified,user_to_support_verified,updated_at)
      VALUES('a',1,1,1,1,1,'now')`).run();
    assert.deepEqual(await commitGroupCutover(db, 'a', -1002, -1001),
      { changed: true, groupId: -1002, revision: 1 });
    const state = db.sqlite.prepare(`SELECT enabled,support_to_user_enabled,user_to_support_enabled,
      support_to_user_verified,user_to_support_verified FROM reaction_settings WHERE bot_id='a'`).get();
    assert.deepEqual({ ...state }, { enabled: 0, support_to_user_enabled: 0, user_to_support_enabled: 0,
      support_to_user_verified: 0, user_to_support_verified: 0 });
    await commitGroupCutover(db, 'a', -1002, -1001);
    assert.equal(db.sqlite.prepare("SELECT enabled FROM reaction_settings WHERE bot_id='a'").get().enabled, 0);
  } finally { db.close(); }
});

test('uncertain delivery or topic creation blocks cutover and retry works after resolution', async () => {
  const db = create();
  try {
    await resolveActiveGroup(db,'a','-1001');
    await registerSupportGroup(db,-1002);
    db.sqlite.prepare(`INSERT INTO conversation_provision_attempts(bot_id,user_id,started_at,request_started_at)
      VALUES('a',7,'now','now')`).run();
    assert.deepEqual((await inspectGroupCutover(db,'a',-1002)).blockers,['topic_creation_unresolved']);
    await assert.rejects(commitGroupCutover(db,'a',-1002,-1001),/group_cutover_blocked/);
    db.sqlite.prepare(`DELETE FROM conversation_provision_attempts WHERE bot_id='a'`).run();
    db.sqlite.prepare(`INSERT INTO message_delivery_attempts(bot_id,direction,source_chat_id,
      source_message_id,user_id,thread_id,target_chat_id,method,started_at,request_started_at)
      VALUES('a','user_to_support',7,11,7,42,-1001,'copyMessage','now','now')`).run();
    assert.deepEqual((await inspectGroupCutover(db,'a',-1002)).blockers,['delivery_unresolved']);
    db.sqlite.prepare(`UPDATE message_delivery_attempts SET completed_at='now' WHERE bot_id='a'`).run();
    assert.equal((await inspectGroupCutover(db,'a',-1002)).ready,true);
    assert.equal((await commitGroupCutover(db,'a',-1002,-1001)).changed,true);
  } finally { db.close(); }
});

test('unfinished reopening and preserved customer replies block a group cutover', async () => {
  const db = create();
  try {
    await resolveActiveGroup(db,'a','-1001');
    await registerSupportGroup(db,-1002);
    db.sqlite.prepare(`INSERT INTO conversation_reopen_effects(bot_id,user_id,old_thread_id,created_at)
      VALUES('a',7,42,'now')`).run();
    db.sqlite.prepare(`INSERT INTO reopen_business_messages(bot_id,user_id,update_id,source_chat_id,
      source_message_id,created_at) VALUES('a',7,700,7,11,'now')`).run();
    assert.deepEqual((await inspectGroupCutover(db,'a',-1002)).blockers,
      ['reopen_effect_unresolved','reopen_business_unresolved']);
    await assert.rejects(commitGroupCutover(db,'a',-1002,-1001),/group_cutover_blocked/);
    db.sqlite.prepare("UPDATE conversation_reopen_effects SET completed_at='now' WHERE bot_id='a'").run();
    assert.deepEqual((await inspectGroupCutover(db,'a',-1002)).blockers,['reopen_business_unresolved']);
    await assert.rejects(commitGroupCutover(db,'a',-1002,-1001),/group_cutover_blocked/);
    db.sqlite.prepare("UPDATE reopen_business_messages SET failure_code='telegram_delivery_outcome_unknown' WHERE bot_id='a'").run();
    assert.deepEqual((await inspectGroupCutover(db,'a',-1002)).blockers,['reopen_business_unresolved']);
    db.sqlite.prepare("UPDATE reopen_business_messages SET failure_code='telegram_source_unavailable',failure_alerted_at='now' WHERE bot_id='a'").run();
    assert.equal((await commitGroupCutover(db,'a',-1002,-1001)).changed,true);
  } finally { db.close(); }
});

test('reopening started between inspection and route update fails the cutover CAS', async () => {
  const db = create();
  try {
    await resolveActiveGroup(db,'a','-1001');
    await registerSupportGroup(db,-1002);
    const originalPrepare = db.prepare.bind(db);
    let injected = false;
    db.prepare = sql => {
      if (!injected && sql.includes('UPDATE service_group_routes SET group_id=')) {
        injected = true;
        db.sqlite.prepare(`INSERT INTO conversation_reopen_effects(bot_id,user_id,old_thread_id,created_at)
          VALUES('a',7,42,'now')`).run();
      }
      return originalPrepare(sql);
    };
    await assert.rejects(commitGroupCutover(db,'a',-1002,-1001),/group_cutover_raced_or_blocked/);
    assert.equal(db.sqlite.prepare("SELECT group_id FROM service_group_routes WHERE bot_id='a'").get().group_id,-1001);
    assert.equal(injected,true);
  } finally { db.close(); }
});

test('queued old-group album blocks cutover before any Telegram send starts', async () => {
  const db = create();
  try {
    await resolveActiveGroup(db,'a','-1001');
    await registerSupportGroup(db,-1002);
    db.sqlite.prepare(`INSERT INTO media_groups(bot_id,direction,media_group_id,source_chat_id,
      target_chat_id,thread_id,user_id,last_received_at,created_at)
      VALUES('a','user_to_support','album-1',7,-1001,42,7,1,'now')`).run();
    db.sqlite.prepare(`INSERT INTO media_group_items(bot_id,direction,media_group_id,source_chat_id,
      message_id,media_type,file_id,received_at)
      VALUES('a','user_to_support','album-1',7,11,'photo','file',1)`).run();
    assert.deepEqual((await inspectGroupCutover(db,'a',-1002)).blockers,['album_unresolved','album_item_unresolved']);
    await assert.rejects(commitGroupCutover(db,'a',-1002,-1001),/group_cutover_blocked/);
    db.sqlite.prepare("UPDATE media_group_items SET delivered_at='now' WHERE bot_id='a'").run();
    db.sqlite.prepare("UPDATE media_groups SET delivery_completed_at='now' WHERE bot_id='a'").run();
    assert.equal((await commitGroupCutover(db,'a',-1002,-1001)).changed,true);
  } finally { db.close(); }
});

test('completed topic marker matching an active conversation survives cutover inspection and is retired with the old topic', async () => {
  const db = create();
  try {
    await resolveActiveGroup(db,'a','-1001');
    await registerSupportGroup(db,-1002);
    addConversation(db,'a',7,-1001,42);
    db.sqlite.prepare(`INSERT INTO conversation_provision_attempts
      (bot_id,user_id,started_at,request_started_at,completed_at,thread_id,support_group_id)
      VALUES('a',7,'start','start','done',42,-1001)`).run();
    assert.equal((await inspectGroupCutover(db,'a',-1002)).ready,true);
    assert.equal((await commitGroupCutover(db,'a',-1002,-1001)).changed,true);
    assert.equal(await archiveConversationForNewGroup(db,'a',7,-1002),true);
    assert.equal(db.sqlite.prepare(`SELECT COUNT(*) n FROM conversation_provision_attempts WHERE bot_id='a'`).get().n,0);
    assert.equal((await findTopicByGroup(db,-1001,42)).historical,1);
    addConversation(db,'a',7,-1002,42);
    assert.equal((await findTopicByGroup(db,-1002,42)).historical,0);
  } finally { db.close(); }
});

test('completed topic marker without its exact active topic still blocks cutover', async () => {
  const db = create();
  try {
    await resolveActiveGroup(db,'a','-1001');
    await registerSupportGroup(db,-1002);
    addConversation(db,'a',7,-1001,42);
    db.sqlite.prepare(`INSERT INTO conversation_provision_attempts
      (bot_id,user_id,started_at,completed_at,thread_id,support_group_id)
      VALUES('a',7,'start','done',42,-1003)`).run();
    assert.deepEqual((await inspectGroupCutover(db,'a',-1002)).blockers,['topic_creation_unresolved']);
    await assert.rejects(commitGroupCutover(db,'a',-1002,-1001),/group_cutover_blocked/);
  } finally { db.close(); }
});
