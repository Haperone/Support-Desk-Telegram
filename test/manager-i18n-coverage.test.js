import test from 'node:test';
import assert from 'node:assert/strict';
import { MANAGER_TRANSLATIONS, opaqueManagerText, translateManager, translateManagerScreen } from '../manager-language.js';

const cyrillic = /[А-Яа-яЁё]/u;

test('the entire manager catalog has matching keys and placeholders without text from another language', () => {
  const keys = Object.keys(MANAGER_TRANSLATIONS.en).sort();
  const slots = value => [...value.matchAll(/\{value\}/g)].map(match => match[0]).sort();
  for (const locale of ['en', 'es', 'zh']) {
    assert.deepEqual(Object.keys(MANAGER_TRANSLATIONS[locale]).sort(), keys, `${locale} keys`);
    for (const key of keys) {
      const value = MANAGER_TRANSLATIONS[locale][key];
      assert.ok(typeof value === 'string' && value.trim(), `${locale}: ${key}`);
      assert.deepEqual(slots(value), slots(key), `${locale}: ${key}`);
      assert.doesNotMatch(value, cyrillic, `${locale}: ${key}`);
      if (locale !== 'zh') assert.doesNotMatch(value, /\p{Script=Han}/u, `${locale}: ${key}`);
    }
  }
});

test('status wording preserves enabled versus disabled and the checked sample boundary', () => {
  const expected = {
    en: ['intentionally enabled', 'intentionally disabled', 'No delayed messages in this sample.'],
    es: ['activado deliberadamente', 'desactivado deliberadamente', 'No hay mensajes retrasados en esta muestra.'],
    zh: ['已主动启用', '已主动关闭', '此样本中没有延迟消息。'],
  };
  for (const [locale, values] of Object.entries(expected)) {
    assert.equal(translateManager(locale, 'включено осознанно'), values[0]);
    assert.equal(translateManager(locale, 'выключено осознанно'), values[1]);
    assert.equal(translateManager(locale, 'Задержанных сообщений в выборке нет.'), values[2]);
  }
  assert.equal(translateManager('es', 'ответ:'), 'respuesta:');
  assert.equal(translateManager('es', 'истекает '), 'vence ');
});

test('translation preserves replacement syntax and literal placeholders in authored values', () => {
  const authored = ['$&', "$'", '$`', '$$', '{value}', 'Пользователи'].join('\n');
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const rendered = translateManager(locale, `Заметка: ${opaqueManagerText(authored)}`);
    assert.ok(rendered.endsWith(authored), `${locale} restores authored text literally`);
    assert.doesNotMatch(rendered, /\uE000opaque\d+\uE001/u);
  }
  for (const [locale, prefix] of [['en', 'Add'], ['es', 'Añadir'], ['zh', '添加']]) {
    assert.equal(translateManager(locale, 'Добавить A{value} ($&)'), `${prefix} A{value} ($&)`);
  }
  const literalMarker = 'Customer \uE000opaque1\uE001';
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const rendered = translateManager(locale, `${opaqueManagerText(literalMarker)}\n${opaqueManagerText('Other customer')}`);
    assert.equal(rendered, `${literalMarker}\nOther customer`, 'restored authored values are never interpreted again');
  }
});
const screens = [
  {
    text: 'Управление поддержкой\n\nВыберите действие или раздел.',
    buttons: ['Мои обращения', 'Все обращения', 'Пользователи', 'Операторы', 'Помощь', '🌐 Язык интерфейса'],
  },
  {
    text: 'Поиск профиля\n\nОтправьте следующим обычным сообщением Telegram ID, @username или часть имени (от 2 символов). Команду перед запросом писать не нужно. Для отмены нажмите кнопку или отправьте /cancel.',
    buttons: ['Отмена', 'Пользователи'],
  },
  {
    text: 'Доставка · Service A · 42\nПользователь: Example\nТема: открыта · группа -100123 · тема #4\nПоследнее сообщение: 2026-09-29\nАктивная карточка обращения не найдена.',
    buttons: ['Открыть тему', 'Здоровье системы', 'Назад к сервису'],
  },
  {
    text: 'Статус доставки сообщения #18\nЗаписей о незавершённой доставке для пользователя нет.',
    buttons: ['Обновить статус', '▶️ Повторить безопасные отправки', 'Обновить проверку'],
  },
  {
    text: 'Настройки · Service A\n\nЯзык: English\nПриветствие: включено\nАвтоответ: выключено\nРеакции: ещё не проверены\nОформление новых тем: по умолчанию\nЗащита сервиса: включено',
    buttons: ['🌐 Сменить язык', 'Приветствие и автоответ', 'Реакции', 'Оформление тем', 'Защита сервиса'],
  },
  {
    text: 'Журнал действий · страница 1\n\n2026-09-29 · команда · Admin — Пользователь заблокирован · 42 · success',
    buttons: ['Скрыть коды', 'Технические коды', 'Меню'],
  },
];

