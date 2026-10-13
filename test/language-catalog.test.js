import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LANGUAGE, LANGUAGES, languageOrDefault } from '../language.js';
import { workAge, workStateLabel, assigneeLabel } from '../conversation-work.js';
import { reactionDirectionLabel, reactionSummary } from '../reaction-checks.js';
import { manualDeliveryText } from '../manual-delivery.js';
import { withNavigation } from '../operator-workspace.js';

test('all supported languages render core work, reaction and recovery labels', () => {
  assert.equal(DEFAULT_LANGUAGE, 'en');
  assert.deepEqual(Object.keys(LANGUAGES), ['en', 'ru', 'es', 'zh']);
  assert.equal(languageOrDefault('missing'), 'en');
  const state = { support_to_user_verified: 1, support_to_user_enabled: 1,
    user_to_support_verified: 0, user_to_support_enabled: 0 };
  for (const locale of Object.keys(LANGUAGES)) {
    for (const text of [workAge('invalid', locale), workStateLabel({ state: 'needs_reply' }, locale),
      assigneeLabel({}, 7, 7, locale), reactionDirectionLabel('support_to_user', locale),
      reactionSummary(state, locale), manualDeliveryText({ snapshot: { rows: [], limited: false } }, locale)]) {
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0);
      if (locale !== 'ru') assert.doesNotMatch(text, /[А-Яа-яЁё]/);
    }
    const navigation = withNavigation({ inline_keyboard: [] }, locale, 1, 'um:g:home:a', 'um:n:home');
    assert.equal(navigation.inline_keyboard.at(-1)[0].callback_data, 'um:n:home');
    if (locale !== 'ru') for (const row of navigation.inline_keyboard)
      for (const item of row) assert.doesNotMatch(item.text, /[А-Яа-яЁё]/);
  }
  assert.equal(workStateLabel({ state: 'needs_reply' }, 'es'), 'Necesita respuesta');
  assert.equal(workStateLabel({ state: 'needs_reply' }, 'zh'), '待回复');
  assert.match(manualDeliveryText({ maintenance: true }, 'es'), /limpieza/);
  assert.match(manualDeliveryText({ maintenance: true }, 'zh'), /清理/);
});
