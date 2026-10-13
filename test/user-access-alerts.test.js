import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { claimAccessEvents,startAccessEvents,completeAccessEvents,formatAccessEvent,accessEventVisible } from '../src/user-access-alerts.js';
import { flushUserAccessAlerts } from '../monitor/user-access-alerts.js';

function fixture() {
  const db=new SqliteD1(new URL('../migrations/',import.meta.url));
  const monitor=new SqliteD1(new URL('../monitor/migrations/',import.meta.url));
  // SQLite triggers use their real clock; dispatch just after those writes.
  let now=new Date(Date.now()+1_000);
  const env={SUPPORT_DB:db,RECOVERY_D1_PLAN:'free',RETENTION_ENABLED:'true',STORAGE_GUARD_ENABLED:'true',SUPPORT_GROUP_ID:'-1001234567890',BOT_REGISTRY:JSON.stringify([{id:'bot',displayName:'Test'}])};
  const bridge={accessClaim:()=>claimAccessEvents(env,now),accessStart:(token,generation)=>startAccessEvents(env,token,generation,now),accessComplete:(token,outcome)=>completeAccessEvents(env,token,outcome,now)};
  const monitorEnv={MONITOR_DB:monitor,SUPPORT_HEALTH:bridge,ALERT_BOT_TOKEN:'fake',ALERT_CHAT_ID:'-1001234567890',ALERT_THREAD_ID:'3',MONITOR_HEALTH_ENABLED:'true'};
  return {db,monitor,env,bridge,monitorEnv,get now(){return now;},advance(ms){now=new Date(now.getTime()+ms);},close(){db.close();monitor.close();}};
}
function state(f,user=1) {
  f.db.sqlite.prepare("INSERT INTO user_abuse_state(bot_id,user_id,created_at,updated_at) VALUES('bot',?,?,?)").run(user,f.now.toISOString(),f.now.toISOString());
}
function challenge(f,user=1) {
  return f.db.sqlite.prepare("INSERT INTO verification_challenges(bot_id,user_id,token_hash,status,created_at,expires_at) VALUES('bot',?,?,'pending',?,?) RETURNING id")
    .get(user,'token-'+user,f.now.toISOString(),new Date(f.now.getTime()+60_000).toISOString()).id;
}
const kinds=f=>f.db.sqlite.prepare('SELECT kind FROM user_access_events ORDER BY id').all().map(r=>r.kind);
const passFetch=async()=>Response.json({ok:true,result:{message_id:101}});

test('access alerts: lifecycle records transitions transactionally, avoids repeated updates and rolls back with the decision',()=>{
 const f=fixture();try {
  state(f);const id=challenge(f);
  f.db.sqlite.prepare("UPDATE verification_challenges SET status='passed',verified_at=? WHERE id=?").run(f.now.toISOString(),id);
  f.db.sqlite.prepare("UPDATE verification_challenges SET status='passed' WHERE id=?").run(id);
  assert.equal(kinds(f).filter(k=>k==='verification_passed').length,1);
  const deadline=new Date(f.now.getTime()+60_000).toISOString();
  f.db.sqlite.prepare('UPDATE user_abuse_state SET muted_until=?,risk_score=12').run(deadline);
  f.db.sqlite.prepare('UPDATE user_abuse_state SET muted_until=?').run(deadline);
  assert.equal(kinds(f).filter(k=>k==='auto_restricted').length,1);
  f.db.sqlite.exec('UPDATE user_abuse_state SET muted_until=NULL');
  assert.ok(kinds(f).includes('auto_restricted_removed'));
  f.db.sqlite.prepare('UPDATE user_abuse_state SET manual_restricted_until=?').run(deadline);
  f.db.sqlite.exec('UPDATE user_abuse_state SET manual_restricted_until=NULL');
  assert.ok(kinds(f).includes('restricted_removed'));
  f.db.sqlite.exec("BEGIN; INSERT INTO banned_users(bot_id,user_id,banned_at) VALUES('bot',1,'rollback'); ROLLBACK;");
  assert.equal(kinds(f).includes('banned'),false);
  f.db.sqlite.exec("INSERT INTO banned_users(bot_id,user_id,banned_at) VALUES('bot',1,'ban'); DELETE FROM banned_users;");
  assert.deepEqual(kinds(f).slice(-2),['banned','unbanned']);
 }finally{f.close();}
});

