import test from 'node:test';
import assert from 'node:assert/strict';
import { MANAGER_LIFECYCLE_COPY } from '../manager-lifecycle-copy.js';
import { translateManager } from '../manager-language.js';

test('manager lifecycle catalogs cover every locale and preserve ordered template data', () => {
  const placeholders = value => (value.match(/\{value\}/g) || []).length;
  const keys = new Set();
  for (const [source, ...targets] of MANAGER_LIFECYCLE_COPY) {
    assert.ok(!keys.has(source), `duplicate source: ${source}`);
    keys.add(source);
    assert.equal(targets.length, 3);
    for (const [index, target] of targets.entries()) {
      assert.ok(target);
      assert.equal(placeholders(target), placeholders(source));
      assert.doesNotMatch(target, /[А-Яа-яЁё]/);
      const values = Array.from({ length: placeholders(source) }, (_, i) => `Данные${i}`);
      let position = 0;
      const fill = text => { position = 0; return text.replaceAll('{value}', () => values[position++]); };
      assert.equal(translateManager(['en', 'es', 'zh'][index], fill(source)), fill(target));
    }
  }
});

test('assembled manager service and alert cards have no untranslated system fields', () => {
  const service = 'Сервис: Example\nБот: @example_bot\nГруппа: -100123\nРеакции: ✅ проверены и включены\nКонтрольный обмен: завершён\nОтветственный: главный администратор\nРезервный: главный администратор\nНапоминание: 30 мин\nЭскалация: 60 мин';
  const alerts = '✅ Алерты переключены в личку.\nПрежний чат недоступен: сообщить там об отключении не удалось.\n\nАлерты\n\nБот: @example_bot\nДоставка: топик 42 группы -100123\n\nАктивен только один режим доставки. При переключении прежний чат получит сообщение об отключении.';
  for (const locale of ['en', 'es', 'zh']) {
    for (const source of [service, alerts]) {
      const text = translateManager(locale, source);
      assert.doesNotMatch(text, /[А-Яа-яЁё]/, `${locale}: ${text}`);
      assert.ok(text.includes('@example_bot'));
      assert.ok(text.includes('-100123'));
    }
  }
  const chinese = translateManager('zh', 'Доставка: топик 42 группы -100123');
  assert.ok(chinese.includes('话题 42'));
  assert.ok(chinese.includes('群组 -100123'));
});
