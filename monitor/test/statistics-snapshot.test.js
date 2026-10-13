import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from '../../test/helpers/sqlite-d1.js';
import { statisticsResourceSnapshot } from '../statistics-snapshot.js';
import { collectRuntime } from '../runtime-health.js';
import { observeIncident } from '../incidents.js';

test('resource snapshot separates active critical monitor incidents from warnings and recovered incidents',async()=>{
 const db=new SqliteD1(new URL('../migrations/',import.meta.url)),at=new Date('2026-10-03T12:00:00Z');
 try{
  for(const [key,severity] of [['critical',95],['warning',85],['info',70],['resolved',0]])await observeIncident(db,{key,severity},at);
  const result=await statisticsResourceSnapshot({MONITOR_DB:db},{start:'2026-10-02T00:00:00Z',end:'2026-10-03T00:00:00Z'},at);
  assert.equal(result.incidents,3);assert.equal(result.criticalIncidents,1);assert.equal(result.warningIncidents,2);
 }finally{db.close();}
});

test('statistics resource RPC distinguishes absent and stale data from zero, uses the actual billing limits, and excludes old errors',async()=>{
 const db=new SqliteD1(new URL('../migrations/',import.meta.url)),at=new Date('2026-10-03T12:00:00.000Z');
 try{
  const env={MONITOR_DB:db},range={start:'2026-10-02T00:00:00.000Z',end:'2026-10-03T00:00:00.000Z'};
  let result=await statisticsResourceSnapshot(env,range,at);assert.equal(result.fresh,false);assert.equal(result.bytes,null);assert.equal(result.runtime.exceptions,null);
  db.sqlite.prepare(`INSERT INTO usage_snapshots(checked_at,day_utc,worker_requests,kv_reads,kv_writes,kv_deletes,kv_lists,d1_rows_read,d1_rows_written) VALUES(?,'2026-10-03',100,0,0,0,0,50,5)`).run('2026-10-03T11:50:00.000Z');
  db.sqlite.exec("INSERT INTO statistics_runtime_windows VALUES('support','2026-10-02T11:00:00.000Z',100,2,1,'available'),('support','2026-10-01T11:00:00.000Z',100,99,99,'available')");
  result=await statisticsResourceSnapshot(env,range,at);assert.equal(result.fresh,true);assert.equal(result.limits.worker_requests,100000);assert.equal(result.runtime.exceptions,2);assert.equal(result.runtime.resource_failures,1);
  result=await statisticsResourceSnapshot(env,range,new Date('2026-10-03T14:00:00Z'));assert.equal(result.fresh,false);
 }finally{db.close();}
});
test('overlapping runtime polls replace the same time window instead of adding exceptions twice',async()=>{
 const db=new SqliteD1(new URL('../migrations/',import.meta.url));
 const wire=async(_url,init)=>{
   const query=JSON.parse(init.body).query;
   const rows=query.includes('RuntimeStatus')?[{dimensions:{status:'scriptThrewException',datetimeFifteenMinutes:'2026-10-03T11:00:00Z'},sum:{requests:3}}]:[];
   return Response.json({data:{viewer:{accounts:[{workersInvocationsAdaptive:rows}]}}});
 };
 try{
  const env={MONITOR_DB:db,RUNTIME_SCRIPT_NAMES:'["support"]'},at=new Date('2026-10-03T12:00:00Z');
  await collectRuntime(env,at,wire);await collectRuntime(env,at,wire);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n,SUM(exceptions) errors FROM statistics_runtime_windows').get().n,1);
  assert.equal(db.sqlite.prepare('SELECT SUM(exceptions) errors FROM statistics_runtime_windows').get().errors,3);
  const snapshot=await statisticsResourceSnapshot(env,{start:'2026-10-03T11:00:00.000Z',end:'2026-10-03T11:15:00.000Z'},at);
  assert.equal(snapshot.runtime.exceptions,3,'the first bucket is included at its exact ISO boundary');
  assert.equal(db.sqlite.prepare("SELECT value FROM monitor_state WHERE key='statistics_runtime_count'").get().value,'1');
  db.sqlite.exec("UPDATE monitor_state SET value='50000' WHERE key='statistics_runtime_count'");
  db.sqlite.exec("INSERT OR IGNORE INTO statistics_runtime_windows VALUES('other','2026-10-03T11:00:00.000Z',10,1,0,'available')");
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM statistics_runtime_windows').get().n,1);
 }finally{db.close();}
});

test('storage growth uses measured timestamps before period boundaries and rejects future or reversed ranges',async()=>{
 const db=new SqliteD1(new URL('../migrations/',import.meta.url)),at=new Date('2026-10-03T12:00:00.000Z');
 try{
 db.sqlite.exec("INSERT INTO storage_daily_samples(resource_id,day_utc,measured_at,bytes) VALUES('account','2026-10-01','2026-10-01T20:00:00.000Z',100),('account','2026-10-02','2026-10-02T20:00:00.000Z',200),('account','2026-10-03','2026-10-03T10:00:00.000Z',300)");
 const env={MONITOR_DB:db};
 const result=await statisticsResourceSnapshot(env,{start:'2026-10-02T00:00:00Z',end:'2026-10-03T00:00:00Z'},at);assert.equal(result.growth,100);
 await assert.rejects(statisticsResourceSnapshot(env,{start:'2026-10-03T10:00:00Z',end:'2026-10-02T12:00:00.000Z'},at));
 await assert.rejects(statisticsResourceSnapshot(env,{start:'2026-10-02T00:00:00Z',end:'2026-10-04T00:00:00Z'},at));
 }finally{db.close();}
});

test('future-dated measurements are unavailable instead of looking permanently fresh',async()=>{
 const db=new SqliteD1(new URL('../migrations/',import.meta.url)),at=new Date('2026-10-03T12:00:00.000Z');
 try{
 db.sqlite.exec("INSERT INTO usage_snapshots(checked_at,day_utc,worker_requests,kv_reads,kv_writes,kv_deletes,kv_lists,d1_rows_read,d1_rows_written) VALUES('2026-10-03T13:00:00.000Z','2026-10-03',100,0,0,0,0,50,5);INSERT INTO storage_samples(resource_id,measured_at,bytes,quality) VALUES('account','2026-10-03T13:00:00.000Z',100,'available')");
 const snapshot=await statisticsResourceSnapshot({MONITOR_DB:db},{start:'2026-10-02T00:00:00.000Z',end:'2026-10-03T00:00:00.000Z'},at);
 assert.equal(snapshot.fresh,false);assert.equal(snapshot.bytes,null);
 }finally{db.close();}
});

test('resource RPC accepts the same 366 calendar-day interval as the report, including the extra DST hour',async()=>{
 const db=new SqliteD1(new URL('../migrations/',import.meta.url)),at=new Date('2026-10-03T12:00:00.000Z');
 try{
 const range={start:'2024-10-25T22:00:00.000Z',end:'2025-10-26T23:00:00.000Z',timeZone:'Europe/Budapest'};
 assert.equal(Date.parse(range.end)-Date.parse(range.start),366*86400000+3600000);
 const result=await statisticsResourceSnapshot({MONITOR_DB:db},range,at);assert.equal(result.fresh,false);
 await assert.rejects(statisticsResourceSnapshot({MONITOR_DB:db},{...range,start:'2024-10-24T22:00:00.000Z'},at));
 }finally{db.close();}
});
