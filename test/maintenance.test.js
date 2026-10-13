import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { SqliteD1 } from './helpers/sqlite-d1.js';

for (const kind of ['uncertain', 'unknown_actor']) {
  test(`bounded maintenance drains ${kind} albums without orphaning their remaining items`, async () => {
    const db = new SqliteD1(new URL('../migrations/', import.meta.url), 45);
    const env = { SUPPORT_DB: db, STORAGE_GUARD_ENABLED: 'true', BOT_REGISTRY: JSON.stringify([
      { id: 'bot', displayName: 'Bot', topicPrefix: 'Bot', tokenBinding: 'TOKEN', webhookSecretBinding: 'SECRET', enabled: false },
    ]) };
    const oldMs = Date.now() - 40 * 86400000;
    const direction = kind === 'unknown_actor' ? 'support_to_user' : 'user_to_support';
    const seed = (album, sourceChat, receivedAt) => {
      const time = new Date(receivedAt).toISOString();
      db.sqlite.prepare(`INSERT INTO media_groups(bot_id, direction, media_group_id, source_chat_id, target_chat_id,
        thread_id, user_id, last_received_at, created_at, delivery_started_at, request_started_at,
        delivery_uncertain_at, delivery_alerted_at, operator_identity_unknown_at, operator_identity_alerted_at)
        VALUES('bot', ?, ?, ?, -100, 50, 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(direction, album, sourceChat, receivedAt, time, time, time, time, kind === 'uncertain' ? time : null,
          kind === 'unknown_actor' ? time : null, kind === 'unknown_actor' ? time : null);
      for (let item = 0; item < 10; item++) {
        db.sqlite.prepare(`INSERT INTO media_group_items(bot_id, direction, media_group_id, source_chat_id,
          message_id, media_type, file_id, received_at, delivery_uncertain_at)
          VALUES('bot', ?, ?, ?, ?, 'photo', 'file', ?, ?)`)
          .run(direction, album, sourceChat, item, receivedAt, time);
      }
    };
    try {
      for (let album = 0; album < 11; album++) seed(String(album), 1, oldMs);
      // The same album ID in another chat must neither be deleted nor block old cleanup.
      seed('0', 2, Date.now());
      const tick = async () => {
        db.queries = 0;
        await worker.scheduled({}, env, null);
        assert.ok(db.queries <= 45);
        assert.equal(db.sqlite.prepare(`SELECT COUNT(*) n FROM media_group_items i WHERE NOT EXISTS(
          SELECT 1 FROM media_groups g WHERE g.bot_id = i.bot_id AND g.direction = i.direction
            AND g.media_group_id = i.media_group_id AND g.source_chat_id = i.source_chat_id)`).get().n, 0);
      };
      await tick();
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM media_group_items WHERE source_chat_id = 1').get().n, 10);
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM media_groups WHERE source_chat_id = 1').get().n, 1);
      await tick();
      await tick();
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM media_group_items WHERE source_chat_id = 1').get().n, 0);
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM media_groups WHERE source_chat_id = 1').get().n, 0);
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM media_group_items WHERE source_chat_id = 2').get().n, 10);
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM media_groups WHERE source_chat_id = 2').get().n, 1);
    } finally { db.close(); }
  });
}
