param(
    [Parameter(Mandatory=$true)][ValidateSet('CreateOrRead','Read')][string]$Mode,
    [Parameter(Mandatory=$true)][string]$Path
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
if (-not (Test-Path -LiteralPath $Path)) {
    if ($Mode -eq 'Read') { throw 'Encrypted webhook secret backup is missing.' }
    $directory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Path))
    [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    $bytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    $plain = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
    $secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
    $protected = ConvertFrom-SecureString -SecureString $secure
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew)
    try {
        $data = [System.Text.Encoding]::ASCII.GetBytes($protected)
        $stream.Write($data, 0, $data.Length)
    } finally { $stream.Dispose() }
} else {
    $secure = Get-Content -LiteralPath $Path -Raw | ConvertTo-SecureString
    $plain = [System.Net.NetworkCredential]::new('', $secure).Password
}
if ($plain -notmatch '^[a-f0-9]{64}$') { throw 'Encrypted webhook secret backup is invalid.' }
[Console]::Out.WriteLine($plain)
