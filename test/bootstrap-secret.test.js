import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('bootstrap webhook secret is stable across retries and encrypted on Windows', { skip: process.platform !== 'win32' }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'bootstrap-secret-test-'));
  const path = join(folder, 'manager.dpapi');
  const script = fileURLToPath(new URL('../scripts/bootstrap-secret.ps1', import.meta.url));
  const run = mode => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Mode', mode, '-Path', path], { encoding: 'utf8', windowsHide: true });
  try {
    const first = run('CreateOrRead');
    assert.equal(first.status, 0, 'DPAPI secret creation should succeed');
    assert.match(first.stdout.trim(), /^[a-f0-9]{64}$/);
    const backup = readFileSync(path, 'utf8');
    assert.ok(backup.length > 100 && !backup.includes(first.stdout.trim()), 'only ciphertext is saved');
    const second = run('Read');
    assert.equal(second.status, 0, 'DPAPI secret read should succeed');
    assert.ok(first.stdout.trim() === second.stdout.trim(), 'retry must reuse the exact webhook secret');
  } finally {
    const inside = relative(tmpdir(), resolve(folder));
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || !basename(folder).startsWith('bootstrap-secret-test-')) {
      throw new Error('Refusing cleanup outside test temporary directory');
    }
    rmSync(folder, { recursive: true, force: true });
  }
});
