import { parseConfig } from './worker.js';
import { resolveMonitorEnvironment, usagePeriod } from './plan.js';
import { withinStatisticsRangeLimit } from '../src/statistics-range-limit.js';

// Internal service RPC: no new HTTP endpoint or Telegram credentials exposed.
export async function statisticsResourceSnapshot(originalEnv,{start,end,timeZone='UTC'}={},at=new Date()) {
 if(Date.parse(end)>at.getTime()||!withinStatisticsRangeLimit(start,end,timeZone))throw new Error('Invalid statistics period');
 start=new Date(start).toISOString();end=new Date(end).toISOString();
 const env=await resolveMonitorEnvironment(originalEnv),db=env.MONITOR_DB,period=usagePeriod(env,at),config=parseConfig(env);
 const usage=await db.prepare('SELECT * FROM usage_snapshots WHERE day_utc=? ORDER BY checked_at DESC LIMIT 1').bind(period.key).first();
 const recent=value=>Number.isFinite(Date.parse(value))&&Date.parse(value)>=at.getTime()-3600000&&Date.parse(value)<=at.getTime();
 const fresh=usage&&recent(usage.checked_at);
 const bytes=await db.prepare("SELECT bytes,measured_at FROM storage_samples WHERE resource_id='account' ORDER BY measured_at DESC LIMIT 1").first();
 const old=await db.prepare("SELECT bytes,measured_at FROM storage_daily_samples WHERE resource_id='account' AND day_utc<=? AND measured_at<=? ORDER BY day_utc DESC LIMIT 1").bind(start.slice(0,10),start).first();
 const last=await db.prepare("SELECT bytes,measured_at FROM storage_daily_samples WHERE resource_id='account' AND day_utc<=? AND measured_at<=? ORDER BY day_utc DESC LIMIT 1").bind(end.slice(0,10),end).first();
 const incidents=await db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(severity>=95),0) AS critical,COALESCE(SUM(severity<95),0) AS warnings FROM monitor_incidents WHERE severity>0 AND recovered_at IS NULL').first();
 const runtime=await db.prepare(`SELECT SUM(exceptions) exceptions,SUM(resource_failures) resource_failures,COUNT(*) windows,MIN(window_start) first_window,MAX(window_start) last_window
   FROM statistics_runtime_windows WHERE window_start>=? AND window_start<?`).bind(start,end).first();
 return {usage,limits:config.limits,fresh:Boolean(fresh),measuredAt:usage?.checked_at||null,usagePeriod:period.start+' — '+period.end,
   bytes:bytes&&recent(bytes.measured_at)?bytes.bytes:null,
   growth:old&&last&&Date.parse(start)-Date.parse(old.measured_at)<=86400000&&Date.parse(end)-Date.parse(last.measured_at)<=86400000?last.bytes-old.bytes:null,incidents:incidents.total,criticalIncidents:incidents.critical,warningIncidents:incidents.warnings,runtime};
}
