import test from 'node:test';
import assert from 'node:assert/strict';
import { MANAGER_USER_COPY } from '../manager-user-copy.js';
import { MANAGER_DIAGNOSTICS_COPY } from '../manager-diagnostics-copy.js';
import { opaqueManagerText, translateManager } from '../manager-language.js';

for (const [name, rows] of [['users', MANAGER_USER_COPY], ['diagnostics', MANAGER_DIAGNOSTICS_COPY]]) {
  test(`${name} catalog is complete and preserves template values in all four languages`, () => {
    const keys = new Set();
    for (const [source, ...targets] of rows) {
      assert.ok(!keys.has(source), `duplicate source: ${source}`);
      keys.add(source);
      assert.equal(targets.length, 3);
      const count = text => (text.match(/\{value\}/g) || []).length;
      const values = Array.from({ length: count(source) }, (_, index) => `Данные${index} $& {value}`);
      const fill = (text, opaque = false) => {
        let index = 0;
        return text.replaceAll('{value}', () => opaque ? opaqueManagerText(values[index++]) : values[index++]);
      };
      for (const [index, locale] of ['ru', 'en', 'es', 'zh'].entries()) {
        const target = index ? targets[index - 1] : source;
        assert.ok(target, `${locale}: ${source}`);
        assert.equal(count(target), count(source), `${locale}: ${source}`);
        if (index) assert.doesNotMatch(target, /[А-Яа-яЁё]/u);
        assert.equal(translateManager(locale, fill(source, true)), fill(target), `${locale}: ${source}`);
      }
    }
  });
}

test('synthetic user scopes translate while identically named authored services remain intact', () => {
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const synthetic = translateManager(locale, 'Пользователи · все сервисы');
    if (locale !== 'ru') assert.doesNotMatch(synthetic, /[А-Яа-яЁё]/u);
    const authored = translateManager(locale, `Пользователи · ${opaqueManagerText('все сервисы')}`);
    assert.ok(authored.endsWith(' · все сервисы'));
  }
});
