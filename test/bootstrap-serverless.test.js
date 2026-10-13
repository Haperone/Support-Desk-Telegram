import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STATUS_COPY } from '../alert-serverless/tgcloud/lib/copy.js';
import { createBootstrapText } from '../scripts/bootstrap-copy.mjs';
import { identityProbe, renderStatusSettings, parseIdentity, checkWebhook, checkServerlessTarget, prepareStatusProject, setupServerlessStatus } from '../scripts/bootstrap-serverless.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const stateFor = () => ({ slug: 'support-test', adminId: '123456', groupId: '-100987654', timezone: 'Asia/Tokyo', monitorLocale: 'es',
  managerBotId: 111, managerUsername: 'fresh_manager_bot', names: { supportWorker: 'support-test', monitorWorker: 'support-test-monitor' },
  publicBaseUrl: 'https://support-test.example.workers.dev', config: { monitor: 'isolated-monitor.toml' } });
const bot = { id: 222, username: 'fresh_alert_bot' };

test('the generated identity endpoint runs using only the SDK API and the runtime console', async () => {
  const logs = [];
  const handler = new Function('api', 'console', identityProbe.replace("import { api } from 'sdk';", '').replace('export default', 'return'))(
    { getMe: async () => bot }, { log: value => logs.push(value) });
  assert.deepEqual(await handler(), { inspected: true });
  assert.deepEqual(parseIdentity(logs[0]), bot);
});
function temporary(t) {
  const folder = mkdtempSync(join(tmpdir(), 'bootstrap-status-test-'));
  t.after(() => {
    const inside = relative(tmpdir(), resolve(folder));
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || !basename(folder).startsWith('bootstrap-status-test-')) throw new Error('Unsafe test cleanup');
    rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}

test('new Telegram projects use only their own user, group, bot and timezone; manual edits are preserved', t => {
  const project = temporary(t), state = stateFor();
  prepareStatusProject(root, project, state, bot, () => {});
  const path = join(project, 'tgcloud/lib/settings.js');
  const settings = readFileSync(path, 'utf8');
  assert.equal(settings, renderStatusSettings(state, bot));
  assert.match(settings, /Asia\/Tokyo/);
  assert.match(settings, /STATUS_LOCALE = "es"/);
  assert.doesNotMatch(settings, /123456789|9876543210|1001234567890|Europe\/Budapest/);
  writeFileSync(path, settings + '// my change');
  assert.throws(() => prepareStatusProject(root, project, state, { ...bot, username: 'new_alert_bot' }, () => {}), /изменён вручную/);
  assert.match(readFileSync(path, 'utf8'), /my change/);
});

test('Serverless enrollment refuses the manager, foreign webhook, wrong bot and an existing unowned program', () => {
  const state = stateFor();
  assert.deepEqual(parseIdentity(`BOOTSTRAP_IDENTITY:${JSON.stringify(bot)}\n`), bot);
  assert.throws(() => parseIdentity('missing metadata'));
  assert.throws(() => checkServerlessTarget(state, { ...bot, id: state.managerBotId }, '0 modules'), /Админушка/);
  assert.throws(() => checkWebhook(bot, '  url: https://other.test/webhook'), /webhook/);
  assert.throws(() => checkWebhook(bot, '  url: https://cloud.telegram.org/app333/webhook'), /webhook/);
  assert.doesNotThrow(() => checkWebhook(bot, '  url: (none set)'));
  assert.throws(() => checkWebhook(bot, '  url: (none set)', { requireActive: true }));
  assert.doesNotThrow(() => checkWebhook(bot, '  url: https://cloud.telegram.org/app222/webhook', { requireActive: true }));
  assert.throws(() => checkServerlessTarget(state, bot, '7 modules'), /уже есть программа/);
  assert.throws(() => checkServerlessTarget({ ...state, serverless: { botId: 333 } }, bot, '0 modules'), /другого/);
  assert.doesNotThrow(() => checkServerlessTarget({ ...state, serverless: { botId: bot.id, deployStarted: true } }, bot, '5 modules'));
});

test('generated projects render commands, refresh buttons and access errors in their configured language', async t => {
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    const project = temporary(t), state = { ...stateFor(), monitorLocale: locale };
    prepareStatusProject(root, project, state, bot, () => {});
    writeFileSync(join(project, 'package.json'), '{"type":"module"}');
    const { handleMessage, handleCallback } = await import(pathToFileURL(join(project, 'tgcloud/lib/status.js')).href);
    const calls = [];
    const dependencies = { db: { get: async () => null }, fetch: async () => assert.fail('Unconfigured status must not fetch'),
      api: { sendMessage: async body => calls.push(body), answerCallbackQuery: async body => calls.push(body) } };
    await handleMessage({ text: '/status@fresh_alert_bot', from: { id: Number(state.adminId) },
      chat: { type: 'private', id: Number(state.adminId) } }, dependencies);
    assert.ok(calls[0].text.startsWith(STATUS_COPY[locale].title));
    assert.equal(calls[0].reply_markup.inline_keyboard[0][0].text, STATUS_COPY[locale].refresh);
    await handleCallback({ id: 'denied', data: 'status:refresh', from: { id: 999 },
      message: { chat: { type: 'private', id: 999 } } }, dependencies);
    assert.equal(calls[1].text, STATUS_COPY[locale].forbidden);
  }
});

