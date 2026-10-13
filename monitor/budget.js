export class MonitorBudgetExhausted extends Error {
  constructor() { super("Monitor work deferred to the next invocation"); this.name = "MonitorBudgetExhausted"; }
}

export function createMonitorContext(env, fetchImpl = fetch) {
  if (env.MONITOR_CONTEXT) return env.MONITOR_CONTEXT;
  let statements = 0;
  let requests = 0;
  const started = performance.now();
  let limit = String(env.RECOVERY_D1_PLAN || "free").toLowerCase() === "paid" ? 1000 : 50;
  const originals = new WeakMap();
  const budget = {
    get statements() { return statements; }, get requests() { return requests; }, get limit() { return limit; },
    setPlan(plan) { limit = plan === "paid" ? 1000 : 50; },
    request() { if (requests >= 47 || performance.now() - started > 90_000) throw new MonitorBudgetExhausted(); requests++; },
    checkpoint(sql = 1, http = 0) {
      if (performance.now() - started > 90_000 || statements + sql > limit - 3 || requests + http > 47) throw new MonitorBudgetExhausted();
    },
  };
  const consume = (sqls) => {
    const reserve = sqls.every((sql) => /^UPDATE monitor_scheduler SET (owner_token = NULL|next_job = \? WHERE)/.test(sql)) ? 0 : 3;
    if (statements + sqls.length > limit - reserve) throw new MonitorBudgetExhausted();
    statements += sqls.length;
  };
  const wrap = (statement, sql) => {
    const result = {
      bind: (...params) => wrap(statement.bind(...params), sql),
      first: (...args) => { consume([sql]); return statement.first(...args); },
      all: (...args) => { consume([sql]); return statement.all(...args); },
      run: (...args) => { consume([sql]); return statement.run(...args); },
    };
    originals.set(result, { statement, sql });
    return result;
  };
  const db = {
    prepare: (sql) => wrap(env.MONITOR_DB.prepare(sql), sql),
    batch: (entries) => { const original = entries.map((entry) => originals.get(entry)); consume(original.map((entry) => entry.sql)); return env.MONITOR_DB.batch(original.map((entry) => entry.statement)); },
  };
  const countedFetch = (...args) => {
    if (performance.now() - started > 90_000 || requests >= 50) throw new MonitorBudgetExhausted();
    requests += 1;
    return fetchImpl(...args);
  };
  const context = { budget, fetch: countedFetch };
  context.env = { ...env, MONITOR_DB: db, MONITOR_CONTEXT: context };
  return context;
}
