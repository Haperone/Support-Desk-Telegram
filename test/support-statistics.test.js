import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { statisticsRange,parseStatisticsDates,nextStatisticsSchedule,scheduledStatisticsRange,statisticsAccess,collectStatistics,recordStatisticsTelegramFailure,localInstant,summarizeStatistics } from '../src/support-statistics.js';
import { prepareStatisticsReport,runStatisticsSchedule,handleStatisticsCallback,handleStatisticsText } from '../src/manager-statistics.js';
import { STATISTICS_COPY,formatStatistics,richEscape } from '../src/statistics-copy.js';
import { createRecoveryDatabase } from '../src/recovery-budget.js';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync,readFileSync } from 'node:fs';
import { managementBotKey,parseBotRegistry } from '../src/worker.js';

const at=new Date('2026-10-03T12:00:00.000Z');
function fixture(){
 const db=new SqliteD1(new URL('../migrations/',import.meta.url));
 db.sqlite.exec("UPDATE statistics_control SET started_at='2026-09-01T00:00:00.000Z';INSERT INTO support_operators(user_id,first_name,active,added_at,added_by,added_by_name) VALUES(8,'Operator',1,'2026-09-01',7,'Admin')");
 const services=['a','b'].map(id=>({id,username:`${id}_bot`,displayName:id==='a'?'A | **raw**':'B',topicPrefix:id,locale:'en',tokenBinding:'TOKEN_'+id.toUpperCase(),webhookSecretBinding:'SECRET_'+id.toUpperCase(),enabled:true}));
 const env={ADMIN_IDS:'7',BOT_REGISTRY:JSON.stringify(services),SUPPORT_DB:db,MANAGER_BOT_TOKEN:'1:TEST'};
 const source=(bot,user,id,time,direction='user_to_support')=>db.sqlite.prepare(`INSERT INTO message_delivery_attempts(bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at,source_created_at)
 VALUES(?,?,?,?,?,51,?,'copyMessage',?,?)`).run(bot,direction,direction==='user_to_support'?user:-100,id,user,direction==='user_to_support'?-100:user,time,time);
 const confirmed=(id,time)=>db.sqlite.prepare('UPDATE message_delivery_attempts SET completed_at=?,target_message_id=? WHERE source_message_id=?').run(time,id+1000,id);
 return {db,env,source,confirmed,close:()=>db.close()};
}
test('statistics local calendar bounds, strict dates and schedules handle DST and month rollover',()=>{
 assert.equal(statisticsRange('today','Europe/Budapest',new Date('2026-03-29T12:00Z')).start,'2026-03-28T23:00:00.000Z');
 assert.equal(statisticsRange('yesterday','Europe/Budapest',new Date('2026-03-30T12:00Z')).end,'2026-03-29T22:00:00.000Z');
 assert.equal(parseStatisticsDates('2026-02-30 2026-03-01','Europe/Budapest',at),null);
 assert.equal(parseStatisticsDates('2026-10-01 2026-10-03','Europe/Budapest',at),null,'future part of today is not a completed day');
 assert.equal(parseStatisticsDates('2026-10-01 2026-10-02','Europe/Budapest',at).custom_end,'2026-10-02T22:00:00.000Z');
 const row={frequency:'daily',timezone:'Europe/Budapest',send_hour:9,send_minute:0,weekday:1};
 assert.equal(nextStatisticsSchedule(row,new Date('2026-10-24T12:00Z')),'2026-10-25T08:00:00.000Z');
 assert.equal(nextStatisticsSchedule({...row,frequency:'monthly'},new Date('2026-12-31T12:00Z')),'2027-01-01T08:00:00.000Z');
 assert.equal(scheduledStatisticsRange({...row,frequency:'monthly'},at).start,'2026-08-31T22:00:00.000Z');
 assert.equal(scheduledStatisticsRange({...row,frequency:'weekly'},at).start,'2026-09-20T22:00:00.000Z');
});
test('facts deduplicate across quarantine and delivery, preserve original receipt time, and count global users once',async()=>{
 const f=fixture();try{
 f.source('a',1,11,'2026-10-02T10:00:00.000Z');
 f.db.sqlite.prepare(`INSERT INTO pending_messages(bot_id,user_id,update_id,source_chat_id,source_message_id,created_at,source_created_at) VALUES('a',1,101,1,11,?,?)`).run('2026-10-02T10:01:00.000Z','2026-10-02T10:00:00.000Z');
 f.source('b',1,12,'2026-10-02T10:02:00.000Z');f.confirmed(11,'2026-10-02T10:02:00.000Z');f.confirmed(12,'2026-10-02T10:03:00.000Z');
 f.db.sqlite.exec("UPDATE pending_messages SET delivered_at='2026-10-02T10:02:00.000Z';UPDATE statistics_users SET first_seen='2026-09-01T00:00:00.000Z' WHERE bot_id='a'");
 const facts=f.db.sqlite.prepare("SELECT * FROM statistics_facts WHERE kind='message'").all();assert.equal(facts.length,2);
 assert.equal(f.db.sqlite.prepare('SELECT facts_count FROM statistics_control').get().facts_count,f.db.sqlite.prepare('SELECT COUNT(*) n FROM statistics_facts').get().n);
 const access=await statisticsAccess(f.env,f.db,7),report=await collectStatistics(f.env,f.db,access,statisticsRange('yesterday','Europe/Budapest',at),at);
 assert.equal(report.totals.users,1);assert.equal(report.totals.newUsers,0);assert.equal(report.totals.returning,1);assert.equal(report.totals.inbound,2);assert.equal(report.totals.deliveredIn,2);
 assert.equal(report.current.pending,0);assert.equal(report.complete,true);
 }finally{f.close();}
});
test('confirmed human answer measures earliest unanswered input once; automated messages and manual waiting do not create samples',()=>{
 const f=fixture();try{
 f.source('a',1,11,'2026-10-02T10:00:00.000Z');f.source('a',1,12,'2026-10-02T10:05:00.000Z');
 f.source('a',1,21,'2026-10-02T10:10:00.000Z','support_to_user');f.confirmed(21,'2026-10-02T10:12:00.000Z');
 f.source('a',1,22,'2026-10-02T10:15:00.000Z','support_to_user');f.confirmed(22,'2026-10-02T10:16:00.000Z');
 const answers=f.db.sqlite.prepare("SELECT * FROM statistics_facts WHERE kind='answer'").all();assert.equal(answers.length,1);assert.ok(Math.abs(answers[0].seconds-720)<.01);assert.equal(answers[0].first_reply,1);
 f.source('a',1,13,'2026-10-02T11:00:00.000Z');f.db.sqlite.exec("UPDATE conversation_work SET state='waiting'");
 assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM statistics_facts WHERE kind='answer'").get().n,1);
 }finally{f.close();}
});
test('operator and group scopes reject forged services and current pending messages preserve same-second distinct inputs',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec("INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,status,created_at) VALUES('a',1,-100,51,'open','2026-10-02'),('b',2,-200,52,'open','2026-10-02')");
 f.source('a',1,11,'2026-10-02T10:00:00.000Z');f.source('a',1,12,'2026-10-02T10:00:00.000Z');f.source('b',2,13,'2026-10-02T10:00:00.000Z');
 f.db.sqlite.exec('UPDATE conversation_work SET assigned_to=8 WHERE bot_id=\'a\'');
 assert.equal(await statisticsAccess(f.env,f.db,8,'b'),null);assert.equal(await statisticsAccess(f.env,f.db,99),null);
 const access=await statisticsAccess(f.env,f.db,8),report=await collectStatistics(f.env,f.db,access,statisticsRange('yesterday','Europe/Budapest',at),at);
 assert.equal(report.current.pending,2);assert.equal(report.totals.inbound,2);assert.equal(report.services.length,1);assert.equal(report.access.primary,false);
 }finally{f.close();}
});
test('bounded facts storage, telemetry observations and four complete catalogs never expose Markdown names as formatting',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec('UPDATE statistics_control SET capacity=4');
 for(let id=1;id<=5;id++)f.source('a',1,id,'2026-10-02T10:00:00.000Z');
 assert.ok(f.db.sqlite.prepare('SELECT clipped_at FROM statistics_control').get().clipped_at);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM statistics_facts').get().n,4);
 const keys=Object.keys(STATISTICS_COPY.en).sort();for(const locale of ['ru','es','zh'])assert.deepEqual(Object.keys(STATISTICS_COPY[locale]).sort(),keys);
 f.db.sqlite.exec('UPDATE statistics_control SET capacity=20');await recordStatisticsTelegramFailure(f.db,'a',{ok:false});
 const result=await prepareStatisticsReport(f.env,f.db,7,{scope:'a',period:'yesterday',timezone:'Europe/Budapest'},null,at);
 assert.equal(result.report.complete,false);assert.equal(result.report.totals.network,0,'a current error is outside yesterday');
 for(const locale of ['en','ru','es','zh']){const text=formatStatistics(result.report,locale);assert.ok(text.includes(richEscape('A | **raw**')));assert.ok(text.includes(STATISTICS_COPY[locale].resources));assert.ok(text.length<32768);assert.ok(!text.includes('undefined'));}
 }finally{f.close();}
});
test('reports lead with actionable queues and retain detailed indicators without wide tables in all languages',async()=>{
 const f=fixture();try{
 const {report}=await prepareStatisticsReport(f.env,f.db,7,{scope:'a',period:'yesterday',timezone:'Europe/Budapest'},null,at);
 report.complete=true;report.previousComplete=true;report.previous={users:2,close:1,late:0,firstMedian:240};
 report.current={...report.current,complete:true,open:9,needs:5,overdue:2,failed:3,uncertain:1,pending:4,oldest:420};
 report.totals={...report.totals,users:8,newUsers:3,firstMedian:180,firstP90:540,nextMedian:60,deliveryMedian:2,within:75,responseSamples:4};
 report.operators=[{name:'<details> **Operator** | x',assigned:5,overdue:2,served:4,closed:3}];
 for(const locale of ['en','ru','es','zh']){
   const c=STATISTICS_COPY[locale],text=formatStatistics(report,locale),visible=text.split('<details>')[0];
   assert.doesNotMatch(text,/^#{1,6} |^\|/m,'no oversized headings or mobile-hostile tables');
   assert.ok(visible.includes(`**9** ${c.queueOpen}`));
   assert.ok(visible.includes(`**2** · ${c.overdue}`));
   assert.ok(visible.includes(`**3** · ${c.failedDelivery}`));
   assert.ok(visible.includes(`**1** · ${c.unknown}`));
   assert.ok(visible.includes(`**4** · ${c.pending}`));
   assert.ok(visible.includes('=='),'delivery and wait problems are highlighted before folded details');
   assert.ok(text.startsWith(`**🔴 ${c.criticalNow}**`));
   assert.ok(!visible.includes(c.queueHealthy));
   assert.ok(!visible.includes(c.unavailable),'missing measurements do not drown the summary');
   for(const key of ['openUsers','waiting','snoozed','resolvedOpen','unknownWork','oldest','first','returning','reopen','firstMedian','firstP90','nextMedian','deliveryMedian','within','samples','assigned','served','inbound','outbound','deliveredIn','deliveredOut','oldestDelivery','network','limited','telegram','d1Errors','workerErrors','resourceFailures','checks','passed','failed','expired','bans','restrictions','awaiting','held','reads','writes','storage','growth','runtime','compare'])assert.ok(text.includes(c[key]),`${locale}: missing ${key}`);
   assert.ok(text.includes(richEscape(report.operators[0].name)));
   assert.equal((text.match(/<details>/g)||[]).length,(text.match(/<\/details>/g)||[]).length);
   assert.equal((text.match(/<details>/g)||[]).length,9,'keep the existing report sections');
   assert.ok(text.includes(`- ${c.firstP90}:<br>**9 ${c.minutes}**`),'a long label and its value have an explicit break');
   assert.ok(text.includes(`- ${c.within}:<br>**75.0%**`));
   assert.ok(text.includes(`- ${c.network}: 0`),'zero indicators stay present without competing with nonzero values');
   assert.ok(!text.includes('**0**'));
   assert.ok(text.includes(`**${richEscape(report.services[0].name)}**<br><br>`));
   assert.ok(text.includes('**75.0%**'));assert.ok(text.includes('**+6**'));
   assert.ok(text.includes(c.missingNote));
   if(locale!=='ru')assert.doesNotMatch(text,/[А-Яа-яЁё]/);
 }
 }finally{f.close();}
});

test('snapshot reports omit unrequested period sections and operator reports retain account privacy',async()=>{
 const f=fixture();try{
 const {report}=await prepareStatisticsReport(f.env,f.db,7,{scope:'a',period:'now',timezone:'Europe/Budapest'},null,at);
 report.complete=true;report.current.complete=true;
 report.access.primary=false;
 for(const locale of ['en','ru','es','zh']){
   const c=STATISTICS_COPY[locale],text=formatStatistics(report,locale);
   for(const key of ['periodSummary','firstMedian','firstP90','within','compare','new','reopen','resources','d1Errors','workerErrors'])assert.ok(!text.includes(c[key]),`${locale}: unrequested/private ${key}`);
   assert.ok(text.includes(c.pending));assert.ok(text.includes(c.awaiting));assert.ok(text.includes(c.snapshot));
   assert.ok(text.includes(c.noOperators));assert.ok(text.includes('🟢 '+c.queueHealthy));
   assert.ok(!text.includes('**—**'),'missing values must not receive number emphasis');
 }
 }finally{f.close();}
});

test('current critical alerts outrank metadata while historical errors and stale usage cannot claim a current outage',async()=>{
 const f=fixture();try{
 const {report}=await prepareStatisticsReport(f.env,f.db,7,{scope:'a',period:'yesterday',timezone:'Europe/Budapest'},null,at);
 report.complete=true;report.current={...report.current,complete:true,failed:0,uncertain:0,overdue:0,pending:0,unassigned:0,unknownWork:0};
 for(const locale of ['en','ru','es','zh']){
   const c=STATISTICS_COPY[locale];
   const cases=[
     {resources:{incidents:2,criticalIncidents:2,warningIncidents:0},label:c.runtime},
     {resources:{fresh:true,usage:{d1_rows_written:100},limits:{d1_rows_written:100}},label:c.limitsReached},
   ];
   for(const sample of cases){
     const text=formatStatistics({...report,resources:sample.resources},locale),top=text.split(`**📊 ${c.title}**`)[0];
     assert.ok(top.startsWith(`**🔴 ${c.criticalNow}**`));
     assert.ok(top.includes(sample.label));assert.ok(top.includes(c.accountStatus));
     assert.ok(!top.includes('<details>'));
     const operatorText=formatStatistics({...report,access:{...report.access,primary:false},resources:sample.resources},locale);
     assert.ok(!operatorText.includes(c.accountStatus));assert.ok(!operatorText.includes(c.criticalNow));
   }
   const past={...report,totals:{...report.totals,network:2,recovered:2},resources:{incidents:0,runtime:{exceptions:3,resource_failures:1}}};
   const text=formatStatistics(past,locale),visible=text.split('<details>')[0];
   assert.ok(!text.includes(c.criticalNow));assert.ok(visible.includes(c.periodFailures));
   for(const key of ['network','recovered','workerErrors','resourceFailures'])assert.ok(visible.includes(c[key]));
   const stale=formatStatistics({...report,resources:{fresh:false,incidents:0,usage:{d1_rows_written:200},limits:{d1_rows_written:100}}},locale);
   assert.ok(!stale.includes(c.limitsReached));assert.ok(!stale.includes(c.criticalNow));
   const near=formatStatistics({...report,resources:{fresh:true,incidents:0,usage:{d1_rows_written:90},limits:{d1_rows_written:100}}},locale);
   assert.ok(near.startsWith(`**🟠 ${c.warningNow}**`));assert.ok(near.includes('**90.0%**'));
   for(const resources of [{incidents:2,criticalIncidents:0,warningIncidents:2},{incidents:2}]){
     const warning=formatStatistics({...report,resources},locale);
     assert.ok(warning.startsWith(`**🟠 ${c.warningNow}**`));assert.ok(!warning.includes(c.criticalNow));
   }
   const incomplete=formatStatistics({...report,current:{...report.current,complete:false}},locale);
   assert.ok(incomplete.startsWith(`**⚪ ${c.queueIncomplete}**`));assert.ok(!incomplete.includes(c.queueHealthy));
 }
 }finally{f.close();}
});

test('report and settings use explicit rich line breaks for metadata, queue counts and named entries',async()=>{
 const f=fixture();try{
 const {report}=await prepareStatisticsReport(f.env,f.db,7,{scope:'a',period:'yesterday',timezone:'Europe/Budapest'},null,at);
 report.current={...report.current,open:9,needs:5,overdue:2};
 report.operators=[{name:'Operator',assigned:5,overdue:2,served:4,closed:3}];
 for(const locale of ['en','ru','es','zh']){
   const c=STATISTICS_COPY[locale],text=formatStatistics(report,locale);
   assert.ok(text.includes(`**9** ${c.queueOpen}<br>\n> **5** ${c.queueNeeds}<br>\n> **2** ${c.queueOverdue}`));
   assert.ok(text.includes(`**Operator**<br><br>\n${c.assigned}: **5**<br>\n${c.overdue}: **2**<br>`));
   assert.match(text,/\*\*<br>\n/);assert.ok(text.includes(`${c.zone}: Europe/Budapest`));
   assert.doesNotMatch(text,/ {2}\n/,'do not depend on trailing whitespace surviving rich parsing');
   f.db.sqlite.prepare('INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,?,?) ON CONFLICT(operator_id) DO UPDATE SET language=excluded.language').run(locale,'now');
   const screens=[],emit=async(markdown)=>screens.push(markdown);
   await handleStatisticsCallback(f.env,f.db,7,'mg:stats:home',emit);
   await handleStatisticsCallback(f.env,f.db,7,'mg:stats:sched:7:weekly',emit);
   for(const screen of screens){assert.ok(screen.includes('<br>\n'));assert.doesNotMatch(screen,/undefined/);if(locale!=='ru')assert.doesNotMatch(screen,/[А-Яа-яЁё]/);}
 }
 }finally{f.close();}
});

test('schedule sends once, handles 429 safely, suppresses ambiguous replay and respects revoked operators',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec("INSERT INTO manager_dm_status(operator_id,started_at,updated_at) VALUES(7,'2026-09-01','2026-09-01');INSERT INTO statistics_schedules(recipient_id,frequency,next_at,enabled,updated_at) VALUES(7,'daily','2026-10-03T07:00:00.000Z',1,'v1')");
 const calls=[];const wire=async(url,init)=>{calls.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:555}});};
 await runStatisticsSchedule(f.env,f.db,at,wire);await runStatisticsSchedule(f.env,f.db,at,wire);assert.equal(calls.length,1);assert.ok(calls[0].rich_message.markdown.includes('Support statistics'));
 f.db.sqlite.exec("UPDATE statistics_schedules SET last_period_end=NULL,next_at='2026-10-03T07:00:00.000Z'");
 await runStatisticsSchedule(f.env,f.db,at,async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:60}},{status:429}));assert.equal(f.db.sqlite.prepare('SELECT status FROM statistics_schedules').get().status,'idle');
 await runStatisticsSchedule(f.env,f.db,new Date(at.getTime()+61000),async()=>{throw new Error('network');});
 assert.equal(f.db.sqlite.prepare('SELECT status FROM statistics_schedules').get().status,'uncertain');
 await runStatisticsSchedule(f.env,f.db,new Date(at.getTime()+120000),wire);assert.equal(calls.length,1);
 f.db.sqlite.exec("UPDATE statistics_schedules SET recipient_id=8,last_period_end=NULL,next_at='2026-10-03T07:00:00.000Z',status='idle';UPDATE support_operators SET active=0 WHERE user_id=8");
 await runStatisticsSchedule(f.env,f.db,at,wire);assert.equal(f.db.sqlite.prepare('SELECT enabled FROM statistics_schedules').get().enabled,0);
 }finally{f.close();}
});
test('statistics forms accept dates without command; schedules retain scope and reject edits of other recipients by operators',async()=>{
 const f=fixture();try{
 const screens=[];const emit=async(markdown,rows)=>screens.push({markdown,rows});
 await handleStatisticsCallback(f.env,f.db,7,'mg:stats:periodset:custom',emit);
 assert.equal(await handleStatisticsText(f.env,f.db,7,'2026-09-01 2026-09-02',emit),true);
 assert.equal(f.db.sqlite.prepare('SELECT period FROM manager_statistics_preferences').get().period,'custom');
 await handleStatisticsCallback(f.env,f.db,7,'mg:stats:sched:7:daily',emit);await handleStatisticsCallback(f.env,f.db,7,'mg:stats:config:7:daily',emit);
 assert.equal(await handleStatisticsText(f.env,f.db,7,'10:30 America/New_York 5',emit),true);
 assert.equal(f.db.sqlite.prepare('SELECT timezone FROM statistics_schedules').get().timezone,'America/New_York');
 const count=screens.length;await handleStatisticsCallback(f.env,f.db,8,'mg:stats:toggle:7:daily:1',emit);assert.equal(screens.length,count);
 }finally{f.close();}
});
test('production Free budget fits one scheduled report and reset invalidates old statistics writes',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec("INSERT INTO manager_dm_status(operator_id,started_at,updated_at) VALUES(7,'2026-09-01','2026-09-01');INSERT INTO statistics_schedules(recipient_id,frequency,next_at,enabled,updated_at) VALUES(7,'daily','2026-10-03T07:00:00.000Z',1,'v1')");
 const budget=createRecoveryDatabase(f.db,'free');budget.storageGeneration=0;
 await runStatisticsSchedule({...f.env,SUPPORT_DB:budget},budget,at,async()=>Response.json({ok:true,result:{message_id:123}}));assert.ok(budget.used<=25);
 f.db.sqlite.exec('UPDATE storage_control SET generation=1');
 await budget.prepare("INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,occurred_at) VALUES('old','network','a','2026-10-03')").run();
 assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM statistics_facts WHERE event_key='old'").get().n,0);assert.equal(f.db.sqlite.prepare('SELECT enabled FROM statistics_schedules').get().enabled,0);
 }finally{f.close();}
});

