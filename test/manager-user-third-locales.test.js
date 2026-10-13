import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { managementBotKey } from '../src/worker.js';
import { translateManagerScreen } from '../src/manager-language.js';
import { showManagerUserHome, showManagerUserList, showManagerUserSearch, showManagerUserCard,
  handleManagerUserAction, handleManagerUserText, handleManagerUserSearchText } from '../src/manager-user-management.js';

const locales = ['en', 'ru', 'es', 'zh'];
const config = { id: 'service-help', username: 'support_help_bot', displayName: 'Support Help', topicPrefix: 'Help',
  locale: 'en', tokenBinding: 'SERVICE_HELP_TOKEN', webhookSecretBinding: 'SERVICE_HELP_SECRET', enabled: true };
const emptyConfig = { ...config, id: 'service-empty', username: 'empty_help_bot', displayName: 'Empty Service',
  tokenBinding: 'EMPTY_HELP_TOKEN', webhookSecretBinding: 'EMPTY_HELP_SECRET' };
function fixture(locale) {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url));
  const env = { SUPPORT_DB: db, BOT_REGISTRY: JSON.stringify([config, emptyConfig]), SERVICE_HELP_TOKEN: '200:HELP',
    SERVICE_HELP_SECRET: 'secret', EMPTY_HELP_TOKEN: '201:EMPTY', EMPTY_HELP_SECRET: 'empty-secret',
    ADMIN_IDS: '7', SUPPORT_GROUP_ID: '-1001234567890' };
  const key = managementBotKey([config, emptyConfig], config.id);
  const emptyKey = managementBotKey([config, emptyConfig], emptyConfig.id);
  const actor = { id: 7, first_name: 'Admin' }, screens = [];
  const show = (text, rows = []) => {
    const rendered = translateManagerScreen(locale, text, rows);
    const screen = { text: rendered.text, rows: rendered.markup };
    screens.push(screen);
    return screen;
  };
  const profile = (userId, firstName, username = null) => {
    db.sqlite.prepare(`INSERT INTO pending_messages
      (bot_id,user_id,update_id,source_chat_id,source_message_id,source_first_name,source_username,created_at)
      VALUES('service-help',?,?,?,?,?,?,?)`).run(userId, userId, userId, userId, firstName, username, new Date().toISOString());
  };
  return { db, env, key, emptyKey, actor, screens, show, profile, close: () => db.close() };
}
const actionButton = (screen, code) => screen.rows.flat().find(item => item.callback_data?.startsWith(`mu:act:${code}:`));

