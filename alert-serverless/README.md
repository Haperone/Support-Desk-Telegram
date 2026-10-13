# Alert bot status on Telegram Serverless

This optional component adds `/status`, `/health`, `/start`, and a refresh button to the same bot that sends Cloudflare alerts. Cloudflare keeps collecting metrics and sending notifications. Telegram handles status requests in private chats and configured support groups, replying in the originating topic.

Only configured administrators can read the status. Commands addressed to another bot are ignored. The public settings template authorizes nobody; the setup wizard generates settings for your installation.

## Recommended setup

Run `npm run setup` from the repository root and follow the optional Telegram Serverless stage. It creates a separate, ignored `.bootstrap-serverless/` workspace, generates the administrator and group settings, helps you sign in using CLI Access from BotFather, and checks the bot before deployment. Read the [first-launch guide](../DEPLOY_FIRST_TIME_RU.md) for details.

The alert bot must be separate from the manager bot. Use the same alert bot for Cloudflare notifications and the Telegram status interface. Each installation chooses its own bot names, IDs, groups, and timezone.

## Manual setup

1. Copy this directory to a separate local workspace. Keep CLI state and installation settings out of public Git history.
2. Set your administrator IDs, alert bot ID and username, permitted group IDs, timezone, and language in `tgcloud/lib/settings.js`. Supported languages are `en`, `ru`, `es`, and `zh`.
3. Enable Serverless in BotFather for the alert bot and run `npm run cli -- login` in the copied workspace. Enter its CLI Access token when prompted.
4. Inspect the existing application with `npm run cli -- status`. Preserve any existing modules; use targeted pushes.
5. From the repository root, run `pwsh -NoProfile -File scripts/configure-alert-status.ps1 -CloudflareOnly`. The script creates an encrypted local backup and keeps an existing status key.
6. Deploy your configured monitor using its installation-specific Wrangler configuration. For the generated setup, use the corresponding `monitor/wrangler.bootstrap.NAME.toml`; manual installations use their own `monitor/wrangler.toml`.
7. In the Serverless workspace, run `npm run cli -- push tgcloud/schema.js tgcloud/lib/ tgcloud/endpoints/`, then `npx --yes --package @tgcloud/cli@0.2.0 tgcloud migrate --safe`.
8. Run the configuration script with your monitor status URL and administrator ID: `pwsh -NoProfile -File scripts/configure-alert-status.ps1 -MonitorUrl 'https://monitor.example.workers.dev/health/status' -AdminId 123456789`. Replace both example values. For a wizard installation, use its built-in Serverless stage, which uses the correct generated workspace and configuration.
9. Push the handlers with `npm run cli -- push tgcloud/handlers/`. Check `npm run cli -- webhook` and, if needed, `npm run cli -- webhook sync`.
10. Open `/status` in the bot's private chat or use `/status@your_alert_bot` in a configured group. Ordinary alerts keep the route selected in the manager bot.

The configuration script uses the repository's `alert-serverless` directory for CLI access. For manual setup, run it from a separate copy of the whole repository with your own Cloudflare configuration and Serverless login. CLI input containing the status key is captured and never printed.

## What the status means

The screen reports database and application availability, check freshness, incidents, the alert route, and the latest confirmed alert send. A confirmed send means Telegram accepted the message, not that someone read it. This is not an end-to-end customer-message delivery test.

If Cloudflare fails, Telegram can show the last cached result with its age and an explicit warning. Requests within 30 seconds reuse the cache, including a failed check. The status credential is stored privately in Telegram's database, separately from the bot token.

`GET /health/status` requires the monitor's separate `STATUS_READ_TOKEN`. It returns 200 for a healthy result, 503 for a degraded result, 401 without the required credential, and 404 when the feature is unconfigured. It does not expose tokens or conversation text.

There is no independent scheduled watchdog or backup notification channel in this component. Status is checked on request, and Telegram remains a shared dependency. The runtime does not provide browser globals such as `URL`, `setTimeout`, or `AbortController`; the code uses the platform SDK's network behavior.

## Verification

Run `npm test` from the repository root to test both components, or from this directory for the Serverless tests. The tests use synthetic identities and do not require production credentials.

[Telegram Serverless documentation](https://core.telegram.org/bots/serverless).