test('topic and message facts and daily caps cannot overrun storage or block customer delivery',()=>{
 const f=fixture();try{
 f.db.sqlite.exec('UPDATE statistics_control SET capacity=3');
 f.source('a',1,11,'2026-10-02T10:00:00.000Z');f.source('a',2,12,'2026-10-02T10:01:00.000Z');
 f.db.sqlite.exec("INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,status,created_at) VALUES('a',1,-100,51,'open','2026-10-02T10:01:00.000Z')");
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM statistics_facts').get().n,3);
 assert.equal(f.db.sqlite.prepare('SELECT facts_count FROM statistics_control').get().facts_count,3);
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM message_delivery_attempts').get().n,2);
 f.confirmed(12,'2026-10-02T10:02:00.000Z');
 assert.ok(f.db.sqlite.prepare('SELECT completed_at FROM message_delivery_attempts WHERE source_message_id=12').get().completed_at);
 f.db.sqlite.exec("UPDATE statistics_control SET capacity=100,write_day=date('now'),daily_facts=1999");
 f.source('b',3,13,'2026-10-02T10:03:00.000Z');
 assert.equal(f.db.sqlite.prepare('SELECT daily_facts FROM statistics_control').get().daily_facts,2000);
 assert.equal(f.db.sqlite.prepare('SELECT facts_count FROM statistics_control').get().facts_count,4);
 f.source('b',4,14,'2026-10-02T10:04:00.000Z');f.confirmed(14,'2026-10-02T10:05:00.000Z');
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM message_delivery_attempts').get().n,4);
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM statistics_facts').get().n,4);
 }finally{f.close();}
});

