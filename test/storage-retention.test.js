import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { resolveInvocationDatabase } from '../src/recovery-budget.js';
import { createStorageJob, confirmStorageJob, runStorageJob, touchStorageTopic, storageMaintenance } from '../src/storage-retention.js';
import { previewFullReset, armFullReset, beginFullReset, runFullReset, RESET_TABLES } from '../src/storage-reset.js';
import { handleStorageUpdate } from '../src/storage-ui.js';
import { storageText, storageEnglish } from '../src/storage-copy.js';
import { requestTelegram } from '../src/telegram-response.js';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const OLD = '2025-09-09T12:00:00.000Z';

test('storage repeated current callback answers without rewriting an unchanged screen',async()=>{
  const {db,env}=fixture(),calls=[];
  try {
    const send=async(method,body)=>{calls.push({method,body});return {ok:true,result:{message_id:900}};};
    const bot={id:'bot',locale:'en',groupCommandOwner:true};
    const query={id:'q',from:{id:42},data:'um:st:details',message:{message_id:900,chat:{id:-100}}};
    await handleStorageUpdate(bot,env,{callback_query:query},send);
    const first=calls.at(-1).body;
    calls.length=0;
    query.message={...query.message,text:first.text,reply_markup:first.reply_markup};
    await handleStorageUpdate(bot,env,{callback_query:query},send);
    assert.deepEqual(calls.map(c=>c.method),['answerCallbackQuery']);
    query.message.text='Old text';
    await handleStorageUpdate(bot,env,{callback_query:query},send);
    assert.equal(calls.at(-1).method,'editMessageText');
  } finally {db.close();}
});

for (const status of [429,503]) test(`storage respects normalized Telegram ${status} without a replacement message`,async()=>{
  const {db,env}=fixture(),calls=[];
  try {
    const send=(method,body)=>requestTelegram({token:'test',method,body,fetchImpl:async()=>{
      calls.push(method);
      return method==='answerCallbackQuery' ? Response.json({ok:true,result:true})
        : Response.json({ok:false,error_code:status,description:'retry later',parameters:{retry_after:20}},{status});
    }});
    await handleStorageUpdate({id:'bot',locale:'en',groupCommandOwner:true},env,{callback_query:{id:'q',from:{id:42},data:'um:st:details',message:{message_id:900,chat:{id:-100}}}},send);
    assert.deepEqual(calls,['answerCallbackQuery','editMessageText']);
  } finally {db.close();}
});

