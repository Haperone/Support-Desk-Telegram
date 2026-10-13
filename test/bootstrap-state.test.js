import assert from 'node:assert/strict';
import test from 'node:test';
import { installationNames } from '../scripts/bootstrap-config.mjs';
import { validateBootstrapState, validateOrigin, runStage, parseBootstrapArgs } from '../scripts/bootstrap-state.mjs';
import { discoverWorkersOrigin } from '../scripts/bootstrap-cloudflare.mjs';

const valid = () => ({ version: 1, slug: 'support-test', names: installationNames('support-test'),
  accountId: 'a'.repeat(32), config: { main: 'main', first: 'first', monitor: 'monitor' }, completed: [],
  groupId: '-10012345', adminId: '12345', managerUsername: 'manager_test_bot',
  publicBaseUrl: 'https://support-test.example.workers.dev', turnstileSiteKey: '0x4AAAAAAnnnnnnnnnnnnnnn', rateNamespaceStart: 123456 });

test('resume accepts valid legacy state but refuses missing account, altered resource ownership and malformed settings', () => {
  const state = valid();
  assert.equal(validateBootstrapState(state, state), state);
  for (const setupLocale of ['ru', 'en']) assert.doesNotThrow(() => validateBootstrapState({ ...state, setupLocale }, state));
  for (const change of [{ accountId: undefined }, { groupId: '123' }, { adminId: '9007199254740992' },
    { rateNamespaceStart: undefined }, { supportDbId: 'wrong' }, { timezone: 'Not/AZone' },
    { publicBaseUrl: state.publicBaseUrl + ':444' }, { config: { ...state.config, monitor: 'production' } },
    { setupLocale: 'es' }, { setupLocale: null }]) {
    assert.throws(() => validateBootstrapState({ ...state, ...change }, state));
  }
  for (const url of ['https://support-test.other.example.workers.dev', 'https://support-test.example.workers.dev/?key=x',
    'https://support-test.example.workers.dev:444']) assert.throws(() => validateOrigin(url, state.slug));
});

test('resume applies new migrations and retries interrupted stages without marking failures complete', async () => {
  const state = { completed: ['migrations'] }, saves = [], applied = [];
  const save = () => saves.push(structuredClone(state));
  const run = (hash, action = async () => applied.push(hash)) => runStage(state, 'migrations', hash, action, save, () => {});
  await run('old'); // Legacy states have no content fingerprint: let Wrangler inspect pending migrations.
  await run('old');
  assert.deepEqual(applied, ['old']);
  await assert.rejects(run('new', async () => { throw new Error('offline'); }), /offline/);
  assert.equal(state.pendingStage, 'migrations');
  assert.equal(state.stageFingerprints.migrations, 'old');
  await run('new');
  assert.deepEqual(applied, ['old', 'new']);
  assert.equal(state.pendingStage, null);
  assert.equal(state.completed.length, 1);
  assert.equal(saves[0].pendingStage, 'migrations');
});

test('CLI help and status-only mode are explicit; unknown arguments do not start an installation', () => {
  assert.equal(parseBootstrapArgs(['--help']).help, true);
  assert.deepEqual(parseBootstrapArgs(['support-test', '--status-bot']), { slug: 'support-test', help: false, statusBot: true });
  assert.throws(() => parseBootstrapArgs(['--yes']));
  assert.throws(() => parseBootstrapArgs(['one', 'two']));
});

test('workers.dev discovery keeps credentials out of output and falls back on missing permissions or bad responses', async () => {
  const token = 'private-test-credential';
  const url = await discoverWorkersOrigin('a'.repeat(32), 'support-test', { token }, async (url, options) => {
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/subdomain`);
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    return Response.json({ success: true, result: { subdomain: 'example' } });
  });
  assert.equal(url, 'https://support-test.example.workers.dev');
  for (const fetchImpl of [async () => new Response('', { status: 403 }), async () => { throw new Error(token); },
    async () => Response.json({ success: true, result: { subdomain: 'evil.test/' } })]) {
    assert.equal(await discoverWorkersOrigin('a'.repeat(32), 'support-test', { token }, fetchImpl), null);
  }
});