test('cached reports reuse bounded reads, change language without recounting and enforce current access',async()=>{
 const f=fixture();try{
 f.source('a',1,11,'2026-10-02T10:00:00.000Z');
 const prefs={scope:'a',period:'yesterday',timezone:'Europe/Budapest'};
 await prepareStatisticsReport(f.env,f.db,7,prefs,null,at);
 const before=f.db.queries;
 const cached=await prepareStatisticsReport(f.env,f.db,7,prefs,null,new Date(at.getTime()+1000));
 assert.ok(f.db.queries-before<=4);assert.equal(cached.report.at,at.toISOString());
 await prepareStatisticsReport(f.env,f.db,8,prefs,null,at);
 f.db.sqlite.exec('UPDATE support_operators SET active=0 WHERE user_id=8');
 assert.equal(await prepareStatisticsReport(f.env,f.db,8,prefs,null,at),null);
 const fresh=await prepareStatisticsReport(f.env,f.db,7,prefs,null,new Date(at.getTime()+61000));
 assert.equal(fresh.report.at,new Date(at.getTime()+61000).toISOString());
 }finally{f.close();}
});

test('group report keeps protection facts and separates banned-user holds from delivery problems',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec("INSERT INTO support_groups(group_id,title,created_at,updated_at) VALUES(-100,'Team','now','now');INSERT INTO service_group_routes(bot_id,group_id,source,updated_at) VALUES('a',-100,'wizard','now');INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,status,created_at) VALUES('a',1,-100,51,'open','2026-10-02');INSERT INTO banned_users(bot_id,user_id,banned_at,banned_by) VALUES('a',1,'2026-10-02T10:00:00.000Z',7)");
 f.source('a',1,11,'2026-10-02T10:00:00.000Z');
 const access=await statisticsAccess(f.env,f.db,7,'g-100');
 const report=await collectStatistics(f.env,f.db,access,statisticsRange('yesterday','Europe/Budapest',at),at);
 assert.equal(report.totals.ban,1);assert.equal(report.current.pending,0);
 assert.ok(formatStatistics(report,'en').includes('Group: Team'));
 }finally{f.close();}
});

