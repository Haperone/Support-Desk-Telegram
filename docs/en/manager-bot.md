# Manager bot, groups, and operators

[Documentation](../README.md) · [Русский](../ru/manager-bot.md)

The manager is a separate Telegram bot. It provides the team's private workspace,
group menus, configuration, and personal notifications. Service bots continue to
relay customer messages. You choose the names of all bots in your installation.
For initial deployment, follow [First launch](first-launch.md).

## Permissions and language

Add the manager to every support group as an administrator with permission to pin
messages and manage topics. Service bots need permission to send messages and manage
topics. An alert bot only needs group access when that group is its notification route.

Send `/start` privately to the manager. Its interface defaults to English; **Interface
language** changes your own language. The administrator chooses a service's customer
language in its settings. English, Russian, Spanish, and Simplified Chinese are available.

Repeated menu commands within ten seconds reuse the same private menu where possible.
An uncertain Telegram send is not blindly repeated; open a fresh screen if needed.

## Add a service and connect a group

1. In the manager's private chat, open service management and add a service bot.
2. Choose an existing connected group, or create a group with topics and add the manager.
   Send the provided one-time `/connect …` command in General from your own account.
3. Add the service bot and complete the permissions/webhook checks. Both token-based
   registration and Managed Bots use this group-connection process. Send tokens only
   in the manager's private chat.
4. Review the service's readiness card. Run the test exchange and [reaction check](reactions.md).
5. Configure the welcome message, acknowledgement/automatic replies, their enabled
   states, customer language, and appearance of new topics. You can copy the welcome
   and acknowledgement settings from another service after reviewing them.
6. Select primary and backup operators and the reminder/escalation intervals.

The test exchange creates a separate test topic and only completes after both
directions succeed. It is not a customer case. The bot attempts to close the topic
after success; if necessary, retry with `/close@your_manager_bot` in that test topic.

## Group menus and moving a service

The manager pins a menu in General. `/menu` repairs a removed pin or creates a new menu
when the saved message has been deleted. If Telegram did not confirm a send, inspect
General first: reply `/adoptmenu` to the existing menu, or use `/retrymenu` only when
the message really is absent. This avoids duplicate menus after uncertain delivery.

Use the service's group-connection action to move it. The wizard prepares the new
group and changes the route, then refreshes the old and new group menus. If only a
menu update fails after the route changes, use **Continue group connection** from
the private home screen. Old conversation history stays in its original group.
Replies from old topics are not forwarded to customers: follow the link to the
current topic and send the answer there.

Old confirmations cannot revert a newer route. A move waits for an unfinished
reopening or uncertain delivery to be resolved; a final, reported delivery failure
does not block movement forever.

## Operators and the work queue

Ask each operator to send `/start` privately to the manager, then add them from
**Operators**. Revoke access there when needed. Primary and backup operators must
be active; if the primary cannot receive messages, assignment falls back to the
backup or main administrator. Telegram's explicit blocked-bot response marks an
operator unavailable. After unblocking, they should send `/start`, then `/available`.

Operators use their private case list; the administrator can see all cases and the
overall overdue queue. Lists show the service, customer, waiting time, and current
workload. An open topic is not necessarily waiting for an operator: cases waiting
for the customer remain visible too.

From a case card you can take or release assignment, defer for an hour, mark resolved,
transfer to another operator with an internal note, and open or close the topic.
`/case` in a customer topic opens its manager card. A transfer continues in the
operator's private chat for the note. Stale buttons show current state instead of
repeating a completed action.

Reminder/escalation presets are 15/30, 30/60, 60/120, or 120/240 minutes. The default
is 30/60 minutes; the recovery scheduler checks every five minutes. Private delivery
failures and uncertain results are visible in the waiting-control screen. Updating
an existing notification's topic link does not create another notification.

## Delivery, moderation, and storage

Use the queues/delivery/drafts section to inspect saved messages. The control and
recovery section provides system status, waiting control, and safe delivery retries.
Reply `/status` to an operator message in its topic to inspect that message's delivery.
An uncertain outcome needs inspection before another send; see [Delivery recovery](delivery-recovery.md).

Customer cards provide moderation and history; search accepts ID, username, or name.
Protection settings include the service's AUTO/ON/OFF schedule. Notifications about
restrictions are described in [User access events](access-alerts.md).

The administrator opens Cloudflare plan and storage settings privately. Storage
size, retention rules, technical cleanup, and a full reset concern the whole system;
topic and manual-delivery views can be scoped to a group. A full reset requires its
own confirmation in the same private chat. See [Storage](retention.md) and [Reports](reports.md).

## Alert bot

The administrator connects a separate bot under **Alerts**. Start that bot privately
before first connection. Choose one route: a topic in a connected support group, or
private chats of the administrator and selected operators. Each private recipient
must have started the alert bot too. You can switch routes, replace the bot, or disable it.

The token is stored encrypted in the monitor database. The original token message
is deleted where possible. Preserve `ALERT_CONFIG_KEY` with your backups: replacing
it prevents decryption of the saved token. The key is initialized by the wizard or
`scripts/initialize-alert-config-key.ps1` after the alert-configuration migration.

Legacy `ALERT_BOT_TOKEN`, `ALERT_CHAT_ID`, and `ALERT_THREAD_ID` settings are the initial
route until configuration moves into the interface. Disabling alerts there does not
silently restore the legacy route. `ALERT_CONFIG_REQUIRED` prevents fallback after
loss of the encryption key. Sending alerts alone needs no webhook; the optional
[Serverless status interface](alert-status.md) has its own webhook.

## Upgrades and recovery

Apply pending support migrations through `0056` and monitor migrations through `0007`
for the current reporting features, then deploy both Workers using your installation's
configuration. See [Database upgrade](database-upgrade.md); these features need no new
bot or statistics-specific secret.

Before any service has moved groups, a saved previous release may be usable after
checking webhooks and both directions of delivery. Keep added database tables; do
not run migrations backwards. After a service moves, **do not deploy an older Worker
that assumes the original shared group**: it may route messages to the wrong topics.
If only the manager fails, repair its token, permissions, or webhook while retaining
current service routes. To move a service back, use the current group wizard.
Restoring a database backup requires reconciling messages received since that backup.
