<div align="center">

# SupportDeskTg

**Customer support and feedback, right in Telegram**

**English** · [Русский](README_RU.md)

[Deploy the project](#quick-start) · [Features](#features) · [Guides](#detailed-guides)

</div>

---

**SupportDeskTg is a ready-to-deploy system for customer support and feedback in Telegram.** A user sends your bot a private message, and it appears in a dedicated topic in your support group. An operator replies in that topic, and the bot delivers the reply to the user. Media and message reactions are supported.

Connect several bots to one or more groups, add operators, assign conversations, and customize welcome messages, automatic replies, languages, and spam protection. A separate manager bot lets the team work with queues, transfer conversations to colleagues, and receive reminders and reports.

> [!NOTE]
> **No rented VPS is required:** the system runs on Cloudflare's free plan. For ordinary conversations, the estimate is **around 500 messages per day**, counting customer messages and operator replies together across all bots. This approximate estimate leaves room for background work; capacity depends on settings and usage. [How the estimate was calculated](#free-plan-estimate).

## Features

| Section | What you get |
| --- | --- |
| **[Conversations](#what-customers-get)** | Text, media, albums, replies, and reactions. |
| **[Team workflow](#team-workflow)** | Queues, assignments, transfers, and reminders. |
| **[Bot settings](#managing-service-bots)** | Multiple services, greetings, languages, and topic appearance. |
| **[Protection](#users-and-spam-protection)** | User search, restrictions, and suspicious-message checks. |
| **[Reports](#statistics-and-reports)** | Workload, response times, and scheduled reports. |
| **[System status](#alerts-and-system-status)** | Alerts, resource usage, and status on request. |
| **[Delivery](#delivery-and-recovery) and [storage](#storage-and-costs)** | Delivery recovery, retention periods, and cleanup. |

## Quick start

**For the first deployment, I recommend using Claude Code or Codex.** Copy the repository to your computer, open the assistant in the project folder, and ask it to deploy and configure the entire system. For example:

<details>
<summary><strong>A ready-to-use prompt for Claude Code or Codex</strong></summary>

> Deploy and configure the entire SupportDeskTg project in my Cloudflare account. Read the project instructions, use the setup wizard, help connect the Telegram bots, and verify message delivery in both directions. Tell me which actions and access you need from me.

</details>

Once you authorize access, the assistant can connect to Cloudflare through its CLI (Wrangler), create the required resources, configure the databases and application, deploy the project, and help verify it works. Signing in to accounts and creating bots in BotFather require your participation.

Initial deployment is the most demanding stage. After that, everyday use is much easier: conversations, operators, settings, and reports are available directly in Telegram.

The project includes a [setup wizard](#first-launch-using-the-setup-wizard): `npm run setup`. Its first step lets you choose Russian or English, and you can also use it to set up the project yourself.

---

## How a conversation works

1. A customer sends a message to a service bot.
2. A dedicated topic appears in the support group, showing the service and customer names. Further messages arrive in the same topic.
3. An operator replies in the topic. The customer receives the reply in the private chat with the bot they contacted.
4. The team can assign an operator, transfer the conversation, snooze it, or mark it resolved. If the customer writes again in a closed conversation, its topic reopens automatically.

To delete your reply for the customer and in its topic, send `/delete` as a reply to that message in the topic. The bot confirms customer deletion before removing the original and reports partial failures. Deletion is usually available within 48 hours. For an album, the command deletes the selected message, not the entire album.

**Deleting through Telegram's regular menu leaves the customer's copy.** A reminder appears in the pinned panel of a new or reopened topic, on conversation cards, and in help. Simply viewing a topic in Telegram produces no bot event, so a new popup on every visit is unavailable.

Several bots can share one group or use different groups. Each service has its own settings, users, and access rules.

<details>
<summary><strong>Which bots are used</strong></summary>

You choose each bot's name and @username when creating it in BotFather. In this guide, a **support bot** (or **service bot**) receives customer messages, the **manager bot** provides team tools and settings, and the **alert bot** sends system status notifications.

</details>

## What customers get

- Support through a normal private Telegram chat.
- Text, photos, videos, files, voice messages, stickers, and albums in both directions.
- Replies to specific messages, preserving the connection between question and answer.
- Standard Telegram reactions: adding, changing, and removing them in verified directions.
- A welcome message on `/start` and a receipt acknowledgement, when the owner has configured those texts.
- A Cloudflare Turnstile check for suspicious activity; ordinary conversations do not require a mandatory CAPTCHA.

`/start` alone does not create a conversation. The customer sends a message to begin. Internal team notes, moderation reasons, and management buttons are not forwarded to them.

## Team workflow

### Queues and conversation cards

The manager bot's private chat provides personal and shared queues, overdue conversations, and filters: needs reply, mine, waiting for customer, snoozed until today, resolved, and all conversations. A card shows the service, customer, assignee, waiting time, and a link to the topic.

From a card, you can:

- Take a conversation or remove its assignment.
- Transfer it to a colleague with an internal note.
- Snooze it for an hour or until the following morning.
- Mark it as waiting for the customer, resolve it, or return it to work.
- Close or reopen its Telegram topic.
- Inspect delivery, the customer profile, and action history.
- Return to the original results or move to the next conversation.

Closing a topic and resolving a conversation are separate actions: work state and waiting for a reply are tracked separately.

Manager bot commands in the support topic:

| Command | Action |
| --- | --- |
| `/case` | Open the conversation card directly in the topic. |
| `/close` · `/open` | Close or reopen the topic. |
| `/status` as a reply to an operator message | Check its delivery state. |

### Operators, responsibility, and reminders

The system has one primary administrator. They add and remove operators and assign a responsible and backup operator for each service. Operator selection shows their current workload.

The manager bot sends private notifications and reminders about unanswered conversations. Each service has configurable reminder and escalation times for drawing the backup operator's attention. **Waiting overview** helps identify overdue work, notification failures, and operators the bot cannot reach.

Operators can set their availability using `/available` and `/unavailable` in the manager bot's private chat. While unavailable, new conversations go to the backup operator or administrator.

<details>
<summary><strong>Operator access and permissions</strong></summary>

Each operator must first open the manager bot and press Start. SupportDeskTg permissions control access: being a Telegram group administrator does not automatically grant access to system settings. Operators work within their service access and assignments; connections, alerts, the plan, and cleanup belong to the primary administrator.

</details>

### Drafts and history

You can resume unfinished message editing, transfers, internal notes, and moderation input through **Drafts**. The activity log shows who changed assignments, user access, or settings and when. The manager bot also provides help for common tasks.

## Managing service bots

After the first installation, add services through **Manager bot → Support bots → Add service bot**. Enter an existing bot's token or create a new bot through Telegram's dialog if Bot Management Mode is enabled for the manager bot. Ordinary service registration does not require redeploying the project.

The connection wizard helps select a service name, topic prefix, and support group, checks bot permissions, and configures delivery. Choose an existing connected group or prepare a new one; you do not need to copy its ID manually.

Each service supports:

- Connecting or moving to another topic-based group. Existing history stays in the previous group, while working links lead to the current conversation.
- A responsible operator, backup operator, and reminder times.
- A readiness check and a **Test exchange**: a test message and reply through a dedicated test topic.
- Reaction checks in both directions. Verified directions can be enabled separately; successful verification of both enables them automatically.
- Pausing and resuming bots registered through the manager, preserving history and settings.
- Reconnecting the same bot when its credentials are unavailable.
- Removing a connection after active conversations and unfinished deliveries have been handled. This does not delete the bot in BotFather.

Details: [connecting services and groups](MANAGER_BOT_SETUP_RU.md#подключение-сервиса-и-группы), [reaction checks](REACTIONS_RU.md).

### Messages, languages, and topic appearance

#### Welcome messages and acknowledgements

Each service has separate settings for a welcome message on `/start` and an acknowledgement of a new or reopened conversation. Preview text before saving, disable it without deleting it, clear it, or copy text and sending settings from another service. Texts start empty: messages are sent only after configuration. The acknowledgement follows successful delivery to support, rather than every customer message.

#### Topic appearance

New topics can use a color and an emoji icon from Telegram's available catalog. Appearance applies when a topic is created, including a replacement for a deleted topic; existing topics are not restyled.

#### Languages

The supported languages are **English, Русский, Español, and 简体中文**. Each operator chooses their private manager interface language. The primary administrator separately chooses each service bot's customer message language; alerts and the status screen also have their own language settings. New services and private interfaces without a saved preference start in English. Authored messages, service names, and notes are not translated automatically.

## Users and spam protection

Use **Users** and **Search** to find someone by Telegram ID, `@username`, or part of their name. Filters include blocked, restricted, awaiting verification, suspicious, trusted, and recent users.

A profile shows the conversation, message queue, access restrictions, and history. An operator with the relevant access can block or unblock a user, set or remove a temporary restriction, grant or revoke trust, and reset risk and verification requirements. Actions show their consequences before confirmation and are recorded in the activity log.

Automatic protection considers message frequency, repeated text and links, mentions, failed checks, and signs of a mass attack. Protection settings are separate for each service.

- Suspicious users receive a Turnstile check. Messages accepted into the verification queue wait for it to finish; a new support topic is not created beforehand.
- After successful verification, eligible queued messages are delivered to support. Background tasks continue delivery if it is delayed.
- Repeated serious violations can trigger temporary restrictions. Permanent blocks are set by an operator.
- During a mass attack, checks are strengthened for new, unknown users. A service can use automatic protection, force the stronger mode, or turn that mode off.

Messages stopped by a block, manual restriction, or frequency limit may not be saved. The customer may need to resend them after the restriction is removed.

## Statistics and reports

**Statistics** shows support health now and results for today, yesterday, the last 7 or 30 days, or selected dates. Reports can cover the whole system, one service, or a group.

Reports include:

- New and returning users, created topics, openings, reopenings, and closures.
- Current queues, unassigned work, and overdue conversations.
- First and subsequent response times and the share of replies within the service's target.
- Activity by service and responsible operator.
- Incoming and outgoing messages, delivery, errors, and protection events.
- Cloudflare resource usage and comparison with the previous equal period.

Current problems appear at the beginning. Past errors are separated from active failures. Missing history or measurements are marked as incomplete instead of being replaced with zero. Account resources are visible to the primary administrator; operator reports follow their access permissions.

Enable daily, weekly, and monthly reports in the manager bot's private chat. Choose the recipient, services or group, time, and time zone. A test send is available. Reports use the recipient's language; subscriptions start disabled.

Scheduled reports cover the completed day, week, or month.

[Report metrics and schedules](SUPPORT_STATISTICS_RU.md).

## Alerts and system status

### What the alert bot reports

A separate alert bot reports delivery problems, protection events, and resource usage. The monitor checks:

- Cloudflare limit usage: application requests (Workers), database reads and writes (D1), and KV storage operations. It warns at 70%, 85%, and 95% and estimates when a resource may run out.
- Database sizes and growth, including databases belonging to other projects in the same account.
- Queue delays, lack of progress, and sends with an unknown outcome.
- Incoming Telegram delivery: a missing or incorrect delivery address, accumulated updates, and delivery errors.
- Application error signals, Telegram restrictions, and monitoring failures. Additional configuration enables checks for Cloudflare execution errors, exceeded resources, and CPU execution time.

It also reports verification events, temporary restrictions, blocks, and unblocks. Notifications include the service, user, time, state, and a topic link when available; conversation text is not copied into them.

In **Manager bot → Alerts**, the primary administrator connects or replaces the alert bot and chooses one route: a group topic or private chats with the administrator and selected operators. Delivery to the new destination is checked before switching. You can disconnect the bot; monitoring continues, but notifications are not sent.

The monitor runs every 15 minutes and distributes checks across services and databases. This does not mean every possible failure will be detected within 15 minutes. Ordinary alerts are triggered by events and thresholds: silence alone does not confirm that the system is healthy.

[Alert setup](MANAGER_BOT_SETUP_RU.md#алерт-бот), [user access events](USER_ACCESS_ALERTS_RU.md), [monitoring capabilities](OPERATIONS_RETENTION_EN.md).

### Status in the same bot using Telegram Serverless

You can optionally add a Telegram Serverless status screen to the alert bot. Cloudflare continues sending ordinary alerts, while Telegram handles `/status`, `/health`, `/start`, and the refresh button.

The screen shows availability of both databases and the main application, check freshness, active problems, the notification route, and the times of the last confirmed send and last sending failure. The primary administrator opens it in a private chat or the connected group; replies stay in the same topic. In groups, use `/status@your_alert_bot`.

If Cloudflare is unavailable, the Telegram part can show the last saved result with its age and a warning. **This is status on request: independent automatic monitoring outside Cloudflare and a backup notification channel are not implemented.** A confirmed send means Telegram accepted the message, not that someone read it. Use the test exchange to check actual conversations.

[Status setup and limitations](alert-serverless/README.md).

## Delivery and recovery

Background tasks resume interrupted operations and delivery of saved messages and albums. A deleted customer topic can be recreated during the next delivery. When a service moves, old topics direct operators to the current conversation.

The manager bot provides **Delivery problems**, detailed message status, and manual recovery for one or all services. The screen explains what is preventing delivery: verification, a restriction, a disabled bot, an inaccessible group, or a Telegram error.

An unknown sending outcome is shown separately and is not retried blindly. The operator needs to inspect the conversation, because an automatic retry could duplicate a message. A completed recovery attempt does not mean the entire queue was delivered.

[Using manual recovery](MANUAL_DELIVERY_RU.md).

## Storage and costs

In **Plan and storage**, the primary administrator sees database sizes, growth forecasts, and retention settings. You can:

- Select a group and browse its topics.
- Prepare cleanup of old message links, exclude individual topics, or protect them from cleanup.
- Confirm that a topic was deleted, delete a selected topic, or set a reminder about it.
- Clean up confirmed deleted topics and completed technical records.
- Set retention periods and automatic cleanup limits.
- Follow job progress and errors, cancel remaining work, and pause or resume a full reset.
- Perform a full reset of conversation data with separate confirmation; an emergency manager entry is available when the database is full.

<details>
<summary><strong>Cleanup and full reset rules</strong></summary>

Automatic cleanup does not remove live topics merely because they have been quiet. It follows the configured rules for confirmed deleted topics. Manual actions have a preview. Cancelling a job does not undo deletions already completed.

Cleaning up old message links keeps the Telegram conversation history, but replies and reactions to those old messages stop synchronizing.

A full reset clears conversation records and queues across all services, including unsent messages. Telegram topics and conversation history, settings, operators, and user restrictions remain. Conversation statistics are cleared and scheduled reports are disabled. The next new conversation creates a new topic.

</details>

The **Free / Workers Paid** selection determines which limits to track. Paid requires a renewal day. The manager's switch does not purchase a Cloudflare subscription: it reflects a plan you have already enabled. Account resources are shared with other projects, so free operation depends on total usage.

[Cleanup and retention](OPERATIONS_RETENTION_EN.md), [plan settings](monitor/README.md#единый-план-freepaid).

<a id="free-plan-estimate"></a>
<details>
<summary>How free-plan message capacity was estimated</summary>

As of October 13, 2026, the estimate is **around 500 messages per day for ordinary conversations**, across all bots combined. A customer message and an operator reply count as two messages. If almost every message starts a new conversation, the estimate drops to **around 300 messages per day**.

Cloudflare's free plan provides [100,000 Workers requests per day](https://developers.cloudflare.com/workers/platform/pricing/) and [100,000 D1 rows written and 5 million rows read per day](https://developers.cloudflare.com/d1/platform/pricing/). A message requires several writes, including statistics, delivery records, and indexes, so the request limit does not equal message capacity.

The calculation checked the current code locally with a bot connected through the manager in Free mode: 10 new conversations, 50 customer follow-ups, 50 operator replies, and 10 reactions. Telegram used simulated responses; delivery was verified. Row changes from application code and triggers were counted with a conservative allowance for updating all indexes. This gave approximately 204 writes for a customer's first message, 152 for a follow-up, 126 for an operator reply, and 46 for a reaction. This estimates write usage; it does not measure billed operations or performance on Cloudflare.

This message mix, including reactions on roughly one in ten messages, averages about 149 writes per message. For 500 messages, that is about 74,500 writes. Another 288 background runs were simulated, matching the current five-minute schedule — about 3,100 writes in the test scenario. Around 22% of the daily limit remains for monitoring, menus, reports, cleanup, and additional retries.

Actual capacity also depends on database reads, execution time, albums, CAPTCHA, delivery retries, accumulated history, and other projects in the account. The monitor shows actual usage; the estimate does not guarantee fixed throughput.

</details>

## Where data is stored

Telegram remains the main conversation archive. The database stores profiles, user-to-topic links, assignments, restrictions, internal notes, settings, statistics, and delivery information. Necessary data, including captions and media information, is temporarily retained for queue and album recovery.

Tokens and keys do not need to be pasted into source files. Tokens for bots registered through the manager are stored encrypted. The setup wizard hides secret input and creates protected backups of generated keys. Keep those backups with your installation data.

## First launch using the setup wizard

A new installation requires:

- **Windows** and **Node.js 22.13+ with npm**.
- **A Cloudflare account**.
- **A manager bot**, created through BotFather.
- **A Telegram group with topics**.

Bots need administrator permissions to work with topics. The wizard explains the further keys and permissions required.

Download the project, open PowerShell in its folder, and run:

```powershell
npm run setup
```

**The first step is Русский / English selection.** The wizard then helps you sign in to Cloudflare, checks the manager bot and group, prepares databases, sets up user verification, deploys the application and monitor, checks their connection, and connects Telegram. Before creating resources, it shows what will be installed and asks for confirmation.

### If setup is interrupted

If setup is interrupted, run the wizard again to select the saved installation and resume. You can change the language without repeating completed stages. At the end, the wizard offers to connect alert bot status on Telegram Serverless now or later. This requires a separate alert bot and its CLI Access from BotFather.

### After installation

1. Open the manager bot's private chat and send `/start`; change the interface language if needed.
2. Add your first service bot and configure its messages and topic appearance.
3. Run the test exchange and reaction checks.
4. Add operators and assign responsibilities.
5. Connect the alert bot, choose a notification destination, and enable reports if needed.

The wizard is for a new installation and resuming its setup. Use the separate upgrade guide for an existing installation.

---

## Detailed guides

Several detailed guides are currently in Russian. The setup wizard and bot interfaces support English.

| Task | Guide |
| --- | --- |
| Prepare a new installation or resume setup | [First launch](DEPLOY_FIRST_TIME_RU.md) |
| Configure the manager, groups, operators, and alerts | [Manager bot](MANAGER_BOT_SETUP_RU.md) |
| Understand reports and schedules | [Support statistics](SUPPORT_STATISTICS_RU.md) |
| Verify reactions | [Reactions](REACTIONS_RU.md) |
| Recover delivery | [Manual recovery](MANUAL_DELIVERY_RU.md) |
| Configure retention and cleanup | [Storage](OPERATIONS_RETENTION_EN.md) |
| Configure monitoring and the Cloudflare plan | [Monitor](monitor/README.md) |
| Add status to the alert bot | [Telegram Serverless](alert-serverless/README.md) |
| Understand protection and moderation alerts | [User access events](USER_ACCESS_ALERTS_RU.md) |
| Upgrade an existing installation's databases | [Database upgrade](DATABASE_SETUP_EN.md) |
| Find the earlier setup process without a manager bot | [Archived guide](DEPLOY_LEGACY_RU.md) |

<details>
<summary><strong>For developers: local checks</strong></summary>

To check the project locally, run `npm test`. Tests do not require production tokens or external accounts.

</details>

---

[Back to top](#supportdesktg)
