# First launch

[Documentation](../README.md) · [Русский](../ru/first-launch.md)

Use this guide for a **new installation with empty databases**, or to resume its
setup. For an existing service, follow [Database upgrade](database-upgrade.md).
Run all commands below from the repository root, even though this guide lives in `docs/`.

## Recommended: the setup wizard

You need Windows, Node.js 22.13 or later with npm, a Cloudflare account, a separate
manager bot created through [BotFather](https://t.me/BotFather), and a Telegram
group with topics. Add the manager as an administrator with permission to manage
topics and pin messages.

```powershell
npm run setup
```

The wizard walks you through the following steps:

1. Choose **English** or **Русский**, before signing in to any service.
2. Name the installation or select a saved one. Sign in to Cloudflare if needed;
   choose an account when several are available.
3. Enter the manager bot token in the hidden prompt. Send `/setup@your_manager_bot`
   in General from your own Telegram account. Confirm the discovered group; you do
   not need to copy numeric IDs. Missing permissions can be corrected and checked again.
4. Confirm the Workers subdomain. Create a **Managed Turnstile** widget for the exact
   hostname shown by the wizard. Supply the site key and secret key from that widget.
   The application sets the `support_verify` action itself.
5. Choose the timezone and alert language. Alerts support English, Russian, Spanish,
   and Simplified Chinese independently of the wizard language. Review the resource
   names and enter **CREATE** when ready.
6. The wizard creates two D1 databases, applies migrations, stores secrets, creates
   protected key backups, and deploys the two Workers in the required order. It asks
   for a Cloudflare analytics token with D1 read access; see [Monitoring](monitoring.md).
7. It checks the manager HTTP route, service bindings, and both databases before
   connecting Telegram's webhook. Pending Telegram updates are preserved.
8. Optionally connect [alert bot status on Telegram Serverless](alert-status.md),
   now or later.

Secret input is hidden and is not saved in source files or the setup state. External
Wrangler and Telegram CLI messages retain their own language. Wrangler may separately
ask for confirmation when applying migrations.

## Resume an interrupted setup

Run the wizard again and select the saved installation, or use its displayed command:

```powershell
node scripts/bootstrap.mjs support-myteam-2026
```

You can change the wizard language without repeating completed steps or changing the
existing alert language. The wizard verifies the account, bot, database identities,
configuration, migrations, and code before reusing progress. It stops when a generated
configuration was edited manually, so those changes can be reconciled.

Keep the generated `wrangler.bootstrap.NAME.toml`, first-deploy configuration,
`monitor/wrangler.bootstrap.NAME.toml`, `.bootstrap-state-NAME.json`, and the key backup
directory shown by the wizard. They are installation data and are excluded from Git.
Windows DPAPI backups require the same Windows user on the same computer. A missing
backup for an existing encryption key stops setup instead of silently replacing it.

For later releases, use your generated configurations with `--config`. The root
configuration may describe a different installation. A completed first launch is not
a general update command; the wizard then offers the optional status component.

## Connect the optional status interface later

First connect a separate alert bot through **Alerts** in the manager's private chat.
Enable Serverless for that same alert bot in BotFather and obtain CLI Access. Run:

```powershell
node scripts/bootstrap.mjs support-myteam-2026 --status-bot
```

The wizard uses the saved installation, checks the bot and existing webhook, and
creates an ignored `.bootstrap-serverless/NAME/` workspace. It refuses to replace an
unrelated application or webhook. The administrator can then use `/status` privately
or `/status@your_alert_bot` in the configured group, with replies in the original topic.
This component checks status on request; it does not run an independent scheduled watchdog.

## Manual installation

The wizard is preferable, but these are the steps for a manually configured installation.
Use your own resource names and IDs throughout. These commands use the repository's
root configuration files, not a wizard-generated installation.

1. Run `npx.cmd --yes wrangler@4.149.0 login` and `whoami`.
2. Before setting a webhook, send `/setup` in General and run
   `node scripts/telegram-setup.mjs`. Verify the account, forum group, and bot permissions.
   The script does not disable an existing webhook.
3. Create the support and monitor databases:

   ```powershell
   npx.cmd --yes wrangler@4.149.0 d1 create telegram-support --config wrangler.toml
   npx.cmd --yes wrangler@4.149.0 d1 create support-monitor --config monitor/wrangler.toml
   ```

4. Put each database ID in its own configuration. Set the main administrator ID
   (exactly one), group ID, manager username without `@`, public Worker URL, and
   Turnstile site key. Keep `BOT_REGISTRY = "[]"`; add services through the manager.
   Set the monitor account ID, verify Worker names/service bindings, and ensure the
   five rate-limit namespace IDs are unused in your account.
5. Verify the schemas, then apply pending migrations to the intended empty databases:

   ```powershell
   node scripts/validate-d1-migrations.mjs
   npx.cmd --yes wrangler@4.149.0 d1 migrations apply telegram-support --remote --config wrangler.toml
   npx.cmd --yes wrangler@4.149.0 d1 migrations apply support-monitor --remote --config monitor/wrangler.toml
   ```

6. Use `wrangler secret put NAME --config FILE` to store `MANAGER_BOT_TOKEN`,
   `MANAGER_WEBHOOK_SECRET`, and `TURNSTILE_SECRET_KEY` for the main Worker, and
   `CF_ANALYTICS_TOKEN` for the monitor. The webhook secret is a separately generated
   random value; BotFather does not issue it. Keep the same value for webhook setup.
7. From the root, run `powershell.exe -NoProfile -File scripts/initialize-bot-registry-key.ps1`
   and `powershell.exe -NoProfile -File scripts/initialize-alert-config-key.ps1`.
   Keep their encryption-key backups outside Git. Run `npm test` and
   `node scripts/validate-wrangler.mjs`.
8. For the first deployment only, temporarily comment out the three main Worker
   service bindings `STORAGE_MONITOR`, `USER_ACCESS_ALERTS`, and `ALERT_SETTINGS`.
   Deploy the main Worker, then the monitor; restore those bindings and deploy the
   main Worker again:

   ```powershell
   npx.cmd --yes wrangler@4.149.0 deploy --config wrangler.toml
   npx.cmd --yes wrangler@4.149.0 deploy --config monitor/wrangler.toml
   # Restore the three main Worker service bindings before this command.
   npx.cmd --yes wrangler@4.149.0 deploy --config wrangler.toml
   ```

9. Run `node scripts/telegram-webhook.mjs manager` with the same token and webhook
   secret saved in Cloudflare. It sets `/tg/manager` without dropping pending updates.

Stop after a failed command. If a database already contains an installation, use the
upgrade guide rather than treating it as a new database. Wrangler deploy publishes
local files directly; pushing Git commits does not deploy the Worker.

## Verify the first service

Open the manager's private chat and send `/start`. Select your interface language,
add a service bot, run the test exchange and reaction checks, then add operators.
Each operator must start the manager privately to receive notifications. Connect
the alert bot, select its destination, and check the Cloudflare plan and storage.

Using your own test customer account, send a message to the service bot, answer in
the created topic, close the conversation, and check reopening with a new message.
The wizard's health probes do not replace this end-to-end exchange.

See [Manager bot](manager-bot.md) for everyday setup. For troubleshooting use
`wrangler tail --config YOUR_CONFIG`; do not delete databases or pending Telegram
updates as a diagnostic step. Local help: `node scripts/bootstrap.mjs --help`.
