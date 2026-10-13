import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('registration key: Windows backup survives an upload failure and a rerun never overwrites a Cloudflare key', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-key-test-'));
  const harness = join(dir, 'test.ps1');
  const script = fileURLToPath(new URL('../scripts/initialize-bot-registry-key.ps1', import.meta.url));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  writeFileSync(harness, `\uFEFF
param([string]$Scenario)
$global:RegistryTestScenario = $Scenario
function global:npx.cmd {
  $global:LASTEXITCODE = 0
  if ($args[2] -ne 'secret') { throw 'Unexpected mock command' }
  if ($args[3] -eq 'list') {
    if ($global:RegistryTestScenario -eq 'exists') { return '[{"name":"BOT_REGISTRY_KEY","type":"secret_text"}]' }
    return '[]'
  }
  if ($args[3] -ne 'put' -or $args[4] -ne 'BOT_REGISTRY_KEY') { throw 'Unexpected mock command' }
  $registryTestValue = ($input -join "").Trim()
  if ($registryTestValue -notmatch '^[a-f0-9]{64}$') { throw 'Invalid secret format' }
  $registryTestHash = [System.Security.Cryptography.SHA256]::Create()
  try { $registryTestDigest = [BitConverter]::ToString($registryTestHash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($registryTestValue))) }
  finally { $registryTestHash.Dispose() }
  [System.IO.File]::AppendAllText(${quote(join(dir, 'hashes.txt'))}, $registryTestDigest + [Environment]::NewLine)
  if ($global:RegistryTestScenario -eq 'fail') { $global:LASTEXITCODE = 1 }
}
& ${quote(script)} -BackupDirectory ${quote(dir)}
`, 'utf8');
  const invoke = scenario => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', harness, scenario], { encoding: 'utf8', windowsHide: true });
  const failed = invoke('fail');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Upload failed/, failed.stdout + failed.stderr);
  const backup = readFileSync(join(dir, 'telegram-private-chatbot-registry-key.dpapi'), 'utf8');
  assert.ok(backup.length > 100, 'backup is encrypted using Windows DPAPI');
  const retried = invoke('success');
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(readFileSync(join(dir, 'telegram-private-chatbot-registry-key.dpapi'), 'utf8'), backup);
  const hashes = readFileSync(join(dir, 'hashes.txt'), 'utf8').trim().split(/\r?\n/);
  assert.equal(hashes.length, 2); assert.equal(hashes[0], hashes[1], 'the same key is uploaded on retry');
  const existing = invoke('exists');
  assert.equal(existing.status, 0, existing.stderr);
  assert.equal(readFileSync(join(dir, 'hashes.txt'), 'utf8').trim().split(/\r?\n/).length, 2, 'no put when key already exists');
  assert.match(existing.stdout, /already exists/);
  for (const result of [failed, retried, existing]) assert.doesNotMatch(result.stdout + result.stderr, /\b[a-f0-9]{64}\b/i, 'the plaintext key is never printed');
});
