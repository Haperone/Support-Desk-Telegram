import { billingDay, normalizePlan } from "../src/cloudflare-plan.js";

export function billingDaySetupLocation(env) {
  return env.SUPPORT_PLAN
    ? "Adminushka → Plan and storage → Cloudflare plan"
    : "General /plan";
}

export function usagePeriod(env, now) {
  const plan = normalizePlan(env.RECOVERY_D1_PLAN);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  let start;
  let end;
  if (plan === "paid") {
    const day = billingDay(env.WORKERS_BILLING_DAY);
    if (day == null) throw new Error(`Set the Workers Paid renewal day in ${billingDaySetupLocation(env)} or WORKERS_BILLING_DAY`);
    const boundary = (offset) => new Date(Date.UTC(year, month + offset,
      Math.min(day, new Date(Date.UTC(year, month + offset + 1, 0)).getUTCDate())));
    const offset = now < boundary(0) ? -1 : 0;
    start = boundary(offset);
    end = boundary(offset + 1);
  } else {
    start = new Date(Date.UTC(year, month, now.getUTCDate()));
    end = new Date(Date.UTC(year, month, now.getUTCDate() + 1));
  }
  return {
    plan, start: start.toISOString(), end: end.toISOString(),
    key: (env.MONITOR_PLAN_UNVERIFIED ? "unverified:" : "") + (plan === "paid" ? "paid:" : "") + start.toISOString().slice(0, 10),
    unverified: env.MONITOR_PLAN_UNVERIFIED === true,
  };
}

export async function resolveMonitorEnvironment(env) {
  if (!env.SUPPORT_PLAN) return env; // Explicit standalone deployments retain env configuration.
  let timer;
  try {
    const state = await Promise.race([
      env.SUPPORT_PLAN.getPlan(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Support plan lookup timed out")), 10_000); }),
    ]);
    if (!state || !["free", "paid"].includes(state.plan)) throw new Error("Invalid support plan response");
    return { ...env, RECOVERY_D1_PLAN: state.plan, WORKERS_BILLING_DAY: billingDay(state.billingDay) };
  } finally { clearTimeout(timer); }
}
