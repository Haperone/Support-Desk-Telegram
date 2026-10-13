import { storageForecast, storageLimits } from './storage.js';

export async function storageSnapshot(env, { cursor = '', locale = 'en' } = {}, now = new Date()) {
  const language = ['ru','en','es','zh'].includes(locale) ? locale : 'en';
  const db = env.MONITOR_DB;
  const saved = await db.prepare("SELECT value FROM monitor_state WHERE key = 'storage_inventory_v1'").first();
  if (!saved?.value) return { quality: 'unavailable', databases: [] };
  const state = JSON.parse(saved.value);
  const rows = (await db.prepare(`SELECT i.database_id, i.name, i.bytes, i.measured_at, i.quality
    FROM storage_inventory i
    WHERE inventory_id = ? AND database_id > ? ORDER BY database_id LIMIT 6`).bind(state.generation, String(cursor).slice(0, 80)).all()).results || [];
  const account = await db.prepare("SELECT bytes, measured_at FROM storage_samples WHERE resource_id = 'account' ORDER BY measured_at DESC LIMIT 1").first();
  const fresh = (row) => row && Date.parse(row.measured_at) >= now.getTime() - 3600000;
  const page=rows.slice(0,5),limit=storageLimits(env).database;
  // Fetch the bounded page's trends together; never translate stored incident prose.
  const samples=page.length?(await db.prepare(`SELECT resource_id,measured_at,bytes FROM storage_daily_samples
    WHERE resource_id IN (SELECT value FROM json_each(?)) AND day_utc>=? ORDER BY resource_id,day_utc`)
    .bind(JSON.stringify(page.map(row=>row.database_id)),new Date(now.getTime()-30*86400000).toISOString().slice(0,10)).all()).results||[]:[];
  return { quality: state.complete && !state.invalid && fresh(account) ? 'available' : 'partial',
    account: fresh(account) ? account : null,
    databases: page.map((row) => {
      const quality=fresh(row)?row.quality:'unavailable';
      const forecast=quality==='available'?storageForecast(samples.filter(sample=>sample.resource_id===row.database_id),limit,now):null;
      const days=Math.ceil(forecast?.daysRemaining||0);
      const forecastText=forecast?{
        en:`At the current growth rate, space may run out in about ${days} days.`,
        ru:`При текущем росте место закончится примерно через ${days} дн.`,
        es:`Al ritmo de crecimiento actual, el espacio podría agotarse en unos ${days} días.`,
        zh:`按当前增长速度，空间可能在约 ${days} 天后耗尽。`,
      }[language]:{en:'Forecast unavailable.',ru:'Прогноз пока недоступен.',es:'Pronóstico no disponible.',zh:'暂时无法预测。'}[language];
      return {...row,quality,limit_bytes:limit,forecast:forecastText};
    }),
    next: rows.length > 5 ? rows[4].database_id : null };
}