test('one operator schedule fits Free limits even with group filtering and service grants',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec("INSERT INTO support_groups(group_id,title,created_at,updated_at) VALUES(-100,'Team','now','now');INSERT INTO service_group_routes(bot_id,group_id,source,updated_at) VALUES('a',-100,'wizard','now');INSERT INTO service_responsibility(bot_id,primary_id,updated_at) VALUES('a',8,'now');INSERT INTO manager_dm_status(operator_id,started_at,updated_at) VALUES(8,'2026-09-01','2026-09-01');INSERT INTO statistics_schedules(recipient_id,frequency,scope,next_at,enabled,updated_at) VALUES(8,'daily','g-100','2026-10-03T07:00:00.000Z',1,'v1')");
 const budget=createRecoveryDatabase(f.db,'free');budget.storageGeneration=0;let sends=0;
 await runStatisticsSchedule({...f.env,SUPPORT_DB:budget},budget,at,async()=>{sends++;return Response.json({ok:true,result:{message_id:123}});});
 assert.equal(sends,1);assert.ok(budget.used<=25,`used ${budget.used} statements`);
 }finally{f.close();}
});

test('new contacts and actual topics are distinct; recreated topics and repeated status cycles keep separate facts',async()=>{
 const f=fixture();try{
 f.source('a',1,11,'2026-10-02T10:00:00.000Z');
 assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM statistics_facts WHERE kind='new'").get().n,0);
 f.db.sqlite.exec("INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,status,created_at) VALUES('a',1,-100,51,'open','2026-10-02T10:01:00.000Z');UPDATE conversations SET status='closed';UPDATE conversations SET status='open';UPDATE conversations SET status='closed';UPDATE conversations SET status='open'");
 assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM statistics_facts WHERE kind='close'").get().n,2);
 assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM statistics_facts WHERE kind='reopen'").get().n,2);
 f.source('a',1,21,'2026-10-02T10:10:00.000Z','support_to_user');f.confirmed(21,'2026-10-02T10:11:00.000Z');
 f.db.sqlite.exec("DELETE FROM conversations;DELETE FROM conversation_work;INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,status,created_at) VALUES('a',1,-100,52,'open','2026-10-02T11:00:00.000Z')");
 f.source('a',1,12,'2026-10-02T10:00:00.000Z');f.source('a',1,22,'2026-10-02T11:10:00.000Z','support_to_user');f.confirmed(22,'2026-10-02T11:11:00.000Z');
 assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM statistics_facts WHERE kind='new'").get().n,2);
 assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM statistics_facts WHERE kind='answer'").get().n,2);
 f.source('b',1,13,'2026-10-02T12:00:00.000Z');
 f.source('a',1,10,'2026-10-01T10:00:00.000Z');
 const range=statisticsRange('yesterday','Europe/Budapest',at);
 let report=await collectStatistics(f.env,f.db,await statisticsAccess(f.env,f.db,7),range,at);
 assert.equal(report.totals.newUsers,0);assert.equal(report.totals.returning,1);
 report=await collectStatistics(f.env,f.db,await statisticsAccess(f.env,f.db,7,'b'),range,at);
 assert.equal(report.totals.newUsers,1);assert.equal(report.totals.returning,0);
 }finally{f.close();}
});