test('storage translations preserve placeholders and never translate substituted user data',()=>{
  for(const [ru,en] of Object.entries(storageEnglish))assert.deepEqual([...ru.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort(),[...en.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort(),ru);
  const t=storageText('en');
  assert.equal(t`Исключить: ${'Анна {1}'} · ${'Shop'}`,'Exclude: Анна {1} · Shop');
});

test('English storage exposes danger separately and retains both reset confirmation stages',async()=>{
  const {db,env,seed}=fixture();
  try {
    seed();const bot={id:'bot',locale:'en',groupCommandOwner:true},calls=[];
    const initialConfirmation=db.sqlite.prepare('SELECT confirmation_nonce FROM storage_control').get().confirmation_nonce;
    const send=async(method,body)=>{calls.push({method,body});return {ok:true,result:{message_id:900}};};
    const click=data=>handleStorageUpdate(bot,env,{callback_query:{id:data,from:{id:42},data:'um:st:'+data,message:{message_id:900,chat:{id:-100}}}},send);
    const buttons=()=>calls.at(-1).body.reply_markup.inline_keyboard.flat();
    for(const action of ['home','danger','details','space','rules','list:0','topic:1','services','jobs','technical']) {
      await click(action);
      assert.doesNotMatch(calls.at(-1).body.text,/[А-Яа-яЁё]/,action);
      for(const b of buttons())assert.doesNotMatch(b.text,/[А-Яа-яЁё]/,action);
      if(action==='home')assert.ok(!buttons().some(b=>b.callback_data==='um:st:reset'));
      if(action==='danger')assert.ok(buttons().some(b=>b.callback_data==='um:st:reset'));
    }
    assert.equal(db.sqlite.prepare('SELECT confirmation_nonce FROM storage_control').get().confirmation_nonce,initialConfirmation);
    db.sqlite.exec("UPDATE storage_jobs SET status='running',last_error='temporary failure'");
    await click('home');
    assert.match(calls.at(-1).body.text,/Jobs needing attention: 1/);
    assert.match(calls.at(-1).body.text,/Jobs running: 1/);
    const phrase=()=>handleStorageUpdate(bot,env,{message:{from:{id:42},chat:{id:-100},text:'DELETE ALL CONVERSATIONS'}},send);
    await phrase();assert.equal(db.sqlite.prepare('SELECT mode FROM storage_control').get().mode,'normal');
    await click('reset');assert.doesNotMatch(calls.at(-1).body.text,/[А-Яа-яЁё]/);
    const arm=buttons().find(b=>b.callback_data?.startsWith('um:st:arm:')).callback_data.slice(6);
    await phrase();assert.equal(db.sqlite.prepare('SELECT mode FROM storage_control').get().mode,'normal');
    await click(arm);assert.match(calls.at(-1).body.text,/DELETE ALL CONVERSATIONS/);
    await phrase();assert.equal(db.sqlite.prepare('SELECT mode FROM storage_control').get().mode,'reset');
    await click('home');assert.match(calls.at(-1).body.text,/Full cleanup/);assert.doesNotMatch(calls.at(-1).body.text,/[А-Яа-яЁё]/);
  } finally {db.close();}
});
function fixture() {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  const env = { SUPPORT_DB: db, ADMIN_IDS: '42', SUPPORT_GROUP_ID: '-100', RETENTION_ENABLED: 'true', BOT_REGISTRY: '[]' };
  db.storageGeneration = 0;
  const seed = (user = 1, count = 2) => {
    db.sqlite.prepare('INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,created_at,last_message_at) VALUES (?,?,?,?,?,?)').run('bot', user, -100, user + 50, OLD, OLD);
    for (let n = 0; n < count; n++) db.sqlite.prepare('INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES (?,?,?,?,?,?)').run('bot', user, user + 50, n + user * 1000, n + user * 1000 + 100000, OLD);
    return db.sqlite.prepare('SELECT * FROM storage_topics WHERE user_id = ?').get(user);
  };
  return { db, env, seed };
}

test('storage workspace: customer labels, page context and one edited operation screen',async()=>{
  const {db,env,seed}=fixture();
  try {
    for(let i=1;i<=7;i++)seed(i);
    db.sqlite.exec("UPDATE conversations SET first_name='Anna' WHERE user_id=7");
    const calls=[],send=async(method,body)=>{calls.push({method,body});return {ok:true,result:{message_id:900}};};
    const bot={id:'bot',locale:'ru',groupCommandOwner:true};
    const click=(data,markup)=>handleStorageUpdate(bot,env,{callback_query:{id:data,from:{id:42},data:'um:st:'+data,message:{message_id:900,chat:{id:-100},reply_markup:markup}}},send);
    await click('list:5');
    let screen=calls.at(-1);assert.equal(screen.method,'editMessageText');
    const entry=screen.body.reply_markup.inline_keyboard.flat().find(b=>b.text.includes('Anna'));
    assert.ok(entry);await click(entry.callback_data.slice(6));
    screen=calls.at(-1);assert.match(screen.body.text,/Anna/);
    const protect=screen.body.reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.includes(':protect:'));
    await click(protect.callback_data.slice(6));
    const back=calls.at(-1).body.reply_markup.inline_keyboard.flat().find(b=>b.text==='← Темы');
    assert.equal(back.callback_data,'um:st:list:5');
    const markup=calls.at(-1).body.reply_markup;await click('home',markup);
    assert.equal(calls.filter(c=>c.method==='sendMessage').length,0);
    db.sqlite.exec('UPDATE storage_topics SET protected=0');
    const job=await createStorageJob(env,{mode:'old',actorId:42});await click('job:'+job+':5');
    assert.match(calls.at(-1).body.text,/Anna.*2025/);
    const exclude=calls.at(-1).body.reply_markup.inline_keyboard.flat().find(b=>b.text.includes('Исключить: Anna'));
    assert.ok(exclude);assert.ok(Buffer.byteLength(exclude.callback_data)<=64);
    assert.ok(calls.at(-1).body.reply_markup.inline_keyboard.flat().some(b=>b.url));
    await click(exclude.callback_data.slice(6));
    assert.equal(db.sqlite.prepare("SELECT status FROM storage_job_topics WHERE job_id=? AND topic_id=7").get(job).status,'excluded');
    assert.ok(calls.at(-1).body.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='um:st:job:'+job+':5'));

  } finally {db.close();}
});

