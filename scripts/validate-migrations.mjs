import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function validate(dir) {
  const names = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  if (!names.length) throw new Error(`No schema migrations in ${dir}`);
  const prefixes = names.map((name) => name.split("_")[0]);
  if (new Set(prefixes).size !== prefixes.length) throw new Error(`Duplicate migration prefix in ${dir}`);
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  try {
    for (const name of names) db.exec(readFileSync(resolve(dir, name), "utf8"));
    const result = db.prepare("PRAGMA integrity_check").get();
    if (String(result.integrity_check).toLowerCase() !== "ok") throw new Error(`Integrity check failed for ${dir}`);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error(`Foreign key check failed for ${dir}`);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    let widest = 0;
    for (const { name } of tables) {
      const columns = db.prepare("SELECT COUNT(*) AS total FROM pragma_table_xinfo(?)").get(name).total;
      if (columns > 100) throw new Error(`${dir}: ${name} has ${columns} columns, exceeding the D1 limit of 100`);
      if (columns >= 90) console.warn(`${dir}: ${name} has ${columns}/100 columns; schema is close to the D1 limit`);
      widest = Math.max(widest, columns);
    }
    console.log(`${dir}: ${names.length} migrations OK; ${tables.length} tables, widest ${widest}/100 columns`);
  } finally { db.close(); }
}

validate("migrations");
validate("monitor/migrations");