test('assignment and responsibility changes invalidate cached data and increment access revision',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec("INSERT INTO manager_statistics_preferences(operator_id,updated_at) VALUES(8,'now');INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,status,created_at) VALUES('b',1,-100,51,'open','2026-10-02'),('b',2,-100,52,'open','2026-10-02')");
 f.source('b',1,11,'2026-10-02T10:00:00.000Z');f.source('b',2,12,'2026-10-02T10:01:00.000Z');
 f.db.sqlite.exec('UPDATE conversation_work SET assigned_to=8');
 const prefs={scope:'b',period:'yesterday',timezone:'Europe/Budapest'};
 const before=await prepareStatisticsReport(f.env,f.db,8,prefs,null,at);assert.equal(before.report.totals.users,2);
 f.db.sqlite.exec('UPDATE conversation_work SET assigned_to=NULL WHERE user_id=1');
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM statistics_report_cache WHERE operator_id=8').get().n,0);
 const after=await prepareStatisticsReport(f.env,f.db,8,prefs,null,new Date(at.getTime()+1000));
 assert.equal(after.report.totals.users,1);assert.ok(after.report.access.grantRevision>before.report.access.grantRevision);
 f.db.sqlite.exec("INSERT INTO service_responsibility(bot_id,primary_id,updated_at) VALUES('b',8,'now')");
 const full=await prepareStatisticsReport(f.env,f.db,8,prefs,null,at);assert.equal(full.report.totals.users,2);
 f.db.sqlite.exec("DELETE FROM service_responsibility WHERE bot_id='b'");
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM statistics_report_cache WHERE operator_id=8').get().n,0);
 }finally{f.close();}
});

test('pre-topic verification holds remain visible in group reports and merged uncertain queues keep original age',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec("INSERT INTO support_groups(group_id,title,created_at,updated_at) VALUES(-100,'Team','now','now');INSERT INTO service_group_routes(bot_id,group_id,source,updated_at) VALUES('b',-100,'wizard','now');INSERT INTO user_abuse_state(bot_id,user_id,verification_required,created_at,updated_at) VALUES('b',1,1,'now','now');INSERT INTO pending_messages(bot_id,user_id,update_id,source_chat_id,source_message_id,created_at,source_created_at) VALUES('b',1,1,1,11,'2026-10-03T10:00:00.000Z','2026-10-02T10:00:00.000Z')");
 let report=await collectStatistics(f.env,f.db,await statisticsAccess(f.env,f.db,7,'g-100'),statisticsRange('yesterday','UTC',at),at);
 assert.equal(report.current.verification,1);assert.equal(report.current.held,1);assert.equal(report.current.pending,0);
 f.db.sqlite.exec('UPDATE user_abuse_state SET verification_required=0');
 f.source('b',1,11,'2026-10-02T10:00:00.000Z');
 f.db.sqlite.exec("UPDATE pending_messages SET request_started_at='2026-10-03T10:05:00.000Z'");
 report=await collectStatistics(f.env,f.db,await statisticsAccess(f.env,f.db,7,'g-100'),statisticsRange('yesterday','UTC',at),at);
 assert.equal(report.current.uncertain,1);assert.equal(report.current.pending,0);assert.equal(report.current.oldestDelivery,26*3600);
 }finally{f.close();}
});

test('bounded history never invents returning users when their first contact is unavailable',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec('UPDATE statistics_control SET users_count=20000');f.source('b',1,11,'2026-10-02T10:00:00.000Z');
 const report=await collectStatistics(f.env,f.db,await statisticsAccess(f.env,f.db,7,'b'),statisticsRange('yesterday','UTC',at),at);
 assert.equal(report.totals.users,1);assert.equal(report.totals.returning,0);assert.equal(report.totals.newUsers,0);assert.equal(report.complete,false);
 const rendered=formatStatistics({...report,current:{...report.current,complete:false}},'en');assert.ok(!rendered.includes(STATISTICS_COPY.en.queueHealthy));
 }finally{f.close();}
});

test('confirmed Telegram rejection disables a schedule; re-enabling clears the error without ambiguous resends',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec("INSERT INTO manager_dm_status(operator_id,started_at,updated_at) VALUES(7,'2026-09-01','2026-09-01');INSERT INTO statistics_schedules(recipient_id,frequency,next_at,enabled,updated_at) VALUES(7,'daily','2026-10-03T07:00:00.000Z',1,'v1')");
 await runStatisticsSchedule(f.env,f.db,at,async()=>Response.json({ok:false,error_code:400,description:'Bad Request'},{status:400}));
 let row=f.db.sqlite.prepare('SELECT * FROM statistics_schedules').get();
 assert.equal(row.enabled,0);assert.equal(row.status,'idle');assert.equal(row.last_error,'telegram_400');assert.equal(row.last_period_end,null);
 await handleStatisticsCallback(f.env,f.db,7,'mg:stats:toggle:7:daily:1',async()=>{});
 row=f.db.sqlite.prepare('SELECT * FROM statistics_schedules').get();assert.equal(row.enabled,1);assert.equal(row.last_error,null);
 }finally{f.close();}
});

test('oversized manual report offers scope selection and reset cancels pending statistics input',async()=>{
 const f=fixture();try{
 const insert=f.db.sqlite.prepare("INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,status,created_at) VALUES('b',?,-100,?,'open','2026-10-02T10:00:00.000Z')");
 for(let i=1;i<=351;i++){insert.run(i,i+50);f.source('b',i,1000+i,'2026-10-02T10:01:00.000Z');}
 f.db.sqlite.exec('UPDATE conversation_work SET assigned_to=user_id+100');
 const screens=[];await handleStatisticsCallback(f.env,f.db,7,'mg:stats:report',async(markdown,rows)=>screens.push({markdown,rows}));
 assert.equal(screens.at(-1).markdown,STATISTICS_COPY.en.reportTooLarge);assert.ok(screens.at(-1).rows.flat().some(b=>b.callback_data==='mg:stats:scope'));
 await handleStatisticsCallback(f.env,f.db,7,'mg:stats:periodset:custom',async()=>{});
 f.db.sqlite.exec('UPDATE storage_control SET generation=generation+1');
 assert.equal(f.db.sqlite.prepare('SELECT input_kind FROM manager_statistics_preferences').get().input_kind,null);
 }finally{f.close();}
});

