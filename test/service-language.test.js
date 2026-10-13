import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { registeredConfig } from '../src/bot-registry.js';
import { managementBotKey } from '../src/worker.js';
import { handleManagerServiceSettings } from '../src/manager-service-settings.js';

test('new service defaults to English and manager can switch its persisted language', async () => {
  const config = registeredConfig({ id: 12345, username: 'example_bot' }, 'Example', 'Example');
  assert.equal(config.locale, 'en');
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  const at = new Date().toISOString();
  await db.prepare(`INSERT INTO registered_bots
    (bot_id,telegram_id,config_json,credentials,status,owner_id,created_at,updated_at)
    VALUES(?,?,?,'test','active',?,?,?)`).bind(config.id, 12345, JSON.stringify(config), 7, at, at).run();
  const key = managementBotKey([config], config.id);
  const env = { BOT_REGISTRY: JSON.stringify([config]) };
  const screens = [];
  const show = (text, rows) => { screens.push({ text, rows }); };

  await handleManagerServiceSettings(env, db, 7, ['language', key], show);
  assert.deepEqual(screens.at(-1).rows.slice(0, 4).map(row => row[0].text),
    ['✓ 🇬🇧 English', '🇷🇺 Русский', '🇪🇸 Español', '🇨🇳 简体中文']);

  await handleManagerServiceSettings(env, db, 7, ['langset', key, 'es'], show);
  const saved = await db.prepare('SELECT config_json FROM registered_bots WHERE bot_id=?').bind(config.id).first();
  assert.equal(JSON.parse(saved.config_json).locale, 'es');
  assert.match(screens.at(-1).text, /Español/);

  await handleManagerServiceSettings(env, db, 7, ['langset', key, 'de'], show);
  const unchanged = await db.prepare('SELECT config_json FROM registered_bots WHERE bot_id=?').bind(config.id).first();
  assert.equal(JSON.parse(unchanged.config_json).locale, 'es');
});
