# Database setup and upgrade

Fresh installations apply a baseline followed by subsequent updates:

- Support: `migrations/0023_initial_schema.sql`.
- Bot messages and navigation: `migrations/0024_bot_messages_and_navigation.sql`.
- Bot message setup reminders: `migrations/0025_bot_setup_notices.sql`.
- Manual delivery runs and queue indexes: `migrations/0026_manual_delivery_runs.sql`.
- CAPTCHA prompt IDs and visible status recovery: `migrations/0027_verification_notice_status.sql`.
- User access alert outbox and transition triggers: `migrations/0028_user_access_alerts.sql`.
- Telegram bot registration and encrypted credentials: `migrations/0029_bot_registration.sql`.
- Separate reaction direction checks and switches: `migrations/0030_reaction_checks.sql`.
- Manager, service groups and storage controls: migrations through `0056_statistics_review.sql`.
- Independent monitor: `monitor/migrations/0005_initial_schema.sql` through `0007_statistics_runtime.sql`.

Together these include the current tables, indexes, constraints, triggers and singleton defaults. Released baselines remain immutable; later features use incremental migrations so live databases can upgrade safely. There is no separate `monitor/schema.sql` copy.

## Fresh, empty databases

Create the D1 databases and set their IDs in the respective Wrangler configs. From the repository root:

```powershell
npx wrangler d1 migrations apply telegram-support --remote --config wrangler.toml
npx wrangler d1 migrations apply support-monitor --remote --config monitor/wrangler.toml
```

Wrangler applies only pending files: `0023` through `0056` for fresh support databases, `0005` through `0007` for the monitor. Subsequent runs skip applied files. Use `migrations apply`, since importing SQL directly with `d1 execute --file` does not register the baseline in Wrangler's journal.

## Databases already using baseline 0023

Apply pending support migrations `0024` through `0056` using the normal config before deploying the new support Worker. Already applied files are skipped. Existing conversations and settings are preserved; already open conversations do not receive a retroactive auto-reply. Per-bot welcomes and auto-replies start empty and disabled. Set the `BOT_REGISTRY_KEY` secret once, then deploy the support Worker. Apply any pending monitor migration before deploying the monitor. For the current manager setup, see [MANAGER_BOT_SETUP_RU.md](MANAGER_BOT_SETUP_RU.md). If 0029 is already installed, keep its existing registry key.

## Existing databases with historical migrations

Do not replay the fresh CREATE script on an existing database or clear `d1_migrations`. Use the one-time transition:

1. Verify database names and IDs in both configs. Export backups with new filenames and keep the data outside Git:

   ```powershell
   npx wrangler d1 export telegram-support --remote --config wrangler.toml --output support-before-schema-upgrade.sql
   npx wrangler d1 export support-monitor --remote --config monitor/wrangler.toml --output monitor-before-schema-upgrade.sql
   ```

2. Prepare local upgrade files using Node.js 22.13+ with `node:sqlite`:

   ```powershell
   node scripts/prepare-database-upgrade.mjs support
   node scripts/prepare-database-upgrade.mjs monitor
   ```

   The helper only writes temporary files and a config copy. It prints a PowerShell Wrangler command for each database and never contacts Cloudflare. Prepare again if you change the original config.

3. Pause message processing and background jobs for both Workers during maintenance. Run the printed commands after checking Wrangler's target database confirmation. Use temporary configs only for this database transition, not deployment.

   The transition verifies the historical journal, applies missing legacy steps, validates the resulting schema, then registers the baseline without recreating tables. Conversations, message mappings, bans and settings remain intact; historical transformations of temporary operational data retain their original behavior.

4. Return to the normal config files. Check that the baseline is no longer pending:

   ```powershell
   npx wrangler d1 migrations list telegram-support --remote --config wrangler.toml
   npx wrangler d1 migrations list support-monitor --remote --config monitor/wrangler.toml
   ```

   Apply any later pending migrations with the normal config before following the [rollout guide](OPERATIONS_RETENTION_EN.md) to deploy and resume processing.

After interruption, fix the cause and repeat the same generated command; completed steps are skipped. Missing or divergent migration journals and incompatible schemas are rejected. Do not bypass validation by changing the journal. Databases imported manually without a journal need an individual comparison; the automatic transition leaves them alone. Fresh baseline databases do not need this transition.

## Historical compatibility

`database/legacy-migrations.json` bundles the previous 26 files for the transition helper and regression tests. Normal Wrangler runs do not read it. Keep the archived filenames and SQL unchanged.

Future released schema changes still need incremental migrations so existing installations can upgrade without losing data. Do not modify an already applied baseline either.

`node scripts/validate-migrations.mjs` checks current schemas. `node --test test/database-schema.test.js` checks equivalence with the archived chain and data preservation when upgrading from every historical version.

References: [D1 migration tracking](https://developers.cloudflare.com/d1/reference/migrations/), [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
