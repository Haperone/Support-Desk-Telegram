import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve, relative, isAbsolute } from "node:path";

const WRANGLER = "4.128.0";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function npxCommand() {
  if (process.platform !== "win32") return { command: "npx", args: [] };
  // .cmd files require a shell on Windows. Invoke npm's JS entrypoint directly
  // so paths with spaces and non-ASCII characters never become shell code.
  const roots = [dirname(process.execPath), process.env.APPDATA && join(process.env.APPDATA, "npm"),
    ...(process.env.PATH || "").split(";")].filter(Boolean);
  const cli = roots.map((root) => join(root, "node_modules", "npm", "bin", "npx-cli.js")).find(existsSync);
  if (!cli) throw new Error("Cannot locate npm/bin/npx-cli.js; install npm beside Node or on PATH");
  return { command: process.execPath, args: [cli] };
}

function removeTemporary(root, target, recursive = false) {
  const within = relative(root, resolve(target));
  if (!within || within.startsWith("..") || isAbsolute(within) || !basename(target).startsWith(".wrangler-ci-")) {
    throw new Error("Refusing cleanup outside the temporary Wrangler workspace");
  }
  rmSync(target, { recursive, force: true });
}

function validate(configPath, label) {
  const dir = realpathSync(dirname(resolve(configPath)));
  const outDir = mkdtempSync(join(dir, ".wrangler-ci-"));
  const tempConfig = `${outDir}.toml`;
  let config = readFileSync(configPath, "utf8");
  config = config.replaceAll("REPLACE_WITH_D1_DATABASE_ID", ZERO_UUID);
  writeFileSync(tempConfig, config);
  try {
    const npx = npxCommand();
    const result = spawnSync(
      npx.command,
      [...npx.args, "--yes", `wrangler@${WRANGLER}`, "deploy", "--dry-run", "--config", tempConfig, "--outdir", outDir],
      { stdio: "inherit", encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${label} Wrangler dry-run failed with exit ${result.status}`);
    console.log(`${label}: Wrangler ${WRANGLER} dry-run OK`);
  } finally {
    removeTemporary(dir, tempConfig);
    removeTemporary(dir, outDir, true);
  }
}

validate("wrangler.toml", "support worker");
validate("monitor/wrangler.toml", "monitor worker");
