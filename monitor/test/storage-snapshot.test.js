import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from '../../test/helpers/sqlite-d1.js';
import { storageSnapshot } from '../storage-snapshot.js';

test('storage snapshot localizes numeric forecasts, keeps stale data unknown and batches page trends',async()=>{
  const db=new SqliteD1(new URL('../migrations/',import.meta.url)),now=new Date('2026-09-15T12:00:00Z');
  try {
    db.sqlite.prepare("INSERT INTO monitor_state(key,value) VALUES('storage_inventory_v1',?)").run(JSON.stringify({generation:'test',complete:true}));
    db.sqlite.prepare("INSERT INTO storage_samples(resource_id,measured_at,bytes,quality) VALUES('account',?,1,'available')").run(now.toISOString());
    for(let i=1;i<=6;i++) {
      db.sqlite.prepare("INSERT INTO storage_inventory(database_id,name,inventory_id,bytes,measured_at,quality) VALUES(?,?,'test',100000000,?,'available')").run('db'+i,'Database '+i,(i===2?new Date(now.getTime()-7200000):now).toISOString());
      for(let day=0;day<7;day++) {
        const at=new Date(now.getTime()-day*86400000).toISOString();
        db.sqlite.prepare('INSERT INTO storage_daily_samples(resource_id,day_utc,measured_at,bytes) VALUES(?,?,?,?)').run('db'+i,at.slice(0,10),at,100000000-day*1000000);
      }
    }
    for(const locale of ['en','ru','es','zh']) {
      db.queries=0;
      const result=await storageSnapshot({MONITOR_DB:db},{locale},now);
      assert.equal(db.queries,4);assert.equal(result.databases.length,5);assert.equal(result.next,'db5');
      assert.equal(result.quality,'available');
      assert.equal(result.databases[0].limit_bytes,500000000);
      assert.match(result.databases[0].forecast,locale==='en'?/400 days/:locale==='ru'?/400 дн/:locale==='es'?/400 días/:/400 天/);
      assert.equal(result.databases[1].quality,'unavailable');
      assert.equal(result.databases[1].forecast,({en:'Forecast unavailable.',ru:'Прогноз пока недоступен.',es:'Pronóstico no disponible.',zh:'暂时无法预测。'})[locale]);
    }
    const last=await storageSnapshot({MONITOR_DB:db},{cursor:'db5',locale:'en'},now);
    assert.equal(last.databases.length,1);assert.equal(last.next,null);
  } finally {db.close();}
});
