import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installationNames, renderBootstrapConfigs } from './bootstrap-config.mjs';
import { WRANGLER } from './bootstrap-state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const slug = 'support-bootstrap-check';
const paths = {
  main: join(root, `wrangler.bootstrap.${slug}.toml`),
  first: join(root, `wrangler.bootstrap.${slug}.first.toml`),
  monitor: join(root, 'monitor', `wrangler.bootstrap.${slug}.toml`),
};
const out = mkdtempSync(join(root, '.bootstrap-validation-'));
const created = [];

function npx() {
  if (process.platform !== 'win32') return { command: 'npx', args: [] };
  const roots = [dirname(process.execPath), process.env.APPDATA && join(process.env.APPDATA, 'npm'),
    ...(process.env.PATH || '').split(';')].filter(Boolean);
  const cli = roots.map(folder => join(folder, 'node_modules', 'npm', 'bin', 'npx-cli.js')).find(existsSync);
  if (!cli) throw new Error('Cannot locate npm/bin/npx-cli.js');
  return { command: process.execPath, args: [cli] };
}

function safeRemove(path, recursive = false) {
  const absolute = resolve(path);
  const inside = relative(root, absolute);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || !basename(absolute).startsWith(recursive ? '.bootstrap-validation-' : 'wrangler.bootstrap.support-bootstrap-check')) {
    throw new Error('Refusing cleanup outside bootstrap validation files');
  }
  rmSync(absolute, { force: true, recursive });
}

try {
  for (const path of Object.values(paths)) if (existsSync(path)) throw new Error(`Validation file already exists: ${path}`);
  const generated = renderBootstrapConfigs(readFileSync(join(root, 'wrangler.toml'), 'utf8'),
    readFileSync(join(root, 'monitor', 'wrangler.toml'), 'utf8'), {
      names: installationNames(slug), accountId: 'a'.repeat(32),
      supportDbId: '11111111-1111-4111-8111-111111111111',
      monitorDbId: '22222222-2222-4222-8222-222222222222',
      groupId: '-100987654321', adminId: '123456789', managerUsername: 'fresh_manager_bot',
      publicBaseUrl: `https://${slug}.example.workers.dev`,
      turnstileSiteKey: '0x4AAAAAAnnnnnnnnnnnnnnn', rateNamespaceStart: 123456,
    });
  writeFileSync(paths.main, generated.main, { flag: 'wx' });
  created.push(paths.main);
  writeFileSync(paths.first, generated.firstMain, { flag: 'wx' });
  created.push(paths.first);
  writeFileSync(paths.monitor, generated.monitor, { flag: 'wx' });
  created.push(paths.monitor);
  const command = npx();
  for (const [label, path] of Object.entries(paths)) {
    const result = spawnSync(command.command,
      [...command.args, '--yes', `wrangler@${WRANGLER}`, 'deploy', '--dry-run', '--config', path, '--outdir', join(out, label)],
      { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Bootstrap ${label} Wrangler dry-run failed`);
    console.log(`Bootstrap ${label}: Wrangler dry-run OK`);
  }
} finally {
  for (const path of created) if (existsSync(path)) safeRemove(path);
  safeRemove(out, true);
}
