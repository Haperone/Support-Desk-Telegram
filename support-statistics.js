import { parseBotRegistry, parseAdminIds } from './worker.js';
import { withinStatisticsRangeLimit } from './statistics-range-limit.js';
export { recordStatisticsTelegramFailure } from './statistics-events.js';

const DAY=86400000;
export const STATISTICS_LIMIT=5000;
export const STATISTICS_PERIODS=['now','today','yesterday','week','month','custom'];
export function localParts(at,timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
    .formatToParts(at).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
}
export function localInstant(year,month,day,timeZone,hour=0,minute=0) {
  const target=Date.UTC(year,month-1,day,hour,minute);
  // Resolve both offsets around a clock change. Choose the first occurrence of
  // a repeated time; move a nonexistent time forward by the size of the gap.
  const offsets=new Set();
  for(const delta of [-2*DAY,-DAY,0,DAY,2*DAY]) {
    const instant=target+delta,p=localParts(new Date(instant),timeZone);
    offsets.add(Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)-instant);
  }
  const candidates=[...offsets].map(offset=>{
    const value=target-offset,p=localParts(new Date(value),timeZone);
    return {value,wall:Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)};
  });
  const exact=candidates.filter(c=>c.wall===target).sort((a,b)=>a.value-b.value);
  const forward=candidates.filter(c=>c.wall>target).sort((a,b)=>a.wall-b.wall);
  return new Date((exact[0]||forward[0]).value);
}
export function statisticsRange(period='today',timeZone='Europe/Budapest',at=new Date(),custom={}) {
  const p=localParts(at,timeZone),today=localInstant(p.year,p.month,p.day,timeZone);
  let start=today,end=at;
  if(period==='now') start=at;
  else if(period==='yesterday') {start=localInstant(p.year,p.month,p.day-1,timeZone);end=today;}
  else if(period==='week') start=localInstant(p.year,p.month,p.day-6,timeZone);
  else if(period==='month') start=localInstant(p.year,p.month,p.day-29,timeZone);
  else if(period==='custom') { start=new Date(custom.custom_start);end=new Date(custom.custom_end); }
  else if(period!=='today') throw new Error('Invalid statistics period');
  if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end>at
    ||!withinStatisticsRangeLimit(start.toISOString(),end.toISOString(),timeZone)) throw new Error('Invalid statistics range');
  return {start:start.toISOString(),end:end.toISOString(),period,timeZone};
}
export function parseStatisticsDates(text,timeZone,at=new Date()) {
  const match=/^(\d{4})-(\d{2})-(\d{2})\s+(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if(!match) return null;
  const n=match.slice(1).map(Number);
  for(const offset of [0,3]) {const date=new Date(Date.UTC(n[offset],n[offset+1]-1,n[offset+2]));if(date.getUTCFullYear()!==n[offset]||date.getUTCMonth()+1!==n[offset+1]||date.getUTCDate()!==n[offset+2])return null;}
  const result={custom_start:localInstant(...n.slice(0,3),timeZone).toISOString(),custom_end:localInstant(n[3],n[4],n[5]+1,timeZone).toISOString()};
  try {statisticsRange('custom',timeZone,at,result);return result;} catch {return null;}
}
export function nextStatisticsSchedule(row,at=new Date()) {
  const p=localParts(at,row.timezone);
  for(let offset=0;offset<=40;offset++) {
    const date=new Date(Date.UTC(p.year,p.month-1,p.day+offset));
    if(row.frequency==='weekly'&&date.getUTCDay()!==row.weekday || row.frequency==='monthly'&&date.getUTCDate()!==1)continue;
    const candidate=localInstant(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate(),row.timezone,row.send_hour,row.send_minute);
    if(candidate>at) return candidate.toISOString();
  }
  throw new Error('Invalid statistics schedule');
}
export function scheduledStatisticsRange(row,at=new Date()) {
  const p=localParts(at,row.timezone),today=localInstant(p.year,p.month,p.day,row.timezone);
  if(row.frequency==='daily') return {start:localInstant(p.year,p.month,p.day-1,row.timezone).toISOString(),end:today.toISOString(),period:'daily',timeZone:row.timezone};
  if(row.frequency==='weekly') {
    const monday=p.day-((new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay()+6)%7);
    return {start:localInstant(p.year,p.month,monday-7,row.timezone).toISOString(),end:localInstant(p.year,p.month,monday,row.timezone).toISOString(),period:'weekly',timeZone:row.timezone};
  }
  return {start:localInstant(p.year,p.month-1,1,row.timezone).toISOString(),end:localInstant(p.year,p.month,1,row.timezone).toISOString(),period:'monthly',timeZone:row.timezone};
}
export async function statisticsAccess(env,db,actorId,scope='a') {
  const primary=Number([...parseAdminIds(env.ADMIN_IDS)][0])===Number(actorId);
  const operator=primary?null:await db.prepare(`SELECT COALESCE(p.access_revision,0) access_revision FROM support_operators o
    LEFT JOIN manager_statistics_preferences p ON p.operator_id=o.user_id WHERE o.user_id=? AND o.active=1`).bind(actorId).first();
  if(!primary&&!operator)return null;
  const services=parseBotRegistry(env.BOT_REGISTRY);
  const ownership=primary?[]:(await db.prepare(`SELECT bot_id,'full' AS access FROM service_responsibility WHERE primary_id=? OR backup_id=?
    UNION SELECT bot_id,'own' FROM conversation_work WHERE assigned_to=? LIMIT 101`).bind(actorId,actorId,actorId).all()).results||[];
  const full=primary?services.map(s=>s.id):ownership.filter(r=>r.access==='full').map(r=>r.bot_id);
  const allowed=services.filter(s=>primary||ownership.some(r=>r.bot_id===s.id));
  let selected=allowed,groupTitle=null;
  if(/^g-\d+$/.test(scope)) {
    const groupId=Number(scope.slice(1));if(!Number.isSafeInteger(groupId)||groupId>=0)return null;
    const routes=(await db.prepare('SELECT r.bot_id,g.title FROM service_group_routes r JOIN support_groups g USING(group_id) WHERE r.group_id=? LIMIT 101').bind(groupId).all()).results||[];
    groupTitle=routes[0]?.title||String(groupId);
    selected=allowed.filter(s=>routes.some(r=>r.bot_id===s.id));
  } else if(scope!=='a') selected=allowed.filter(s=>s.id===(scope.startsWith('s:')?scope.slice(2):scope));
  if(scope!=='a'&&!selected.length)return null;
  return {primary,actorId,scope,grantRevision:operator?.access_revision||0,services:selected,allowed,full,botIds:selected.map(s=>s.id),groupTitle,groupId:/^g-\d+$/.test(scope)?Number(scope.slice(1)):null};
}
const visible=(alias,access)=>`(((${alias}.bot_id IN (SELECT value FROM json_each(?1))) OR (?3=1 AND ${alias}.bot_id='__system__') OR (?3=1 AND ?2 IS NULL AND ${alias}.bot_id='__manager__'))
  AND (?2 IS NULL OR ${alias}.group_id=?2 OR (?3=1 AND ${alias}.bot_id='__system__'))
  AND (?3=1 OR ${alias}.bot_id IN (SELECT value FROM json_each(?4)) OR ${alias}.actor_id=?5 OR EXISTS
  (SELECT 1 FROM conversation_work v WHERE v.bot_id=${alias}.bot_id AND v.user_id=${alias}.user_id AND v.assigned_to=?5)))`;
export function summarizeStatistics(facts,range) {
  const rows=facts.filter(f=>f.occurred_at>=range.start&&f.occurred_at<range.end);
  const n=kind=>rows.filter(f=>f.kind===kind).length;
  const inbound=rows.filter(f=>f.kind==='message'&&f.direction==='user_to_support');
  const users=new Set(inbound.filter(f=>f.user_id!=null).map(f=>f.user_id));
  const newUsers=new Set(rows.filter(f=>f.kind==='new').map(f=>f.user_id));
  const samples=rows.filter(f=>f.kind==='answer'&&Number.isFinite(f.seconds)).map(f=>({...f,seconds:Math.round(f.seconds*1000)/1000}));
  const durations=first=>samples.filter(f=>Boolean(f.first_reply)===first).map(f=>f.seconds).sort((a,b)=>a-b);
  const percentile=(values,q)=>values.length?values[Math.ceil(q*values.length)-1]:null;
  const first=durations(true),next=durations(false);
  const delivery=facts.filter(f=>f.kind==='message'&&f.delivered_at>=range.start&&f.delivered_at<range.end);
  const failed=facts.filter(f=>f.kind==='message'&&f.failure_at>=range.start&&f.failure_at<range.end);
  const late=samples.filter(f=>f.seconds>f.deadline_seconds).length;
  return {users:users.size,newUsers:newUsers.size,returning:[...users].filter(id=>!newUsers.has(id)).length,
    new:n('new'),reopen:n('reopen'),close:n('close'),inbound:inbound.length,outbound:rows.filter(f=>f.kind==='message'&&f.direction==='support_to_user').length,
    deliveredIn:delivery.filter(f=>f.direction==='user_to_support').length,deliveredOut:delivery.filter(f=>f.direction==='support_to_user').length,
    problems:failed.length,recovered:delivery.filter(f=>f.failure_at).length,
    firstMedian:percentile(first,.5),firstP90:percentile(first,.9),nextMedian:percentile(next,.5),responseSamples:samples.length,
    within:samples.length?100*(samples.length-late)/samples.length:null,late,
    deliveryMedian:percentile(delivery.filter(f=>f.direction==='user_to_support').map(f=>Math.max(0,(Date.parse(f.delivered_at)-Date.parse(f.occurred_at))/1000)).sort((a,b)=>a-b),.5),
    check:n('check'),passed:n('passed'),failed:n('failed'),expired:n('expired'),ban:n('ban'),restriction:n('restriction'),
    network:n('network'),limited:n('limited'),telegram:n('telegram'),d1:n('d1')};
}
export async function collectStatistics(env,db,access,range,at=new Date()) {
  db.recoveryCheckpoint?.(12);
  const args=[JSON.stringify(access.botIds),access.groupId,access.primary?1:0,JSON.stringify(access.full),access.actorId];
  const previous={...range,start:new Date(Date.parse(range.start)-(Date.parse(range.end)-Date.parse(range.start))).toISOString(),end:range.start};
  const earliest=new Date(Math.max(Date.parse(previous.start),at.getTime()-400*DAY)).toISOString();
  const control=await db.prepare('SELECT c.*,s.generation FROM statistics_control c JOIN storage_control s ON s.id=c.id WHERE c.id=1').first();
  const facts=(await db.prepare(`SELECT f.* FROM statistics_facts f WHERE ${visible('f',access)}
    AND ((f.occurred_at>=?6 AND f.occurred_at<?7) OR (f.delivered_at>=?6 AND f.delivered_at<?7) OR (f.failure_at>=?6 AND f.failure_at<?7))
    ORDER BY f.occurred_at DESC LIMIT ${STATISTICS_LIMIT+1}`).bind(...args,earliest,range.end).all()).results||[];
  const measuredFacts=facts.slice(0,STATISTICS_LIMIT);
  const live=(await db.prepare(`SELECT c.bot_id,c.user_id,c.support_group_id group_id,c.status,c.thread_id,w.state,w.assigned_to actor_id,
    w.snoozed_until,w.cycle_started_at,w.notification_cycle,r.reminder_minutes,o.first_name,o.username
    FROM conversations c LEFT JOIN conversation_work w USING(bot_id,user_id)
    LEFT JOIN service_responsibility r ON r.bot_id=c.bot_id LEFT JOIN support_operators o ON o.user_id=w.assigned_to
    WHERE ${visible('c0',access).replaceAll('c0.bot_id','c.bot_id').replaceAll('c0.group_id','c.support_group_id').replaceAll('c0.actor_id','w.assigned_to').replaceAll('c0.user_id','c.user_id')}
    ORDER BY c.status='open' DESC,c.bot_id,c.user_id LIMIT ${STATISTICS_LIMIT+1}`).bind(...args).all()).results||[];
  const queued=(await db.prepare(`SELECT f.* FROM (
    SELECT bot_id,user_id,COALESCE(source_created_at,started_at) occurred_at,COALESCE(failure_code,IIF(request_started_at IS NOT NULL,'telegram_delivery_outcome_unknown',NULL)) failure_code,direction,'m:'||bot_id||':'||direction||':'||source_chat_id||':'||source_message_id event_key FROM (SELECT * FROM message_delivery_attempts WHERE bot_id IN (SELECT value FROM json_each(?1)) AND completed_at IS NULL LIMIT ${STATISTICS_LIMIT+1})
    UNION ALL SELECT bot_id,user_id,COALESCE(source_created_at,created_at),COALESCE(failure_code,IIF(request_started_at IS NOT NULL,'telegram_delivery_outcome_unknown',NULL)),'user_to_support','m:'||bot_id||':user_to_support:'||source_chat_id||':'||source_message_id FROM (SELECT * FROM pending_messages WHERE bot_id IN (SELECT value FROM json_each(?1)) AND delivered_at IS NULL LIMIT ${STATISTICS_LIMIT+1})
    UNION ALL SELECT bot_id,user_id,COALESCE(source_created_at,created_at),failure_code,'user_to_support','m:'||bot_id||':user_to_support:'||user_id||':'||source_message_id FROM (SELECT * FROM reopen_business_messages WHERE bot_id IN (SELECT value FROM json_each(?1)) AND delivered_at IS NULL LIMIT ${STATISTICS_LIMIT+1})
    UNION ALL SELECT i.bot_id,g.user_id,COALESCE(i.source_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',i.received_at/1000.0,'unixepoch')),IIF(i.delivery_uncertain_at IS NOT NULL OR g.delivery_uncertain_at IS NOT NULL OR g.request_started_at IS NOT NULL,'telegram_delivery_outcome_unknown',NULL),i.direction,'m:'||i.bot_id||':'||i.direction||':'||i.source_chat_id||':'||i.message_id FROM
      (SELECT * FROM media_group_items WHERE bot_id IN (SELECT value FROM json_each(?1)) AND delivered_at IS NULL LIMIT ${STATISTICS_LIMIT+1}) i JOIN media_groups g USING(bot_id,direction,media_group_id,source_chat_id)
    ) f LIMIT ${STATISTICS_LIMIT+1}`).bind(args[0]).all()).results||[];
  const customerIndex=new Map(live.map(c=>[JSON.stringify([c.bot_id,c.user_id]),c]));
  const uniquePending=new Map();
  for(const r of queued) {const customer=customerIndex.get(JSON.stringify([r.bot_id,r.user_id]));
    if(access.groupId&&customer&&customer.group_id!==access.groupId)continue;
    if(!access.primary&&!access.full.includes(r.bot_id)&&customer?.actor_id!==access.actorId)continue;
    // Queue transitions can have two durable representations of the same input.
    const old=uniquePending.get(r.event_key);
    const severity=value=>/unknown/.test(value||'')?2:value?1:0;
    if(!old)uniquePending.set(r.event_key,r);
    else {if(severity(r.failure_code)>severity(old.failure_code))old.failure_code=r.failure_code;
      if(r.occurred_at<old.occurred_at)old.occurred_at=r.occurred_at;}
  }
  const pending=[...uniquePending.values()].sort((a,b)=>String(a.occurred_at).localeCompare(String(b.occurred_at)));
  const awaiting=(await db.prepare(`SELECT s.bot_id,s.user_id,s.verification_required,s.muted_until,s.manual_restricted_until,b.user_id banned
    FROM user_abuse_state s LEFT JOIN banned_users b USING(bot_id,user_id)
    WHERE s.bot_id IN (SELECT value FROM json_each(?1)) AND (s.verification_required=1 OR s.muted_until>?2 OR s.manual_restricted_until>?2 OR b.user_id IS NOT NULL)
    UNION ALL SELECT b.bot_id,b.user_id,0,NULL,NULL,b.user_id FROM banned_users b
    WHERE b.bot_id IN (SELECT value FROM json_each(?1)) AND NOT EXISTS(SELECT 1 FROM user_abuse_state s WHERE s.bot_id=b.bot_id AND s.user_id=b.user_id)
    LIMIT ${STATISTICS_LIMIT+1}`).bind(args[0],at.toISOString()).all()).results||[];
  const restrictedAwaiting=awaiting.filter(r=>(!access.groupId||!customerIndex.has(JSON.stringify([r.bot_id,r.user_id]))||customerIndex.get(JSON.stringify([r.bot_id,r.user_id]))?.group_id===access.groupId)
    &&(access.primary||access.full.includes(r.bot_id)||customerIndex.get(JSON.stringify([r.bot_id,r.user_id]))?.actor_id===access.actorId));
  const effective=r=>r.state==='snoozed'&&r.snoozed_until<=at.toISOString()?'needs_reply':r.state;
  const open=live.filter(r=>r.status==='open');
  const needs=open.filter(r=>effective(r)==='needs_reply');
  const unknownWork=open.filter(r=>!['needs_reply','waiting','snoozed','resolved'].includes(r.state)
    ||effective(r)==='needs_reply'&&!Number.isFinite(Date.parse(r.cycle_started_at))
    ||r.state==='snoozed'&&!Number.isFinite(Date.parse(r.snoozed_until)));
  const overdue=needs.filter(r=>r.cycle_started_at&&(at-Date.parse(r.cycle_started_at))/60000>=(r.reminder_minutes??30));
  const overdueSet=new Set(overdue);
  const ages=needs.filter(r=>r.cycle_started_at).map(r=>Math.max(0,(at-Date.parse(r.cycle_started_at))/1000));
  const operators=new Map();
  for(const r of open)if(r.actor_id) {const value=operators.get(r.actor_id)||{id:r.actor_id,name:r.first_name||r.username||String(r.actor_id),assigned:0,overdue:0,served:0,closed:0};value.assigned++;if(overdueSet.has(r))value.overdue++;operators.set(r.actor_id,value);}
  for(const f of measuredFacts)if(f.actor_id&&f.occurred_at>=range.start&&f.occurred_at<range.end&&['answer','close'].includes(f.kind)) {const value=operators.get(f.actor_id)||{id:f.actor_id,name:String(f.actor_id),assigned:0,overdue:0,served:0,closed:0};if(f.kind==='answer')value.served++;else value.closed++;operators.set(f.actor_id,value);}
  const gapFloor=control.clipped_at?Date.parse(control.clipped_at.slice(0,10))+DAY:0;
  const coverageStart=new Date(Math.max(Date.parse(control.started_at),at.getTime()-400*DAY,
    control.retained_after?Date.parse(control.retained_after)+1:0,gapFloor)).toISOString();
  let complete=facts.length<=STATISTICS_LIMIT&&live.length<=STATISTICS_LIMIT&&queued.length<=STATISTICS_LIMIT&&awaiting.length<=STATISTICS_LIMIT&&!unknownWork.length
    &&range.start>=coverageStart;
  const userIds=[...new Set(measuredFacts.filter(f=>f.kind==='message'&&f.direction==='user_to_support').map(f=>f.user_id))];
  const firstSeen=(await db.prepare(`SELECT user_id,MIN(first_seen) first_seen FROM statistics_users
    WHERE user_id IN (SELECT value FROM json_each(?1)) AND (?2='a' OR bot_id IN (SELECT value FROM json_each(?3))) GROUP BY user_id`)
    .bind(JSON.stringify(userIds),access.scope,args[0]).all()).results||[];
  const knownUsers=new Set(firstSeen.map(u=>u.user_id));
  if(userIds.some(id=>!knownUsers.has(id)))complete=false;
  const totalsFor=period=>{const totals=summarizeStatistics(measuredFacts,period);const users=new Set(measuredFacts.filter(f=>f.kind==='message'&&f.direction==='user_to_support'&&f.occurred_at>=period.start&&f.occurred_at<period.end).map(f=>f.user_id));totals.newUsers=firstSeen.filter(u=>users.has(u.user_id)&&u.first_seen>=period.start&&u.first_seen<period.end).length;totals.returning=firstSeen.filter(u=>users.has(u.user_id)&&u.first_seen<period.start).length;return totals;};
  const holds=new Map(restrictedAwaiting.map(u=>[JSON.stringify([u.bot_id,u.user_id]),u]));
  const held=r=>r.direction==='user_to_support'&&holds.has(JSON.stringify([r.bot_id,r.user_id]));
  const deliveryPending=pending.filter(r=>!held(r));
  return {range,at:at.toISOString(),access,control,coverageStart,complete,previousComplete:complete&&previous.start>=coverageStart,
    totals:totalsFor(range),previous:totalsFor(previous),
    current:{complete:live.length<=STATISTICS_LIMIT&&queued.length<=STATISTICS_LIMIT&&awaiting.length<=STATISTICS_LIMIT&&!unknownWork.length,open:open.length,users:new Set(open.map(r=>r.user_id)).size,needs:needs.length,waiting:open.filter(r=>effective(r)==='waiting').length,
      snoozed:open.filter(r=>effective(r)==='snoozed').length,unassigned:open.filter(r=>!r.actor_id).length,overdue:overdue.length,oldest:ages.length?Math.max(...ages):null,
      resolvedOpen:open.filter(r=>r.state==='resolved').length,unknownWork:unknownWork.length,
      pending:deliveryPending.filter(r=>!r.failure_code).length,failed:deliveryPending.filter(r=>r.failure_code&&!/unknown/.test(r.failure_code)).length,
      uncertain:deliveryPending.filter(r=>/unknown/.test(r.failure_code||'')).length,verification:restrictedAwaiting.filter(r=>r.verification_required).length,
      held:pending.filter(r=>held(r)&&holds.get(JSON.stringify([r.bot_id,r.user_id])).verification_required).length,
      oldestDelivery:deliveryPending.length?Math.max(0,(at-Date.parse(deliveryPending[0].occurred_at))/1000):null},
    operators:[...operators.values()],services:access.services.map(s=>({name:s.displayName,id:s.id,
      users:new Set(measuredFacts.filter(f=>f.bot_id===s.id&&f.kind==='message'&&f.direction==='user_to_support'&&f.occurred_at>=range.start&&f.occurred_at<range.end).map(f=>f.user_id)).size,
      open:open.filter(c=>c.bot_id===s.id).length,overdue:overdue.filter(c=>c.bot_id===s.id).length}))};
}
