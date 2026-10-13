# SupportDeskTg contributor notes

Read `README.md` first; `README_RU.md` contains the Russian version. Use Node.js
22.13 or newer. `npm run setup` is the guided path for a new installation.

Application modules live in `src/`; the Worker entrypoint is `src/entry.js`.
Use `docs/README.md` for English/Russian guides. Run commands from the repository root.

- Keep installation-specific IDs, credentials, CLI state, and data out of Git.
- Preserve placeholder values in the checked-in Wrangler and Serverless settings.
  The wizard creates separate, ignored installation configuration.
- Run `npm test` and `node scripts/validate-migrations.mjs` after relevant changes.
  Use the Wrangler dry-run and generated-config validators for deployment changes.
- Never read or edit `alert-serverless/.tgcloud/`; use its supported CLI.
- Preserve unrelated changes. Do not commit, push, or deploy without authorization.
- GitHub publication and Cloudflare/Telegram deployment are separate operations.
