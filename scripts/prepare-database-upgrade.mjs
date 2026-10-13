import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const baselines = {
  support: { directory: "migrations", name: "0023_initial_schema.sql", config: "wrangler.toml" },
  monitor: { directory: "monitor/migrations", name: "0005_initial_schema.sql", config: "monitor/wrangler.toml" },
};
export const legacy = JSON.parse(readFileSync(new URL("../database/legacy-migrations.json", import.meta.url), "utf8"));
export const preflightName = "0000_legacy_upgrade_preflight.sql";
const literal = value => value == null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;

export function preflightSql(kind) {
  if (!Object.hasOwn(baselines, kind)) throw new Error("Choose support or monitor");
  const history = legacy[kind].map((entry, index) => `(${literal(entry.name)}, ${index + 1})`).join(",\n");
  return `-- Refuse fresh, imported-without-journal, or divergent databases before any old migration runs.
CREATE TABLE __legacy_upgrade_guard (ok INTEGER NOT NULL CONSTRAINT expected_contiguous_legacy_migration_history CHECK(ok = 1));
INSERT INTO __legacy_upgrade_guard(ok)
WITH history(name, position) AS (VALUES ${history})
SELECT COUNT(*) > 0 AND COUNT(*) = MAX(position)
  AND NOT EXISTS(SELECT 1 FROM d1_migrations WHERE name NOT IN (SELECT name FROM history))
FROM history JOIN d1_migrations USING(name);
DROP TABLE __legacy_upgrade_guard;
`;
}

// Assert structural compatibility before marking the new baseline as applied.
// Each statement stays small enough for D1, including the widest support table.
function assertRows(query, rows) {
  const matches = rows.map(row => `(${Object.entries(row).map(([key, value]) => `"${key}" IS ${literal(value)}`).join(" AND ")})`).join(" OR ") || "0";
  return `INSERT INTO __baseline_upgrade_guard(ok) SELECT (COUNT(*) = ${rows.length} AND COALESCE(SUM(CASE WHEN ${matches} THEN 1 ELSE 0 END), 0) = ${rows.length}) FROM ${query};`;
}

export function adoptionSql(kind) {
  if (!Object.hasOwn(baselines, kind)) throw new Error("Choose support or monitor");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    for (const entry of legacy[kind]) db.exec(entry.sql);
    const statements = [
      "-- One-time adoption after the archived migrations. No application data is changed.",
      "CREATE TABLE __baseline_upgrade_guard (ok INTEGER NOT NULL CONSTRAINT incompatible_database_schema CHECK(ok = 1));",
    ];
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const { name } of tables) {
      for (const pragma of ["table_xinfo", "foreign_key_list", "index_list"]) {
        // index_list.seq is an enumeration detail, not part of the schema.
        const projection = pragma === "index_list" ? 'name, "unique", origin, partial' : "*";
        const query = `(SELECT ${projection} FROM pragma_${pragma}(${literal(name)}))`;
        statements.push(assertRows(query, db.prepare(`SELECT * FROM ${query}`).all()));
      }
      for (const index of db.prepare("SELECT name FROM pragma_index_list(?)").all(name)) {
        const query = `pragma_index_xinfo(${literal(index.name)})`;
        statements.push(assertRows(query, db.prepare(`SELECT * FROM ${query}`).all()));
      }
    }
    const normalizedSql = "replace(replace(replace(replace(sql, char(13), ''), char(10), ''), char(9), ''), ' ', '')";
    const projection = `type, name, tbl_name, ${normalizedSql} AS definition`;
    const objects = db.prepare(`SELECT ${projection} FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
    // Include CHECK constraints, partial-index predicates and complete trigger bodies.
    for (const object of objects) {
      statements.push(assertRows(`(SELECT ${projection} FROM sqlite_schema WHERE name = ${literal(object.name)})`, [object]));
    }
    statements.push("DROP TABLE __baseline_upgrade_guard;");
    return statements.join("\n\n") + "\n";
  } finally { db.close(); }
}

export function prepareUpgrade(kind, { parent = tmpdir() } = {}) {
  const baseline = baselines[kind];
  if (!Object.hasOwn(baselines, kind)) throw new Error("Choose support or monitor");
  const configPath = resolve(root, baseline.config);
  let config = readFileSync(configPath, "utf8");
  if ((config.match(/^\[\[d1_databases\]\]\r?$/gm) || []).length !== 1) throw new Error("Upgrade requires a config with exactly one D1 database");
  const main = config.match(/^main\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const database = config.match(/^database_name\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!main || !database || !/^migrations_dir\s*=\s*"[^"]+"\s*$/m.test(config)) throw new Error("Unsupported Wrangler config: main, database_name and migrations_dir are required");
  const adoption = adoptionSql(kind);
  const directory = mkdtempSync(join(resolve(parent), `telegram-${kind}-upgrade-`));
  const migrations = join(directory, "migrations");
  mkdirSync(migrations);
  writeFileSync(join(migrations, preflightName), preflightSql(kind), { flag: "wx" });
  for (const entry of legacy[kind]) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(entry.name)) throw new Error("Invalid archived migration filename");
    writeFileSync(join(migrations, entry.name), entry.sql, { flag: "wx" });
  }
  writeFileSync(join(migrations, baseline.name), adoption, { flag: "wx" });
  const tomlPath = path => JSON.stringify(path.replaceAll("\\", "/"));
  config = config.replace(/^main\s*=\s*"[^"]+"\s*$/m, `main = ${tomlPath(resolve(dirname(configPath), main))}`)
    .replace(/^migrations_dir\s*=\s*"[^"]+"\s*$/m, `migrations_dir = ${tomlPath(migrations)}`);
  const outputConfig = join(directory, "wrangler.toml");
  writeFileSync(outputConfig, config, { flag: "wx" });
  return { directory, config: outputConfig, migrations, database };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/prepare-database-upgrade.mjs support|monitor");
  const result = prepareUpgrade(process.argv[2]);
  const shellQuote = value => `'${value.replaceAll("'", "''")}'`;
  console.log(`Prepared local upgrade files: ${result.directory}\nNo database commands have been executed.\nReview DATABASE_SETUP.md, then run in PowerShell:\nnpx wrangler d1 migrations apply ${shellQuote(result.database)} --remote --config ${shellQuote(result.config)}`);
}
