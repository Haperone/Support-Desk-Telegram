import test from 'node:test';
import assert from 'node:assert/strict';
import { showManagerHelp } from '../manager-diagnostics.js';
import { translateManagerScreen } from '../manager-language.js';

test('every manager help section and role renders complete four-language copy', async () => {
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    for (const actorId of [7, 8]) {
      for (const section of ['', 'reply', 'transfer', 'access', 'delivery', 'drafts', 'commands']) {
        let screen;
        await showManagerHelp({ ADMIN_IDS: '7' }, null, actorId, (text, rows) => {
          screen = translateManagerScreen(locale, text, rows);
        }, section);
        assert.ok(screen.text.length > 20);
        if (locale !== 'ru') assert.doesNotMatch(JSON.stringify(screen), /[А-Яа-яЁё]/u, `${locale}:${actorId}:${section}`);
        assert.ok(screen.markup.flat().some(button => button.callback_data === 'mg:home'));
        if (section === 'commands') {
          assert.ok(screen.text.includes('/status'));
          assert.equal(screen.text.includes('/all'), actorId === 7);
        }
        if (!section) assert.equal(screen.markup.flat().some(button => button.callback_data === 'mg:health'), actorId === 7);
      }
    }
  }
});
