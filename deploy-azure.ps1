param(
    [Parameter(Mandatory = $true)][string]$SubscriptionId,
    [Parameter(Mandatory = $true)][string]$ResourceGroup,
    [Parameter(Mandatory = $true)][string]$AppName,
    [string]$AzureCli = 'az',
    [string]$SwaCli = 'swa'
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build-static.ps1')
$hostname = & $AzureCli staticwebapp show --name $AppName --resource-group $ResourceGroup --subscription $SubscriptionId --query defaultHostname --output tsv --only-show-errors
if ($LASTEXITCODE -ne 0 -or !$hostname) { throw 'Unable to access the target Static Web App. Run az login and check the resource arguments.' }
$previousToken = $env:SWA_CLI_DEPLOYMENT_TOKEN
try {
    $token = & $AzureCli staticwebapp secrets list --name $AppName --resource-group $ResourceGroup --subscription $SubscriptionId --query properties.apiKey --output tsv --only-show-errors
    if ($LASTEXITCODE -ne 0 -or !$token) { throw 'Unable to obtain deployment authorization for the selected Static Web App.' }
    $env:SWA_CLI_DEPLOYMENT_TOKEN = $token.Trim()
    $token = $null
    & $SwaCli deploy (Join-Path $PSScriptRoot 'dist') --swa-config-location (Join-Path $PSScriptRoot 'dist') --env production --no-use-keychain
    if ($LASTEXITCODE -ne 0) { throw 'Azure Static Web Apps deployment failed. The deployment CLI output contains the failure details.' }
    Write-Host "Published to https://$hostname/"
} finally {
    $env:SWA_CLI_DEPLOYMENT_TOKEN = $previousToken
    $token = $null
}
