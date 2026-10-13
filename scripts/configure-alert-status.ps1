#requires -Version 7.0
param(
    [switch]$CloudflareOnly,
    [string]$MonitorUrl = '',
    [long]$AdminId = 0
)
$ErrorActionPreference = 'Stop'
if (-not $CloudflareOnly -and (-not $MonitorUrl -or $AdminId -le 0)) {
    throw 'Provide your own -MonitorUrl and positive -AdminId, or use the setup wizard.'
}
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverlessRoot = Join-Path $projectRoot 'alert-serverless'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$npxRoots = @((Split-Path $nodeExecutable), (Join-Path $env:APPDATA 'npm'))
$npxCli = $npxRoots | ForEach-Object { Join-Path $_ 'node_modules\npm\bin\npx-cli.js' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $npxCli) { throw 'Cannot find the npm CLI.' }
$monitorConfig = Join-Path $projectRoot 'monitor\wrangler.toml'
$secretListText = & $nodeExecutable $npxCli --yes wrangler@4.149.0 secret list --config $monitorConfig
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect monitor secrets.' }
$secretList = ($secretListText -join "`n") | ConvertFrom-Json
$alreadyConfigured = @($secretList | Where-Object { $_.name -eq 'STATUS_READ_TOKEN' }).Count -gt 0
$backupDir = Join-Path $env:USERPROFILE '.codex\backups\telegram-support'
$backupPath = Join-Path $backupDir 'telegram-support-status-read-token.dpapi'
if ($alreadyConfigured -and -not (Test-Path -LiteralPath $backupPath)) {
    throw 'STATUS_READ_TOKEN already exists but its local backup is missing. No key was changed.'
}
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$accessToken = $null
try {
    if (Test-Path -LiteralPath $backupPath) {
        $secureToken = Get-Content -LiteralPath $backupPath -Raw | ConvertTo-SecureString
        $accessToken = [System.Net.NetworkCredential]::new('', $secureToken).Password
    } else {
        $accessToken = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
        $secureToken = ConvertTo-SecureString $accessToken -AsPlainText -Force
        $protectedToken = ConvertFrom-SecureString $secureToken
        $stream = [System.IO.File]::Open($backupPath, [System.IO.FileMode]::CreateNew)
        try {
            $bytes = [System.Text.Encoding]::ASCII.GetBytes($protectedToken)
            $stream.Write($bytes, 0, $bytes.Length)
        } finally { $stream.Dispose() }
    }
    if ($accessToken -notmatch '^[a-f0-9]{64}$') { throw 'The saved status key is invalid.' }
    if (-not $alreadyConfigured) {
        Write-Host 'Saving the status read key in Cloudflare. The key is not printed.'
        $accessToken | & $nodeExecutable $npxCli --yes wrangler@4.149.0 secret put STATUS_READ_TOKEN --config $monitorConfig
        if ($LASTEXITCODE -ne 0) { throw 'Could not save the status read key. Keep its encrypted backup.' }
    }
    if ($CloudflareOnly) { Write-Host 'Cloudflare status key is ready.'; return }
    $inputJson = @{ monitorUrl = $MonitorUrl; accessToken = $accessToken } | ConvertTo-Json -Compress
    $contextJson = @{ initData = @{ user = @{ id = $AdminId } } } | ConvertTo-Json -Compress
    Push-Location -LiteralPath $serverlessRoot
    try {
        # Pass JSON directly to Node argv; no shell-built command or plaintext file.
        # The CLI echoes input arguments, so capture its output without displaying the key.
        $configurationOutput = & $nodeExecutable $npxCli --yes --package '@tgcloud/cli@0.2.0' tgcloud run endpoints/configureStatus $inputJson --ctx $contextJson 2>&1
        if ($LASTEXITCODE -ne 0) { throw 'Telegram status configuration failed. No bot token was changed.' }
        if (($configurationOutput -join "`n") -notmatch 'configured:\s*true') { throw 'Telegram did not confirm the status configuration.' }
        Write-Host 'Telegram status configuration confirmed. The key is not printed.'
    } finally { Pop-Location }
} finally {
    Remove-Variable accessToken,secureToken,protectedToken,bytes,inputJson,configurationOutput -ErrorAction SilentlyContinue
}