test('review migration upgrades an existing 0055 database without losing pending messages or schedule settings',()=>{
 const db=new DatabaseSync(':memory:'),dir=new URL('../migrations/',import.meta.url);
 try{
 for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')&&f<'0056').sort())db.exec(readFileSync(new URL(file,dir),'utf8'));
 db.exec("INSERT INTO pending_messages(bot_id,user_id,update_id,source_chat_id,source_message_id,created_at) VALUES('b',1,1,1,11,'2026-10-02T10:00:00.000Z');INSERT INTO statistics_schedules(recipient_id,frequency,timezone,next_at,enabled,updated_at) VALUES(8,'weekly','Asia/Shanghai','2026-10-05T01:00:00.000Z',1,'v1');INSERT INTO statistics_report_cache VALUES(8,'old','{}','2099-01-01')");
 const before=db.prepare('SELECT * FROM pending_messages').get(),first=db.prepare('SELECT * FROM statistics_users').get();
 db.exec(readFileSync(new URL('0056_statistics_review.sql',dir),'utf8'));
 assert.deepEqual(db.prepare('SELECT * FROM pending_messages').get(),before);
 assert.deepEqual(db.prepare('SELECT * FROM statistics_users').get(),first);
 const schedule=db.prepare('SELECT * FROM statistics_schedules').get();assert.equal(schedule.enabled,1);assert.equal(schedule.timezone,'Asia/Shanghai');assert.equal(schedule.next_at,'2026-10-05T01:00:00.000Z');
 assert.equal(db.prepare('SELECT access_revision FROM manager_statistics_preferences WHERE operator_id=8').get().access_revision,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM statistics_report_cache').get().n,0);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM statistics_facts WHERE kind='new'").get().n,0);
 }finally{db.close();}
});

test('nonexistent schedule times move forward and repeated times produce only one daily run',()=>{
 const row={frequency:'daily',timezone:'America/New_York',send_hour:2,send_minute:30};
 assert.equal(localInstant(2026,3,8,row.timezone,2,30).toISOString(),'2026-03-08T07:30:00.000Z');
 assert.equal(nextStatisticsSchedule(row,new Date('2026-03-08T06:45Z')),'2026-03-08T07:30:00.000Z');
 assert.equal(localInstant(2026,10,4,'Australia/Lord_Howe',2,15).toISOString(),'2026-10-03T15:45:00.000Z');
 const fold={...row,timezone:'Europe/Budapest'};
 assert.equal(nextStatisticsSchedule(fold,new Date('2026-10-25T00:00Z')),'2026-10-25T00:30:00.000Z');
 assert.equal(nextStatisticsSchedule(fold,new Date('2026-10-25T00:31Z')),'2026-10-26T01:30:00.000Z');
});

test('scheduled and test report buttons keep the schedule scope and completed period without changing manual preferences',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec("INSERT INTO manager_dm_status(operator_id,started_at,updated_at) VALUES(7,'2026-09-01','now');INSERT INTO statistics_schedules(recipient_id,frequency,scope,timezone,next_at,enabled,updated_at) VALUES(7,'weekly','b','Asia/Shanghai','2026-10-03T07:00:00.000Z',1,'v1');INSERT INTO manager_statistics_preferences(operator_id,scope,period,updated_at) VALUES(7,'a','now','v1')");
 let body;
 await runStatisticsSchedule(f.env,f.db,at,async(_url,init)=>{body=JSON.parse(init.body);return Response.json({ok:true,result:{message_id:123}});});
 assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data,'mg:stats:scheduleTest:7:weekly');
 assert.equal(body.reply_markup.inline_keyboard[1][0].callback_data,'mg:stats:sched:7:weekly');
 const screens=[];
 await handleStatisticsCallback(f.env,f.db,7,body.reply_markup.inline_keyboard[0][0].callback_data,async(markdown,rows)=>screens.push({markdown,rows}));
 assert.ok(screens.at(-1).markdown.includes('**Weekly**'));assert.ok(screens.at(-1).markdown.includes('Scope: **B**'));assert.ok(screens.at(-1).markdown.includes('Asia/Shanghai'));
 assert.equal(screens.at(-1).rows[0][0].callback_data,'mg:stats:scheduleTest:7:weekly');
 const prefs=f.db.sqlite.prepare('SELECT scope,period FROM manager_statistics_preferences WHERE operator_id=7').get();assert.equal(prefs.scope,'a');assert.equal(prefs.period,'now');
 }finally{f.close();}
});

test('a reset during resource collection cannot return the old snapshot or poison a fresh request with the old cache',async()=>{
 const f=fixture();try{
 f.source('a',1,11,'2026-10-02T10:00:00.000Z');
 const prefs={scope:'a',period:'yesterday',timezone:'Europe/Budapest'};
 const env={...f.env,STORAGE_MONITOR:{statistics:async()=>{f.db.sqlite.exec('UPDATE storage_control SET generation=generation+1');return null;}}};
 assert.equal(await prepareStatisticsReport(env,f.db,7,prefs,null,at),null);
 const fresh=await prepareStatisticsReport(f.env,f.db,7,prefs,null,at);
 assert.equal(fresh.report.control.generation,1);
 }finally{f.close();}
});

test('manual reports recheck assignment revocation after collection, including when the service list stays unchanged',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec("INSERT INTO manager_statistics_preferences(operator_id,updated_at) VALUES(8,'now');INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,status,created_at) VALUES('b',1,-100,51,'open','2026-10-02'),('b',2,-100,52,'open','2026-10-02')");
 f.source('b',1,11,'2026-10-02T10:00:00.000Z');f.source('b',2,12,'2026-10-02T10:01:00.000Z');f.db.sqlite.exec('UPDATE conversation_work SET assigned_to=8');
 const originalPrepare=f.db.prepare.bind(f.db);let changed=false;
 f.db.prepare=sql=>{
   const result=originalPrepare(sql);
   if(sql.includes('SELECT user_id,MIN(first_seen)')){
     const bind=result.bind;
     result.bind=(...args)=>{const statement=bind(...args),all=statement.all;statement.all=async()=>{
       const rows=await all();if(!changed){changed=true;f.db.sqlite.exec('UPDATE conversation_work SET assigned_to=NULL WHERE user_id=1');}return rows;
     };return statement;};
   }
   return result;
 };
 assert.equal(await prepareStatisticsReport(f.env,f.db,8,{scope:'b',period:'yesterday',timezone:'Europe/Budapest'},null,at),null);
 const fresh=await prepareStatisticsReport(f.env,f.db,8,{scope:'b',period:'yesterday',timezone:'Europe/Budapest'},null,at);
 assert.equal(fresh.report.totals.users,1);
 }finally{f.close();}
});

test('missing work state or wait start marks current indicators partial and never claims no overdue conversations',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec("INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,status,created_at) VALUES('b',1,-100,51,'open','2026-10-02'),('b',2,-100,52,'open','2026-10-02');INSERT INTO conversation_work(bot_id,user_id,state,updated_at) VALUES('b',2,'needs_reply','now')");
 const report=await collectStatistics(f.env,f.db,await statisticsAccess(f.env,f.db,7),statisticsRange('yesterday','Europe/Budapest',at),at);
 assert.equal(report.current.unknownWork,2);assert.equal(report.current.complete,false);assert.equal(report.complete,false);
 for(const locale of ['en','ru','es','zh'])assert.ok(!formatStatistics(report,locale).includes(STATISTICS_COPY[locale].queueHealthy));
 }finally{f.close();}
});

test('retaining facts by source age cannot hide a missing recent delivery or failure in a complete report',async()=>{
 const f=fixture();try{
 f.source('b',1,11,'2026-09-01T10:00:00.000Z');f.confirmed(11,'2026-10-02T10:00:00.000Z');
 f.source('b',2,12,'2026-09-01T11:00:00.000Z');
 f.db.sqlite.exec("UPDATE statistics_facts SET failure_at='2026-10-02T12:00:00.000Z',failure_code='confirmed' WHERE user_id=2");
 const range=statisticsRange('yesterday','UTC',at),access=await statisticsAccess(f.env,f.db,7,'b');
 let report=await collectStatistics(f.env,f.db,access,range,at);assert.equal(report.totals.deliveredIn,1);assert.equal(report.totals.problems,1);assert.equal(report.complete,true);
 f.db.sqlite.exec("DELETE FROM statistics_facts WHERE occurred_at<'2026-10-01'");
 report=await collectStatistics(f.env,f.db,access,range,at);assert.equal(report.complete,false);
 assert.equal(report.control.retained_after,'2026-10-02T12:00:00.000Z');assert.equal(report.totals.deliveredIn,0);
 }finally{f.close();}
});

