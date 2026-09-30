$ErrorActionPreference = 'Stop'
$manifest = Get-Content (Join-Path $PSScriptRoot 'vendor\manifest.json') -Raw | ConvertFrom-Json
$destination = Join-Path $PSScriptRoot 'vendor\msal-browser'
$archive = Join-Path ([IO.Path]::GetTempPath()) ("gather-msal-" + [guid]::NewGuid() + '.tgz')
try {
    Invoke-WebRequest $manifest.source -OutFile $archive
    $sha = [Security.Cryptography.SHA512]::Create()
    try { $hash = [Convert]::ToBase64String($sha.ComputeHash([IO.File]::ReadAllBytes($archive))) }
    finally { $sha.Dispose() }
    if ("sha512-$hash" -ne $manifest.integrity) { throw 'Microsoft SDK integrity check failed.' }
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    & tar -xf $archive -C $destination --strip-components=1 @($manifest.files)
    if ($LASTEXITCODE -ne 0) { throw 'Microsoft SDK extraction failed.' }
    Write-Host "Installed $($manifest.name) $($manifest.version) with verified integrity."
} finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
}
