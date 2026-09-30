param([int]$Port = 5173)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$files = @{
    '/' = @('index.html', 'text/html')
    '/index.html' = @('index.html', 'text/html')
    '/styles.css' = @('styles.css', 'text/css')
    '/app.js' = @('app.js', 'text/javascript')
    '/mail.js' = @('mail.js', 'text/javascript')
    '/tests.html' = @('tests.html', 'text/html')
    '/mail.test.js' = @('mail.test.js', 'text/javascript')
    '/ui-tests.html' = @('ui-tests.html', 'text/html')
    '/ui.test.js' = @('ui.test.js', 'text/javascript')
    '/provider-mail.js' = @('provider-mail.js', 'text/javascript')
    '/mailbox-store.js' = @('mailbox-store.js', 'text/javascript')
    '/auth.js' = @('auth.js', 'text/javascript')
    '/accounts-panel.js' = @('accounts-panel.js', 'text/javascript')
    '/oauth-redirect.html' = @('oauth-redirect.html', 'text/html')
    '/oauth-redirect.js' = @('oauth-redirect.js', 'text/javascript')
    '/vendor/msal-browser/lib/msal-browser.min.js' = @('vendor\msal-browser\lib\msal-browser.min.js', 'text/javascript')
    '/vendor/msal-browser/lib/redirect-bridge/msal-redirect-bridge.js' = @('vendor\msal-browser\lib\redirect-bridge\msal-redirect-bridge.js', 'text/javascript')
    '/provider-tests.html' = @('provider-tests.html', 'text/html')
    '/provider.test.js' = @('provider.test.js', 'text/javascript')
}
try {
    $listener.Start()
    Write-Host "Gather is running at http://127.0.0.1:$Port (Ctrl+C to stop)"
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $response = $context.Response
        try {
            $response.Headers.Add('X-Content-Type-Options', 'nosniff')
            $response.Headers.Add('Referrer-Policy', 'no-referrer')
            $file = $files[$context.Request.Url.AbsolutePath]
            if ($null -eq $file) {
                $response.StatusCode = 404
                $bytes = [Text.Encoding]::UTF8.GetBytes('Not found')
            } else {
                $response.ContentType = "$($file[1]); charset=utf-8"
                $response.Headers.Add('Cache-Control', 'no-store')
                $bytes = [IO.File]::ReadAllBytes((Join-Path $root $file[0]))
            }
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } catch {
            Write-Warning $_
        } finally {
            $response.Close()
        }
    }
} finally {
    $listener.Close()
}
