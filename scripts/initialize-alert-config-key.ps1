param([string]$BackupDirectory = '', [string]$ConfigPath = '')
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$alertConfig = (Resolve-Path -LiteralPath $(if ($ConfigPath) { $ConfigPath } else { Join-Path $PSScriptRoot '..\monitor\wrangler.toml' })).Path
$secretsText = & npx.cmd --yes wrangler@4.128.0 secret list --config $alertConfig
if ($LASTEXITCODE -ne 0) { throw 'Could not read monitor secrets. No key was changed.' }
try { $secrets = ($secretsText -join "`n") | ConvertFrom-Json }
catch { throw 'Could not parse monitor secrets. No key was changed.' }
if (@($secrets | Where-Object { $_.name -eq 'ALERT_CONFIG_KEY' }).Count -gt 0) {
    Write-Host 'ALERT_CONFIG_KEY already exists. Keeping the existing key.'
    exit 0
}

$backupDir = if ($BackupDirectory) { [System.IO.Path]::GetFullPath($BackupDirectory) } else { Join-Path $env:USERPROFILE '.codex\backups\telegram-support' }
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$backup = Join-Path $backupDir 'telegram-support-alert-config-key.dpapi'
$plainKey = $null
try {
    if (Test-Path -LiteralPath $backup) {
        $secureKey = Get-Content -LiteralPath $backup -Raw | ConvertTo-SecureString
        $plainKey = [System.Net.NetworkCredential]::new('', $secureKey).Password
        if ($plainKey -notmatch '^[a-f0-9]{64}$') { throw 'The saved key is invalid. No key was uploaded.' }
    } else {
        $bytes = New-Object byte[] 32
        $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
        $plainKey = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
        $secureKey = ConvertTo-SecureString -String $plainKey -AsPlainText -Force
        $protected = ConvertFrom-SecureString -SecureString $secureKey
        $stream = [System.IO.File]::Open($backup, [System.IO.FileMode]::CreateNew)
        try {
            $data = [System.Text.Encoding]::ASCII.GetBytes($protected)
            $stream.Write($data, 0, $data.Length)
        } finally { $stream.Dispose() }
    }
    Write-Host 'Saving ALERT_CONFIG_KEY for the monitor. The key is not printed.'
    $plainKey | & npx.cmd --yes wrangler@4.128.0 secret put ALERT_CONFIG_KEY --config $alertConfig
    if ($LASTEXITCODE -ne 0) { throw 'Upload failed. Keep the backup and rerun this script to reuse the same key.' }
    Write-Host "Encrypted local backup: $backup"
} finally {
    Remove-Variable plainKey, secureKey, bytes, protected -ErrorAction SilentlyContinue
}
