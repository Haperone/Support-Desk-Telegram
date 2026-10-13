import test from 'node:test';
import assert from 'node:assert/strict';
import { auditActionLabel, formatInfo } from '../src/worker.js';

test('audit actions use their own locale catalog across all supported locales', () => {
  assert.equal(auditActionLabel({ locale: 'ru' }, 'attack_control_auto'), 'Защита возвращена в AUTO');
  assert.equal(auditActionLabel({ locale: 'en' }, 'attack_control_auto'), 'Protection returned to AUTO');
  assert.equal(auditActionLabel({ locale: 'es' }, 'attack_control_auto'), 'Protección restablecida en AUTO');
  assert.equal(auditActionLabel({ locale: 'zh' }, 'attack_control_auto'), '防护已恢复为 AUTO');
});

test('user cards localize every fixed information label in all supported locales', () => {
  const conversation = { user_id: 42, username: 'alex', thread_id: 55, status: 'open' };
  const bot = { displayName: 'Folder Links', username: 'FolderLinksBot' };
  const expected = {
    ru: ['Пользователь', 'Сервис', 'Бот', 'ID пользователя', 'Тема', 'Статус'],
    en: ['User', 'Service', 'Bot', 'User ID', 'Topic', 'Status'],
    es: ['Usuario', 'Servicio', 'Bot', 'ID de usuario', 'Tema', 'Estado'],
    zh: ['用户', '服务', '机器人', '用户 ID', '话题', '状态'],
  };
  for (const [locale, labels] of Object.entries(expected)) {
    const text = formatInfo(conversation, { ...bot, locale });
    for (const label of labels) assert.ok(text.includes(label), `${locale} card should include ${label}`);
    assert.ok(text.includes('@alex'));
  }
});