test('manager screen coverage: representative cards and buttons have no untranslated Cyrillic', () => {
  for (const locale of ['en', 'es', 'zh']) {
    for (const screen of screens) {
      const rendered = translateManagerScreen(locale, screen.text, [screen.buttons.map(text => ({ text, callback_data: 'test' }))]);
      assert.equal(cyrillic.test(rendered.text), false, `${locale} text still contains Cyrillic: ${rendered.text}`);
      for (const row of rendered.markup) for (const button of row)
        assert.equal(cyrillic.test(button.text), false, `${locale} button still contains Cyrillic: ${button.text}`);
    }
  }
});

test('translation leaves operator-authored text and names intact', () => {
  assert.equal(translateManager('en', 'Привет, Пользователи!'), 'Привет, Пользователи!');
  assert.equal(translateManager('es', 'Заметка: Пользователи'), 'Nota: Пользователи');
  assert.equal(translateManager('zh', 'Пользователи из Москвы'), 'Пользователи из Москвы');
  assert.equal(translateManager('en', 'Пользователи', { preserve: ['Пользователи'] }), 'Пользователи');
  assert.equal(translateManager('es', `${opaqueManagerText('Пользователи')} · группа -100123`), 'Пользователи · grupo -100123',
    'authored group names stay opaque while their fixed group label translates');
  assert.equal(translateManager('es', `Пользователи · ${opaqueManagerText('группа -100123')}`), 'Usuarios · группа -100123',
    'a user-list heading translates while its authored service name stays intact');
  assert.equal(translateManager('zh', 'Меню · бот «Поддержка»'), 'Меню · бот «Поддержка»');
});

test('opaque authored values cannot collide with catalog labels in any locale', () => {
  const source = `Service: ${opaqueManagerText('Пользователи')}\n${opaqueManagerText('Menu')}\n${opaqueManagerText('Users')}`;
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const rendered = translateManager(locale, source);
    assert.ok(rendered.includes('Пользователи'));
    assert.ok(rendered.includes('\nMenu\nUsers'));
    assert.ok(!/[\uE000-\uF8FF]/u.test(rendered), 'private-use markers never reach Telegram');
  }
});

