const now=()=>new Date().toISOString();
const workLocale=value=>value===true?'ru':value===false?'en':['en','ru','es','zh'].includes(value)?value:'en';
const workCopy={
  en:{unknown:'time unknown',now:'just now',minute:'min',hour:'h',day:'d',unassigned:'unassigned',you:'you',primary:'primary administrator',operator:'operator',needs_reply:'Needs reply',waiting:'Waiting for customer',snoozed:'Return later',resolved:'Resolved'},
  ru:{unknown:'время неизвестно',now:'только что',minute:'мин',hour:'ч',day:'д',unassigned:'не назначен',you:'вы',primary:'главный администратор',operator:'оператор',needs_reply:'Нужен ответ',waiting:'Ждём клиента',snoozed:'Вернуться позже',resolved:'Решено'},
  es:{unknown:'hora desconocida',now:'ahora mismo',minute:'min',hour:'h',day:'d',unassigned:'sin asignar',you:'tú',primary:'administrador principal',operator:'operador',needs_reply:'Necesita respuesta',waiting:'Esperando al cliente',snoozed:'Volver más tarde',resolved:'Resuelto'},
  zh:{unknown:'时间未知',now:'刚刚',minute:'分钟',hour:'小时',day:'天',unassigned:'未分配',you:'你',primary:'主管理员',operator:'操作员',needs_reply:'待回复',waiting:'等待客户',snoozed:'稍后处理',resolved:'已解决'},
};
export const WORK_FILTERS=['needs','mine','waiting','today','resolved','all'];
function nextLocalTime(at, timeZone, hour = 0) {
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const parts=date=>Object.fromEntries(formatter.formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  const local=parts(at), target=Date.UTC(local.year,local.month-1,local.day+1,hour);
  let utc=target;
  for(let i=0;i<3;i++) { const p=parts(new Date(utc));utc=target-(Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-utc); }
  return new Date(utc).toISOString();
}
export const tomorrowMorning = (at = new Date(), timeZone = 'Europe/Budapest') => nextLocalTime(at, timeZone, 9);
const queueConditions = {
  needs:"(w.state='needs_reply' OR (w.state='snoozed' AND w.snoozed_until<=?3))",
  mine:"w.assigned_to=?2 AND w.state<>'resolved'", waiting:"w.state='waiting'",
  today:"w.state='snoozed' AND w.snoozed_until<?4", resolved:"w.state='resolved'", all:'1=1',
};
export async function workCounts(db,{botId=null,actor,at=new Date(),timeZone='Europe/Budapest',botIds=null}) {
  return db.prepare(`SELECT ${WORK_FILTERS.map(f=>`COUNT(CASE WHEN ${queueConditions[f]} THEN 1 END) AS ${f==='all'?'"all"':f}`).join(',')}
    FROM conversation_work w WHERE (?1 IS NULL OR w.bot_id=?1) AND (?5 IS NULL OR w.bot_id IN (SELECT value FROM json_each(?5)))`)
    .bind(botId,actor,at.toISOString(),nextLocalTime(at,timeZone),botIds?JSON.stringify(botIds):null).first();
}
export function workAge(value,ru=true,at=new Date()) {
  const copy=workCopy[workLocale(ru)];
  const elapsed=at.getTime()-Date.parse(value);
  if(!Number.isFinite(elapsed))return copy.unknown;
  const minutes=Math.max(0,Math.floor(elapsed/60000));
  if(minutes<1)return copy.now;
  if(minutes<60)return `${minutes} ${copy.minute}`;
  if(minutes<1440)return `${Math.floor(minutes/60)} ${copy.hour}`;
  return `${Math.floor(minutes/1440)} ${copy.day}`;
}
export function assigneeLabel(row,actor,primaryId,ru=true) {
  const copy=workCopy[workLocale(ru)];
  if(!row?.assigned_to)return copy.unassigned;
  if(Number(row.assigned_to)===Number(actor))return copy.you;
  const name=[row.operator_first_name,row.operator_last_name].filter(Boolean).join(' ');
  if(name||row.operator_username)return name+(row.operator_username?`${name?' · ':''}@${row.operator_username}`:'');
  if(Number(row.assigned_to)===Number(primaryId))return copy.primary;
  return copy.operator;
}
export async function workQueue(db,{botId=null,filter='needs',actor,page=0,at=new Date(),timeZone='Europe/Budapest',botIds=null}) {
  if (!WORK_FILTERS.includes(filter)) throw new Error('Unknown work queue');
  const where=queueConditions[filter].replace('?4','?5');
  const rows=await db.prepare(`SELECT w.*,c.thread_id,c.first_name,c.last_name,c.username,o.first_name operator_first_name,o.last_name operator_last_name,o.username operator_username,COUNT(*) OVER() total
    FROM conversation_work w LEFT JOIN conversations c ON c.bot_id=w.bot_id AND c.user_id=w.user_id
    LEFT JOIN support_operators o ON o.user_id=w.assigned_to
    WHERE (?1 IS NULL OR w.bot_id=?1) AND (?6 IS NULL OR w.bot_id IN (SELECT value FROM json_each(?6))) AND ${where} AND (?2 IS NOT NULL) AND (?3 IS NOT NULL) AND (?5 IS NOT NULL)
    ORDER BY COALESCE(w.snoozed_until,w.last_inbound_at,w.updated_at),w.bot_id,w.user_id LIMIT 6 OFFSET ?4`).bind(botId,actor,at.toISOString(),Math.max(0,Number(page)||0)*5,nextLocalTime(at,timeZone),botIds?JSON.stringify(botIds):null).all();
  return {rows:(rows.results||[]).slice(0,5),hasNext:(rows.results||[]).length>5,total:rows.results?.[0]?.total||0};
}
export async function readWork(db,botId,userId) {
  return db.prepare('SELECT w.*,o.first_name operator_first_name,o.last_name operator_last_name,o.username operator_username FROM conversation_work w LEFT JOIN support_operators o ON o.user_id=w.assigned_to WHERE w.bot_id=? AND w.user_id=?').bind(botId,userId).first();
}
export async function changeWork(db,{botId,userId,actor,revision,action,target=null,note='',until=null,primaryId=null,audit=null}) {
  const timestamp=now();
  const sets={take:"assigned_to=?5",release:'assigned_to=NULL',waiting:"state='waiting',snoozed_until=NULL,resolved_at=NULL",resolve:"state='resolved',resolved_at=?6,snoozed_until=NULL",needs:"state='needs_reply',snoozed_until=NULL,resolved_at=NULL",snooze:"state='snoozed',snoozed_until=?7,resolved_at=NULL",transfer:'assigned_to=?8,note=?9'};
  if (!sets[action]) throw new Error('Unknown work action');
  if (action==='snooze' && (!Number.isFinite(Date.parse(until)) || Date.parse(until)<=Date.now() || Date.parse(until)>Date.now()+31*86400000)) throw new Error('Invalid return time');
  const sql=`UPDATE conversation_work SET ${sets[action]},revision=revision+1,updated_at=?6
    WHERE bot_id=?1 AND user_id=?2 AND revision=?3
      AND (?4<>'take' OR assigned_to IS NULL OR assigned_to=?5)
      AND (?4<>'transfer' OR ?8=?5 OR ?8=?10 OR EXISTS(SELECT 1 FROM support_operators WHERE user_id=?8 AND active=1))
      AND ?9 IS NOT NULL AND ?7 IS NOT NULL`;
  const args=[botId,userId,revision,action,actor,timestamp,until||'',target||actor,note,primaryId];
  if(audit) {
    // The audit is part of the same transaction and exists only if this update won.
    const [changed]=await db.batch([db.prepare(sql).bind(...args),db.prepare(`INSERT INTO operator_audit(bot_id,user_id,operator_id,operator_name,action,reason,result,created_at,actor_type)
      SELECT ?,?,?,?,?,?,'success',?,'operator' WHERE changes()>0`).bind(botId,userId,actor,audit.actorName,audit.action,note||null,timestamp)]);
    return changed.meta?.changes>0?{bot_id:botId,user_id:userId,revision:revision+1}:null;
  }
  const row=await db.prepare(sql+' RETURNING *').bind(...args).first();
  return row || null;
}
export function workStateLabel(row,ru=true,at=new Date()) {
  const state=row?.state==='snoozed'&&Date.parse(row.snoozed_until)<=at.getTime()?'needs_reply':row?.state||'needs_reply';
  return workCopy[workLocale(ru)][state];
}
