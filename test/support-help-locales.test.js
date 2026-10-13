import test from 'node:test';
import assert from 'node:assert/strict';
import { supportHelp } from '../support-help.js';

test('support help renders all topics in Spanish and Simplified Chinese', () => {
  for (const locale of ['es', 'zh']) {
    for (const section of ['reply', 'transfer', 'access', 'delivery', 'drafts', 'commands']) {
      const result = supportHelp(locale, true, section, true);
      assert.ok(result.text.length > 40, `${locale}/${section} should have complete instructions`);
      assert.deepEqual(result.inline_keyboard, []);
      if (section === 'commands') assert.match(result.text, /\/(menu|cancel)/);
      if (['reply', 'commands'].includes(section)) assert.match(result.text, /\/delete/);
    }
    const home = supportHelp(locale, true);
    assert.equal(home.inline_keyboard.length, 6);
    assert.ok(home.text.length > 0);
  }
});

test('support help keeps the existing boolean locale API and English/Russian copy', () => {
  assert.equal(supportHelp(true, false, 'reply').text, supportHelp('ru', false, 'reply').text);
  assert.equal(supportHelp(false, false, 'reply').text, supportHelp('en', false, 'reply').text);
  assert.match(supportHelp('ru', false, 'reply').text, /Как ответить/);
  assert.match(supportHelp('en', false, 'reply').text, /How do I reply/);
});