test('a schedule claim atomically rejects assignment changes after its last access read',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec("INSERT INTO manager_statistics_preferences(operator_id,updated_at) VALUES(8,'now');INSERT INTO manager_dm_status(operator_id,started_at,updated_at) VALUES(8,'2026-09-01','now');INSERT INTO statistics_schedules(recipient_id,frequency,scope,next_at,enabled,updated_at) VALUES(8,'daily','b','2026-10-03T07:00:00.000Z',1,'v1');INSERT INTO conversations(bot_id,user_id,support_group_id,thread_id,status,created_at) VALUES('b',1,-100,51,'open','2026-10-02'),('b',2,-100,52,'open','2026-10-02')");
 f.source('b',1,11,'2026-10-02T10:00:00.000Z');f.source('b',2,12,'2026-10-02T10:01:00.000Z');f.db.sqlite.exec('UPDATE conversation_work SET assigned_to=8');
 const originalPrepare=f.db.prepare.bind(f.db);let changed=false,sends=0;
 f.db.prepare=sql=>{
   if(!changed&&sql.includes("SET status='sending',last_error=NULL,claim_token=")){
     changed=true;f.db.sqlite.exec('UPDATE conversation_work SET assigned_to=NULL WHERE user_id=1');
   }
   return originalPrepare(sql);
 };
 await runStatisticsSchedule(f.env,f.db,at,async()=>{sends++;return Response.json({ok:true,result:{message_id:123}});});
 assert.equal(changed,true);assert.equal(sends,0);assert.equal(f.db.sqlite.prepare('SELECT status FROM statistics_schedules').get().status,'idle');
 await runStatisticsSchedule(f.env,f.db,at,async()=>{sends++;return Response.json({ok:true,result:{message_id:123}});});
 assert.equal(sends,1);
 }finally{f.close();}
});

test('repeated enable and disable buttons are idempotent and cannot cancel a claimed send',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec("INSERT INTO manager_dm_status(operator_id,started_at,updated_at) VALUES(7,'now','now')");
 const screens=[],emit=async(markdown,rows)=>screens.push({markdown,rows});
 await handleStatisticsCallback(f.env,f.db,7,'mg:stats:sched:7:daily',emit);
 const enable=screens.at(-1).rows[0][0].callback_data;assert.equal(enable,'mg:stats:toggle:7:daily:1');
 await handleStatisticsCallback(f.env,f.db,7,enable,emit);
 const disable=screens.at(-1).rows[0][0].callback_data;assert.equal(disable,'mg:stats:toggle:7:daily:0');
 f.db.sqlite.exec("UPDATE statistics_schedules SET status='sending',claim_token='claim',last_period_end='2026-10-02T22:00:00.000Z'");
 const claimed=f.db.sqlite.prepare('SELECT * FROM statistics_schedules').get();
 await handleStatisticsCallback(f.env,f.db,7,enable,emit);
 assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM statistics_schedules').get(),claimed);
 await handleStatisticsCallback(f.env,f.db,7,'mg:stats:toggle:7:daily',emit);
 assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM statistics_schedules').get(),claimed,'legacy toggle only refreshes');
 await handleStatisticsCallback(f.env,f.db,7,disable,emit);
 const disabled=f.db.sqlite.prepare('SELECT * FROM statistics_schedules').get();assert.equal(disabled.enabled,0);assert.equal(disabled.claim_token,null);
 await handleStatisticsCallback(f.env,f.db,7,disable,emit);
 assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM statistics_schedules').get(),disabled);
 }finally{f.close();}
});

test('366 completed calendar days remain valid across DST; the 367th day is rejected',()=>{
 const dates=parseStatisticsDates('2024-10-26 2025-10-26','Europe/Budapest',at);
 assert.ok(dates);assert.equal(Date.parse(dates.custom_end)-Date.parse(dates.custom_start),366*86400000+3600000);
 assert.equal(statisticsRange('custom','Europe/Budapest',at,dates).end,dates.custom_end);
 assert.equal(parseStatisticsDates('2024-10-25 2025-10-26','Europe/Budapest',at),null);
 assert.throws(()=>statisticsRange('custom','UTC',at,{custom_start:'wrong',custom_end:'wrong'}),/Invalid statistics range/);
});

test('response deadlines compare millisecond precision without SQLite floating-point lateness',async()=>{
 const f=fixture();try{
 for(const [user,offset] of [[1,'00.000'],[2,'00.001'],[3,'59.999']]){
   f.source('b',user,100+user,'2026-10-02T10:00:00.000Z');
   f.source('b',user,200+user,'2026-10-02T10:20:00.000Z','support_to_user');
   f.confirmed(200+user,`2026-10-02T10:${user===3?'29':'30'}:${offset}Z`);
 }
 const range=statisticsRange('yesterday','UTC',at),facts=f.db.sqlite.prepare("SELECT * FROM statistics_facts WHERE kind='answer' ORDER BY user_id").all();
 assert.equal(facts[0].seconds,1800);assert.equal(facts[1].seconds,1800.001);assert.equal(facts[2].seconds,1799.999);
 const totals=summarizeStatistics(facts,range);assert.equal(totals.late,1);assert.equal(totals.within,100*2/3);
 const legacy=summarizeStatistics([{...facts[0],seconds:1800.000013411045}],range);assert.equal(legacy.late,0);
 }finally{f.close();}
});

test('delivery of an obsolete answer does not finish the cycle for a newer unanswered input',()=>{
 const f=fixture();try{
 f.source('b',1,11,'2026-10-02T10:00:00.000Z');
 f.source('b',1,21,'2026-10-02T10:10:00.000Z','support_to_user');
 f.source('b',1,12,'2026-10-02T10:15:00.000Z');
 f.confirmed(21,'2026-10-02T10:20:00.000Z');
 assert.equal(f.db.sqlite.prepare('SELECT state FROM conversation_work').get().state,'needs_reply');
 assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM statistics_facts WHERE kind='answer'").get().n,0);
 f.source('b',1,22,'2026-10-02T10:30:00.000Z','support_to_user');f.confirmed(22,'2026-10-02T10:31:00.000Z');
 const answer=f.db.sqlite.prepare("SELECT * FROM statistics_facts WHERE kind='answer'").get();assert.equal(answer.seconds,31*60);assert.equal(answer.first_reply,1);
 assert.equal(f.db.sqlite.prepare('SELECT state FROM conversation_work').get().state,'waiting');
 f.confirmed(22,'2026-10-02T10:32:00.000Z');assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM statistics_facts WHERE kind='answer'").get().n,1);
 f.source('b',1,13,'2026-10-02T11:00:00.000Z');f.source('b',1,23,'2026-10-02T11:10:00.000Z','support_to_user');f.source('b',1,14,'2026-10-02T11:15:00.000Z');f.confirmed(23,'2026-10-02T11:20:00.000Z');
 f.source('b',1,24,'2026-10-02T11:30:00.000Z','support_to_user');f.confirmed(24,'2026-10-02T11:31:00.000Z');
 assert.equal(f.db.sqlite.prepare("SELECT first_reply FROM statistics_facts WHERE kind='answer' ORDER BY occurred_at DESC LIMIT 1").get().first_reply,0);
 }finally{f.close();}
});

