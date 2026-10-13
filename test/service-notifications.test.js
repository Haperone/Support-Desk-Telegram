import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import {
  setServiceOwners, getServiceOwners, markManagerDmStarted, setOperatorAvailability,
  ensureServiceAssignee, queueInboundNotice, queueTransferNotice, stageDueNotices,
  claimNextNotice, markNoticeSent, markNoticeUncertain, markNoticeRetryable,
  markExpiredClaimsUncertain, markNoticeFailed, dispatchNextNotice,
  markSentNoticeLinksForRoute, syncNextSentNoticeLink,
  terminalNoticePruneStatement,
} from '../service-notifications.js';

const base='2026-09-26T10:00:00.000Z';
const at=minutes=>new Date(Date.parse(base)+minutes*60000);
const database=()=>new SqliteD1(new URL('../migrations/',import.meta.url));
function setup(db) {
  db.sqlite.prepare("INSERT INTO bots(id,display_name,topic_prefix,created_at) VALUES('bot','Service','S',?)").run(base);
  db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,created_at)
    VALUES('bot',42,-100123,77,?)`).run(base);
  for (const id of [7,8]) db.sqlite.prepare(`INSERT INTO support_operators
    (user_id,first_name,active,added_by,added_by_name,added_at) VALUES(?, 'Operator',1,99,'Admin',?)`).run(id,base);
}
function inbound(db,id,minutes) {
  db.sqlite.prepare(`INSERT INTO message_delivery_attempts
    (bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at,source_created_at)
    VALUES('bot','user_to_support',42,?,42,77,-100123,'copyMessage',?,?)`)
    .run(id,at(minutes).toISOString(),at(minutes).toISOString());
  db.sqlite.prepare(`UPDATE message_delivery_attempts SET completed_at=?,target_message_id=?
    WHERE bot_id='bot' AND direction='user_to_support' AND source_message_id=?`)
    .run(at(minutes).toISOString(),id+500,id);
}
function answer(db,id,minutes,confirmed=true) {
  db.sqlite.prepare(`INSERT INTO message_delivery_attempts
    (bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at,source_created_at)
    VALUES('bot','support_to_user',-100123,?,42,77,42,'copyMessage',?,?)`)
    .run(id,at(minutes).toISOString(),at(minutes).toISOString());
  if (confirmed) db.sqlite.prepare(`UPDATE message_delivery_attempts SET completed_at=?,target_message_id=?
    WHERE bot_id='bot' AND direction='support_to_user' AND source_message_id=?`)
    .run(at(minutes+1).toISOString(),id+1000,id);
}
const noticeOptions={botId:'bot',userId:42,adminId:99,groupId:-100123,threadId:77,delivered:true};

test('Cron stages notices only for its current service',async()=>{
  const db=database();
  try {
    setup(db);
    db.sqlite.prepare("INSERT INTO bots(id,display_name,topic_prefix,created_at) VALUES('other','Other','O',?)").run(base);
    db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,created_at)
      VALUES('other',43,-100456,88,?)`).run(base);
    db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,updated_at)
      VALUES('other',43,'needs_reply',?)`).run(base);
    db.sqlite.prepare(`UPDATE conversation_work SET notification_cycle=1,cycle_started_at=?,
      last_inbound_at=?,state='needs_reply' WHERE bot_id IN ('bot','other')`)
      .run(base,base);
    inbound(db,1,0);
    await markManagerDmStarted(db,{operatorId:99,at:at(0)});
    await stageDueNotices(db,{adminId:99,botId:'bot',at:at(30)});
    assert.equal(db.sqlite.prepare("SELECT assigned_to FROM conversation_work WHERE bot_id='bot'").get().assigned_to,99);
    assert.equal(db.sqlite.prepare("SELECT assigned_to FROM conversation_work WHERE bot_id='other'").get().assigned_to,null);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM service_notification_outbox WHERE bot_id='other'").get().n,0);
    db.sqlite.prepare(`INSERT INTO service_notification_outbox
      (bot_id,user_id,notification_cycle,kind,recipient_id,group_id,thread_id,available_at,created_at,
       status,claim_token,claimed_at)
      VALUES('other',43,1,'new',99,-100456,88,?,?,'sending','other-claim',?)`)
      .run(base,base,base);
    await claimNextNotice(db,{botId:'bot',at:at(30)});
    assert.equal(db.sqlite.prepare("SELECT status FROM service_notification_outbox WHERE bot_id='other'").get().status,'sending');
    // The scheduled global expiry pass must still settle claims from services
    // which were disabled after their Telegram send began.
    await markExpiredClaimsUncertain(db,{at:at(30)});
    assert.equal(db.sqlite.prepare("SELECT status FROM service_notification_outbox WHERE bot_id='other'").get().status,'uncertain');
  } finally {db.close();}
});

test('cycle starts at earliest inbound; repeated messages do not reset 30/60 minute alerts',async()=>{
  const db=database();
  try {
    setup(db);
    await setServiceOwners(db,{botId:'bot',primaryId:7,backupId:8,at:at(0)});
    for (const id of [7,8,99]) await markManagerDmStarted(db,{operatorId:id,at:at(0)});
    inbound(db,1,0);
    const first=await queueInboundNotice(db,{...noticeOptions,at:at(0)});
    assert.equal(first.kind,'new'); assert.equal(first.recipient_id,7);
    inbound(db,2,10); inbound(db,3,20);
    assert.equal((await queueInboundNotice(db,{...noticeOptions,at:at(20)})).id,first.id);
    const work=db.sqlite.prepare("SELECT * FROM conversation_work WHERE bot_id='bot'").get();
    assert.equal(work.cycle_started_at,base); assert.equal(work.notification_cycle,1);
    await stageDueNotices(db,{adminId:99,at:at(29)});
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM service_notification_outbox WHERE kind='reminder'").get().n,0);
    await stageDueNotices(db,{adminId:99,at:at(30)});
    await stageDueNotices(db,{adminId:99,at:at(35)});
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM service_notification_outbox WHERE kind='reminder'").get().n,1);
    await stageDueNotices(db,{adminId:99,at:at(60)});
    const fallback=db.sqlite.prepare("SELECT * FROM service_notification_outbox WHERE kind='fallback'").get();
    assert.equal(fallback.recipient_id,8);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM service_notification_outbox').get().n,3);
  } finally {db.close();}
});

test('Cron recovers a new-group link when the webhook could not stage the cutover notice',async()=>{
  const db=database();
  try {
    setup(db); await markManagerDmStarted(db,{operatorId:99,at:at(0)});
    inbound(db,1,0);
    const old=await queueInboundNotice(db,{...noticeOptions,at:at(0)});
    db.sqlite.prepare("UPDATE service_notification_outbox SET status='sent',telegram_message_id=500,sent_at=? WHERE id=?")
      .run(at(0).toISOString(),old.id);
    db.sqlite.prepare("UPDATE conversations SET support_group_id=-100456,thread_id=88 WHERE bot_id='bot' AND user_id=42").run();
    db.sqlite.prepare(`INSERT INTO message_delivery_attempts
      (bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at,source_created_at,completed_at,target_message_id)
      VALUES('bot','user_to_support',42,2,42,88,-100456,'copyMessage',?,?,?,502)`)
      .run(at(5).toISOString(),at(5).toISOString(),at(5).toISOString());
    await stageDueNotices(db,{adminId:99,at:at(6)});
    const moved=db.sqlite.prepare("SELECT group_id,thread_id FROM service_notification_outbox WHERE bot_id='bot' AND user_id=42 AND kind='transfer'").get();
    assert.equal(Number(moved?.group_id),-100456);
    assert.equal(Number(moved?.thread_id),88);
    db.sqlite.prepare("UPDATE service_notification_outbox SET status='sent',telegram_message_id=501,sent_at=? WHERE kind='transfer'")
      .run(at(6).toISOString());
    db.sqlite.prepare("UPDATE conversations SET support_group_id=-100789,thread_id=99 WHERE bot_id='bot' AND user_id=42").run();
    db.sqlite.prepare(`INSERT INTO message_delivery_attempts
      (bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at,source_created_at,completed_at,target_message_id)
      VALUES('bot','user_to_support',42,3,42,99,-100789,'copyMessage',?,?,?,503)`)
      .run(at(7).toISOString(),at(7).toISOString(),at(7).toISOString());
    await stageDueNotices(db,{adminId:99,at:at(8)});
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM service_notification_outbox WHERE status='sent' AND error_code='link_refresh_pending' AND group_id=-100789 AND thread_id=99").get().n,2);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM service_notification_outbox WHERE kind='transfer'").get().n,1);
  } finally {db.close();}
});

test('sent operator cards can be relinked after repeated group moves without resending them',async()=>{
  const db=database();
  try {
    setup(db); await markManagerDmStarted(db,{operatorId:99,at:at(0)});
    inbound(db,1,0);
    const first=await queueInboundNotice(db,{...noticeOptions,at:at(0)});
    db.sqlite.prepare("UPDATE service_notification_outbox SET status='sent',telegram_message_id=500,sent_at=? WHERE id=?")
      .run(at(0).toISOString(),first.id);
    await markSentNoticeLinksForRoute(db,{botId:'bot',userId:42,groupId:-100456,threadId:88});
    let edits=0;
    await syncNextSentNoticeLink(db,{botId:'bot',edit:async row=>{
      edits++; assert.equal(Number(row.group_id),-100456);
      return {ok:false,deliveryUncertain:true,description:'timeout'};
    }});
    assert.equal(db.sqlite.prepare('SELECT error_code FROM service_notification_outbox WHERE id=?').get(first.id).error_code,'link_refresh_pending');
    await syncNextSentNoticeLink(db,{botId:'bot',edit:async row=>{
      edits++; assert.equal(Number(row.telegram_message_id),500);
      return {ok:true};
    }});
    assert.equal(db.sqlite.prepare('SELECT error_code FROM service_notification_outbox WHERE id=?').get(first.id).error_code,null);
    await markSentNoticeLinksForRoute(db,{botId:'bot',userId:42,groupId:-100789,threadId:99});
    await syncNextSentNoticeLink(db,{botId:'bot',edit:async row=>{
      edits++; assert.equal(Number(row.group_id),-100789);
      assert.equal(Number(row.thread_id),99);
      return {ok:false,errorCode:400,description:'Bad Request: message is not modified'};
    }});
    assert.equal(edits,3);
    assert.equal(db.sqlite.prepare('SELECT error_code FROM service_notification_outbox WHERE id=?').get(first.id).error_code,null);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM service_notification_outbox').get().n,1);
  } finally {db.close();}
});

test('a card confirmed after group cutover is marked for link repair',async()=>{
  const db=database();
  try {
    setup(db); await markManagerDmStarted(db,{operatorId:99,at:at(0)});
    inbound(db,1,0);
    await queueInboundNotice(db,{...noticeOptions,at:at(0)});
    const claimed=await claimNextNotice(db,{at:at(0)});
    assert.ok(claimed);
    db.sqlite.prepare("UPDATE conversations SET support_group_id=-100456,thread_id=88 WHERE bot_id='bot' AND user_id=42").run();
    const sent=await markNoticeSent(db,{id:claimed.id,claimToken:claimed.claim_token,telegramMessageId:500,at:at(1)});
    assert.equal(Number(sent.group_id),-100456);
    assert.equal(Number(sent.thread_id),88);
    assert.equal(sent.error_code,'link_refresh_pending');
  } finally {db.close();}
});

test('confirmed human answer ends cycle; same-second answer and unconfirmed answer do not',async()=>{
  const db=database();
  try {
    setup(db); await markManagerDmStarted(db,{operatorId:99,at:at(0)});
    inbound(db,1,0); await queueInboundNotice(db,{...noticeOptions,at:at(0)});
    answer(db,101,5,false);
    assert.equal(db.sqlite.prepare('SELECT state FROM conversation_work').get().state,'needs_reply');
    inbound(db,2,5);
    db.sqlite.prepare(`UPDATE message_delivery_attempts SET completed_at=?,target_message_id=1101
      WHERE direction='support_to_user' AND source_message_id=101`).run(at(6).toISOString());
    assert.equal(db.sqlite.prepare('SELECT state FROM conversation_work').get().state,'needs_reply');
    answer(db,102,10,true);
    assert.equal(db.sqlite.prepare('SELECT state FROM conversation_work').get().state,'waiting');
    await stageDueNotices(db,{adminId:99,at:at(40)});
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM service_notification_outbox WHERE kind='reminder'").get().n,0);
    inbound(db,3,45);
    const reply=await queueInboundNotice(db,{...noticeOptions,at:at(45)});
    assert.equal(reply.kind,'reply'); assert.equal(reply.notification_cycle,2);
    assert.equal(db.sqlite.prepare('SELECT cycle_started_at FROM conversation_work').get().cycle_started_at,at(45).toISOString());
  } finally {db.close();}
});

test('availability and DM registration use backup and admin, with reassignment of open work',async()=>{
  const db=database();
  try {
    setup(db); await setServiceOwners(db,{botId:'bot',primaryId:7,backupId:8});
    await markManagerDmStarted(db,{operatorId:8});
    inbound(db,1,0);
    assert.equal((await ensureServiceAssignee(db,{botId:'bot',userId:42,adminId:99})).assigned_to,8);
    await setOperatorAvailability(db,{operatorId:8,available:false,adminId:99});
    assert.equal(db.sqlite.prepare('SELECT assigned_to FROM conversation_work').get().assigned_to,99);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM service_notification_outbox WHERE kind='transfer' AND recipient_id=99").get().n,1);
    await markManagerDmStarted(db,{operatorId:7});
    await setOperatorAvailability(db,{operatorId:8,available:true});
    db.sqlite.prepare('UPDATE conversation_work SET assigned_to=NULL').run();
    assert.equal((await ensureServiceAssignee(db,{botId:'bot',userId:42,adminId:99})).assigned_to,7);
    assert.equal((await getServiceOwners(db,'bot')).backup_id,8);
  } finally {db.close();}
});

test('revoking an operator moves a queue larger than one Free-plan batch at once',async()=>{
  const db=database();
  try {
    setup(db); await setServiceOwners(db,{botId:'bot',primaryId:7,backupId:8});
    for (const id of [7,8]) await markManagerDmStarted(db,{operatorId:id,at:at(0)});
    inbound(db,1,0); await queueInboundNotice(db,{...noticeOptions,at:at(0)});
    for (let userId=43;userId<55;userId++) {
      db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,created_at)
        VALUES('bot',?,-100123,?,?)`).run(userId,userId+100,base);
      db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,assigned_to,updated_at,
        notification_cycle,cycle_started_at) VALUES('bot',?,7,?,1,?)`).run(userId,base,base);
    }
    await setOperatorAvailability(db,{operatorId:7,available:false,adminId:99,at:at(1)});
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM conversation_work WHERE assigned_to=8").get().n,13);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM service_notification_outbox WHERE kind='transfer' AND recipient_id=8").get().n,13);
    assert.equal(db.sqlite.prepare("SELECT status FROM service_notification_outbox WHERE kind='new'").get().status,'cancelled');
    assert.equal((await claimNextNotice(db,{at:at(1)}))?.recipient_id,8);
  } finally {db.close();}
});

test('outbox claims are atomic and unknown Telegram outcome is never silently resent',async()=>{
  const db=database();
  try {
    setup(db); await markManagerDmStarted(db,{operatorId:99}); inbound(db,1,0);
    assert.equal(await queueInboundNotice(db,{...noticeOptions,delivered:false}),null);
    await queueInboundNotice(db,{...noticeOptions,at:at(0)});
    const claim=await claimNextNotice(db,{at:at(0)});
    assert.equal(claim.status,'sending');
    assert.equal(await claimNextNotice(db,{at:at(1)}),null);
    assert.equal(await markNoticeSent(db,{id:claim.id,claimToken:'wrong',telegramMessageId:50}),null);
    await markExpiredClaimsUncertain(db,{at:at(11)});
    assert.equal(db.sqlite.prepare('SELECT status FROM service_notification_outbox').get().status,'uncertain');
    assert.equal(await claimNextNotice(db,{at:at(12)}),null);
    assert.equal(await markNoticeSent(db,{id:claim.id,claimToken:claim.claim_token,telegramMessageId:50}),null);
  } finally {db.close();}
});

test('terminal notice retention is bounded and preserves the active cycle and unresolved claims',async()=>{
  const db=database();
  try {
    setup(db);
    db.sqlite.prepare(`INSERT INTO conversation_work(bot_id,user_id,state,notification_cycle,updated_at)
      VALUES('bot',42,'needs_reply',2,?)`).run(base);
    const old=days=>new Date(Date.parse(base)-days*86_400_000).toISOString();
    const add=(cycle,kind,recipient,status,days)=>db.sqlite.prepare(`INSERT INTO service_notification_outbox
      (bot_id,user_id,notification_cycle,kind,recipient_id,group_id,thread_id,
        status,available_at,created_at,telegram_message_id,sent_at)
      VALUES('bot',42,?,?,?,?,77,?,?,?, ?,?)`)
      .run(cycle,kind,recipient,-100123,status,old(days),old(days),status==='sent'?recipient:null,
        status==='sent'?old(days):null);
    add(1,'new',10,'sent',40);
    add(1,'reply',11,'cancelled',40);
    add(1,'transfer',12,'failed',200);
    add(1,'reminder',13,'uncertain',100);
    add(2,'new',14,'sent',200);
    add(1,'fallback',15,'pending',200);
    await terminalNoticePruneStatement(db,{at:new Date(base),limit:2}).run();
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM service_notification_outbox').get().n,4);
    await terminalNoticePruneStatement(db,{at:new Date(base),limit:2}).run();
    assert.deepEqual(db.sqlite.prepare('SELECT recipient_id FROM service_notification_outbox ORDER BY recipient_id').all()
      .map(row=>row.recipient_id),[13,14,15]);
    await terminalNoticePruneStatement(db,{at:new Date(Date.parse(base)+81*86_400_000)}).run();
    assert.deepEqual(db.sqlite.prepare('SELECT recipient_id FROM service_notification_outbox ORDER BY recipient_id').all()
      .map(row=>row.recipient_id),[14,15], 'the current unresolved cycle and pending work remain');
  } finally {db.close();}
});

test('Cron recovers a missed new card only after the inbound reaches its topic',async()=>{
  const db=database();
  try {
    setup(db); await markManagerDmStarted(db,{operatorId:99,at:at(0)});
    inbound(db,1,0);
    db.sqlite.prepare(`UPDATE message_delivery_attempts SET completed_at=NULL,target_message_id=NULL
      WHERE direction='user_to_support'`).run();
    await stageDueNotices(db,{adminId:99,at:at(35)});
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM service_notification_outbox').get().n,0);
    db.sqlite.prepare(`UPDATE message_delivery_attempts SET completed_at=?,target_message_id=501
      WHERE direction='user_to_support'`).run(at(36).toISOString());
    await stageDueNotices(db,{adminId:99,at:at(36)});
    assert.deepEqual(db.sqlite.prepare('SELECT kind FROM service_notification_outbox ORDER BY id').all().map(r=>r.kind),['new','reminder']);
  } finally {db.close();}
});

test('confirmed send, retryable rejection, permanent failure and transfer retain honest states',async()=>{
  const db=database();
  try {
    setup(db); await markManagerDmStarted(db,{operatorId:7});
    await setServiceOwners(db,{botId:'bot',primaryId:7}); inbound(db,1,0);
    await queueInboundNotice(db,{...noticeOptions,at:at(0)});
    const first=await claimNextNotice(db,{at:at(0)});
    await markNoticeRetryable(db,{id:first.id,claimToken:first.claim_token,after:at(2),errorCode:'telegram_429'});
    assert.equal(await claimNextNotice(db,{at:at(1)}),null);
    const retry=await claimNextNotice(db,{at:at(2)});
    await markNoticeSent(db,{id:retry.id,claimToken:retry.claim_token,telegramMessageId:501,at:at(2)});
    assert.equal(db.sqlite.prepare('SELECT telegram_message_id FROM service_notification_outbox WHERE id=?').get(first.id).telegram_message_id,501);
    await stageDueNotices(db,{adminId:99,at:at(30)});
    const reminder=await claimNextNotice(db,{at:at(30)});
    await markNoticeUncertain(db,{id:reminder.id,claimToken:reminder.claim_token});
    assert.equal((await claimNextNotice(db,{at:at(31)})),null);
    db.sqlite.prepare("UPDATE conversation_work SET assigned_to=99,revision=revision+1").run();
    await queueTransferNotice(db,{botId:'bot',userId:42,groupId:-100123,threadId:77,note:'context',at:at(31)});
    const transfer=await claimNextNotice(db,{at:at(31)});
    assert.equal(transfer.kind,'transfer'); assert.equal(transfer.note,'context');
    await markNoticeFailed(db,{id:transfer.id,claimToken:transfer.claim_token,errorCode:'blocked',unreachable:true});
    assert.equal(db.sqlite.prepare('SELECT status FROM service_notification_outbox WHERE id=?').get(transfer.id).status,'failed');
  } finally {db.close();}
});

test('transfer note reaches the new operator while the conversation waits for the customer',async()=>{
  const db=database();
  try {
    setup(db); await markManagerDmStarted(db,{operatorId:99});
    inbound(db,1,0);
    db.sqlite.prepare("UPDATE conversation_work SET state='waiting',assigned_to=99").run();
    await queueTransferNotice(db,{botId:'bot',userId:42,groupId:-100123,threadId:77,note:'context',at:at(1)});
    await stageDueNotices(db,{adminId:99,at:at(1)});
    const notice=await claimNextNotice(db,{at:at(1)});
    assert.equal(notice?.kind,'transfer');
    assert.equal(notice?.note,'context');
  } finally {db.close();}
});

test('cancelled transfer can be restaged after interrupted reassignment',async()=>{
  const db=database();
  try {
    setup(db); await markManagerDmStarted(db,{operatorId:99});
    inbound(db,1,0);
    db.sqlite.prepare('UPDATE conversation_work SET assigned_to=99').run();
    await queueTransferNotice(db,{botId:'bot',userId:42,groupId:-100123,threadId:77,note:'context',at:at(1)});
    db.sqlite.prepare("UPDATE service_notification_outbox SET status='cancelled' WHERE kind='transfer'").run();
    await queueTransferNotice(db,{botId:'bot',userId:42,groupId:-100123,threadId:77,note:'context',at:at(2)});
    assert.equal(db.sqlite.prepare("SELECT status FROM service_notification_outbox WHERE kind='transfer'").get().status,'pending');
    assert.equal((await claimNextNotice(db,{at:at(2)}))?.kind,'transfer');
  } finally {db.close();}
});

test('unavailable backup fallback moves to administrator',async()=>{
  const db=database();
  try {
    setup(db); await setServiceOwners(db,{botId:'bot',primaryId:7,backupId:8});
    for (const id of [7,8,99]) await markManagerDmStarted(db,{operatorId:id,at:at(0)});
    inbound(db,1,0); await queueInboundNotice(db,{...noticeOptions,at:at(0)});
    await stageDueNotices(db,{adminId:99,at:at(60)});
    assert.equal(db.sqlite.prepare("SELECT status FROM service_notification_outbox WHERE kind='fallback' AND recipient_id=8").get().status,'pending');
    await setOperatorAvailability(db,{operatorId:8,available:false,adminId:99,at:at(61)});
    await stageDueNotices(db,{adminId:99,at:at(61)});
    assert.equal(db.sqlite.prepare("SELECT status FROM service_notification_outbox WHERE kind='fallback' AND recipient_id=8").get().status,'cancelled');
    assert.equal(db.sqlite.prepare("SELECT status FROM service_notification_outbox WHERE kind='fallback' AND recipient_id=99").get().status,'pending');
  } finally {db.close();}
});

test('undeliverable primary DM routes the same cycle to backup without marking sent',async()=>{
  const db=database();
  try {
    setup(db); await setServiceOwners(db,{botId:'bot',primaryId:7,backupId:8});
    for (const id of [7,8]) await markManagerDmStarted(db,{operatorId:id});
    inbound(db,1,0); await queueInboundNotice(db,{...noticeOptions,at:at(0)});
    const claim=await claimNextNotice(db,{at:at(0)});
    await markNoticeFailed(db,{id:claim.id,claimToken:claim.claim_token,errorCode:'telegram_403',unreachable:true,adminId:99,at:at(1)});
    assert.equal(db.sqlite.prepare('SELECT assigned_to FROM conversation_work').get().assigned_to,8);
    assert.equal(db.sqlite.prepare('SELECT status FROM service_notification_outbox WHERE id=?').get(claim.id).status,'failed');
    const backup=await claimNextNotice(db,{at:at(1)});
    assert.equal(backup.recipient_id,8); assert.equal(backup.kind,'new');
  } finally {db.close();}
});

test('dispatcher confirms Telegram ID, delays 429, and quarantines ambiguous sends',async()=>{
  const db=database();
  try {
    setup(db); await markManagerDmStarted(db,{operatorId:99,at:at(0)});
    inbound(db,1,0); await queueInboundNotice(db,{...noticeOptions,at:at(0)});
    let calls=0;
    await dispatchNextNotice(db,{botId:'bot',adminId:99,at:at(0),send:async()=>{calls++;return {ok:false,errorCode:429,rateLimited:true,retryAfterSeconds:120};}});
    assert.equal(db.sqlite.prepare('SELECT status FROM service_notification_outbox').get().status,'retryable');
    assert.equal(await dispatchNextNotice(db,{botId:'bot',adminId:99,at:at(1),send:async()=>{calls++;return {ok:true,result:{message_id:51}};}}),null);
    assert.equal(calls,1);
    await dispatchNextNotice(db,{botId:'bot',adminId:99,at:at(2),send:async()=>{calls++;return {ok:true,result:{message_id:51}};}});
    assert.equal(db.sqlite.prepare('SELECT status FROM service_notification_outbox').get().status,'sent');
    assert.equal(db.sqlite.prepare('SELECT telegram_message_id FROM service_notification_outbox').get().telegram_message_id,51);
    await stageDueNotices(db,{adminId:99,at:at(30)});
    await dispatchNextNotice(db,{botId:'bot',adminId:99,at:at(30),send:async()=>({ok:false,httpStatus:503,deliveryUncertain:true})});
    assert.equal(db.sqlite.prepare("SELECT status FROM service_notification_outbox WHERE kind='reminder'").get().status,'uncertain');
    assert.equal(await claimNextNotice(db,{botId:'bot',at:at(31)}),null);
  } finally {db.close();}
});

test('Cron stages a verified pending delivery and a cleaned album mapping, but never an unconfirmed input',async()=>{
  const db=database();
  try {
    setup(db); await markManagerDmStarted(db,{operatorId:99,at:at(0)});
    db.sqlite.prepare(`INSERT INTO pending_messages(bot_id,user_id,source_chat_id,source_message_id,update_id,created_at,source_created_at)
      VALUES('bot',42,42,1,1,?,?)`).run(base,base);
    await stageDueNotices(db,{adminId:99,at:at(1)});
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM service_notification_outbox').get().n,0);
    db.sqlite.prepare(`UPDATE pending_messages SET delivery_completed_at=?,delivered_at=?,target_message_id=501,target_thread_id=77 WHERE source_message_id=1`).run(base,base);
    await stageDueNotices(db,{adminId:99,at:at(1)});
    assert.equal(db.sqlite.prepare("SELECT kind FROM service_notification_outbox WHERE kind='new'").get().kind,'new');
    db.sqlite.prepare("DELETE FROM pending_messages").run();
    db.sqlite.prepare(`INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at)
      VALUES('bot',42,77,2,502,?)`).run(at(5).toISOString());
    db.sqlite.prepare("UPDATE conversation_work SET state='waiting'").run();
    db.sqlite.prepare("UPDATE conversation_work SET state='needs_reply',last_inbound_message_id=2,last_inbound_at=?").run(at(5).toISOString());
    await stageDueNotices(db,{adminId:99,at:at(6)});
    assert.equal(db.sqlite.prepare("SELECT kind FROM service_notification_outbox WHERE notification_cycle=2").get().kind,'reply');
  } finally {db.close();}
});
