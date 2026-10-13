export function normalizePlan(value = "free") {
  const plan = String(value).trim().toLowerCase();
  if (plan !== "free" && plan !== "paid") throw new Error("RECOVERY_D1_PLAN must be free or paid");
  return plan;
}

export function billingDay(value) {
  if (value == null || value === "") return null;
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("WORKERS_BILLING_DAY must be between 1 and 31");
  return day;
}

export async function readCloudflarePlan(db, env, { operational = false, storage = false } = {}) {
  const configuredPlan = normalizePlan(env.RECOVERY_D1_PLAN);
  const extra = (operational ? ", (SELECT json_group_object(bot_key, not_before) FROM telegram_cooldowns WHERE not_before > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS telegram_cooldowns" : "")
    + (storage ? ", (SELECT generation FROM storage_control WHERE id = 1) AS storage_generation, (SELECT mode FROM storage_control WHERE id = 1) AS storage_mode" : "");
  const row = await db.prepare(`SELECT plan, billing_day, revision${extra} FROM cloudflare_plan_settings WHERE id = 1`).first();
  if (!row?.revision) throw new Error("Cloudflare plan settings are unavailable; initialize or upgrade the database using DATABASE_SETUP.md before starting the Worker");
  if (storage && (!Number.isSafeInteger(row.storage_generation) || row.storage_generation < 0 || !['normal', 'reset'].includes(row.storage_mode))) {
    throw new Error('Storage control is unavailable; initialize or upgrade the database using DATABASE_SETUP.md before starting the Worker');
  }
  return {
    plan: normalizePlan(row.plan ?? configuredPlan),
    configuredPlan,
    source: row.plan == null ? "config" : "general",
    billingDay: billingDay(row.billing_day ?? env.WORKERS_BILLING_DAY),
    revision: row.revision,
    ...(operational ? { telegramCooldowns: JSON.parse(row.telegram_cooldowns || "{}") } : {}),
    ...(storage ? { storageGeneration: row.storage_generation, storageMode: row.storage_mode } : {}),
  };
}
