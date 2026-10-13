# Support reports and schedules

[Documentation](../README.md) · [Русский](../ru/reports.md)

Open statistics in the manager's private chat. Reports bring together customers,
cases, waiting time, operator workload, delivery, failures, protection, and resources.
A dash means no measurement, not zero. Expand sections in the report message for details.

## Manual reports and access

Choose **Now**, today, yesterday, the last 7 or 30 calendar days including today,
or a custom completed date range of at most 366 days. Enter custom dates as
`2026-10-01 2026-10-02`; the end date is included. Leaving the menu closes the input form.
Scope the report to all services, one service, or a support group.

Now shows the current queue, delivery, verification, and resources. Response-time
statistics, period totals, and comparison with a previous equal period need a dated report.
Repeated requests within a minute can reuse a cached snapshot; its actual time is shown.
Changing language changes presentation without recalculating the data.

Administrators can see the whole system. Operators see services they are responsible
for, and the accessible portion of services where they only have assigned cases.
Account resources and D1/Worker errors are administrator-only and remain system-wide
even with a service/group filter. Permissions are checked again for scheduled delivery.

## Scheduled reports

Daily, weekly, and monthly subscriptions are enabled separately. An administrator
can configure their own subscription or an active operator's; operators manage only
their own. Recipients must first send `/start` to the manager bot.

Choose the scope and send a time setting such as `09:00 Europe/Budapest 1`.
The last value is the weekday: 0 is Sunday, 1 Monday, through 6 Saturday. The timezone
also applies to manual reports for the person making the setting.

| Frequency | Reported period | Default |
| --- | --- | --- |
| Daily | Previous complete day in the selected timezone | 09:00 |
| Weekly | Previous Monday–Sunday week | Monday, 09:00 |
| Monthly | Previous calendar month | First day, 09:00 |

The default timezone is `Europe/Budapest`; nothing is sent until enabled. Reports
arrive in the manager's private chat in the recipient's language. Incident alerts
continue independently. A test report is shown to you or sent to the selected operator.

The shared recovery scheduler sends at most one report per pass within its D1 budget.
Delivery can be delayed; missed historical periods are not sent as a backlog.
During daylight-saving transitions, a nonexistent local time is moved forward by
the transition length; a repeated time uses its first occurrence only.

Refresh on a scheduled/test report uses the subscription's current scope, timezone,
and most recent completed period. It does not change your manual report selection.
Old input forms cannot overwrite a changed schedule; explicit enable/disable buttons
do not toggle back on repeated clicks.

An uncertain or interrupted send is not repeated for the same period. Confirmed 429
responses defer a safe retry using `retry_after`. Confirmed permanent Telegram 4xx
failures disable the subscription; a blocked bot or missing private chat requires
the recipient to start/unblock the manager. Oversized reports ask for a narrower scope.

## Reading the numbers

- **Customers:** unique Telegram IDs across all services. A person writing to a second
  service is not automatically a new customer globally. A service report uses that
  service's first known activity; unknown history is not labelled as a returning user.
- **Topics and cases:** new topic records include recreation after deletion or a move.
  A first message held in verification without a topic does not create a topic count.
  Open topics and cases waiting for an answer are separate; resolved cases with an open
  topic are shown separately. Deferred cases return to waiting after their deadline.
- **Response time:** measured only after confirmed delivery of a human reply. Welcome
  messages, automatic replies, and manually changing to “waiting for customer” do not
  count. A burst of incoming messages keeps the original waiting start. One waiting
  cycle produces one sample; first/reopened responses are separate from later cycles.
  Median, 90th percentile, and on-time share use measured cycles and the service's
  deadline at the time of reply. A newer incoming message during delivery keeps the
  newer waiting cycle open. Millisecond rounding avoids false deadline misses.
- **Operators:** the assigned responsible operator at answer/closure time, not proof
  that they personally sent every message and not a quality ranking. Current workload
  is shown separately.
- **Delivery:** counts logical original messages once across quarantine, recovery,
  and normal delivery. Incoming counts use receipt time; delivered/recovered counts
  use confirmation time. Verification-held messages are separate from technical queues.
- **Failures:** recorded Telegram request failures, message problems, recovered
  deliveries, D1 errors, and observed Worker intervals. Overlapping monitoring windows
  are deduplicated. Missing observations are not evidence that no failures occurred.
- **Resources:** current Free/Paid measurements and quota periods, not historical quota
  percentages for the chosen report dates. Measurements over an hour old or dated in
  the future are unavailable. Storage growth requires nearby boundary measurements.

Incomplete case state, missing history, collection gaps, and sampling limits are
labelled explicitly. A zero based on incomplete data is not a confirmation of health.
Reports recheck permissions and database generation after collection; stale cached
data is not reused after a full reset or relevant access changes.

## Storage and installation

Statistics store compact facts, not conversation text, files, or tokens. Collection
starts with the statistics migrations; old totals are not reconstructed as if complete.

- Up to 20,000 facts and 20,000 service/customer profiles; at most 2,000 new facts per
  UTC day. These are telemetry budgets, not support-message quotas.
- Facts are kept for up to 400 days and pruned in bounded batches. Collection failure
  should not interrupt customer delivery.
- Report queries read bounded samples of up to 5,001 rows; excess data is marked incomplete.
- One minute-lived cache entry per operator and at most three subscriptions per recipient.
- A full conversation reset clears facts, statistics profiles, and cache, resets the
  history start, and disables subscriptions while retaining their settings.
- Monitor runtime history keeps non-overlapping windows for up to 400 days, capped
  at 50,000 windows. Missing windows do not mean zero errors.

For an existing installation, apply support migrations through `0056` and monitor
migrations through `0007`, then deploy both Workers. Runtime errors require
`MONITOR_RUNTIME_ENABLED`; otherwise that measurement is unavailable. Follow
[Database upgrade](database-upgrade.md) and [Monitoring](monitoring.md).
