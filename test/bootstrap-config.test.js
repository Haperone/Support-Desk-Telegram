import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { installationNames, renderBootstrapConfigs, readD1List, findOwnDatabase } from '../scripts/bootstrap-config.mjs';

const mainTemplate = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const monitorTemplate = readFileSync(new URL('../monitor/wrangler.toml', import.meta.url), 'utf8');
const names = installationNames('support-new-install');
const input = {
  names, accountId: 'a'.repeat(32), supportDbId: '11111111-1111-4111-8111-111111111111',
  monitorDbId: '22222222-2222-4222-8222-222222222222', groupId: '-100987654321',
  adminId: '987654321', managerUsername: 'fresh_manager_bot',
  publicBaseUrl: 'https://support-new-install.example.workers.dev',
  turnstileSiteKey: '0x4AAAAAAnnnnnnnnnnnnnnn', rateNamespaceStart: 123456,
};

test('bootstrap renders isolated Worker and D1 configuration without production IDs', () => {
  const { main, firstMain, monitor } = renderBootstrapConfigs(mainTemplate, monitorTemplate, input);
  assert.match(main, /^name = "support-new-install"$/m);
  assert.match(main, /^database_name = "support-new-install-support"$/m);
  assert.match(main, /^MANAGER_BOT_USERNAME = "fresh_manager_bot"$/m);
  assert.match(main, /^PUBLIC_BASE_URL = "https:\/\/support-new-install\.example\.workers\.dev"$/m);
  assert.match(main, /^namespace_id = "123460"$/m);
  assert.match(main, /^service = "support-new-install-monitor"$/m);
  assert.equal((main.match(/\[\[services\]\]/g) || []).length, 3);
  assert.equal(firstMain.includes('[[services]]'), false);
  assert.match(monitor, /^name = "support-new-install-monitor"$/m);
  assert.match(monitor, /^CF_ACCOUNT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"$/m);
  assert.match(monitor, /^service = "support-new-install"$/m);
  assert.ok(!main.includes(mainTemplate.match(/^database_id = "([^"]+)"/m)[1]));
  assert.ok(!monitor.includes(monitorTemplate.match(/^database_id = "([^"]+)"/m)[1]));
});

test('renamed template Workers and an explicit account do not retain old bindings or duplicate account IDs', () => {
  const mainSource = mainTemplate.replaceAll('telegram-private-chatbot', 'previous-support')
    .replaceAll('telegram-support-usage-monitor', 'previous-monitor').replace(/^name = .*$/m, value => `${value}\naccount_id = "${'b'.repeat(32)}"`);
  const monitorSource = monitorTemplate.replaceAll('telegram-private-chatbot', 'previous-support')
    .replaceAll('telegram-support-usage-monitor', 'previous-monitor').replace(/^name = .*$/m, value => `${value}\naccount_id = "${'b'.repeat(32)}"`);
  const { main, monitor } = renderBootstrapConfigs(mainSource, monitorSource, { ...input, timezone: 'Asia/Tokyo', monitorLocale: 'ru' });
  assert.equal((main.match(/^account_id =/gm) || []).length, 1);
  assert.equal((monitor.match(/^account_id =/gm) || []).length, 1);
  assert.doesNotMatch(main, /^service = "previous-/m);
  assert.doesNotMatch(monitor, /^service = "previous-/m);
  assert.match(monitor, /^DISPLAY_TIMEZONE = "Asia\/Tokyo"$/m);
  assert.match(monitor, /^MONITOR_LOCALE = "ru"$/m);
});

test('bootstrap refuses to adopt a database without saved ownership', () => {
  const list = readD1List({ result: [{ name: 'support-new-install-support', uuid: 'id' }] });
  assert.throws(() => findOwnDatabase(list, 'support-new-install-support'), /без записи UUID/);
  assert.equal(findOwnDatabase(list, 'support-new-install-support', 'id')?.uuid, 'id');
  assert.throws(() => findOwnDatabase(list, 'support-new-install-support', 'other'), /конфликт/);
});
