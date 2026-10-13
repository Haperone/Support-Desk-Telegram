import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { assertD1CompoundSelectLimit } from './d1-sql-limits.js';

export class SqliteD1 {
  constructor(migrations, maxQueries = Infinity) {
    this.sqlite = new DatabaseSync(":memory:");
    this.queries = 0;
    this.maxQueries = maxQueries;
    this.statements = [];
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
    }
  }
  prepare(sql) {
    const statement = (params = []) => {
      const execute = (method) => {
        if (++this.queries > this.maxQueries) throw new Error("Test D1 statement limit exceeded");
        this.statements.push(sql);
        assertD1CompoundSelectLimit(sql);
        return this.sqlite.prepare(sql)[method](...params);
      };
      return {
        bind: (...args) => statement(args),
        first: async () => execute("get") || null,
        all: async () => ({ results: execute("all") }),
        run: async () => {
          const before = this.sqlite.prepare('SELECT total_changes() AS n').get().n;
          execute('run');
          const changes = Number(this.sqlite.prepare('SELECT total_changes() AS n').get().n - before);
          return { success: true, meta: { changes, rows_written: changes } };
        },
      };
    };
    return statement();
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  close() { this.sqlite.close(); }
}
