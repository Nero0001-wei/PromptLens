param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("dev", "prod")]
  [string]$Environment
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $projectRoot ".env.$Environment.local"
$templateFile = Join-Path $projectRoot "s.$Environment.yaml"

if (-not (Test-Path $templateFile)) {
  throw "Missing deployment template: $templateFile"
}

if (-not (Test-Path $envFile)) {
  throw "Missing environment file: $envFile. Copy .env.$Environment.local.example and fill it first."
}

Get-Content -Encoding UTF8 $envFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) {
    return
  }

  $parts = $line -split "=", 2
  if ($parts.Length -ne 2) {
    return
  }

  $name = $parts[0].Trim()
  $value = $parts[1]
  [Environment]::SetEnvironmentVariable($name, $value, "Process")
}

if (-not $env:ZHIPU_API_KEY) {
  throw "Missing ZHIPU_API_KEY in .env.$Environment.local."
}

if (-not $env:CORS_ORIGIN) {
  $env:CORS_ORIGIN = "*"
}

if ($null -eq $env:APP_TOKEN -or $env:APP_TOKEN -eq "") {
  $env:APP_TOKEN = "__NONE__"
}

if (-not $env:RATE_LIMIT_WINDOW_MS) {
  $env:RATE_LIMIT_WINDOW_MS = "600000"
}

if (-not $env:RATE_LIMIT_MAX_REQUESTS) {
  $env:RATE_LIMIT_MAX_REQUESTS = "30"
}

if (-not $env:RATE_LIMIT_DISABLED) {
  $env:RATE_LIMIT_DISABLED = "false"
}

Write-Host "Deploying PromptLens backend to $Environment environment..." -ForegroundColor Cyan
Write-Host "Template: $templateFile"

Set-Location $projectRoot
s -t $templateFile deploy -y
