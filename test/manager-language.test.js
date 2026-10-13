import test from 'node:test';
import assert from 'node:assert/strict';
import { getManagerLanguage, setManagerLanguage, translateManager } from '../manager-language.js';

function database(initial = null) {
  let row = initial;
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
          async first() { return row; },
          async run() {
            if (sql.startsWith('INSERT INTO manager_operator_preferences')) row = { language: args[1] };
            return { success: true };
          },
          };
        },
      };
    },
  };
}

test('manager language defaults to English and only accepts supported stored values', async () => {
  assert.equal(await getManagerLanguage(database(), 7), 'en');
  assert.equal(await getManagerLanguage(database({ language: 'ru' }), 7), 'ru');
  assert.equal(await getManagerLanguage(database({ language: 'fr' }), 7), 'en');
});

test('operator language changes persist only supported locales', async () => {
  const db = database();
  assert.equal(await setManagerLanguage(db, 7, 'es'), true);
  assert.equal(await getManagerLanguage(db, 7), 'es');
  assert.equal(await setManagerLanguage(db, 7, 'fr'), false);
  assert.equal(await getManagerLanguage(db, 7), 'es');
});

test('manager translation keeps Russian and translates common home-screen labels', () => {
  assert.equal(translateManager('ru', 'Меню'), 'Меню');
  assert.equal(translateManager('en', 'Меню'), 'Menu');
  assert.equal(translateManager('es', 'Пользователи'), 'Usuarios');
  assert.equal(translateManager('zh', 'Операторы'), '客服人员');
});