test('access alerts: rate rejection groups five-minute bursts; raw edge signals alone do not claim delivery was stopped',()=>{
 const f=fixture();try {
  const insert=f.db.sqlite.prepare("INSERT INTO abuse_events(bot_id,user_id,event_key,event_type,created_at) VALUES('bot',1,?,?,?)");
  insert.run('raw','burst_limit',f.now.toISOString());
  assert.equal(kinds(f).length,0);
  for(let i=0;i<100;i++) insert.run('rejected-'+i,'access_rate_limited',f.now.toISOString());
  assert.deepEqual(kinds(f),['access_rate_limited']);
  assert.equal(f.db.sqlite.prepare('SELECT occurrences FROM user_access_events').get().occurrences,100);
  insert.run('full','access_queue_full',f.now.toISOString());
  assert.equal(kinds(f).at(-1),'access_queue_full');
 }finally{f.close();}
});

test('access alerts: simultaneous monitors send one batch through the alert bot into topic 3, then never replay it',async()=>{
 const f=fixture();try {
  state(f);challenge(f);
  f.db.sqlite.exec("INSERT INTO pending_messages(bot_id,user_id,update_id,source_chat_id,source_message_id,source_username,source_first_name,created_at) VALUES('bot',1,1,1,1,'first_contact','Alice','now')");
  const calls=[];
  const fetchImpl=async(url,request)=>{calls.push({url,body:JSON.parse(request.body)});return passFetch();};
  await Promise.all([flushUserAccessAlerts(f.monitorEnv,{fetchImpl,now:f.now}),flushUserAccessAlerts(f.monitorEnv,{fetchImpl,now:f.now})]);
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/botfake\/sendMessage$/);
  assert.equal(calls[0].body.message_thread_id,3);
  assert.match(calls[0].body.text,/Alice.*@first_contact/);
  assert.match(calls[0].body.text,/Topic not created yet/);
  f.advance(3_000);await flushUserAccessAlerts(f.monitorEnv,{fetchImpl,now:f.now});
  assert.equal(calls.length,1);
  assert.ok(f.db.queries<45);
 }finally{f.close();}
});

test('access alerts: definite Telegram rejection retries after cooldown; uncertain outcomes do not duplicate',async()=>{
 const f=fixture();try {
  state(f);challenge(f);
  let calls=0;
  const limited=async()=>{calls++;return Response.json({ok:false,error_code:429,description:'Too many',parameters:{retry_after:120}},{status:429});};
  await flushUserAccessAlerts(f.monitorEnv,{fetchImpl:limited,now:f.now});
  assert.equal(f.db.sqlite.prepare("SELECT request_started_at FROM user_access_events WHERE kind='verification_required'").get().request_started_at,null);
  f.advance(60_000);await flushUserAccessAlerts(f.monitorEnv,{fetchImpl:limited,now:f.now});assert.equal(calls,1);
  f.advance(61_000);
  const uncertain=async()=>{calls++;throw new Error('timeout');};
  await flushUserAccessAlerts(f.monitorEnv,{fetchImpl:uncertain,now:f.now});
  assert.equal(calls,2);
  assert.ok(f.db.sqlite.prepare("SELECT uncertain_at FROM user_access_events WHERE kind='verification_required'").get().uncertain_at);
  f.advance(180_000);await flushUserAccessAlerts(f.monitorEnv,{fetchImpl:uncertain,now:f.now});assert.equal(calls,2);
 }finally{f.close();}
});

test('access alerts: a lost post-send RPC response cannot duplicate a notice; stale pre-send claims recover',async()=>{
 const f=fixture();try {
  state(f);challenge(f);
  let claim=await f.bridge.accessClaim();
  f.advance(121_000);claim=await f.bridge.accessClaim();assert.ok(claim);
  assert.equal(await f.bridge.accessStart(claim.token,claim.generation),true);
  // Crash after request-start leaves the batch quarantined, rather than replayed.
  f.advance(121_000);assert.equal(await f.bridge.accessClaim(),null);
  assert.ok(f.db.sqlite.prepare('SELECT uncertain_at FROM user_access_events ORDER BY id LIMIT 1').get().uncertain_at);
 }finally{f.close();}
});

