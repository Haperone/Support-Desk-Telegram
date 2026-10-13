import test from 'node:test';
import assert from 'node:assert/strict';
import { assertD1CompoundSelectLimit } from './helpers/d1-sql-limits.js';

test('D1 compound limit rejects six terms, with independent limits for subqueries and CTEs', () => {
  const five = Array.from({length: 5}, (_, i) => `SELECT ${i}`).join(' UNION ALL ');
  assert.doesNotThrow(() => assertD1CompoundSelectLimit(five));
  for (const operator of ['UNION', 'INTERSECT', 'EXCEPT']) {
    assert.throws(() => assertD1CompoundSelectLimit(`${five} ${operator} SELECT 6`), /too many terms/);
    assert.throws(() => assertD1CompoundSelectLimit(`SELECT * FROM (${five} ${operator} SELECT 6)`), /too many terms/);
  }
  assert.doesNotThrow(() => assertD1CompoundSelectLimit(`WITH a AS (${five}), b AS (${five}) SELECT * FROM a UNION SELECT * FROM b; ${five}`));
  assert.doesNotThrow(() => assertD1CompoundSelectLimit(`${five} /* UNION SELECT 6 */ -- UNION SELECT 7\n`));
  assert.doesNotThrow(() => assertD1CompoundSelectLimit(`SELECT 'UNION UNION UNION UNION UNION', "UNION", [UNION], \`UNION\``));
});
