# Monitoring and Cloudflare plan

[Documentation](../README.md) · [Русский](../ru/monitoring.md)

The monitor is a separate Cloudflare Worker. Its fifteen-minute Cron checks usage,
storage, delivery, and health, saves measurements in D1, and sends Telegram alerts.
The manager's **Alerts** settings select the bot and destination. Optional
[Telegram Serverless status](alert-status.md) adds an on-demand status screen to that bot.

## What it checks

- Workers requests, D1 rows read/written, and KV reads/writes/deletes/lists for the
  current Free UTC day or Paid billing month.
- Usage thresholds of 70/85/95%, once per level, metric, and period. Free and Paid
  snapshots and deduplication are kept separate.
- A forecast from a snapshot around an hour earlier, when usage is at least 30%,
  growth is positive, and the remaining time is within `PREDICTIVE_WARNING_HOURS`.
- Top Worker scripts and configured KV namespaces when those analytics dimensions
  are available. Account-wide totals are collected separately.
- Current D1 sizes and capacity, account storage, ready/stalled/uncertain delivery
  queues, webhook configuration/backlog/errors, and sampled application failures.
- Optional Worker exceptions and CPU measurements when runtime collection is enabled
  and its fields, units, traffic, and limits are verified.

After three consecutive Cloudflare API failures, the monitor attempts a health alert;
after recovery it sends one recovery notification. Telegram HTTP status and API result
are checked. A failed alert is not recorded as successfully delivered.

The monitor uses `MONITOR_DB`, not KV. `SUPPORT_PLAN` reads the configured plan and
`SUPPORT_HEALTH` reads aggregate application health; the monitor has no direct binding
to the support database or conversation text. See [Operational retention](retention.md)
for job budgets, partial measurements, storage forecasts, and incident lifecycle.

## Setup and credentials

Use [the setup wizard](first-launch.md) for a new installation. Manual installations
must configure `monitor/wrangler.toml`, create the monitor database, and apply all
pending migrations through `0007`. Existing historical schemas need the
[database transition](database-upgrade.md), not a replay of the initial schema.

Set your `CF_ACCOUNT_ID`, timezone, and `MONITOR_LOCALE` (`en`, `ru`, `es`, or `zh`).
Check that service bindings name your main Worker. Alerts are configured privately
through the manager; `ALERT_CHAT_ID` and `ALERT_THREAD_ID` only describe a legacy route.

Create a Cloudflare API token with the analytics read permissions needed by Workers,
D1, and KV queries. D1 size measurement also needs **D1 Read**, either on that token
or on a separate `CF_D1_READ_TOKEN`. Global API Key, Workers Edit, KV Write, and
Account Edit are not needed for these monitoring queries.

From the repository root, store the token as a secret using your monitor config:

```powershell
npx wrangler secret put CF_ANALYTICS_TOKEN --config monitor/wrangler.toml
```

Do not put tokens in TOML, JavaScript, documentation, or Git. The alert configuration
key is provisioned by the wizard or `scripts/initialize-alert-config-key.ps1`; keep its
DPAPI backup. A separate `STATUS_READ_TOKEN` is used for Serverless status, not the
Telegram bot token. See [Manager bot](manager-bot.md#alert-bot) for routes and key recovery.

## Free and Paid

The administrator selects the plan under the manager's plan/storage menu. The monitor
reads it each run. Until an explicit choice is saved, the main Worker's `RECOVERY_D1_PLAN`
provides the default; choosing the configuration option restores that behavior.
Changing a saved plan needs no deployment, while changing an environment variable does.

Paid requires the subscription renewal day (1–31). Period boundaries use UTC; a short
month uses its last day when needed. Without a known renewal day, monthly data is not
reported as confirmed. A standalone monitor without `SUPPORT_PLAN` must set its own
`RECOVERY_D1_PLAN` and `WORKERS_BILLING_DAY`.

| Metric | Configured Free daily default | Configured Paid monthly included default |
| --- | ---: | ---: |
| Workers requests | 100,000 | 10,000,000 |
| D1 rows read | 5,000,000 | 25,000,000,000 |
| D1 rows written | 100,000 | 50,000,000 |
| KV reads | 100,000 | 10,000,000 |
| KV writes, deletes, lists — each | 1,000 | 1,000,000 |

These are the defaults implemented in the project; verify your account's current
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).
Paid overage can incur charges rather than stopping requests. The usage screen is
not a full billing estimate; CPU and storage charges are separate.

`LIMIT_*` adjusts Free thresholds. Paid overrides use `PAID_LIMIT_WORKER_REQUESTS`,
`PAID_LIMIT_D1_ROWS_READ`, `PAID_LIMIT_D1_ROWS_WRITTEN`, and the corresponding
`PAID_LIMIT_KV_*` variables. Per-invocation D1 query budgets remain a separate limit.
If the plan cannot be read, emergency Free daily warnings are explicitly unconfirmed;
they do not silently become a confirmed Paid account's ordinary history.

## Verify the deployment

The monitor entrypoint is `monitor/service-entry.js`. The main Worker is
`src/entry.js`; initial circular binding setup is described in [First launch](first-launch.md).
Run local checks before a real deploy:

```powershell
node --test monitor/test/monitor.test.js
node scripts/validate-wrangler.mjs
```

After deployment, inspect `monitor_check_complete`, the plan/period fields, and
breakdown status. Compare usage with the dashboard for the same period, allowing
analytics delay. If fields or breakdowns are unavailable, inspect the live GraphQL
schema and token permissions. Test alert thresholds, deduplication, topic delivery,
and recovery from a Telegram error in a separate test environment.

`KV_NAMESPACE_NAMES` optionally maps namespace IDs to labels; only listed IDs receive
namespace breakdowns. Raw usage snapshots are pruned after seven days. Reset times
are displayed using the selected IANA timezone and daylight-saving rules.

## Limits of monitoring

Jobs rotate within statement, network, and time budgets, so a fifteen-minute Cron
does not guarantee that every resource is checked every fifteen minutes. An immediate
quota spike can exhaust the account before a warning. Aggregated GraphQL data is
not an exact billing meter. Missing measurements are not zero and do not prove recovery.

Daily summary and `/usage` are not implemented; `DAILY_SUMMARY=false` is a reserved
compatibility setting. The monitor shares Cloudflare and Telegram dependencies with
alert delivery and cannot guarantee an alert during a total outage of either provider.
The Serverless component provides on-demand status and cached results, not an independent
scheduled watchdog or backup notification channel.
