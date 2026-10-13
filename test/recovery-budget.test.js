import test from "node:test";
import assert from "node:assert/strict";
import { createRecoveryDatabase, createWebhookDatabase, resolveInvocationDatabase, RecoveryBudgetExhausted } from "../src/recovery-budget.js";

test("durable plan lookup counts once, follows config until overridden, and freezes each invocation", async () => {
  let row = { plan: null, revision: "initial", billing_day: null };
  let submitted = 0;
  const raw = { prepare: () => ({ first() { submitted++; return { ...row }; }, run() { submitted++; } }) };
  const first = await resolveInvocationDatabase(raw, { RECOVERY_D1_PLAN: "paid" });
  assert.equal(first.plan, "paid");
  assert.equal(first.used, 1);
  assert.equal(first.cloudflarePlan.source, "config");
  row = { plan: "free", revision: "changed", billing_day: 31 };
  const proxy = new Proxy(first, {});
  assert.equal(await resolveInvocationDatabase(proxy, { RECOVERY_D1_PLAN: "free" }), proxy);
  assert.equal(submitted, 1);
  assert.equal(first.plan, "paid");
  const free = await resolveInvocationDatabase(raw, { RECOVERY_D1_PLAN: "paid" });
  assert.equal(free.plan, "free");
  assert.equal(free.cloudflarePlan.billingDay, 31);
  for (let i = 1; i < 44; i++) free.prepare("SELECT 1").run();
  assert.throws(() => free.prepare("SELECT 1").run(), RecoveryBudgetExhausted);
  for (let i = 0; i < 6; i++) free.prepare("DELETE FROM processed_updates WHERE owner_token = ?").run();
  assert.equal(free.used, 50);
  assert.equal(submitted, 51); // First Paid lookup + the entire Free invocation.
  row.plan = "paid";
  const cron = await resolveInvocationDatabase(raw, {}, "recovery");
  assert.equal(cron.plan, "paid");
  assert.equal(cron.limit, 905);
  assert.equal(cron.used, 1);
  row = null;
  raw.prepare = () => ({ first() { return null; } });
  await assert.rejects(resolveInvocationDatabase(raw, {}), /Cloudflare plan settings are unavailable.*DATABASE_SETUP/);
});

test("paid profile removes Free caps but preserves its own ceiling", () => {
  let submitted = 0;
  const raw = { prepare: () => ({ run: () => { submitted++; } }) };
  const paid = createRecoveryDatabase(raw, "paid");
  for (let i = 0; i < 900; i++) paid.prepare("SELECT 1").run();
  assert.equal(paid.limit, 905);
  assert.equal(paid.startLimit, 850);
  assert.throws(() => paid.prepare("SELECT 1").run(), RecoveryBudgetExhausted);
  assert.equal(submitted, 900);
  const free = createRecoveryDatabase(raw);
  assert.equal(free.limit, 45);
  assert.equal(free.startLimit, 30);
  assert.throws(() => createRecoveryDatabase(raw, "off"), /RECOVERY_D1_PLAN/);
  const telegram = createRecoveryDatabase(raw, "paid");
  for (let i = 0; i < 400; i++) telegram.recoveryTelegramCheckpoint();
  assert.throws(() => telegram.recoveryTelegramCheckpoint(), RecoveryBudgetExhausted);
});

test("recovery counts failed statements and rejects a whole batch before submission", async () => {
  let submitted = 0;
  const raw = {
    prepare: () => ({ run() { submitted++; throw new Error("D1 unavailable"); } }),
    batch: async (statements) => { submitted += statements.length; },
  };
  const db = createRecoveryDatabase(raw);
  for (let i = 0; i < 39; i++) assert.throws(() => db.prepare("SELECT 1").run(), /D1 unavailable/);
  assert.throws(() => db.batch([db.prepare("SELECT 1"), db.prepare("SELECT 2")]), RecoveryBudgetExhausted);
  assert.equal(submitted, 39);
  assert.equal(db.used, 39);
  assert.throws(() => db.prepare("SELECT 1").run(), /D1 unavailable/);
  assert.throws(() => db.prepare("SELECT 1").run(), RecoveryBudgetExhausted);
  for (let i = 0; i < 5; i++) assert.throws(() => db.prepare("DELETE FROM pending_flush_locks WHERE owner_token = ?").run(), /D1 unavailable/);
  assert.throws(() => db.prepare("DELETE FROM pending_flush_locks WHERE owner_token = ?").run(), RecoveryBudgetExhausted);
  assert.equal(submitted, 45);
});

