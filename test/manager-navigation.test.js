import test from 'node:test';
import assert from 'node:assert/strict';
import { managerScreenKeyboard } from '../manager-navigation.js';

const action = (text, callback_data) => ({ text, callback_data });

test('manager screens keep actions and put Back and Menu below a disabled divider', () => {
  const cases = [
    ['mg:service:b123', true, 'mg:section:bots'],
    ['mg:queue:a:needs:0', true, 'mg:section:work'],
    ['mg:rxview:a', true, 'mg:section:bots'],
    ['mg:plan', true, 'mg:section:platform'],
    ['mg:settings:b123', true, 'mg:service:b123'],
    ['mg:msg:b123:w:view', true, 'mg:msgs:b123'],
    ['mu:list:a:trusted:0', false, 'mu:home:a'],
    ['mu:card:b123:456', false, 'mu:home:b123'],
    ['mu:audit:b123:456:0', false, 'mu:card:b123:456'],
    ['um:st:home', true, 'mg:storage'],
    ['um:st:topic:12:0', true, 'um:st:list:0'],
  ];
  for (const [route, primary, expectedBack] of cases) {
    const rows = managerScreenKeyboard([[action('Действие', 'test:action')]], { route, primary });
    assert.deepEqual(rows[0], [action('Действие', 'test:action')], route);
    assert.deepEqual(rows.at(-2), [{ text: '────────', disabled: {} }], route);
    assert.deepEqual(rows.at(-1), [
      { ...action('← Назад', expectedBack), style: 'primary' },
      { ...action('🏠 Меню', 'mg:home'), style: 'primary' },
    ], route);
  }
});

test('explicit cancel remains the Back action and existing menu buttons are not duplicated', () => {
  const rows = managerScreenKeyboard([
    [action('Подтвердить', 'test:confirm')],
    [action('Отмена', 'mu:cancel:nonce')],
    [action('Меню', 'mg:home')],
  ], { route: 'mu:confirm:nonce' });
  assert.deepEqual(rows, [
    [{ ...action('Подтвердить', 'test:confirm'), style: 'success' }],
    [{ text: '────────', disabled: {} }],
    [{ ...action('← Назад', 'mu:cancel:nonce'), style: 'primary' },
      { ...action('🏠 Меню', 'mg:home'), style: 'primary' }],
  ]);
});

test('main menu remains a single action keyboard', () => {
  const rows = [[action('Операторы', 'mg:operators')]];
  assert.deepEqual(managerScreenKeyboard(rows, { root: true }), rows);
});

test('an expired interactive card with no original buttons still has a way out', () => {
  assert.deepEqual(managerScreenKeyboard(undefined, { route: 'mu:card:b123:456' }), [
    [{ text: '────────', disabled: {} }],
    [{ ...action('← Назад', 'mu:home:b123'), style: 'primary' },
      { ...action('🏠 Меню', 'mg:home'), style: 'primary' }],
  ]);
});

test('dangerous removals and shutdowns are red, including their final confirmations', () => {
  const cases = [
    ['Удалить подключение', 'mg:lifecycle:b123:remove', ''],
    ['Да, удалить подключение', 'mg:lifedo:b123:remove', ''],
    ['Удалить из операторов', 'mg:opremove:12', ''],
    ['Приостановить бота', 'mg:lifecycle:b123:pause', ''],
    ['Отключить алерт-бота', 'mg:alert:remove', ''],
    ['Да, отключить', 'mg:alert:removeok:3', ''],
    ['🔴 Выключить поддержку → пользователь', 'mg:rxset:b123:0:off', ''],
    ['Очистить текст', 'mg:msg:b123:w:clear', ''],
    ['Да, очистить', 'mg:msgsave:nonce', ''],
    ['Сбросить оформление', 'mg:stylereset:b123', ''],
    ['OFF', 'mg:attackconfirm:b123', ''],
    ['Снять защиту', 'um:st:protect:12:3:0', ''],
    ['Я удалил эту тему', 'um:st:missing:12:0', ''],
    ['Да, темы больше нет', 'um:st:mark:12:3:0', ''],
    ['Понимаю, перейти к подтверждению', 'um:st:arm:nonce', ''],
    ['Подтвердить очистку 5 тем', 'um:st:start:abc', ''],
    ['Подтвердить служебную очистку', 'um:st:start:abc', ''],
    ['Подтвердить', 'mu:confirm:nonce', 'Подтвердите действие: Заблокировать\nСервис: LIC'],
    ['Подтвердить', 'mu:confirm:nonce', 'Подтвердите действие: Ограничить\nСервис: LIC'],
  ];
  for (const [label, data, screenText] of cases) {
    const rows = managerScreenKeyboard([[action(label, data)]], { screenText });
    assert.equal(rows[0][0].style, 'danger', label);
  }
});

test('safe confirmations are green and ordinary transitions keep the default style', () => {
  const cases = [
    ['Подтвердить передачу', 'mg:commit:nonce'],
    ['Да, добавить', 'mg:opaddconfirm:12:abc'],
    ['Да, возобновить', 'mg:lifedo:b123:resume'],
    ['Применить оба сообщения', 'mg:copyapply:b123:b456:hash'],
    ['Сохранить', 'mg:msgsave:nonce'],
    ['Подключить', 'br:connect:nonce:2'],
    ['Подключить группу', 'mg:confirm:nonce'],
    ['Подтвердить', 'mu:confirm:nonce'],
    ['Применить правила', 'um:st:policy:180:7:500:3'],
    ['Да, остановить оставшуюся очистку', 'um:st:stopconfirm:2'],
  ];
  for (const [label, data] of cases) {
    const rows = managerScreenKeyboard([[action(label, data)]]);
    assert.equal(rows[0][0].style, 'success', label);
  }
  const rows = managerScreenKeyboard([[action('Проверить подключение', 'br:check:nonce:2')],
    [action('Открыть тему', 'mg:work:b123:12')]]);
  assert.equal(rows[0][0].style, undefined);
  assert.equal(rows[1][0].style, undefined);
});