test('storage workspace: policy preview is inert and stale confirmation cannot replace newer rules',async()=>{
  const {db,env}=fixture();
  try {
    const calls=[],send=async(method,body)=>{calls.push({method,body});return {ok:true,result:{message_id:901}};};
    const bot={id:'bot',locale:'ru',groupCommandOwner:true};
    const initial=db.sqlite.prepare('SELECT * FROM storage_control').get();
    await handleStorageUpdate(bot,env,{message:{message_id:1,from:{id:42},chat:{id:-100},text:'/storage rules 90 14 1000'}},send);
    assert.equal(db.sqlite.prepare('SELECT retention_days FROM storage_control').get().retention_days,initial.retention_days);
    const data=calls.at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
    const update={callback_query:{id:'policy',from:{id:42},data,message:{message_id:901,chat:{id:-100}}}};
    await handleStorageUpdate(bot,env,update,send);
    assert.equal(db.sqlite.prepare('SELECT retention_days FROM storage_control').get().retention_days,90);
    db.sqlite.exec('UPDATE storage_control SET retention_days=365,policy_revision=policy_revision+1');
    await handleStorageUpdate(bot,env,update,send);
    assert.equal(db.sqlite.prepare('SELECT retention_days FROM storage_control').get().retention_days,365);
  } finally {db.close();}
});

test('cleanup requires explicit confirmation and deletes only old mappings in batches', async () => {
  const { db, env, seed } = fixture();
  try {
    seed(1, 120);
    db.sqlite.prepare('INSERT INTO message_mappings(bot_id,user_id,thread_id,created_at) VALUES (?,?,?,?)').run('bot', 1, 51, NOW.toISOString());
    const id = await createStorageJob(env, { mode: 'old', actorId: 42 }, NOW);
    await runStorageJob(env, NOW);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM message_mappings').get().n, 121);
    assert.equal(await confirmStorageJob(env, id, 42, NOW), true);
    await runStorageJob(env, NOW);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM message_mappings').get().n, 21);
    await runStorageJob(env, NOW);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM message_mappings').get().n, 1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 1);
    assert.equal(db.sqlite.prepare('SELECT deleted_rows FROM storage_jobs').get().deleted_rows, 120);
  } finally { db.close(); }
});

test('new activity and protection invalidate earlier cleanup consent', async () => {
  for (const mutation of ['activity', 'protect']) {
    const { db, env, seed } = fixture();
    try {
      seed();
      const id = await createStorageJob(env, { mode: 'old', actorId: 42 }, NOW);
      await confirmStorageJob(env, id, 42, NOW);
      if (mutation === 'activity') await touchStorageTopic(env, 'bot', 51, 1, NOW);
      else db.sqlite.exec('UPDATE storage_topics SET protected = 1, revision = revision + 1');
      await runStorageJob(env, NOW);
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM message_mappings').get().n, 2);
      assert.equal(db.sqlite.prepare('SELECT status FROM storage_job_topics').get().status, 'cancelled');
    } finally { db.close(); }
  }
});

test('deleted cleanup selects only explicitly confirmed topics; unknown is retained', async () => {
  const { db, env, seed } = fixture();
  try {
    const confirmed = seed(1); seed(2);
    for(const user of [1,2])db.sqlite.prepare("INSERT INTO conversation_work(bot_id,user_id,updated_at,note) VALUES('bot',?,?,'keep context')").run(user,OLD);
    for (const user of [1, 2]) {
      db.sqlite.prepare(`INSERT INTO service_notification_outbox
        (bot_id,user_id,notification_cycle,kind,recipient_id,group_id,thread_id,available_at,created_at)
        VALUES('bot',?,1,'new',42,-100,?,?,?)`).run(user,user+50,OLD,OLD);
      db.sqlite.prepare(`INSERT INTO manager_work_flows
        (operator_id,bot_id,user_id,expected_revision,stage,nonce,expires_at,updated_at,note)
        VALUES(?,'bot',?,0,'note',?,?,?,'private note')`).run(user+40,user,`draft-${user}`,OLD,OLD);
      db.sqlite.prepare(`INSERT INTO service_topic_history
        (bot_id,user_id,support_group_id,thread_id,conversation_id,status,created_at,archived_at,replacement_group_id)
        VALUES('bot',?,-100,?,?, 'closed',?,?,-100)`).run(user,user+40,user+900,OLD,OLD);
    }
    db.sqlite.prepare("UPDATE storage_topics SET state = 'missing_confirmed', missing_at = ? WHERE id = ?").run(NOW.toISOString(), confirmed.id);
    const id = await createStorageJob(env, { mode: 'deleted', actorId: 42 }, NOW);
    await confirmStorageJob(env, id, 42, NOW);
    await runStorageJob(env, NOW);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM conversations WHERE user_id = 1').get().n, 0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM message_mappings WHERE user_id = 2').get().n, 2);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM conversation_work WHERE user_id=1').get().n,0);
    assert.equal(db.sqlite.prepare('SELECT note FROM conversation_work WHERE user_id=2').get().note,'keep context');
    for (const table of ['service_notification_outbox', 'manager_work_flows', 'service_topic_history']) {
      assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=1`).get().n, 0, table);
      assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=2`).get().n, 1, table);
    }
  } finally { db.close(); }
});