test('populated audit, delivery, and moderation cards translate fixed fields only', () => {
  const audit = 'Журнал действий · страница 2\n\n2026-09-29 · bot1 · Alex — Ограничение включено · 123 · 45 мин · operator note · success';
  const delivery = 'Проблемы доставки · Support A\nЗаписей: 1 · страница 1/1\n\nSupport A · User · 22\nоператор → клиент · исход неясен — сначала проверьте переписку\nСообщение -100123/44';
  const user = 'Иван · Support A\nTelegram ID: 123\nUsername: @person\nСостояние: ограничен до 2026-10-02\nПоследняя активность: 2026-09-30\nОбращение: открыто\nРиск сейчас: 5 · CAPTCHA: ожидает\nДоступ к переписке:\n• Блокировка оператором\n• Ручное ограничение до 2026-10-02\n• Автоограничение до 2026-10-01\n• Требуется CAPTCHA\nДоверие: нет\nОжидающих сообщений: 2 · ожидающих возобновления: 1';
  const confirmation = 'Подтвердите действие: Ограничить\nСервис: bot1\nTelegram ID: 123\nСрок: 45 мин\nПричина: operator note\n\nНедоставленные сообщения будут удалены из очереди и их потребуется отправить заново.';
  const cases = {
    en: [[audit, ['Activity log · page 2', 'Restriction enabled', '45 min']],
      [delivery, ['Delivery problems', 'Records: 1', 'operator → customer', 'uncertain outcome']],
      [user, ['restricted until 2026-10-02', 'Current risk: 5', 'Manual restriction until 2026-10-02', 'waiting to reopen: 1']],
      [confirmation, ['Confirm action: Restrict', 'Duration: 45 min', 'Reason: operator note', 'must be sent again']]],
    es: [[audit, ['Registro de actividad · página 2', 'Restricción activada', '45 min']],
      [delivery, ['Problemas de entrega', 'Registros: 1', 'operador → cliente', 'resultado incierto']],
      [user, ['restringido hasta 2026-10-02', 'Riesgo actual: 5', 'Restricción manual hasta 2026-10-02', 'pendientes de reanudación: 1']],
      [confirmation, ['Confirma la acción: Restringir', 'Duración: 45 min', 'Motivo: operator note', 'enviarlos de nuevo']]],
    zh: [[audit, ['操作日志 · 第 2 页', '限制已启用', '45 分钟']],
      [delivery, ['投递问题', '记录：1', '客服 → 客户', '结果不明']],
      [user, ['受限 至 2026-10-02', '当前风险： 5', '手动限制至 2026-10-02', '等待恢复： 1']],
      [confirmation, ['确认操作： 限制', '时长： 45 分钟', '原因： operator note', '需要重新发送']]],
  };
  for (const locale of ['en', 'es', 'zh']) {
    for (const [source, expected] of cases[locale]) {
      const rendered = translateManager(locale, source);
      for (const phrase of expected) assert.ok(rendered.includes(phrase), `${locale} missing ${phrase}: ${rendered}`);
      if (source.includes('operator note')) assert.ok(rendered.includes('operator note'), 'operator-entered notes remain unchanged');
    }
  }
});

test('populated reaction, system-health, and user-count rows localize their fixed fields', () => {
  const screens = [
    'Реакции · Service A\n\nПоддержка → пользователь: 🟢 включено, не проверено\nПользователь → поддержка: выключено, не проверено',
    '  группа -100123, меню готово; проверка: done, истекает 2026-10-01 12:00 UTC',
    'Людей: 2 · профилей: 3',
  ];
  const expected = {
    en: [['Support → user:', 'enabled, not verified', 'User → support:'], ['group -100123', 'menu ready', 'check: complete', 'expires'], ['People: 2 · profiles: 3']],
    es: [['Soporte → usuario:', 'activado, sin verificar', 'Usuario → soporte:'], ['grupo -100123', 'menú listo', 'comprobación: completado', 'vence'], ['Personas: 2 · perfiles: 3']],
    zh: [['支持人员 → 用户：', '已启用，未验证', '用户 → 支持人员：'], ['群组 -100123', '菜单已就绪', '检查：完成', '到期时间'], ['用户数：2 · 资料数：3']],
  };
  for (const locale of ['en', 'es', 'zh']) {
    for (const [index, text] of screens.entries()) {
      const rendered = translateManager(locale, text);
      for (const phrase of expected[locale][index]) assert.ok(rendered.includes(phrase), `${locale} missing ${phrase}: ${rendered}`);
      if (index === 0) assert.ok(rendered.includes('Service A'), 'service display names remain unchanged');
    }
  }
});
