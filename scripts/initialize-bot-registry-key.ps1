param([string]$BackupDirectory = '', [string]$ConfigPath = '')
$ErrorActionPreference = 'Stop'
# A parent Node/PowerShell 7 process may pass its module path to Windows PowerShell.
# Load the security cmdlets matching this host before using Windows DPAPI.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$registryConfig = if ($ConfigPath) { $ConfigPath } else { Join-Path $PSScriptRoot '..\wrangler.toml' }
$registryConfig = (Resolve-Path -LiteralPath $registryConfig).Path
$registryConfigText = Get-Content -LiteralPath $registryConfig -Raw
$registryWorkerMatch = [regex]::Match($registryConfigText, '(?m)^name\s*=\s*"([a-z0-9-]+)"')
if (-not $registryWorkerMatch.Success) { throw 'Cannot determine the Worker name from wrangler.toml.' }
$registryWorkerName = $registryWorkerMatch.Groups[1].Value

# Never replace an existing encryption key: previous bot tokens depend on it.
$registrySecretsText = & npx.cmd --yes wrangler@4.128.0 secret list --config $registryConfig
if ($LASTEXITCODE -ne 0) { throw 'Could not read Cloudflare secrets. No key was changed.' }
try { $registrySecrets = ($registrySecretsText -join "`n") | ConvertFrom-Json }
catch { throw 'Could not parse the secrets list. No key was changed.' }
if (@($registrySecrets | Where-Object { $_.name -eq 'BOT_REGISTRY_KEY' }).Count -gt 0) {
    Write-Host 'BOT_REGISTRY_KEY already exists. Keeping the existing key.'
    exit 0
}

$registryBackupDir = if ($BackupDirectory) { [System.IO.Path]::GetFullPath($BackupDirectory) } else { Join-Path $env:USERPROFILE '.codex\backups\telegram-support' }
New-Item -ItemType Directory -Path $registryBackupDir -Force | Out-Null
$registryKeyBackup = Join-Path $registryBackupDir ($registryWorkerName + '-registry-key.dpapi')
$registryPlainKey = $null
try {
    if (Test-Path -LiteralPath $registryKeyBackup) {
        $registrySecureKey = Get-Content -LiteralPath $registryKeyBackup -Raw | ConvertTo-SecureString
        $registryPlainKey = [System.Net.NetworkCredential]::new('', $registrySecureKey).Password
        if ($registryPlainKey -notmatch '^[a-f0-9]{64}$') { throw 'The saved key is invalid. No key was uploaded.' }
    } else {
        $registryBytes = New-Object byte[] 32
        $registryGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $registryGenerator.GetBytes($registryBytes) } finally { $registryGenerator.Dispose() }
        $registryPlainKey = [BitConverter]::ToString($registryBytes).Replace('-', '').ToLowerInvariant()
        $registrySecureKey = ConvertTo-SecureString -String $registryPlainKey -AsPlainText -Force
        $registryProtectedKey = ConvertFrom-SecureString -SecureString $registrySecureKey
        # CreateNew prevents concurrent runs from replacing a backup with another key.
        $registryBackupStream = [System.IO.File]::Open($registryKeyBackup, [System.IO.FileMode]::CreateNew)
        try {
            $registryBackupBytes = [System.Text.Encoding]::ASCII.GetBytes($registryProtectedKey)
            $registryBackupStream.Write($registryBackupBytes, 0, $registryBackupBytes.Length)
        } finally { $registryBackupStream.Dispose() }
    }
    Write-Host "Saving BOT_REGISTRY_KEY for $registryWorkerName. The key is not printed."
    $registryPlainKey | & npx.cmd --yes wrangler@4.128.0 secret put BOT_REGISTRY_KEY --config $registryConfig
    if ($LASTEXITCODE -ne 0) { throw 'Upload failed. Keep the backup and rerun this script to reuse the same key.' }
    Write-Host "Encrypted local backup: $registryKeyBackup"
    Write-Host 'This DPAPI backup can be opened by this Windows account on this computer.'
} finally {
    Remove-Variable registryPlainKey, registrySecureKey, registryBytes, registryProtectedKey -ErrorAction SilentlyContinue
}
