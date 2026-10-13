import { readCloudflarePlan } from "./cloudflare-plan.js";
import { guardStorageGeneration } from "./storage-generation.js";
import { recordStatisticsFailure } from './statistics-events.js';

// Count statements (including every batch member), not just binding calls.
// Cron reserves five slots for lease release/cursor unwind; webhooks also reserve
// update completion and callback cleanup (six on Free, ten on Paid).
const PROFILES = {
  free: { work: 40, total: 45, start: 30, telegram: 40 },
  paid: { work: 900, total: 905, start: 850, telegram: 400 },
};

export class RecoveryBudgetExhausted extends Error {
  constructor() { super("D1 work deferred to the next invocation"); }
}

export function recoveryCheckpoint(db, required = 1) {
  db.recoveryCheckpoint?.(required + (db.telegramCooldownEnabled ? 1 : 0));
}

export function backgroundDbRun(db, sql, ...params) {
  return db.recoveryBackgroundRun ? db.recoveryBackgroundRun(sql, ...params) : db.prepare(sql).bind(...params).run();
}

export function createRecoveryDatabase(raw, plan = "free") {
  return createBudgetedDatabase(raw, plan, "recovery");
}

export function createWebhookDatabase(raw, plan = "free") {
  // Delegation through the General control plane must share one invocation budget.
  if (raw?.invocationBudget) return raw;
  return createBudgetedDatabase(raw, plan, "webhook");
}

export async function resolveInvocationDatabase(raw, env, mode = "webhook") {
  if (raw?.invocationBudget) return raw;
  // Resolve once per invocation, counting even this lookup. General delegation
  // reuses the wrapper, and changing the stored plan never resets an active budget.
  const bootstrap = createBudgetedDatabase(raw, "free", mode);
  const setting = await readCloudflarePlan(bootstrap, env, { operational: env.TELEGRAM_COOLDOWN_ENABLED === "true", storage: env.RETENTION_ENABLED === "true" || env.STORAGE_GUARD_ENABLED === 'true' });
  const db = createBudgetedDatabase(raw, setting.plan, mode, bootstrap.used);
  return Object.assign(db, { cloudflarePlan: setting, telegramCooldowns: setting.telegramCooldowns || {}, telegramCooldownEnabled: env.TELEGRAM_COOLDOWN_ENABLED === "true",
    storageGeneration: setting.storageGeneration, storageMode: setting.storageMode });
}

function createBudgetedDatabase(raw, plan, mode, initialUsed = 0) {
  plan = String(plan).trim().toLowerCase();
  if (!Object.hasOwn(PROFILES, plan)) throw new Error("RECOVERY_D1_PLAN must be free or paid");
  const limits = mode === "webhook"
    ? { ...PROFILES[plan], work: plan === "free" ? 44 : 990, total: plan === "free" ? 50 : 1000 }
    : PROFILES[plan];
  let used = initialUsed;
  let telegramCalls = 0;
  let foregroundReserved = 0;
  const originals = new WeakMap();
  const checkpoint = (required = 1) => {
    if (used + required > limits.work || telegramCalls >= limits.telegram) throw new RecoveryBudgetExhausted();
    // Heartbeats must not spend the statements checked before an external effect.
    // Foreground statements consume this reservation; background renewals do not.
    foregroundReserved = Math.max(foregroundReserved, required);
  };
  const release = (sql) => /^(DELETE FROM \w+_locks? WHERE .*owner_token =|UPDATE conversation_reopen_effects SET recovery_owner_token = NULL|UPDATE recovery_scheduler SET next_job = next_job - 1)/s.test(sql.trim())
    || /^UPDATE media_group(s|_items) SET /s.test(sql.trim())
      && /claimed_at = \? AND (g\.)?claimed_version = \?/.test(sql)
      && /request_started_at IS NULL AND (g\.)?delivery_completed_at IS NULL/.test(sql)
    || mode === "webhook" && (
      /^DELETE FROM (processed_updates|general_message_claims|general_callback_recoveries|verification_attempts|logical_message_guards) WHERE .*owner_token =/s.test(sql.trim())
      || /^UPDATE (processed_updates|general_message_claims|general_callback_recoveries) SET (state = 'completed'|dispatch_succeeded_at|completed_at|delivery_uncertain_at)/s.test(sql.trim())
      || /^UPDATE logical_message_guards SET owner_token = NULL/s.test(sql.trim())
      || /^UPDATE reaction_checks SET lease_token = NULL/s.test(sql.trim())
      || /^UPDATE operator_pending_actions SET stage = '(confirm|service)' WHERE /s.test(sql.trim())
    );
  const consume = (sqls, background = false) => {
    const limit = background ? limits.work - foregroundReserved : sqls.every(release) ? limits.total : limits.work;
    if (used + sqls.length > limit) throw new RecoveryBudgetExhausted();
    used += sqls.length; // Failed attempts consume budget too.
    if (!background) foregroundReserved = Math.max(0, foregroundReserved - sqls.length);
  };
  const wrap = (statement, sql) => {
    const execute=(method,args)=>{
      consume([sql]);
      const result=statement[method](...args);
      if(!result?.catch)return result;
      return result.catch(async error=>{
        await recordStatisticsFailure(database,'__system__','d1');
        throw error;
      });
    };
    const wrapped = {
      bind: (...args) => wrap(statement.bind(...args), sql),
      first: (...args) => execute('first',args),
      all: (...args) => execute('all',args),
      run: (...args) => execute('run',args),
    };
    originals.set(wrapped, { statement, sql });
    return wrapped;
  };
  const database = {
    invocationBudget: mode,
    plan,
    limit: limits.total,
    startLimit: limits.start,
    get used() { return used; },
    recoveryCheckpoint: checkpoint,
    recoveryBackgroundRun(sql, ...params) {
      if (used + 1 + foregroundReserved > limits.work) return null;
      consume([sql], true);
      return raw.prepare(database.storageGeneration == null ? sql : guardStorageGeneration(sql, database.storageGeneration)).bind(...params).run();
    },
    recoveryTelegramCheckpoint() {
      checkpoint();
      if (++telegramCalls > limits.telegram) throw new RecoveryBudgetExhausted();
    },
    prepare: (sql) => wrap(raw.prepare(database.storageGeneration == null ? sql : guardStorageGeneration(sql, database.storageGeneration)), sql),
    prepareStorage: (sql) => wrap(raw.prepare(sql), sql),
    batch(statements) {
      const entries = statements.map((statement) => originals.get(statement));
      consume(entries.map((entry) => entry.sql));
      return raw.batch(entries.map((entry) => entry.statement));
    },
  };
  return database;
}
