$ErrorActionPreference = 'Stop'
$output = Join-Path $PSScriptRoot 'dist'
$files = @(
    'index.html', 'oauth-redirect.html', 'oauth-redirect.js', 'styles.css',
    'app.js', 'mail.js', 'auth.js', 'accounts-panel.js', 'mailbox-store.js', 'provider-mail.js',
    'email-html.js', 'email-images.js', 'email-styles.js', 'email-text.js', 'email-quotes.js', 'email-send.js',
    'conversation-actions.js',
    'staticwebapp.config.json',
    'vendor\msal-browser\lib\msal-browser.min.js',
    'vendor\msal-browser\lib\redirect-bridge\msal-redirect-bridge.js',
    'vendor\msal-browser\LICENSE',
    'vendor\dompurify\dist\purify.es.mjs',
    'vendor\dompurify\LICENSE'
)
$files = $files | ForEach-Object { $_.Replace('\', [IO.Path]::DirectorySeparatorChar) }
foreach ($file in $files) {
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $file) -PathType Leaf)) {
        throw "Required deployment file is missing: $file. Run restore-sdk.ps1 if vendor files are missing."
    }
}
Get-Content (Join-Path $PSScriptRoot 'staticwebapp.config.json') -Raw | ConvertFrom-Json | Out-Null
if (Test-Path -LiteralPath $output) {
    if ((Get-Item -LiteralPath $output).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Refusing to package into a linked dist directory.'
    }
    foreach ($item in Get-ChildItem -LiteralPath $output -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked path in dist is not allowed: $($item.Name)" }
        $relative = $item.FullName.Substring($output.Length + 1)
        if (!$item.PSIsContainer -and $relative -notin $files) {
            throw "Unexpected file in dist: $relative. Remove it before packaging to avoid publishing unintended files."
        }
    }
}
New-Item -ItemType Directory -Path $output -Force | Out-Null
foreach ($file in $files) {
    $destination = Join-Path $output $file
    New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $destination -Force
}
Write-Host "Packaged $($files.Count) production files into $output. Tests, scripts, and local data are excluded."