test('status enrollment resumes after configuration failure and never enables handlers before a successful check', async t => {
  const folder = temporary(t), state = stateFor(), calls = [], token = 'a'.repeat(64), messages = [];
  const english = createBootstrapText('en');
  let failed = false, modules = 0;
  const { cpSync, mkdirSync } = await import('node:fs');
  // Copy only public project sources; never read or copy the real CLI credential directory.
  mkdirSync(join(folder, 'alert-serverless'));
  cpSync(join(root, 'alert-serverless/tgcloud'), join(folder, 'alert-serverless/tgcloud'), { recursive: true });
  writeFileSync(join(folder, 'alert-serverless/tgcloud.jsonc'), '{}');
  const dependencies = { root: folder, state, backupDir: folder, save: () => {},
    log: value => messages.push(english(value)),
    ask: async prompt => { messages.push(english(prompt)); return ''; },
    choose: async (prompt, options) => {
      messages.push(english(prompt), ...options.map(option => english(option.label))); return true;
    },
    npx: () => ({ command: 'node', prefix: ['npx-cli.js'] }),
    generatedSecret: async (config, name) => {
      assert.equal(config, state.config.monitor); assert.equal(name, 'STATUS_READ_TOKEN'); return token;
    },
    child: async (_command, args, options) => {
      const command = args.slice(args.indexOf('tgcloud') + 1); calls.push({ command, options });
      if (command[0] === 'fetch') return `Snapshot updated — ${modules} modules (revision 1)`;
      if (command[0] === 'webhook') return '  url: https://cloud.telegram.org/app222/webhook';
      if (command[1] === 'endpoints/bootstrapIdentity') return `BOOTSTRAP_IDENTITY:${JSON.stringify(bot)}`;
      if (command[0] === 'push') { modules = 5; return 'done'; }
      if (command[1] === 'endpoints/configureStatus') {
        assert.equal(options.inherit, undefined, 'CLI input containing the key must be captured');
        assert.equal(JSON.parse(command[2]).monitorUrl, 'https://support-test-monitor.example.workers.dev/health/status');
        if (!failed) { failed = true; throw new Error('temporary failure'); }
        return '< {configured:true}';
      }
      if (command[1] === 'endpoints/getStatus') return '< {error:null,snapshot:{overall:"degraded"}}';
      return 'done';
    },
  };
  await assert.rejects(setupServerlessStatus(dependencies), /temporary failure/);
  assert.equal(calls.some(call => call.command.includes('tgcloud/handlers/')), false);
  assert.equal(state.serverless.completedAt, undefined);
  await setupServerlessStatus(dependencies);
  assert.ok(state.serverless.completedAt);
  assert.equal(calls.filter(call => call.command.includes('tgcloud/handlers/')).length, 1);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(token));
  assert.match(messages.join('\n'), /Status connected/);
  assert.match(messages.join('\n'), /Yes, this is my alert bot/);
  assert.doesNotMatch(messages.join('\n'), /[А-Яа-яЁё]/);
  assert.ok(!messages.join('\n').includes(token));
});