test('automatic cleanup enforces age, quarantine, known activity, and daily allowance', async () => {
  const { db, env, seed } = fixture();
  try {
    for (let n = 1; n <= 4; n++) seed(n, 4);
    db.sqlite.exec("UPDATE storage_control SET daily_limit = 2; UPDATE storage_topics SET state = 'missing_confirmed', missing_at = '2026-08-01T00:00:00.000Z'");
    db.sqlite.prepare('UPDATE storage_topics SET missing_at = ? WHERE user_id = 2').run(NOW.toISOString());
    db.sqlite.exec("UPDATE storage_topics SET activity_known = 0 WHERE user_id = 3; UPDATE storage_topics SET last_activity = '2026-09-01T00:00:00.000Z' WHERE user_id = 4");
    const id = await createStorageJob(env, { mode: 'auto', actorId: 42 }, NOW);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM storage_job_topics').get().n, 1);
    await confirmStorageJob(env, id, 42, NOW);
    await runStorageJob(env, NOW); await runStorageJob(env, NOW);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM message_mappings WHERE user_id = 1').get().n, 2);
    assert.equal(db.sqlite.prepare('SELECT cleanup_used FROM storage_control').get().cleanup_used, 2);
  } finally { db.close(); }
});

test('full reset requires a fresh two-stage primary-admin confirmation, preserves security and resumes', async () => {
  const { db, env, seed } = fixture();
  try {
    seed();
    db.sqlite.prepare("INSERT INTO processed_updates(bot_id,update_id,state,owner_token,processed_at) VALUES ('bot',8,'processing','old-worker',?)").run(OLD);
    db.sqlite.prepare("INSERT INTO banned_users(bot_id,user_id,banned_at) VALUES ('bot',9,?)").run(OLD);
    db.sqlite.prepare("INSERT INTO user_abuse_state(bot_id,user_id,manual_trust,verification_required,pending_release_required,created_at,updated_at) VALUES ('bot',9,1,1,1,?,?)").run(OLD, OLD);
    db.sqlite.prepare(`INSERT INTO service_notification_outbox
      (bot_id,user_id,notification_cycle,kind,recipient_id,group_id,thread_id,available_at,created_at)
      VALUES('bot',1,1,'new',42,-100,51,?,?)`).run(OLD, OLD);
    db.sqlite.prepare(`INSERT INTO manager_work_flows
      (operator_id,bot_id,user_id,expected_revision,stage,nonce,expires_at,updated_at,note)
      VALUES(42,'bot',1,0,'note','draft',?,?,'private note')`).run(OLD, OLD);
    db.sqlite.prepare('INSERT INTO manager_search_flows(operator_id,expires_at) VALUES(42,?)').run(OLD);
    db.sqlite.prepare('INSERT INTO manager_home_screens(operator_id,update_id,requested_at,message_id) VALUES(42,500,?,777)').run(OLD);
    db.sqlite.prepare("INSERT INTO manager_work_navigation(operator_id,list_route,card_route,updated_at) VALUES(42,'mg:queue:a:needs:0','mg:work:a:1',?)").run(OLD);
    db.sqlite.prepare(`INSERT INTO service_topic_history
      (bot_id,user_id,support_group_id,thread_id,conversation_id,status,created_at,archived_at,replacement_group_id)
      VALUES('bot',1,-100,49,999,'closed',?,?,-100)`).run(OLD, OLD);
    assert.equal(await beginFullReset(env, 42, 'УДАЛИТЬ ВСЕ ОБРАЩЕНИЯ', NOW), false);
    const nonce = await previewFullReset(env, 42, NOW);
    assert.equal(await beginFullReset(env, 42, 'УДАЛИТЬ ВСЕ ОБРАЩЕНИЯ', NOW), false);
    await assert.rejects(armFullReset(env, 43, nonce, NOW), /primary/);
    assert.equal(await armFullReset(env, 42, 'old', NOW), false);
    assert.equal(await armFullReset(env, 42, nonce, NOW), true);
    assert.equal(await beginFullReset(env, 42, 'УДАЛИТЬ ВСЕ ОБРАЩЕНИЯ', NOW), true);
    assert.equal(await beginFullReset(env, 42, 'УДАЛИТЬ ВСЕ ОБРАЩЕНИЯ', NOW), false);
    await runFullReset(env, NOW);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 1);
    const later = new Date(NOW.getTime() + 121000);
    for (let n = 0; n < RESET_TABLES.length + 5; n++) await runFullReset(env, later);
    assert.equal(db.sqlite.prepare('SELECT mode FROM storage_control').get().mode, 'normal');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM message_mappings').get().n, 0);
    for (const table of ['service_notification_outbox', 'manager_work_flows', 'manager_search_flows', 'manager_work_navigation', 'manager_home_screens', 'service_topic_history'])
      assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM storage_audit').get().n, 1);
    assert.equal(db.sqlite.prepare('SELECT state FROM processed_updates WHERE update_id = 8').get().state, 'completed');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM banned_users').get().n, 1);
    assert.deepEqual({ ...db.sqlite.prepare('SELECT manual_trust, verification_required, pending_release_required FROM user_abuse_state').get() }, { manual_trust: 1, verification_required: 0, pending_release_required: 0 });
    const current = await resolveInvocationDatabase(db, { RETENTION_ENABLED: 'true' });
    await current.prepare('INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,created_at) VALUES (?,?,?,?,?)').bind('bot', 2, -100, 52, later.toISOString()).run();
    await runFullReset(env, later);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 1);
  } finally { db.close(); }
});