test('access alerts: reset fences a claimed batch and does not generate misleading unblock events',async()=>{
 const f=fixture();try {
  state(f);challenge(f);const claim=await f.bridge.accessClaim();
  f.db.sqlite.exec("UPDATE storage_control SET mode='reset',generation=generation+1; DELETE FROM verification_challenges;");
  assert.equal(await f.bridge.accessStart(claim.token,claim.generation),false);
  assert.equal(await f.bridge.accessClaim(),null);
  assert.equal(kinds(f).includes('verification_ended'),false);
 }finally{f.close();}
});

test('access alerts: expired and revoked deadlines do not claim a new restriction or successful delivery',()=>{
 const base={id:1,kind:'verification_passed',bot_id:'bot',service:'Test',user_id:1,first_name:'Alice',created_at:new Date().toISOString(),thread_id:44,support_group_id:-1001234567890,queued:3};
 const text=formatAccessEvent(base,'Europe/Budapest',new Date(),'ru');
 assert.match(text,/прошёл проверку/);assert.match(text,/Это не подтверждение доставки/);assert.match(text,/https:\/\/t.me\/c\/1234567890\/44/);
 assert.equal(accessEventVisible({kind:'verification_due',challenge_status:'passed'}),false);
 assert.equal(accessEventVisible({kind:'verification_due',challenge_status:'pending'}),true);
 assert.equal(accessEventVisible({kind:'restricted_due',deadline:'old',manual_restricted_until:'new'}),false);
 const long=formatAccessEvent({...base,kind:'banned',detail:'reason\n'.repeat(100),first_name:'name\n'.repeat(100)},'Europe/Budapest',new Date(),'ru');
 assert.ok([long,long,long].join('\n\n').length<4000);
});

test('access alerts: operator restriction event text stays distinct from restriction status in every locale',()=>{
 const base={id:1,kind:'restricted',bot_id:'bot',service:'Test',user_id:1,first_name:'Alice',created_at:new Date().toISOString(),thread_id:44,support_group_id:-1001234567890,queued:0,manual_restricted_until:new Date(Date.now()+60_000).toISOString()};
 const expected={ru:['Оператор ограничил пользователя','ограничен'],en:['Operator restricted the user','restricted'],es:['Un operador restringió al usuario','restringido'],zh:['管理员限制了用户','受限']};
 for(const [locale,phrases] of Object.entries(expected)){
  const text=formatAccessEvent(base,'Europe/Budapest',new Date(),locale);
  for(const phrase of phrases) assert.ok(text.includes(phrase),`${locale} should contain ${phrase}`);
 }
});

test('access alerts: migration adopts current restrictions without replaying historical successful CAPTCHA',()=>{
 const db=new DatabaseSync(':memory:');try {
  for(const name of ['0023_initial_schema.sql','0024_bot_messages_and_navigation.sql','0025_bot_setup_notices.sql','0026_manual_delivery_runs.sql','0027_verification_notice_status.sql']) db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const now=new Date().toISOString(),future=new Date(Date.now()+60_000).toISOString();
  db.prepare("INSERT INTO user_abuse_state(bot_id,user_id,muted_until,created_at,updated_at) VALUES('bot',1,?,?,?)").run(future,now,now);
  db.prepare("INSERT INTO verification_challenges(bot_id,user_id,token_hash,status,created_at,expires_at) VALUES('bot',1,'old','passed',?,?)").run(now,now);
  db.exec(readFileSync(new URL('../migrations/0028_user_access_alerts.sql',import.meta.url),'utf8'));
  assert.deepEqual(db.prepare('SELECT kind FROM user_access_events ORDER BY id').all().map(r=>r.kind),['auto_restricted','auto_restricted_due']);
  assert.equal(db.prepare('SELECT status FROM verification_challenges').get().status,'passed');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 }finally{db.close();}
});
