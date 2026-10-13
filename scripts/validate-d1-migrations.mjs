import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const WRANGLER = "4.128.0";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function npxCommand() {
  if (process.platform !== "win32") return { command: "npx", args: [] };
  // Run npm's JS entrypoint so Windows paths never become shell code.
  const roots = [dirname(process.execPath), process.env.APPDATA && join(process.env.APPDATA, "npm"),
    ...(process.env.PATH || "").split(";")].filter(Boolean);
  const cli = roots.map((root) => join(root, "node_modules", "npm", "bin", "npx-cli.js")).find(existsSync);
  if (!cli) throw new Error("Cannot locate npm/bin/npx-cli.js; install npm beside Node or on PATH");
  return { command: process.execPath, args: [cli] };
}

function configValue(config, key) {
  const match = config.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"));
  if (!match) throw new Error(`Missing ${key} in Wrangler config`);
  return match[1];
}

function validate(configPath, label) {
  const source = readFileSync(configPath, "utf8");
  const configDir = dirname(resolve(configPath));
  const migrationsDir = resolve(configDir, configValue(source, "migrations_dir"));
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  if (!files.length) throw new Error(`No migrations in ${migrationsDir}`);
  const tempRoot = mkdtempSync(join(tmpdir(), "telegram-d1-migrations-"));
  try {
    const tempMigrations = join(tempRoot, "migrations");
    mkdirSync(tempMigrations);
    for (const name of files) copyFileSync(join(migrationsDir, name), join(tempMigrations, name));
    const tempConfig = join(tempRoot, "wrangler.toml");
    const mainPath = resolve(configDir, configValue(source, "main")).replaceAll("\\", "/");
    const databaseName = configValue(source, "database_name");
    writeFileSync(tempConfig, `name = "d1-migrations-audit"\nmain = ${JSON.stringify(mainPath)}\n` +
      `compatibility_date = ${JSON.stringify(configValue(source, "compatibility_date"))}\n` +
      `[[d1_databases]]\nbinding = ${JSON.stringify(configValue(source, "binding"))}\n` +
      `database_name = ${JSON.stringify(databaseName)}\ndatabase_id = "${ZERO_UUID}"\nmigrations_dir = "migrations"\n`);
    const npx = npxCommand();
    const result = spawnSync(npx.command,
      [...npx.args, "--yes", `wrangler@${WRANGLER}`, "d1", "migrations", "apply", databaseName,
        "--local", "--config", tempConfig, "--persist-to", join(tempRoot, "state")],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env: { ...process.env, CI: "1" } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${label} local D1 migration failed:\n${result.stdout}\n${result.stderr}`);
    console.log(`${label}: ${files.length} migrations applied by Wrangler ${WRANGLER} on a fresh local D1`);
  } finally {
    const tempDir = realpathSync(tmpdir());
    const resolvedRoot = realpathSync(tempRoot);
    const within = relative(tempDir, resolvedRoot);
    if (!within || within.startsWith("..") || isAbsolute(within) || !basename(tempRoot).startsWith("telegram-d1-migrations-")) {
      throw new Error("Refusing cleanup outside the temporary D1 workspace");
    }
    rmSync(resolvedRoot, { recursive: true, force: true });
  }
}

validate("wrangler.toml", "support database");
validate("monitor/wrangler.toml", "monitor database");
