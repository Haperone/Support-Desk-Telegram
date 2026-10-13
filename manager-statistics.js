import { statisticsAccess,statisticsRange,collectStatistics,parseStatisticsDates,nextStatisticsSchedule,scheduledStatisticsRange,localParts } from './support-statistics.js';
import { statisticsCopy,formatStatistics,richEscape } from './statistics-copy.js';
import { getManagerLanguage } from './manager-language.js';
import { managementBotKey,managementBotFromKey,parseBotRegistry,parseAdminIds } from './worker.js';
import { requestTelegram } from './telegram-response.js';
import { recordStatisticsTelegramFailure } from './statistics-events.js';

export class StatisticsReportTooLarge extends Error {}

const frequencies=['daily','weekly','monthly'];
const primary=env=>Number([...parseAdminIds(env.ADMIN_IDS)][0]);
const button=(text,callback_data,style)=>({text,callback_data,...(style?{style}:{})});
const route=(...parts)=>['mg','stats',...parts].join(':');
const read=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const run=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
async function scopeLabel(env,db,scope,c){
 if(scope==='a')return c.all;
 if(/^g-\d+$/.test(scope)){const group=await read(db,'SELECT title FROM support_groups WHERE group_id=?',Number(scope.slice(1)));return c.group+': '+(group?.title||scope.slice(1));}
 return parseBotRegistry(env.BOT_REGISTRY).find(s=>s.id===(scope.startsWith('s:')?scope.slice(2):scope))?.displayName||c.noAccess;
}
export async function statisticsPreferences(db,actor) {
 await run(db,`INSERT OR IGNORE INTO manager_statistics_preferences(operator_id,updated_at) VALUES(?,?)`,actor,new Date().toISOString());
 return read(db,'SELECT * FROM manager_statistics_preferences WHERE operator_id=?',actor);
}
async function authorizedRecipient(env,db,actor,id) {
 if(actor!==primary(env)&&id!==actor)return false;
 return id===primary(env)||Boolean(await read(db,'SELECT 1 FROM support_operators WHERE user_id=? AND active=1',id));
}
function navigation(c,parent=route('home')) {return [[{text:'────────',disabled:{}}],[button(c.back,parent,'primary'),button(c.menu,'mg:home','primary')]];}
export function statisticsReportKeyboard(c){return [[button(c.refresh,route('report'))],[button(c.choose,route('period')),button(c.scopeButton,route('scope'))],[button(c.settings,route('recipients'))],...navigation(c)];}
function scheduledReportKeyboard(c,recipient,frequency){return [[button(c.refresh,route('scheduleTest',recipient,frequency))],[button(c.settings,route('sched',recipient,frequency))],...navigation(c)];}
async function resources(env,range){
 if(!env.STORAGE_MONITOR?.statistics)return null;
 let timer;
 try{return await Promise.race([env.STORAGE_MONITOR.statistics(range),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Statistics resource timeout')),10000);})]);}
 catch{return null;}finally{clearTimeout(timer);}
}
export async function prepareStatisticsReport(env,db,actor,prefs,range=null,at=new Date()) {
 const access=await statisticsAccess(env,db,actor,prefs.scope);
 if(!access) return null;
 range ||= statisticsRange(prefs.period,prefs.timezone,at,prefs);
 const fingerprint=JSON.stringify([access.scope,access.botIds,access.full,access.grantRevision,range.period,range.timeZone,range.period==='now'?Math.floor(Date.parse(range.start)/60000):range.start,Math.floor(Date.parse(range.end)/60000)]);
 const cache=await read(db,"SELECT c.payload,s.generation FROM statistics_report_cache c JOIN storage_control s ON s.id=1 AND s.mode='normal' WHERE c.operator_id=? AND c.fingerprint=? AND c.expires_at>?",actor,fingerprint,at.toISOString());
 let report;
 if(cache)try{report=JSON.parse(cache.payload);if(report?.control?.generation!==cache.generation)report=null;}catch{/* A damaged cache is rebuilt. */}
 if(!report){
   report=await collectStatistics(env,db,access,range,at);
   if(access.primary)report.resources=await resources(env,range);
   await run(db,`INSERT INTO statistics_report_cache(operator_id,fingerprint,payload,expires_at) VALUES(?,?,?,?)
     ON CONFLICT(operator_id) DO UPDATE SET fingerprint=excluded.fingerprint,payload=excluded.payload,expires_at=excluded.expires_at`,actor,fingerprint,JSON.stringify(report),new Date(at.getTime()+60000).toISOString());
 }
 const locale=await getManagerLanguage(db,actor);
 // Collection and the resource RPC yield to other requests. Recheck the
 // captured generation and grants for manual, test and scheduled reports alike.
 const current=await read(db,`SELECT 1 FROM storage_control s LEFT JOIN manager_statistics_preferences p ON p.operator_id=?
   WHERE s.id=1 AND s.mode='normal' AND s.generation=? AND (?=1 OR
     (COALESCE(p.access_revision,0)=? AND EXISTS(SELECT 1 FROM support_operators WHERE user_id=? AND active=1)))`,
   actor,report.control.generation,access.primary?1:0,access.grantRevision,actor);
 if(!current)return null;
 const markdown=formatStatistics(report,locale);
 if(markdown.length>32768||report.operators.length+report.services.length>350)throw new StatisticsReportTooLarge(statisticsCopy(locale).reportTooLarge);
 return {report,locale,markdown,rows:statisticsReportKeyboard(statisticsCopy(locale))};
}
async function scheduleRow(db,recipient,frequency,prefs) {
 const at=new Date();
 await run(db,'INSERT OR IGNORE INTO manager_statistics_preferences(operator_id,updated_at) VALUES(?,?)',recipient,at.toISOString());
 const defaults={frequency,timezone:prefs.timezone,send_hour:9,send_minute:0,weekday:1};
 await run(db,`INSERT OR IGNORE INTO statistics_schedules(recipient_id,frequency,scope,timezone,next_at,updated_at)
   VALUES(?,?,?,?,?,?)`,recipient,frequency,prefs.scope,prefs.timezone,nextStatisticsSchedule(defaults,at),at.toISOString());
 return read(db,'SELECT * FROM statistics_schedules WHERE recipient_id=? AND frequency=?',recipient,frequency);
}
export async function handleStatisticsCallback(env,db,actor,data,emit) {
 const [,,action='home',key,detail,extra]=data.split(':');
 const locale=await getManagerLanguage(db,actor),c=statisticsCopy(locale),prefs=await statisticsPreferences(db,actor);
 if(action==='home')return emit(`# 📊 ${c.title}\n\n${c.scope}: **${richEscape(await scopeLabel(env,db,prefs.scope,c))}**<br>\n${c.period}: **${c[prefs.period]||c.custom}**<br>\n${c.zone}: ${richEscape(prefs.timezone)}`,
   [[button(c.report,route('report'))],[button(c.choose,route('period'))],[button(c.scopeButton,route('scope'))],[button(c.settings,route('recipients'))],...navigation(c,'mg:home')]);
 if(action==='report'||action==='test') {
   let result;
   try{result=await prepareStatisticsReport(env,db,actor,prefs);}catch(error){
     if(!(error instanceof StatisticsReportTooLarge))throw error;
     return emit(c.reportTooLarge,[[button(c.scopeButton,route('scope'))],...navigation(c)]);
   }
   return result?emit(result.markdown,result.rows):emit(c.noAccess,navigation(c));
 }
 if(action==='period')return emit(`# ${c.choose}`,[...['now','today','yesterday','week','month','custom'].map(p=>[button(c[p],route('periodset',p))]),...navigation(c)]);
 if(action==='periodset'){
   if(!['now','today','yesterday','week','month','custom'].includes(key))return;
   if(key==='custom'){
     await run(db,"UPDATE manager_statistics_preferences SET input_kind='dates',expires_at=?,updated_at=? WHERE operator_id=?",new Date(Date.now()+600000).toISOString(),new Date().toISOString(),actor);
     return emit(c.datePrompt,navigation(c,route('period')));
   }
   await run(db,'UPDATE manager_statistics_preferences SET period=?,input_kind=NULL,updated_at=? WHERE operator_id=?',key,new Date().toISOString(),actor);
   return handleStatisticsCallback(env,db,actor,route('report'),emit);
 }
 if(action==='scope') {
   const recipient=Number(detail),forSchedule=frequencies.includes(extra)&&Number.isSafeInteger(recipient);
   if(forSchedule&&!await authorizedRecipient(env,db,actor,recipient))return;
   const access=await statisticsAccess(env,db,actor);
   if(!access)return;
   const registry=parseBotRegistry(env.BOT_REGISTRY),groups=(await db.prepare(`SELECT DISTINCT g.group_id,g.title FROM support_groups g
      JOIN service_group_routes r USING(group_id) WHERE r.bot_id IN (SELECT value FROM json_each(?)) ORDER BY g.group_id LIMIT 100`).bind(JSON.stringify(access.allowed.map(s=>s.id))).all()).results||[];
   const tail=forSchedule?[recipient,extra]:[];
   const page=Math.max(0,Number(key)||0),items=[button(c.all,route('scopeset','a',...tail)),...access.allowed.map(s=>button(s.displayName,route('scopeset',managementBotKey(registry,s.id),...tail))),...groups.map(g=>button(`${c.group}: ${g.title||g.group_id}`,route('scopeset','g'+g.group_id,...tail)))];
   return emit(`# ${c.scopeButton}`,[...items.slice(page*8,page*8+8).map(b=>[b]),...(page?[[button('←',route('scope',page-1,...tail))]]:[]),...(items.length>(page+1)*8?[[button('→',route('scope',page+1,...tail))]]:[]),...navigation(c,forSchedule?route('sched',recipient,extra):route('home'))]);
 }
 if(action==='scopeset'){
   const service=key==='a'||/^g-\d+$/.test(key)?null:managementBotFromKey(parseBotRegistry(env.BOT_REGISTRY),key);
   const scope=service?'s:'+service.id:key==='a'||/^g-\d+$/.test(key)?key:null;
   if(!scope||!await statisticsAccess(env,db,actor,scope))return emit(c.noAccess,navigation(c));
   if(frequencies.includes(extra)){
     const recipient=Number(detail);
     if(!Number.isSafeInteger(recipient)||!await authorizedRecipient(env,db,actor,recipient)||!await statisticsAccess(env,db,recipient,scope))return emit(c.noAccess,navigation(c));
     const row=await scheduleRow(db,recipient,extra,prefs);
     await run(db,"UPDATE statistics_schedules SET scope=?,claim_token=NULL,status='idle',last_error=NULL,next_at=?,updated_at=? WHERE recipient_id=? AND frequency=?",scope,nextStatisticsSchedule(row),new Date().toISOString(),recipient,extra);
     return handleStatisticsCallback(env,db,actor,route('sched',recipient,extra),emit);
   }
   await run(db,'UPDATE manager_statistics_preferences SET scope=?,updated_at=? WHERE operator_id=?',scope,new Date().toISOString(),actor);
   return handleStatisticsCallback(env,db,actor,route('home'),emit);
 }
 if(action==='recipients'){
   if(actor!==primary(env))return handleStatisticsCallback(env,db,actor,route('recipient',actor),emit);
   const page=Math.max(0,Number(key)||0),operators=(await db.prepare('SELECT user_id,first_name,username FROM support_operators WHERE active=1 ORDER BY user_id LIMIT 9 OFFSET ?').bind(page*8).all()).results||[];
   return emit(`# 👤 ${c.recipient}`,[...[button(c.self,route('recipient',actor)),...operators.slice(0,8).map(o=>button(o.first_name||o.username||String(o.user_id),route('recipient',o.user_id)))].map(b=>[b]),...(page?[[button('←',route('recipients',page-1))]]:[]),...(operators.length>8?[[button('→',route('recipients',page+1))]]:[]),...navigation(c)]);
 }
 const recipient=Number(key);
 if(!Number.isSafeInteger(recipient)||recipient<=0||!await authorizedRecipient(env,db,actor,recipient))return;
 if(action==='recipient') {
   const rows=(await db.prepare('SELECT * FROM statistics_schedules WHERE recipient_id=?').bind(recipient).all()).results||[];
   return emit(`# ⚙️ ${c.schedule}\n\n${c.recipient}: ${recipient}\n\n${c.scheduleNote}`,[...frequencies.map(f=>[button(`${c[f]} · ${rows.find(r=>r.frequency===f)?.enabled?c.enabled:c.disabled}`,route('sched',recipient,f))]),...navigation(c,route('recipients'))]);
 }
 if(!frequencies.includes(detail))return;
 if(!['sched','toggle','config','scheduleScope','scheduleTest'].includes(action))return;
 const row=await scheduleRow(db,recipient,detail,prefs);
 if(action==='toggle') {
   // Old toggle buttons only refresh the card. New buttons state their desired
   // value, so a second click cannot reverse the action or cancel an active send.
   if(['0','1'].includes(extra)&&row.enabled!==Number(extra)) {
     const desired=Number(extra);
     if(desired){
       const access=await statisticsAccess(env,db,recipient,row.scope);
       const dm=await read(db,'SELECT started_at,unreachable_at FROM manager_dm_status WHERE operator_id=?',recipient);
       if(!access)return emit(c.noAccess,navigation(c,route('recipient',recipient)));
       if(!dm?.started_at||dm.unreachable_at)return emit(c.recipientUnavailable,navigation(c,route('recipient',recipient)));
     }
     await run(db,`UPDATE statistics_schedules SET enabled=?,next_at=?,status='idle',last_error=NULL,claim_token=NULL,updated_at=?
       WHERE recipient_id=? AND frequency=? AND enabled<>? AND revision=?`,desired,nextStatisticsSchedule(row),new Date().toISOString(),recipient,detail,desired,row.revision);
   }
 }
 if(action==='config'){
   await run(db,'UPDATE manager_statistics_preferences SET input_kind=?,input_revision=?,expires_at=?,updated_at=? WHERE operator_id=?',`schedule:${recipient}:${detail}:${crypto.randomUUID()}`,row.revision,new Date(Date.now()+600000).toISOString(),new Date().toISOString(),actor);
   return emit(c.configPrompt,navigation(c,route('sched',recipient,detail)));
 }
 if(action==='scheduleScope'){
   if(!await statisticsAccess(env,db,recipient,prefs.scope))return emit(c.noAccess,navigation(c,route('sched',recipient,detail)));
   await run(db,"UPDATE statistics_schedules SET scope=?,claim_token=NULL,status='idle',last_error=NULL,next_at=?,updated_at=? WHERE recipient_id=? AND frequency=?",prefs.scope,nextStatisticsSchedule(row),new Date().toISOString(),recipient,detail);
 }
 if(action==='scheduleTest'){
   const targetPrefs={scope:row.scope,timezone:row.timezone,period:'yesterday'};
   if(recipient!==actor){
     const dm=await read(db,'SELECT started_at,unreachable_at FROM manager_dm_status WHERE operator_id=?',recipient);
     if(!dm?.started_at||dm.unreachable_at)return emit(c.recipientUnavailable,navigation(c));
   }
   let result;
   try{result=await prepareStatisticsReport(env,db,recipient,targetPrefs,scheduledStatisticsRange(row));}catch(error){
     if(!(error instanceof StatisticsReportTooLarge))throw error;
     return emit(c.reportTooLarge,[[button(c.scopeButton,route('scope',0,recipient,detail))],...navigation(c,route('sched',recipient,detail))]);
   }
   if(!result)return emit(c.noAccess,navigation(c));
   result.rows=scheduledReportKeyboard(statisticsCopy(result.locale),recipient,detail);
   if(recipient!==actor){
     await emit(result.markdown,result.rows,recipient);
     return emit(c.saved,navigation(c,route('sched',recipient,detail)));
   }
   return emit(result.markdown,result.rows);
 }
 const updated=await read(db,'SELECT * FROM statistics_schedules WHERE recipient_id=? AND frequency=?',recipient,detail);
 const scheduleError=updated.last_error==='no_access'?c.scheduleNoAccess:updated.last_error==='recipient_unavailable'?c.recipientUnavailable:updated.last_error?c.scheduleFailed:'';
 const weekday=new Intl.DateTimeFormat(({en:'en-GB',ru:'ru-RU',es:'es-ES',zh:'zh-CN'})[locale],{weekday:'long',timeZone:'UTC'}).format(new Date(Date.UTC(2026,9,4+updated.weekday)));
 return emit(`# ⚙️ ${c[detail]}\n\n${c.recipient}: ${recipient}<br>\n${updated.enabled?c.enabled:c.disabled}<br>\n${c.scope}: ${richEscape(await scopeLabel(env,db,updated.scope,c))}<br>\n${String(updated.send_hour).padStart(2,'0')}:${String(updated.send_minute).padStart(2,'0')}<br>\n${richEscape(updated.timezone)}<br>\n${detail==='weekly'?weekday:detail==='monthly'?c.monthDay:''}<br>\n${updated.status==='uncertain'?c.blocked:scheduleError}`,
  [[button(updated.enabled?c.disable:c.enable,route('toggle',recipient,detail,updated.enabled?'0':'1'),updated.enabled?'danger':'success')],[button(c.configure,route('config',recipient,detail))],
    [button(c.scopeButton,route('scope',0,recipient,detail))],[button(c.test,route('scheduleTest',recipient,detail),'success')],...navigation(c,route('recipient',recipient))]);
}
export async function handleStatisticsText(env,db,actor,text,emit) {
 const prefs=await read(db,'SELECT * FROM manager_statistics_preferences WHERE operator_id=? AND input_kind IS NOT NULL AND expires_at>?',actor,new Date().toISOString());
 if(!prefs)return false;
 const locale=await getManagerLanguage(db,actor),c=statisticsCopy(locale);
 if(prefs.input_kind==='dates') {
   const dates=parseStatisticsDates(text,prefs.timezone);
   if(!dates){await emit(c.invalid+'\n\n'+c.datePrompt,navigation(c,route('period')));return true;}
   await run(db,"UPDATE manager_statistics_preferences SET period='custom',custom_start=?,custom_end=?,input_kind=NULL,updated_at=? WHERE operator_id=?",dates.custom_start,dates.custom_end,new Date().toISOString(),actor);
   await handleStatisticsCallback(env,db,actor,route('report'),emit);return true;
 }
 const [,rawId,frequency]=prefs.input_kind.split(':'),recipient=Number(rawId);
 if(!frequencies.includes(frequency)||!await authorizedRecipient(env,db,actor,recipient))return false;
 const match=/^(\d{2}):(\d{2})\s+([A-Za-z0-9_+\-/]+)\s+([0-6])$/.exec(text.trim());
 let valid=Boolean(match)&&Number(match[1])<24&&Number(match[2])<60;
 try{if(valid)localParts(new Date(),match[3]);}catch{valid=false;}
 if(!valid){await emit(c.invalid+'\n\n'+c.configPrompt,navigation(c,route('sched',recipient,frequency)));return true;}
 const at=new Date(),values={frequency,timezone:match[3],send_hour:Number(match[1]),send_minute:Number(match[2]),weekday:Number(match[4])};
 const saved=await read(db,`UPDATE statistics_schedules SET timezone=?,send_hour=?,send_minute=?,weekday=?,next_at=?,status='idle',last_error=NULL,claim_token=NULL,updated_at=?
   WHERE recipient_id=? AND frequency=? AND revision=? AND EXISTS(SELECT 1 FROM manager_statistics_preferences
     WHERE operator_id=? AND input_kind=? AND expires_at>?) RETURNING recipient_id`,values.timezone,values.send_hour,values.send_minute,values.weekday,nextStatisticsSchedule(values,at),at.toISOString(),recipient,frequency,prefs.input_revision,actor,prefs.input_kind,at.toISOString());
 if(!saved){
   await run(db,'UPDATE manager_statistics_preferences SET input_kind=NULL WHERE operator_id=? AND input_kind=?',actor,prefs.input_kind);
   await emit(c.configChanged,navigation(c,route('sched',recipient,frequency)));return true;
 }
 await run(db,'UPDATE manager_statistics_preferences SET timezone=?,input_kind=NULL,updated_at=? WHERE operator_id=? AND input_kind=?',values.timezone,at.toISOString(),actor,prefs.input_kind);
 await handleStatisticsCallback(env,db,actor,route('sched',recipient,frequency),emit);return true;
}
export async function runStatisticsSchedule(env,db,at=new Date(),fetchImpl=fetch) {
 if(!env.MANAGER_BOT_TOKEN)return;
 db.recoveryCheckpoint?.(25);
 // An interrupted send is ambiguous. Never resend the same period automatically.
 await run(db,"UPDATE statistics_schedules SET status='uncertain',last_error='interrupted' WHERE enabled=1 AND status='sending' AND claimed_at<?",new Date(at.getTime()-120000).toISOString());
 const row=await read(db,"SELECT * FROM statistics_schedules WHERE enabled=1 AND next_at<=? AND status<>'sending' ORDER BY next_at,recipient_id LIMIT 1",at.toISOString());
 if(!row)return;
 const access=await statisticsAccess(env,db,row.recipient_id,row.scope);
 const dm=await read(db,'SELECT started_at,unreachable_at FROM manager_dm_status WHERE operator_id=?',row.recipient_id);
 if(!access||!dm?.started_at||dm.unreachable_at){await run(db,'UPDATE statistics_schedules SET enabled=0,last_error=? WHERE recipient_id=? AND frequency=? AND next_at=? AND revision=?',access?'recipient_unavailable':'no_access',row.recipient_id,row.frequency,row.next_at,row.revision);return;}
 const range=scheduledStatisticsRange(row,at),next=nextStatisticsSchedule(row,at),token=crypto.randomUUID();
 if(row.last_period_end===range.end){await run(db,"UPDATE statistics_schedules SET next_at=? WHERE recipient_id=? AND frequency=? AND next_at=? AND revision=? AND status<>'sending'",next,row.recipient_id,row.frequency,row.next_at,row.revision);return;}
 // Compute before claiming: budget or data collection failures cannot strand a send.
 let result;
 try {result=await prepareStatisticsReport(env,db,row.recipient_id,{scope:row.scope,timezone:row.timezone},range,at);}
 catch(error){
   if(error instanceof StatisticsReportTooLarge){
     await run(db,'UPDATE statistics_schedules SET enabled=0,last_error=? WHERE recipient_id=? AND frequency=? AND next_at=? AND revision=?', 'report_too_large',row.recipient_id,row.frequency,row.next_at,row.revision);
   }
   throw error;
 }
 if(!result)return;
 result.rows=scheduledReportKeyboard(statisticsCopy(result.locale),row.recipient_id,row.frequency);
 // Resource RPC can yield long enough for an operator's service grants to change.
 const currentAccess=await statisticsAccess(env,db,row.recipient_id,row.scope);
 if(!currentAccess||JSON.stringify(currentAccess.botIds)!==JSON.stringify(result.report.access.botIds)
   ||JSON.stringify(currentAccess.full)!==JSON.stringify(result.report.access.full)
   ||currentAccess.grantRevision!==result.report.access.grantRevision)return;
 const claim=await read(db,`UPDATE statistics_schedules SET status='sending',last_error=NULL,claim_token=?,claimed_at=?,last_period_end=?,next_at=?
   WHERE recipient_id=? AND frequency=? AND enabled=1 AND status<>'sending' AND next_at=? AND revision=?
   AND (recipient_id=? OR EXISTS(SELECT 1 FROM support_operators o LEFT JOIN manager_statistics_preferences p ON p.operator_id=o.user_id
     WHERE o.user_id=recipient_id AND o.active=1 AND COALESCE(p.access_revision,0)=?)) RETURNING recipient_id`,
   token,at.toISOString(),range.end,next,row.recipient_id,row.frequency,row.next_at,row.revision,primary(env),result.report.access.grantRevision);
 if(!claim)return;
 db.recoveryTelegramCheckpoint?.();
 const sent=await requestTelegram({token:env.MANAGER_BOT_TOKEN,method:'sendRichMessage',body:{chat_id:row.recipient_id,rich_message:{markdown:result.markdown},reply_markup:{inline_keyboard:result.rows}},fetchImpl,timeoutMs:10000});
 const confirmed=sent.ok&&Number.isSafeInteger(Number(sent.result?.message_id))&&Number(sent.result.message_id)>0;
 if(confirmed)await run(db,"UPDATE statistics_schedules SET status='idle',claim_token=NULL,last_sent_at=? WHERE recipient_id=? AND frequency=? AND claim_token=?",at.toISOString(),row.recipient_id,row.frequency,token);
 else if(sent.rateLimited)await run(db,"UPDATE statistics_schedules SET status='idle',claim_token=NULL,last_period_end=?,next_at=? WHERE recipient_id=? AND frequency=? AND claim_token=?",row.last_period_end,new Date(at.getTime()+Math.max(60,sent.retryAfterSeconds||60)*1000).toISOString(),row.recipient_id,row.frequency,token);
 else if(!sent.ok&&!sent.deliveryUncertain&&Number(sent.errorCode||sent.httpStatus)>=400&&Number(sent.errorCode||sent.httpStatus)<500)
   await run(db,"UPDATE statistics_schedules SET status='idle',enabled=0,last_error=?,claim_token=NULL,last_period_end=? WHERE recipient_id=? AND frequency=? AND claim_token=?",'telegram_'+(sent.errorCode||sent.httpStatus),row.last_period_end,row.recipient_id,row.frequency,token);
 else await run(db,"UPDATE statistics_schedules SET status='uncertain',last_error='unknown' WHERE recipient_id=? AND frequency=? AND claim_token=?",row.recipient_id,row.frequency,token);
 if(!sent.ok)await recordStatisticsTelegramFailure(db,'__manager__',sent);
}
