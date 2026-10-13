import { createMonitorContext } from './budget.js';
import { sendTelegram } from './worker.js';
import { telegramBotKey } from '../telegram-cooldown.js';
import { accessEventVisible, formatAccessEvent } from '../user-access-alerts.js';
import { readAlertRoute } from './alert-config.js';

export async function flushUserAccessAlerts(rawEnv, {fetchImpl=fetch,now=new Date()}={}) {
  if (!rawEnv.SUPPORT_HEALTH) return {disabled:true};
  const context=createMonitorContext(rawEnv,fetchImpl);
  const env=context.env;
  const route=await readAlertRoute(env);
  if (!route) return {disabled:true};
  const key=telegramBotKey({id:'monitor-alerts',token:route.token});
  const cooldown=await env.MONITOR_DB.prepare('SELECT not_before FROM telegram_cooldowns WHERE bot_key=?').bind(key).first();
  if (Date.parse(cooldown?.not_before)>now.getTime()) return {cooldown:true};
  const claim=await env.SUPPORT_HEALTH.accessClaim();
  if (!claim) return {empty:true};
  const events=claim.events.filter(accessEventVisible);
  // The source caps each batch at three notices, retaining every event in order.
  const text=events.map(e=>formatAccessEvent(e,env.DISPLAY_TIMEZONE||'Europe/Budapest',now,env.MONITOR_LOCALE||'en')).join('\n\n');
  if (text.length>4000) throw new Error('Access alert batch exceeds Telegram message limit');
  if (!text) {
    await env.SUPPORT_HEALTH.accessComplete(claim.token,{ok:true});
    return {sent:0};
  }
  if (!await env.SUPPORT_HEALTH.accessStart(claim.token,claim.generation)) return {stale:true};
  let result;
  try { result=await sendTelegram(env,text,context.fetch); }
  catch { result={ok:false,deliveryUncertain:true}; }
  await env.SUPPORT_HEALTH.accessComplete(claim.token,{ok:result.ok===true,uncertain:result.deliveryUncertain===true,retryAfterSeconds:result.retryAfterSeconds});
  if (!result.ok) console.warn(JSON.stringify({event:'user_access_alert_send_failed',uncertain:result.deliveryUncertain===true,event_ids:events.map(e=>e.id)}));
  return {sent:result.ok?events.length:0,uncertain:result.deliveryUncertain===true};
}
