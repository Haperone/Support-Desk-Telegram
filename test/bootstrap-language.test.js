import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { BOOTSTRAP_COPY, BOOTSTRAP_STAGES, createBootstrapText, selectBootstrapLanguage } from '../scripts/bootstrap-copy.mjs';
import { runStage } from '../scripts/bootstrap-state.mjs';
import { request } from '../scripts/telegram-setup.mjs';
import { connectWebhook } from '../scripts/telegram-webhook.mjs';

const english = createBootstrapText('en');
const russian = createBootstrapText('ru');
const cyrillic = /[А-Яа-яЁё]/;

test('the first language prompt supports both languages and retries invalid choices', async () => {
  for (const [answer, expected] of [['1', 'ru'], ['ru', 'ru'], ['2', 'en'], ['EN', 'en']]) {
    const events = [], answers = ['wrong', answer];
    const locale = await selectBootstrapLanguage({
      log: message => events.push(message),
      ask: async (prompt, fallback) => {
        assert.equal(fallback, '1');
        assert.match(prompt, /Выберите \/ Choose/);
        return answers.shift();
      },
    });
    assert.equal(locale, expected);
    assert.match(events[0], /1\. Русский\n  2\. English/);
    assert.match(events[1], /Enter 1 or 2/);
  }
});

test('every wizard translation preserves placeholders and opaque user values', () => {
  const seen = new Set();
  const slots = value => [...value.matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort();
  const fill = value => value.replace(/\{(\d+)\}/g, (_match, slot) => `VALUE_${slot}: группа $& $1 {99}\nsecond line`);
  for (const [ru, en] of BOOTSTRAP_COPY) {
    assert.ok(ru.trim() && en.trim());
    assert.ok(!seen.has(ru), `Duplicate: ${ru}`);
    seen.add(ru);
    assert.deepEqual(slots(en), slots(ru), ru);
    assert.doesNotMatch(en, cyrillic, ru);
    assert.equal(english(fill(ru)), fill(en), ru);
    assert.equal(russian(fill(ru)), fill(ru));
  }
  assert.equal(english('author text: группа'), 'author text: группа');
});

test('Russian UI literals in the wizard and its shared error paths have English translations', () => {
  const sources = ['bootstrap.mjs', 'bootstrap-serverless.mjs', 'bootstrap-state.mjs', 'bootstrap-config.mjs', 'bootstrap-probe.mjs']
    .map(file => [file, readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8')]);
  for (const [file, start, end] of [
    ['telegram-setup.mjs', 'export function hiddenToken', 'export async function checkTelegramSetup'],
    ['telegram-webhook.mjs', 'export async function connectWebhook', 'if (process.argv[1]'],
  ]) {
    const source = readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8');
    // Only functions reached by the wizard; independent legacy commands have their own UI.
    sources.push([file, source.slice(source.indexOf(start), source.indexOf(end))]);
  }
  const excluded = new Set(['Русский', 'Вставь токен бота поддержки и нажми Enter (ввод скрыт): ',
    'Теперь отправь /selfcheck в General группы поддержки. Ответ бота подтвердит реальную доставку и правильность webhook secret.',
    // This composite includes another localized phrase; real Telegram responses are tested below.
    'VALUE: код VALUE. VALUE']);
  for (const [file, source] of sources) {
    for (const line of source.split('\n')) {
      if (line.trimStart().startsWith('//')) continue;
      for (const match of line.matchAll(/'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/g)) {
        const value = (match[1] ?? match[2]).replace(/\$\{([^}]*)\}/g, (_match, expression) =>
          file === 'bootstrap-state.mjs' && expression === 'name' ? BOOTSTRAP_STAGES[0][0] : 'VALUE')
          .replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\`/g, '`');
        if (!cyrillic.test(value) || excluded.has(value)) continue;
        assert.doesNotMatch(english(value), cyrillic, `${file}: ${value}`);
      }
    }
  }
});

test('switching wizard language does not repeat completed stages or change persisted identifiers', async () => {
  const state = { completed: [], setupLocale: 'ru' }, logs = [];
  let calls = 0;
  for (const [id, label] of BOOTSTRAP_STAGES) {
    await runStage(state, id, 'same-input', async () => { calls++; }, () => {}, () => {});
    state.setupLocale = 'en';
    await runStage(state, id, 'same-input', () => assert.fail('Repeated completed stage'), () => {}, value => logs.push(english(value)));
    assert.equal(logs.at(-1), `✓ ${label}: already completed`);
  }
  assert.equal(calls, BOOTSTRAP_STAGES.length);
  assert.deepEqual(state.completed, BOOTSTRAP_STAGES.map(([id]) => id));
});

test('Telegram errors remain actionable in English without exposing tokens or raw responses', async () => {
  const token = '123:private-token';
  for (const code of [401, 404, 409, 429, 500]) {
    await assert.rejects(request(token, 'getMe', {}, async () => Response.json({ ok: false, error_code: code, description: token }, { status: code })), error => {
      const message = english(error.message);
      assert.match(message, new RegExp(`getMe: code ${code}`));
      assert.doesNotMatch(message, cyrillic);
      assert.ok(!message.includes(token));
      return true;
    });
  }
  for (const code of ['ETIMEDOUT', 'ENOTFOUND', 'CERT_HAS_EXPIRED', 'ECONNRESET']) {
    await assert.rejects(request(token, 'getMe', {}, async () => { throw Object.assign(new Error(token), { code }); }), error => {
      assert.doesNotMatch(english(error.message), cyrillic);
      assert.ok(!english(error.message).includes(token));
      return true;
    });
  }
});

test('webhook setup progress is translated through the wizard logger', async () => {
  const logs = [], url = 'https://support-test.example.workers.dev/tg/manager';
  const results = [{ username: 'manager_test_bot' }, { url: '' }, true,
    { url, pending_update_count: 3, last_error_date: 123 }];
  await connectWebhook({ username: 'manager_test_bot', url, manager: true }, '123:token', 'secret', {
    fetchImpl: async () => Response.json({ ok: true, result: results.shift() }),
    log: value => logs.push(english(value)),
  });
  assert.equal(logs[0], 'Connecting Telegram message delivery to the Worker…');
  assert.ok(logs.some(value => value.includes(url)));
  assert.ok(logs.some(value => value.includes('/start')));
  for (const value of logs) assert.doesNotMatch(value, cyrillic);
});

test('non-interactive CLI help includes both languages without sign-in or resource changes', () => {
  const result = spawnSync(process.execPath, ['scripts/bootstrap.mjs', '--help'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Первый шаг — выбор языка/);
  assert.match(result.stdout, /The first step is language selection/);
  assert.match(result.stdout, /--status-bot/);
  assert.equal(result.stderr, '');
});
