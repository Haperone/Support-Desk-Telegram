import { WorkerEntrypoint } from "cloudflare:workers";
import { readCloudflarePlan } from "./cloudflare-plan.js";
import { supportHealthSnapshot, supportServices } from "./support-health.js";
import { beginManualDelivery, executeManualDelivery, inspectManualDelivery, manualDeliveryStatus, stepManualDelivery, MANAGER_DELIVERY_UI } from './manual-delivery.js';
import { publishManualDelivery, runManualDeliveryTarget, syncVerificationNotice } from './worker.js';
import { resolveInvocationDatabase } from './recovery-budget.js';
import supportWorker from './control-plane-worker.js';
import { claimAccessEvents, startAccessEvents, completeAccessEvents } from './user-access-alerts.js';
import { createRegistrationWorker } from './bot-onboarding.js';
import { withBotRegistry } from './bot-registry.js';
import { createManagerWorker, publishManagerManualDelivery } from './manager-bot.js';

const publishDelivery = (env, run) => run.ui_bot_id === MANAGER_DELIVERY_UI
  ? publishManagerManualDelivery(env, run) : publishManualDelivery(env, run);

const registeredSupportWorker = createRegistrationWorker(supportWorker);
const supportWithManager = createManagerWorker(registeredSupportWorker);

// A named service binding exposes plan metadata only, with no public HTTP route.
export class CloudflarePlan extends WorkerEntrypoint {
  getPlan() { return readCloudflarePlan(this.env.SUPPORT_DB, this.env); }
}

export class SupportHealth extends WorkerEntrypoint {
  async services() { return supportServices(await withBotRegistry(this.env)); }
  async snapshot(options) { return supportHealthSnapshot(await withBotRegistry(this.env), { botId: options?.botId }); }
  async accessClaim() { return claimAccessEvents(await withBotRegistry(this.env, 'recovery')); }
  accessStart(token,generation) { return startAccessEvents(this.env,token,generation); }
  accessComplete(token,outcome) { return completeAccessEvents(this.env,token,outcome); }
}

// A verification result gets a fresh budget even when delivery used the HTTP
// invocation's allowance. This service only reflects a durably passed challenge.
export class VerificationStatus extends WorkerEntrypoint {
  async sync(challengeId, allowLegacy = false) {
    const env = await withBotRegistry(this.env, 'recovery');
    const db = await resolveInvocationDatabase(env.SUPPORT_DB, env, 'recovery');
    if (db.storageMode === 'reset') return;
    return syncVerificationNotice({ ...env, SUPPORT_DB: db }, challengeId, allowLegacy === true);
  }
}

// ctx.exports creates this private loopback service without a new Worker or secret.
export class DeliveryRecovery extends WorkerEntrypoint {
  async status(options) { return manualDeliveryStatus(await withBotRegistry(this.env), options); }
  async inspect(token, observed) { return inspectManualDelivery(await withBotRegistry(this.env, 'recovery'), token, observed); }
  async step(token, target) { return stepManualDelivery(await withBotRegistry(this.env, 'recovery'), token, target, runManualDeliveryTarget); }
  async start(options) {
    const env = await withBotRegistry(this.env);
    const result = await beginManualDelivery(env, options, publishDelivery);
    if (result.started) this.ctx.waitUntil(executeManualDelivery(env, result.run.token, this.ctx.exports.DeliveryRecovery, publishDelivery));
    return result;
  }
}

function dispatchAccessAlerts(env,ctx) {
  if (!env.USER_ACCESS_ALERTS || !ctx?.waitUntil) return;
  ctx.waitUntil(env.USER_ACCESS_ALERTS.flush().catch(error=>console.warn(JSON.stringify({event:'user_access_alerts_deferred',message:String(error?.message||error).slice(0,300)}))));
}
export default {
  async fetch(request,env,ctx) {
    const response=await supportWithManager.fetch(request,env,ctx);
    // Only accepted authenticated Telegram updates / accepted CAPTCHA POSTs.
    if (request.method==='POST' && (response.ok || new URL(request.url).pathname.startsWith('/verify/') && response.status===403)) dispatchAccessAlerts(env,ctx);
    return response;
  },
  scheduled(controller,env,ctx) {
    dispatchAccessAlerts(env,ctx);
    return supportWithManager.scheduled(controller,env,ctx);
  },
};
