import test from "node:test";
import assert from "node:assert/strict";
import { usagePeriod, resolveMonitorEnvironment } from "../plan.js";
import { fetchCloudflareUsage, parseConfig, formatUsageAlert } from "../worker.js";

test("Paid period follows subscription renewal, including leap years and short months", () => {
  const check = (now, day, start, end) => {
    const result = usagePeriod({ RECOVERY_D1_PLAN: "paid", WORKERS_BILLING_DAY: day }, new Date(now));
    assert.equal(result.start, start + "T00:00:00.000Z");
    assert.equal(result.end, end + "T00:00:00.000Z");
    assert.equal(result.key, "paid:" + start);
  };
  check("2026-09-06T12:00:00Z", 17, "2026-08-17", "2026-09-17");
  check("2026-09-17T00:00:00Z", 17, "2026-09-17", "2026-10-17");
  check("2026-03-01T00:00:00Z", 31, "2026-02-28", "2026-03-31");
  check("2028-02-29T00:00:00Z", 31, "2028-02-29", "2028-03-31");
  check("2028-02-28T23:59:59Z", 31, "2028-01-31", "2028-02-29");
  check("2027-01-02T12:00:00Z", 6, "2026-12-06", "2027-01-06");
  const free = usagePeriod({}, new Date("2026-09-06T23:59:59Z"));
  assert.equal(free.key, "2026-09-06");
  assert.equal(free.end, "2026-09-07T00:00:00.000Z");
  for (const day of [undefined, 0, 32, 1.5, "17x"]) {
    assert.throws(() => usagePeriod({ RECOVERY_D1_PLAN: "paid", WORKERS_BILLING_DAY: day }, new Date()), /renewal|BILLING_DAY/);
  }
});

test("missing renewal day points to the plan screen available in this deployment", () => {
  assert.throws(() => usagePeriod({ RECOVERY_D1_PLAN: "paid" }, new Date()), /General \/plan/);
  assert.throws(() => usagePeriod({ RECOVERY_D1_PLAN: "paid", SUPPORT_PLAN: {} }, new Date()), /Adminushka → Plan and storage → Cloudflare plan/);
  assert.throws(() => parseConfig({ RECOVERY_D1_PLAN: "paid", SUPPORT_PLAN: {} }), /Adminushka → Plan and storage → Cloudflare plan/);
});

test("Paid uses monthly allowances and separate overrides; Free daily settings cannot leak", async () => {
  const original = { RECOVERY_D1_PLAN: "free", LIMIT_WORKER_REQUESTS: "100000", LIMIT_D1_ROWS_READ: "5000000" };
  let selected = "paid";
  const linked = { ...original, SUPPORT_PLAN: { async getPlan() { return { plan: selected, billingDay: 17 }; } } };
  const resolved = await resolveMonitorEnvironment(linked);
  assert.equal(linked.RECOVERY_D1_PLAN, "free");
  assert.deepEqual(parseConfig(resolved).limits, {
    worker_requests: 10_000_000, d1_rows_read: 25_000_000_000, d1_rows_written: 50_000_000,
    kv_reads: 10_000_000, kv_writes: 1_000_000, kv_deletes: 1_000_000, kv_lists: 1_000_000,
  });
  assert.equal(parseConfig({ ...resolved, PAID_LIMIT_WORKER_REQUESTS: "12345678" }).limits.worker_requests, 12345678);
  selected = "free";
  assert.equal(parseConfig(await resolveMonitorEnvironment(linked)).limits.worker_requests, 100000);
  assert.throws(() => parseConfig({ RECOVERY_D1_PLAN: "paid" }), /renewal/);
  await assert.rejects(resolveMonitorEnvironment({ SUPPORT_PLAN: { getPlan: async () => ({ plan: "pro" }) } }), /Invalid/);
  await assert.rejects(resolveMonitorEnvironment({ SUPPORT_PLAN: { getPlan: async () => { throw new Error("D1 unavailable"); } } }), /D1 unavailable/);
});

test("every GraphQL dataset uses the same billing period and Paid alerts describe overage", async () => {
  const now = new Date("2026-09-06T12:00:00Z");
  const requests = [];
  const settings = { RECOVERY_D1_PLAN: "paid", WORKERS_BILLING_DAY: 17, KV_NAMESPACE_NAMES: '{"ns":"One"}' };
  const usage = await fetchCloudflareUsage(settings, now, async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return Response.json({ data: { viewer: { accounts: [{
      workersInvocationsAdaptive: [{ sum: { requests: 9_600_000 }, dimensions: { scriptName: "bot" } }],
      d1AnalyticsAdaptiveGroups: [], kvOperationsAdaptiveGroups: [],
    }] } } });
  });
  assert.equal(requests.length, 4);
  for (const request of requests) {
    const workers = request.query.includes("workersInvocationsAdaptive");
    assert.equal(request.variables.start, workers ? "2026-08-17T00:00:00.000Z" : "2026-08-17");
    assert.equal(request.variables.end, workers ? now.toISOString() : "2026-09-06");
  }
  const text = formatUsageAlert("worker_requests", usage.worker_requests, 10_000_000, "95", null, usage, now, "Europe/Budapest");
  assert.match(text, /2026-08-17 → 2026-09-17/);
  assert.match(text, /additional usage is billed, not blocked/);
  assert.doesNotMatch(text, /LIMIT CRITICAL|Reset:|daily quota/);
});
