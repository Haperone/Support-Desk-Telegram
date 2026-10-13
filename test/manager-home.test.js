import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { claimManagerHome, completeManagerHome, releaseManagerHome } from '../manager-home.js';

test('home leases cover concurrent commands, retries, expired claims, and independent operators', async () => {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  const at = ms => new Date(Date.UTC(2026, 8, 30, 12) + ms);
  try {
    const first = await claimManagerHome(db, 7, 100, at(0));
    assert.ok(first);
    assert.equal(await claimManagerHome(db, 7, 101, at(1)), null, 'concurrent command is covered');
    const other = await claimManagerHome(db, 8, 102, at(1));
    assert.ok(other, 'another operator has an independent lease');
    await completeManagerHome(db, 7, first.token, 777);
    assert.equal(await claimManagerHome(db, 7, 100, at(2)), null, 'completed update is not replayed');
    assert.equal(await claimManagerHome(db, 7, 99, at(2)), null, 'older update is ignored');
    const refresh = await claimManagerHome(db, 7, 101, at(5000));
    assert.equal(refresh.messageId, 777);
    await releaseManagerHome(db, 7, refresh.token);
    const retry = await claimManagerHome(db, 7, 101, at(6000));
    assert.equal(retry.messageId, 777);
    const expired = await claimManagerHome(db, 7, 103, at(70_000));
    assert.ok(expired, 'expired lease can be taken over without spinning');
    assert.equal(expired.messageId, null, 'outside the burst, open a fresh screen');
    await completeManagerHome(db, 7, retry.token, 999);
    assert.equal(db.sqlite.prepare('SELECT completed FROM manager_home_screens WHERE operator_id=7').get().completed, 0,
      'a former owner cannot finish a newer claim');
    await completeManagerHome(db, 7, expired.token, 888);
    assert.equal(db.sqlite.prepare('SELECT message_id FROM manager_home_screens WHERE operator_id=7').get().message_id, 888);
  } finally { db.close(); }
});