test('manager user read screens and moderation previews render without Russian scaffolding in all locales', async () => {
  const leaks = [];
  for (const locale of locales) {
    const f = fixture(locale);
    try {
      f.profile(1001, 'Alice Example', 'alice_example');
      f.profile(1002, 'Blocked Example');
      f.profile(1003, 'Restricted Example');
      f.profile(1004, 'Trusted Example');
      f.profile(1005, 'Captcha Example');
      f.profile(1006, 'Second Example');
      f.db.sqlite.prepare(`INSERT INTO conversations(bot_id,user_id,first_name,username,support_group_id,thread_id,status,created_at)
        VALUES('service-help',1001,'Alice Example','alice_example',-1001234567890,44,'open',?)`).run(new Date().toISOString());
      const future = new Date(Date.now() + 86_400_000).toISOString();
      f.db.sqlite.prepare("INSERT INTO banned_users(bot_id,user_id,reason,banned_at) VALUES('service-help',1002,'Repeated spam',?)").run(new Date().toISOString());
      f.db.sqlite.prepare(`INSERT INTO user_abuse_state(bot_id,user_id,manual_restricted_until,manual_trust,verification_required,risk_score,created_at,updated_at)
        VALUES('service-help',1003,?,0,0,0,?,?)`).run(future, future, future);
      f.db.sqlite.prepare(`INSERT INTO user_abuse_state(bot_id,user_id,manual_trust,verification_required,risk_score,created_at,updated_at)
        VALUES('service-help',1004,1,0,0,?,?)`).run(future, future);
      f.db.sqlite.prepare(`INSERT INTO user_abuse_state(bot_id,user_id,verification_required,risk_score,created_at,updated_at)
        VALUES('service-help',1005,1,5,?,?)`).run(future, future);
      for (const [index, action] of ['manual_trust', 'manual_ban', 'manual_restrict', 'risk_reset', 'conversation_close', 'manual_untrust'].entries())
        f.db.sqlite.prepare(`INSERT INTO operator_audit(bot_id,user_id,actor_type,operator_id,operator_name,action,result,reason,created_at)
          VALUES('service-help',1001,'operator',7,'Admin',?,'success','Reviewed profile',?)`).run(action, `2026-09-30T10:0${index}:00Z`);

      await showManagerUserHome(f.env, f.db, 7, f.show);
      await showManagerUserHome(f.env, f.db, 7, f.show, f.key);
      await showManagerUserHome(f.env, f.db, 7, f.show, f.emptyKey);
      for (const filter of ['x', 'b', 'r', 'v', 's', 't', 'n']) {
        await showManagerUserList(f.env, f.db, 7, 'a', filter, 0, f.show);
        await showManagerUserList(f.env, f.db, 7, f.key, filter, 0, f.show);
        await showManagerUserList(f.env, f.db, 7, f.emptyKey, filter, 0, f.show);
      }
      await showManagerUserList(f.env, f.db, 7, 'a', 'x', 1, f.show);
      await showManagerUserList(f.env, f.db, 7, f.emptyKey, 'x', 1, f.show);
      await showManagerUserSearch(f.env, f.db, 7, '', f.show);
      await handleManagerUserSearchText(f.env, f.db, 7, 'x', f.show);
      await handleManagerUserText(f.env, f.db, f.actor, 'x', f.show);
      await showManagerUserSearch(f.env, f.db, 7, '@missing_user', f.show);
      await showManagerUserSearch(f.env, f.db, 7, 'Alice', f.show);
      for (let index = 0; index < 21; index++) f.profile(1100 + index, 'Shared Example');
      await showManagerUserSearch(f.env, f.db, 7, 'Shared Example', f.show);
      await showManagerUserCard(f.env, f.db, 7, f.key, 1001, f.show);
      await showManagerUserCard(f.env, f.db, 7, f.key, 1002, f.show);
      await showManagerUserCard(f.env, f.db, 7, f.key, 1003, f.show);
      await showManagerUserCard(f.env, f.db, 7, f.key, 1004, f.show);
      await showManagerUserCard(f.env, f.db, 7, f.key, 1005, f.show);
      await showManagerUserCard(f.env, f.db, 7, f.emptyKey, 1099, f.show);
      await handleManagerUserAction(f.env, f.db, f.actor, `mu:audit:${f.key}:1001:0`, f.show);
      await handleManagerUserAction(f.env, f.db, f.actor, `mu:audit:${f.key}:1001:0:d`, f.show);
      await handleManagerUserAction(f.env, f.db, f.actor, `mu:audit:${f.key}:1001:1:d`, f.show);

      const ban = actionButton((await showManagerUserCard(f.env, f.db, 7, f.key, 1006, f.show)), 'ban');
      await handleManagerUserAction(f.env, f.db, f.actor, ban.callback_data, f.show);
      await handleManagerUserText(f.env, f.db, f.actor, 'x', f.show);
      await handleManagerUserText(f.env, f.db, f.actor, 'Repeated spam from customer', f.show);

      await showManagerUserCard(f.env, f.db, 7, f.key, 1006, f.show);
      const restrict = f.screens.at(-1).rows.flat().find(item => item.callback_data?.startsWith('mu:restrict:'));
      await handleManagerUserAction(f.env, f.db, f.actor, restrict.callback_data, f.show);
      const custom = f.screens.at(-1).rows.flat().find(item => item.callback_data?.includes(':custom:'));
      await handleManagerUserAction(f.env, f.db, f.actor, custom.callback_data, f.show);
      await handleManagerUserText(f.env, f.db, f.actor, 'invalid', f.show);
      await handleManagerUserText(f.env, f.db, f.actor, '6h', f.show);
      await handleManagerUserText(f.env, f.db, f.actor, 'Repeated spam', f.show);

      await showManagerUserCard(f.env, f.db, 7, f.key, 1006, f.show);
      const quickRestrict = f.screens.at(-1).rows.flat().find(item => item.callback_data?.startsWith('mu:restrict:'));
      await handleManagerUserAction(f.env, f.db, f.actor, quickRestrict.callback_data, f.show);
      const quick = f.screens.at(-1).rows.flat().find(item => item.callback_data?.includes(':15m:'));
      await handleManagerUserAction(f.env, f.db, f.actor, quick.callback_data, f.show);
      await handleManagerUserText(f.env, f.db, f.actor, 'Temporary spam', f.show);

      for (const [userId, code] of [[1002, 'unban'], [1003, 'unrestrict'], [1004, 'untrust'], [1005, 'riskreset'], [1001, 'trust']]) {
        const button = actionButton((await showManagerUserCard(f.env, f.db, 7, f.key, userId, f.show)), code);
        await handleManagerUserAction(f.env, f.db, f.actor, button.callback_data, f.show);
      }

      // Rare but reachable callback outcomes and read-only service state.
      await handleManagerUserAction(f.env, f.db, f.actor, 'mu:resume', f.show);
      await handleManagerUserAction(f.env, f.db, f.actor, 'mu:revise:expired', f.show);
      await handleManagerUserAction(f.env, f.db, f.actor, 'mu:confirm:expired', f.show);
      await handleManagerUserAction(f.env, f.db, f.actor, 'mu:cancel:expired', f.show);
      const banForResume = actionButton(await showManagerUserCard(f.env, f.db, 7, f.key, 1006, f.show), 'ban');
      await handleManagerUserAction(f.env, f.db, f.actor, banForResume.callback_data, f.show);
      f.db.sqlite.prepare("UPDATE operator_pending_actions SET suspended=1 WHERE operator_id=7").run();
      await handleManagerUserAction(f.env, f.db, f.actor, 'mu:resume', f.show);
      await handleManagerUserText(f.env, f.db, f.actor, 'A sufficiently long authored reason', f.show);
      const revise = f.screens.at(-1).rows.flat().find(item => item.callback_data?.startsWith('mu:revise:'));
      await handleManagerUserAction(f.env, f.db, f.actor, revise.callback_data, f.show);
      const cancel = f.screens.at(-1).rows.flat().find(item => item.callback_data?.startsWith('mu:cancel:'));
      await handleManagerUserAction(f.env, f.db, f.actor, cancel.callback_data, f.show);
      await showManagerUserCard(f.env, f.db, 7, 'invalid-key', 1001, f.show);
      await showManagerUserCard(f.env, f.db, 7, f.key, 999999, f.show);
      f.env.BOT_REGISTRY = JSON.stringify([{ ...config, enabled: false }, emptyConfig]);
      await showManagerUserCard(f.env, f.db, 7, f.key, 1001, f.show);
      await handleManagerUserAction(f.env, f.db, f.actor, `mu:act:ban:${f.key}:1001:stale`, f.show);

      if (locale !== 'ru') for (const [index, screen] of f.screens.entries()) {
        const items = [screen.text, ...screen.rows.flat().map(item => item.text)];
        for (const text of items) for (const line of String(text).split('\n'))
          if (/[А-Яа-яЁё]/u.test(line)) leaks.push(`${locale} screen ${index}: ${line}`);
      }
      assert.ok(f.screens.length > 35, `${locale}: expected broad read and action route coverage, got ${f.screens.length}`);
      assert.ok(f.screens.some(screen => screen.text.includes('Alice Example')), `${locale}: authored name should remain intact`);
      assert.ok(f.screens.some(screen => screen.text.includes('Repeated spam')), `${locale}: authored reason should remain intact`);
    } finally { f.close(); }
  }
  assert.deepEqual([...new Set(leaks.map(item => item.slice(item.indexOf(': ') + 2)))], []);
});
