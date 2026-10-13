# User access and moderation alerts

[Documentation](../README.md) · [Русский](../ru/access-alerts.md)

The alert bot sends access events to the destination selected under **Alerts** in the
manager's private chat: one group topic or private chats of the administrator and
selected operators. Legacy chat/topic variables only supply the initial file-based route.

## Events and contents

Notifications cover CAPTCHA requested, failed, passed, expired, or cancelled; automatic
and manual restrictions; expiry or removal of restrictions; bans/unbans; messages stopped
by a rate limit; a full verification queue; and an unavailable abuse check.

An alert identifies the service bot, customer, Telegram ID, event time, restriction
deadline, and current state. It links to an existing topic. Without a topic, use the
manager's search by Telegram ID. A missing stored name falls back to the ID.
Alerts do not copy private conversation text, but may include an operator's internal
ban reason. Receiving an alert does not itself change access permissions.

**Passing CAPTCHA does not prove delivery.** The alert shows the remaining verification
queue. Messages stopped by a rate limit or manual restriction may not have been saved;
ask the customer to resend them when access is restored.

## Timing, grouping, and retries

An accepted Telegram update or verification result schedules background dispatch.
Reprocessing an update does not create a duplicate event. Up to three events are grouped
into one message, so a backlog can delay alerts. Each event retains its original time;
the current-state summary is evaluated when the alert is prepared.

Rate-limit and full-queue events are grouped by customer, bot, reason, and five-minute
window. At most one alert per such window reports the count accumulated before sending.
Normal delivered messages do not produce these alerts.

The main Worker's five-minute scheduler and monitor's fifteen-minute scheduler continue
dispatch and deadline processing using a shared send lock. Confirmed Telegram failures
can be retried; 429 responses honor `retry_after`.

An uncertain send, including a crash after dispatch started, is **not automatically
repeated**. The event records `uncertain_at`; logs identify `user_access_alert_send_failed`
with `uncertain: true`. Telegram acceptance cannot be guaranteed in this case.

Confirmed and uncertain events are pruned in batches after 30 days. Pending events
remain until processed. A full history reset clears the queue and cancels old batches
that have not started. Expiry is rechecked before sending so an extended restriction
is not reported as removed; another active restriction is shown in the current state.

## Installation and verification

For current code, use [First launch](first-launch.md) or [Database upgrade](database-upgrade.md),
then [connect the alert bot](manager-bot.md#alert-bot). Historical migration `0028`
introduced the event queue; it needs the main Worker's `USER_ACCESS_ALERTS` service
binding and a monitor with the corresponding entrypoint. Upgrade the monitor before
the main Worker when introducing that binding to an existing installation.

Test by restricting and unrestricting your own test customer. Check that both events
arrive at the selected destination. Allow the scheduler to process a backlog before
investigating `user_access_alerts_deferred` and `user_access_alert_send_failed` logs.
Use normal verification flow for a CAPTCHA check instead of flooding messages.

From the repository root, run `node --test test/user-access-alerts.test.js` for focused
checks, `npm test` for the full suite, and `node scripts/validate-wrangler.mjs` for builds.