test("Telegram exhaustion yields before writing another request-start marker", () => {
  const db = createRecoveryDatabase({});
  for (let i = 0; i < 40; i++) db.recoveryTelegramCheckpoint();
  assert.throws(() => db.recoveryCheckpoint(3), RecoveryBudgetExhausted);
  assert.throws(() => db.recoveryTelegramCheckpoint(), RecoveryBudgetExhausted);
});

test("webhook delegates share one budget and reserve only completion and fenced cleanup", () => {
  let submitted = 0;
  const raw = { prepare: () => ({ run: () => { submitted++; } }) };
  const db = createWebhookDatabase(raw);
  const proxy = new Proxy(db, {});
  assert.equal(createWebhookDatabase(proxy), proxy);
  for (let i = 0; i < 44; i++) proxy.prepare("SELECT 1").run();
  assert.throws(() => db.prepare("SELECT 1").run(), RecoveryBudgetExhausted);
  assert.throws(() => db.prepare("DELETE FROM processed_updates WHERE bot_id = ?").run(), RecoveryBudgetExhausted);
  proxy.prepare("UPDATE processed_updates SET state = 'completed' WHERE bot_id = ? AND owner_token = ?").run();
  for (let i = 0; i < 5; i++) db.prepare("DELETE FROM abuse_decision_locks WHERE bot_id = ? AND owner_token = ?").run();
  assert.throws(() => db.prepare("DELETE FROM abuse_decision_locks WHERE owner_token = ?").run(), RecoveryBudgetExhausted);
  assert.equal(db.used, 50);
  assert.equal(submitted, 50);
});

test("webhook Paid keeps its ceiling and a Free batch is rejected atomically", () => {
  let submitted = 0;
  const raw = {
    prepare: () => ({ run: () => { submitted++; } }),
    batch: (statements) => { submitted += statements.length; },
  };
  const free = createWebhookDatabase(raw);
  for (let i = 0; i < 43; i++) free.prepare("SELECT 1").run();
  assert.throws(() => free.batch([free.prepare("SELECT 1"), free.prepare("SELECT 2")]), RecoveryBudgetExhausted);
  assert.equal(submitted, 43);
  const paid = createWebhookDatabase(raw, "paid");
  for (let i = 0; i < 990; i++) paid.prepare("SELECT 1").run();
  assert.throws(() => paid.prepare("SELECT 1").run(), RecoveryBudgetExhausted);
  for (let i = 0; i < 10; i++) paid.prepare("DELETE FROM processed_updates WHERE owner_token = ?").run();
  assert.throws(() => paid.prepare("DELETE FROM processed_updates WHERE owner_token = ?").run(), RecoveryBudgetExhausted);
  assert.equal(paid.used, 1000);
});

for (const [plan, work] of [["free", 44], ["paid", 990]]) test(`${plan}: background renewals cannot consume a foreground result reservation`, async () => {
  let submitted = 0;
  const statement = { bind() { return this; }, run() { submitted++; return { meta: { changes: 1 } }; } };
  const db = createWebhookDatabase({ prepare: () => statement }, plan);
  for (let index = 0; index < work - 10; index++) db.prepare("SELECT 1").run();
  db.recoveryCheckpoint(6);
  for (let index = 0; index < 4; index++) assert.ok(await db.recoveryBackgroundRun("UPDATE a_lease SET expires_at = ?", "later"));
  assert.equal(await db.recoveryBackgroundRun("UPDATE a_lease SET expires_at = ?", "later"), null);
  assert.equal(submitted, work - 6);
  for (let index = 0; index < 6; index++) db.prepare("SELECT 1").run();
  assert.equal(submitted, work);
  assert.equal(await db.recoveryBackgroundRun("UPDATE a_lease SET expires_at = ?", "later"), null);
  assert.throws(() => db.prepare("SELECT 1").run(), RecoveryBudgetExhausted);
  db.prepare("DELETE FROM logical_message_guards WHERE state = 'claimed' AND owner_token = ?").run();
  assert.equal(db.used, work + 1);
});
