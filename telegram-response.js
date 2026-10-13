import { retryAfterSeconds } from "./http-errors.js";

export async function requestTelegram({ token, method, body, timeoutMs = 15_000, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
    });
    let payload;
    let invalid = false;
    try { payload = await response.json(); }
    catch { invalid = true; }
    invalid ||= !payload || typeof payload !== "object" || typeof payload.ok !== "boolean";
    const httpStatus = response.status;
    const errorCode = Number(payload?.error_code) || null;
    const limited = httpStatus === 429 || errorCode === 429;
    const serverError = httpStatus >= 500 || errorCode >= 500;
    const headerWait = retryAfterSeconds(response.headers?.get("retry-after"));
    const parameterWait = retryAfterSeconds(payload?.parameters?.retry_after);
    const wait = Math.max(headerWait || 0, parameterWait || 0) || null;
    return {
      ok: response.ok && !invalid && payload.ok === true,
      result: payload?.result, parameters: payload?.parameters, errorCode, httpStatus,
      description: String(controller.signal.aborted ? "Telegram request timed out" : invalid
        ? `Telegram returned HTTP ${httpStatus} without valid JSON` : payload?.description || `Telegram returned HTTP ${httpStatus}`).slice(0, 500),
      retryable: limited || serverError || (invalid && response.ok),
      deliveryUncertain: !limited && (serverError || (invalid && response.ok)),
      rateLimited: limited,
      retryAfterSeconds: limited ? wait : null,
    };
  } catch (error) {
    if (["RecoveryBudgetExhausted", "MonitorBudgetExhausted"].includes(error.constructor?.name)) throw error;
    return { ok: false, retryable: true, deliveryUncertain: true,
      description: controller.signal.aborted ? "Telegram request timed out" : "Telegram network request failed" };
  } finally { clearTimeout(timer); }
}
