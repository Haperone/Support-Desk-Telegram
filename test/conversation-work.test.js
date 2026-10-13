import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { workQueue, workCounts, tomorrowMorning, assigneeLabel } from '../src/conversation-work.js';

const database=()=>new SqliteD1(new URL('../migrations/',import.meta.url));
function attempt(db,direction,id,source,started=source) {
  db.sqlite.prepare(`INSERT INTO message_delivery_attempts(bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at,source_created_at)
    VALUES('bot',?,?,?,?,51,?,'copyMessage',?,?)`).run(direction,direction==='user_to_support'?1:-1001234567890,id,1,direction==='user_to_support'?-1001234567890:1,started,source);
}
function confirm(db,id) {
  db.sqlite.prepare("UPDATE message_delivery_attempts SET target_message_id=42,completed_at='2026-09-12T12:00:00.000Z' WHERE direction='support_to_user' AND source_message_id=?").run(id);
}

test('work queue: retries and reordered older inputs do not reopen answered work or hide a newer question',()=>{
  const db=database();
  try {
    attempt(db,'user_to_support',100,'2026-09-12T10:00:00.000Z');
    attempt(db,'support_to_user',500,'2026-09-12T10:10:00.000Z');confirm(db,500);
    const before=db.sqlite.prepare('SELECT * FROM conversation_work').get();assert.equal(before.state,'waiting');
    db.sqlite.exec("DELETE FROM message_delivery_attempts WHERE direction='user_to_support'");
    attempt(db,'user_to_support',100,'2026-09-12T10:00:00.000Z','2026-09-12T10:20:00.000Z');
    attempt(db,'user_to_support',99,'2026-09-12T09:59:00.000Z');
    assert.deepEqual(db.sqlite.prepare('SELECT * FROM conversation_work').get(),before);
    attempt(db,'user_to_support',101,'2026-09-12T10:15:00.000Z');
    db.sqlite.exec("DELETE FROM message_delivery_attempts WHERE direction='support_to_user'");
    attempt(db,'support_to_user',500,'2026-09-12T10:10:00.000Z','2026-09-12T11:00:00.000Z');confirm(db,500);
    assert.equal(db.sqlite.prepare('SELECT state FROM conversation_work').get().state,'needs_reply');
  } finally {db.close();}
});

for(const [at,expected] of [
  ['2026-09-15T20:30:00Z','2026-09-16T07:00:00.000Z'],
  ['2026-03-28T21:30:00Z','2026-03-29T07:00:00.000Z'],
  ['2026-10-24T20:30:00Z','2026-10-25T08:00:00.000Z'],
  ['2026-12-31T22:30:00Z','2027-01-01T08:00:00.000Z'],
])test('tomorrow returns at 09:00 Budapest, including DST and year rollover: '+at,()=>{
  assert.equal(tomorrowMorning(new Date(at)),expected);
});

test('queue counts match every filter and service scope, with assignees fetched in the page query',async()=>{
  const db=database(),at=new Date('2026-09-15T12:00:00Z');
  try {
    const insert=db.sqlite.prepare('INSERT INTO conversation_work(bot_id,user_id,state,assigned_to,snoozed_until,updated_at) VALUES(?,?,?,?,?,?)');
    for(const [id,state,owner,until] of [[1,'needs_reply',7,null],[2,'waiting',8,null],[3,'snoozed',7,'2026-09-15T11:00:00Z'],[4,'snoozed',null,'2026-09-16T12:00:00Z'],[5,'resolved',7,null]])insert.run('bot',id,state,owner,until,at.toISOString());
    insert.run('removed',6,'needs_reply',7,null,at.toISOString());
    const options={actor:7,at,botIds:['bot']},counts=await workCounts(db,options);
    assert.deepEqual({...counts},{needs:2,mine:2,waiting:1,today:1,resolved:1,all:5});
    for(const [filter,count] of Object.entries(counts))assert.equal((await workQueue(db,{...options,filter})).total,count);
    assert.equal(assigneeLabel({assigned_to:7},7,99,false),'you');
    assert.equal(assigneeLabel({assigned_to:99},7,99,false),'primary administrator');
    assert.equal(assigneeLabel({assigned_to:8,operator_first_name:'Anna',operator_username:'anna'},7,99,false),'Anna · @anna');
    assert.equal(assigneeLabel({assigned_to:8},7,99,false),'operator');
  } finally {db.close();}
});

test('work queue: unconfirmed answers and same-second source dates keep the request visible',()=>{
  const db=database();
  try {
    attempt(db,'user_to_support',100,'2026-09-12T10:00:00.000Z');
    attempt(db,'support_to_user',500,'2026-09-12T10:01:00.000Z');
    assert.equal(db.sqlite.prepare('SELECT state FROM conversation_work').get().state,'needs_reply');
    attempt(db,'user_to_support',101,'2026-09-12T10:01:00.000Z');confirm(db,500);
    assert.equal(db.sqlite.prepare('SELECT state FROM conversation_work').get().state,'needs_reply');
  } finally {db.close();}
});

for(const [at,included,excluded] of [
  ['2026-10-25T00:30:00.000Z','2026-10-25T22:45:00.000Z','2026-10-25T23:15:00.000Z'],
  ['2026-03-29T00:30:00.000Z','2026-03-29T21:45:00.000Z','2026-03-29T22:15:00.000Z'],
])test('work queue: today follows Budapest midnight across DST '+at,async()=>{
  const db=database();
  try {
    for(const [id,until] of [[1,included],[2,excluded]])db.sqlite.prepare("INSERT INTO conversation_work(bot_id,user_id,state,snoozed_until,updated_at) VALUES('bot',?,'snoozed',?,?)").run(id,until,at);
    assert.deepEqual((await workQueue(db,{filter:'today',actor:7,at:new Date(at)})).rows.map(r=>r.user_id),[1]);
  } finally {db.close();}
});
