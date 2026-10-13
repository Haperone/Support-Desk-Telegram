# Archived setup without a dedicated manager

[Documentation](../README.md) · [Русский](../ru/legacy-setup.md)

This guide explains the earlier configuration-based installation for maintainers of
existing instances. **For a new installation use [First launch](first-launch.md).**
The current manager interface replaces the old service-bot management menus in General.
Do not assume every archived command is still available in the current runtime.

## How the earlier installation was arranged

The main Cloudflare Worker hosted several service bots defined in `BOT_REGISTRY`.
Each entry supplied a stable service ID, display name, Telegram username, locale,
topic prefix, and environment binding names for the token and webhook secret.
`SUPPORT_GROUP_ID` selected the shared forum group. A separate Worker monitored usage.
Customers still wrote privately to a service bot and received replies sent from topics.

The file-based registry named secret bindings; actual bot tokens belonged in Wrangler
secrets. A webhook secret was separately generated and supplied to both the Worker
and Telegram. `PUBLIC_BASE_URL` identified the main Worker, and Turnstile used a
public site key plus a secret stored outside source control.

## Inspect an existing instance before updating

1. Identify its Cloudflare account, Worker names, database IDs, service bindings,
   generated/manual configurations, and current webhook URLs.
2. Export fresh D1 backups with unique filenames outside the repository. Preserve
   encryption keys and local setup state. Confirm that your intended configuration
   targets those databases, not another installation.
3. Inspect the migration journal. Use [Database upgrade](database-upgrade.md) for an
   old pre-baseline schema; apply pending migrations normally for a baseline database.
   Do not recreate populated databases, erase the journal, or replay initial CREATE SQL.
4. Create a separate manager bot, give it group permissions, and follow
   [Manager setup](manager-bot.md). Its own token and webhook secret are separate from
   service-bot credentials.
5. Preserve existing service identities and credentials while checking their adoption
   into managed storage. Avoid registering a second copy of a bot already configured.
6. Check message delivery in both directions with test accounts, including reopening,
   reactions, moderator access, alerts, and the group menu.

Existing static services and dynamically registered services can coexist. Registered
tokens are encrypted in D1 using `BOT_REGISTRY_KEY`; keep the existing key when
upgrading. An adopted static service can continue using its managed credentials after
removal from the static registry. Removing a registry entry is not a substitute for
disabling a service through the current manager.

## Commands and paths today

Run commands from the repository root. `wrangler.toml` now loads `src/entry.js`;
the monitor loads `monitor/service-entry.js`. A wizard-generated installation uses
its own `wrangler.bootstrap.NAME.toml` configurations. Always pass the intended config.

Use the current manager's private workspace for operators, service settings, alerts,
queues, storage, and reports. Group commands such as `/case`, `/close`, and `/open`
operate on the current topic; old General management panels are historical.

`node scripts/telegram-webhook.mjs manager` configures the manager route using hidden
token/secret input for a manually configured installation. Do not disable another
bot's webhook or drop pending updates merely to obtain IDs or test an upgrade.
Wrangler deploy publishes local code directly; a Git push alone does not deploy it.

After moving any service to another group, do not roll back to a Worker that assumes
one shared group. Use the current manager to move it back if necessary, resolving
unfinished and uncertain deliveries first. Keep newly added tables during code rollback.

The Russian archive retains the longer historical walkthrough. The English guides
above provide the current, supported installation and recovery procedures.
