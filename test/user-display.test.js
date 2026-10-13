import test from 'node:test';
import assert from 'node:assert/strict';
import { customerName } from '../src/user-display.js';

test('customer display falls back from placeholder names to username or ID', () => {
  assert.equal(customerName({ first_name: '-', username: 'example_customer', user_id: 101 }), '@example_customer');
  assert.equal(customerName({ first_name: '—', last_name: 'Family', username: 'handle' }), 'Family');
  assert.equal(customerName({ first_name: '   ', username: null, user_id: 42 }), '42');
  assert.equal(customerName({ first_name: 'Testifier', username: 'test', user_id: 7 }), 'Testifier');
});