test('service scope cannot collide with the all-services sentinel or a group identifier',async()=>{
 const f=fixture();try{
 const registry=JSON.parse(f.env.BOT_REGISTRY);registry.push({...registry[0],id:'g-100',displayName:'Group-like service',tokenBinding:'TOKEN_G',webhookSecretBinding:'SECRET_G'});f.env.BOT_REGISTRY=JSON.stringify(registry);
 f.source('b',1,11,'2026-10-01T10:00:00.000Z');f.source('a',1,12,'2026-10-02T10:00:00.000Z');f.source('g-100',2,13,'2026-10-02T10:01:00.000Z');
 for(const id of ['a','g-100']){
   const screens=[];await handleStatisticsCallback(f.env,f.db,7,'mg:stats:scopeset:'+managementBotKey(parseBotRegistry(f.env.BOT_REGISTRY),id),async(markdown,rows)=>screens.push({markdown,rows}));
   assert.equal(f.db.sqlite.prepare('SELECT scope FROM manager_statistics_preferences').get().scope,'s:'+id);
   const access=await statisticsAccess(f.env,f.db,7,'s:'+id);assert.deepEqual(access.botIds,[id]);assert.equal(access.groupId,null);
   const report=await collectStatistics(f.env,f.db,access,statisticsRange('yesterday','UTC',at),at);
   assert.equal(report.totals.users,1);assert.equal(report.totals.newUsers,1);
   assert.ok(screens.at(-1).markdown.includes(richEscape(registry.find(s=>s.id===id).displayName)));
 }
 assert.deepEqual((await statisticsAccess(f.env,f.db,7,'b')).botIds,['b'],'previous ordinary service scopes still work');
 assert.equal(await statisticsAccess(f.env,f.db,8,'s:b'),null,'qualification does not grant operator access');
 }finally{f.close();}
});

test('unstarted or unreachable recipients have their own localized explanation, distinct from missing service access',async()=>{
 for(const locale of ['en','ru','es','zh']){
 const f=fixture();try{
 f.db.sqlite.prepare("INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,?,'now')").run(locale);
 const screens=[],emit=async(markdown,rows)=>screens.push({markdown,rows});
 await handleStatisticsCallback(f.env,f.db,7,'mg:stats:toggle:8:daily:1',emit);
 assert.equal(screens.at(-1).markdown,STATISTICS_COPY[locale].recipientUnavailable);assert.equal(f.db.sqlite.prepare('SELECT enabled FROM statistics_schedules').get().enabled,0);
 await handleStatisticsCallback(f.env,f.db,7,'mg:stats:scheduleTest:8:daily',emit);
 assert.equal(screens.at(-1).markdown,STATISTICS_COPY[locale].recipientUnavailable);
 f.db.sqlite.exec("UPDATE statistics_schedules SET enabled=1,next_at='2026-10-03T07:00:00.000Z'");
 await runStatisticsSchedule(f.env,f.db,at,async()=>{throw new Error('must not send');});
 assert.equal(f.db.sqlite.prepare('SELECT last_error FROM statistics_schedules').get().last_error,'recipient_unavailable');
 await handleStatisticsCallback(f.env,f.db,7,'mg:stats:sched:8:daily',emit);
 assert.ok(screens.at(-1).markdown.includes(STATISTICS_COPY[locale].recipientUnavailable));
 f.db.sqlite.exec("UPDATE statistics_schedules SET last_error='no_access'");
 await handleStatisticsCallback(f.env,f.db,7,'mg:stats:sched:8:daily',emit);
 assert.ok(screens.at(-1).markdown.includes(STATISTICS_COPY[locale].scheduleNoAccess));
 }finally{f.close();}
 }
});

test('schedule forms detect same-timestamp edits and cannot overwrite a newer form or another saved configuration',async()=>{
 const f=fixture();try{
 const screens=[],emit=async(markdown,rows)=>screens.push({markdown,rows});
 await handleStatisticsCallback(f.env,f.db,7,'mg:stats:config:7:daily',emit);
 const prefs=f.db.sqlite.prepare('SELECT * FROM manager_statistics_preferences').get(),before=f.db.sqlite.prepare('SELECT * FROM statistics_schedules').get();
 f.db.sqlite.exec("UPDATE statistics_schedules SET send_hour=12");
 assert.equal(f.db.sqlite.prepare('SELECT updated_at FROM statistics_schedules').get().updated_at,before.updated_at);
 assert.equal(await handleStatisticsText(f.env,f.db,7,'11:30 Asia/Shanghai 2',emit),true);
 assert.equal(f.db.sqlite.prepare('SELECT send_hour FROM statistics_schedules').get().send_hour,12);
 assert.equal(screens.at(-1).markdown,STATISTICS_COPY.en.configChanged);
 await handleStatisticsCallback(f.env,f.db,7,'mg:stats:config:7:daily',emit);
 const original=f.db.prepare.bind(f.db);let replaced=false;
 f.db.prepare=sql=>{
   if(!replaced&&sql.startsWith('UPDATE statistics_schedules SET timezone=')){
     replaced=true;f.db.sqlite.prepare('UPDATE manager_statistics_preferences SET input_kind=?').run(prefs.input_kind);
   }
   return original(sql);
 };
 await handleStatisticsText(f.env,f.db,7,'11:30 Asia/Shanghai 2',emit);
 assert.equal(replaced,true);assert.equal(f.db.sqlite.prepare('SELECT send_hour FROM statistics_schedules').get().send_hour,12);
 assert.equal(f.db.sqlite.prepare('SELECT input_kind FROM manager_statistics_preferences').get().input_kind,prefs.input_kind,'a different form is preserved');
 }finally{f.close();}
});

test('schedule version prevents a stale Cron claim even when a setting changes with identical timestamp and due time',async()=>{
 const f=fixture();try{
 f.db.sqlite.exec("INSERT INTO manager_dm_status(operator_id,started_at,updated_at) VALUES(7,'now','now');INSERT INTO statistics_schedules(recipient_id,frequency,next_at,enabled,updated_at) VALUES(7,'daily','2026-10-03T07:00:00.000Z',1,'v1')");
 const original=f.db.prepare.bind(f.db);let changed=false,sends=0;
 f.db.prepare=sql=>{
   if(!changed&&sql.includes("SET status='sending',last_error=NULL,claim_token=")){
     changed=true;f.db.sqlite.exec("UPDATE statistics_schedules SET timezone='Asia/Shanghai'");
   }
   return original(sql);
 };
 await runStatisticsSchedule(f.env,f.db,at,async()=>{sends++;return Response.json({ok:true,result:{message_id:123}});});
 assert.equal(changed,true);assert.equal(sends,0);assert.equal(f.db.sqlite.prepare('SELECT revision FROM statistics_schedules').get().revision,1);
 await runStatisticsSchedule(f.env,f.db,at,async()=>{sends++;return Response.json({ok:true,result:{message_id:123}});});
 assert.equal(sends,1);
 }finally{f.close();}
});
