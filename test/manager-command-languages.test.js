import test from 'node:test';
import assert from 'node:assert/strict';
import { managerCommandList } from '../worker.js';

test('manager command descriptions follow personal language and access', () => {
  const descriptions = new Map();
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const operator = managerCommandList(locale);
    const primary = managerCommandList(locale, true);
    assert.ok(operator.every(item => !['addbot', 'storage', 'alerts'].includes(item.command)));
    assert.ok(primary.some(item => item.command === 'storage'));
    assert.deepEqual(primary.slice(0, operator.length), operator);
    assert.ok(operator.every(item => item.description.length <= 256));
    descriptions.set(locale, operator.find(item => item.command === 'menu').description);
  }
  assert.equal(new Set(descriptions.values()).size, 4);
  assert.equal(managerCommandList()[0].description, managerCommandList('en')[0].description);
});
