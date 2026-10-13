export async function recordStatisticsFailure(db,botId,kind) {
 if(!db)return;
 try{
  db.recoveryCheckpoint?.(10); // Leave foreground delivery and lease cleanup room.
  const sql='INSERT OR IGNORE INTO statistics_facts(event_key,kind,bot_id,occurred_at,group_id) VALUES(?,?,?,?,COALESCE((SELECT group_id FROM service_group_routes WHERE bot_id=?),0))';
  const args=[crypto.randomUUID(),kind,botId,new Date().toISOString(),botId];
  if(db.recoveryBackgroundRun)await db.recoveryBackgroundRun(sql,...args);
  else await db.prepare(sql).bind(...args).run();
 }catch{/* Failure telemetry is a lower bound and must never replace the original failure. */}
}
export function recordStatisticsTelegramFailure(db,botId,result){
 if(result.ok||result.deferred)return;
 return recordStatisticsFailure(db,botId,result.rateLimited?'limited':!result.httpStatus?'network':'telegram');
}
