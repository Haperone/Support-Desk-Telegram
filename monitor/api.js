import { GraphQlRequestError, retryAfterSeconds, retryDeadline } from "../src/http-errors.js";

export function createCloudflareFetch(env, fetchImpl, now = new Date()) {
  const scope = `cloudflare:${env.CF_ACCOUNT_ID}`;
  let statePromise;
  let deadline = null;
  return async (url, init) => {
    if (new URL(url).hostname !== "api.cloudflare.com") return fetchImpl(url, init);
    statePromise ??= Promise.resolve().then(() => env.MONITOR_DB.prepare("SELECT not_before, failures FROM monitor_api_cooldowns WHERE scope = ?")
      .bind(scope).first()).catch((error) => { if (error.name === "MonitorBudgetExhausted") throw error; return null; });
    const state = await statePromise;
    const notBefore = [deadline, state?.not_before].filter(Boolean).sort().at(-1);
    if (notBefore && notBefore > now.toISOString()) {
      throw new GraphQlRequestError("Cloudflare API is waiting for retry_after", {
        httpStatus: 429, retryAfterSeconds: Math.ceil((Date.parse(notBefore) - now.getTime()) / 1000),
      });
    }
    const response = await fetchImpl(url, init);
    if (response.status === 429) {
      const seconds = retryAfterSeconds(response.headers?.get("retry-after"), now.getTime());
      const next = retryDeadline(seconds, now.getTime(), Number(state?.failures || 0));
      deadline = !deadline || next > deadline ? next : deadline;
      try {
        await env.MONITOR_DB.prepare(`INSERT INTO monitor_api_cooldowns(scope, not_before, failures, updated_at)
          VALUES (?, ?, 1, ?) ON CONFLICT(scope) DO UPDATE SET
          not_before = MAX(not_before, excluded.not_before), failures = failures + 1, updated_at = excluded.updated_at`)
          .bind(scope, deadline, now.toISOString()).run();
      } catch { /* Preserve the API failure even when the monitor database is unavailable. */ }
    } else if (response.ok && state && !deadline) {
      // A concurrent successful request must never erase a new 429 deadline.
      try {
        await env.MONITOR_DB.prepare("DELETE FROM monitor_api_cooldowns WHERE scope = ? AND not_before <= ?").bind(scope, now.toISOString()).run();
        statePromise = Promise.resolve(null);
      } catch { /* Health measurements can continue when state is read-only. */ }
    }
    return response;
  };
}

export async function cloudflareRest(env, path, fetchImpl, now = new Date()) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(30_000, Number(env.MONITOR_FETCH_TIMEOUT_MS) || 15_000));
  try {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/${path}`, {
      headers: { authorization: `Bearer ${env.CF_D1_READ_TOKEN || env.CF_ANALYTICS_TOKEN}`, accept: "application/json" }, signal: controller.signal,
    });
    const details = { httpStatus: response.status, retryAfterSeconds: retryAfterSeconds(response.headers?.get("retry-after"), now.getTime()) };
    let payload;
    try { payload = await response.json(); }
    catch { throw new GraphQlRequestError(`Cloudflare REST returned HTTP ${response.status} without usable JSON`, details); }
    if (!response.ok || payload.success !== true) throw new GraphQlRequestError(`Cloudflare REST request failed (HTTP ${response.status})`, details);
    return payload;
  } catch (error) {
    if (error instanceof GraphQlRequestError) throw error;
    if (error.name === "MonitorBudgetExhausted") throw error;
    throw new GraphQlRequestError(controller.signal.aborted ? "Cloudflare REST timed out" : "Cloudflare REST network request failed", { category: "network" });
  } finally { clearTimeout(timer); }
}