test('storage UI rejects another operator and a topic; callback lengths fit Telegram', async () => {
  const { db, env, seed } = fixture();
  const calls = [];
  const send = async (method, body) => { calls.push({ method, body }); return { ok: true }; };
  const bot = { id: 'bot', locale: 'ru', groupCommandOwner: true };
  try {
    seed();
    for (const [actor, thread] of [[43, 1], [42, 51]]) {
      await handleStorageUpdate(bot, env, { callback_query: { id: 'q', from: { id: actor }, data: 'um:st:reset', message: { chat: { id: -100 }, message_thread_id: thread } } }, send);
      assert.equal(calls.at(-1).method, 'answerCallbackQuery');
    }
    await handleStorageUpdate(bot, env, { message: { from: { id: 42 }, chat: { id: -100 }, text: '/storage' } }, send);
    assert.match(calls.at(-1).body.text, /Хранилище/);
    const id = await createStorageJob(env, { mode: 'old', actorId: 42 });
    await handleStorageUpdate(bot, env, { callback_query: { id: 'q', from: { id: 42 }, data: `um:st:job:${id}`, message: { chat: { id: -100 } } } }, send);
    for (const call of calls) for (const row of call.body.reply_markup?.inline_keyboard || []) for (const b of row) { if(b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64); else assert.match(b.url,/^https:\/\/t.me\/c\//); }
  } finally { db.close(); }
});

test('storage maintenance and a cleanup batch fit the Free invocation budget', async () => {
  const { db, env, seed } = fixture();
  try {
    seed();
    const wrapped = await resolveInvocationDatabase(db, env, 'recovery');
    await storageMaintenance({ ...env, SUPPORT_DB: wrapped }, async () => ({ ok: true }), NOW);
    assert.ok(wrapped.used <= 40);
    const fresh = await resolveInvocationDatabase(db, env, 'recovery');
    await runStorageJob({ ...env, SUPPORT_DB: fresh }, NOW);
    assert.ok(fresh.used <= 40);
  } finally { db.close(); }
});

test('manual and automatic storage jobs for another registered group survive the background runner', async () => {
  const { db, env } = fixture();
  try {
    db.sqlite.prepare(`INSERT INTO support_groups(group_id,title,created_at,updated_at)
      VALUES(-200,'Second',?,?)`).run(OLD, OLD);
    const generation = db.sqlite.prepare('SELECT generation FROM storage_control WHERE id=1').get().generation;
    db.sqlite.prepare(`INSERT INTO storage_topics(bot_id,support_group_id,thread_id,user_id,state,
      last_activity,activity_known,generation) VALUES('bot',-200,52,2,'present',?,1,?)`).run(OLD, generation);
    const groupEnv = { ...env, SUPPORT_GROUP_ID: '-200' };
    const id = await createStorageJob(groupEnv, { mode: 'old', actorId: 42 }, NOW);
    assert.equal(await confirmStorageJob(groupEnv, id, 42, NOW), true);
    await runStorageJob(env, NOW);
    assert.notEqual(db.sqlite.prepare('SELECT status FROM storage_jobs WHERE id=?').get(id).status, 'cancelled');
    db.sqlite.prepare("UPDATE storage_jobs SET status='completed' WHERE id=?").run(id);
    db.sqlite.prepare(`UPDATE storage_topics SET state='missing_confirmed',missing_at=? WHERE support_group_id=-200`).run(OLD);
    await storageMaintenance(env, async () => ({ ok: true }), NOW);
    assert.equal(db.sqlite.prepare("SELECT support_group_id FROM storage_jobs WHERE mode='auto' ORDER BY created_at DESC LIMIT 1").get().support_group_id, -200);
  } finally { db.close(); }
});

test('stopping a full reset resumes intake and preserves the records not yet deleted', async () => {
  const { db, env, seed } = fixture();
  try {
    seed();
    const nonce = await previewFullReset(env, 42, NOW);
    await armFullReset(env, 42, nonce, NOW);
    await beginFullReset(env, 42, 'УДАЛИТЬ ВСЕ ОБРАЩЕНИЯ', NOW);
    db.sqlite.exec('UPDATE storage_control SET reset_cancel_requested = 1');
    await runFullReset(env, new Date(NOW.getTime() + 121000));
    assert.equal(db.sqlite.prepare('SELECT mode FROM storage_control').get().mode, 'normal');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 1);
    assert.equal(db.sqlite.prepare('SELECT action FROM storage_audit').get().action, 'full_reset_cancelled');
  } finally { db.close(); }
});

test('technical cleanup retires completed records without deleting active delivery or mappings', async () => {
  const { db, env, seed } = fixture();
  try {
    seed();
    db.sqlite.prepare("INSERT INTO processed_updates(bot_id,update_id,state,owner_token,processed_at,completed_at) VALUES ('bot',1,'completed','owner',?,?)").run(OLD, OLD);
    db.sqlite.prepare("INSERT INTO processed_updates(bot_id,update_id,state,owner_token,processed_at) VALUES ('bot',2,'processing','owner',?)").run(OLD);
    const id = await createStorageJob(env, { mode: 'technical', actorId: 42 }, NOW);
    await confirmStorageJob(env, id, 42, NOW);
    for (let n = 0; n < 8; n++) await runStorageJob(env, NOW);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM processed_updates').get().n, 1);
    assert.equal(db.sqlite.prepare('SELECT state FROM processed_updates').get().state, 'processing');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM message_mappings').get().n, 2);
    assert.equal(db.sqlite.prepare('SELECT status FROM storage_jobs WHERE id = ?').get(id).status, 'completed');
  } finally { db.close(); }
});

test('a preallocated reserve permits the confirmation transition in a full SQLite file', async () => {
  const { db, env, seed } = fixture();
  try {
    seed();
    db.sqlite.exec('CREATE TABLE test_filler(data BLOB)');
    const pages = db.sqlite.prepare('PRAGMA page_count').get().page_count;
    db.sqlite.exec(`PRAGMA max_page_count = ${pages}`);
    const insert = db.sqlite.prepare('INSERT INTO test_filler(data) VALUES (zeroblob(3000))');
    let filled = false;
    for (let n = 0; n < 10000; n++) { try { insert.run(); } catch (error) { assert.match(error.message, /full/); filled = true; break; } }
    assert.ok(filled);
    const nonce = await previewFullReset(env, 42, NOW);
    assert.ok(nonce);
    assert.equal(await armFullReset(env, 42, nonce, NOW), true);
    assert.equal(await beginFullReset(env, 42, 'УДАЛИТЬ ВСЕ ОБРАЩЕНИЯ', NOW), true);
  } finally { db.close(); }
});
