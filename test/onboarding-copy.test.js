import test from 'node:test';
import assert from 'node:assert/strict';
import { ONBOARDING_COPY, onboardingText } from '../src/onboarding-copy.js';

test('onboarding templates have complete four-language placeholder parity', () => {
  for (const row of ONBOARDING_COPY) {
    assert.equal(row.length, 4);
    const count = text => (text.match(/\{value\}/g) || []).length;
    for (const [index, text] of row.entries()) {
      assert.ok(text);
      assert.equal(count(text), count(row[0]));
      if (index) assert.doesNotMatch(text, /[А-Яа-яЁё]/);
    }
  }
});

test('onboarding translates scaffolding without changing dynamic names', () => {
  for (const locale of ['en', 'es', 'zh']) {
    const title = 'обычный';
    assert.ok(onboardingText(locale, `Сервис: ${title}`).endsWith(title));
    assert.ok(onboardingText(locale, `Группа: ${title}`).endsWith(title));
    assert.ok(onboardingText(locale, `Найден @example_bot.`).includes('@example_bot'));
    assert.equal(onboardingText(locale, title), title);
  }
});
