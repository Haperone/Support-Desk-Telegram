export function retryAfterSeconds(value, now = Date.now()) {
  if (value == null || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Math.ceil(Number(text));
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) && date > now ? Math.ceil((date - now) / 1000) : null;
}

export function retryDeadline(seconds, now = Date.now(), failures = 0, random = Math.random) {
  const delay = seconds ?? Math.ceil(Math.min(3600, 30 * 2 ** Math.min(7, failures)) * (1 + random() / 4));
  const deadline = now + delay * 1000;
  if (!Number.isSafeInteger(deadline) || deadline > 8_640_000_000_000_000) throw new Error("Invalid retry deadline");
  return new Date(deadline).toISOString();
}

export class GraphQlRequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    if (typeof details === "boolean") details = { schemaRelated: details };
    this.name = "GraphQlRequestError";
    this.httpStatus = details.httpStatus ?? null;
    this.category = details.category || (this.httpStatus === 429 ? "rate_limit"
      : [401, 403].includes(this.httpStatus) ? "access" : details.schemaRelated ? "schema" : "upstream");
    this.schemaRelated = this.category === "schema";
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
    this.retryable = this.category === "rate_limit" || this.category === "network" || this.httpStatus >= 500;
    this.dataset = details.dataset ?? null;
  }
}
