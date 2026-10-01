$ErrorActionPreference = 'Stop'
$manifest = Get-Content (Join-Path $PSScriptRoot 'vendor\manifest.json') -Raw | ConvertFrom-Json
foreach ($package in $manifest.packages) {
    $destination = Join-Path $PSScriptRoot ("vendor\" + $package.directory)
    $archive = Join-Path ([IO.Path]::GetTempPath()) ("gather-vendor-" + [guid]::NewGuid() + '.tgz')
    try {
        Invoke-WebRequest $package.source -OutFile $archive
        $sha = [Security.Cryptography.SHA512]::Create()
        try { $hash = [Convert]::ToBase64String($sha.ComputeHash([IO.File]::ReadAllBytes($archive))) }
        finally { $sha.Dispose() }
        if ("sha512-$hash" -ne $package.integrity) { throw "$($package.name) integrity check failed." }
        New-Item -ItemType Directory -Force -Path $destination | Out-Null
        & tar -xf $archive -C $destination --strip-components=1 @($package.files)
        if ($LASTEXITCODE -ne 0) { throw "$($package.name) extraction failed." }
        Write-Host "Installed $($package.name) $($package.version) with verified integrity."
    } finally {
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
    }
}
