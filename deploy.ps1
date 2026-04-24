$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $projectRoot ".env.local"

if (Test-Path $envFile) {
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
}

if (-not $env:ZHIPU_API_KEY) {
  throw "Missing ZHIPU_API_KEY. Create .env.local first."
}

if (-not $env:CORS_ORIGIN) {
  $env:CORS_ORIGIN = "*"
}

if ($null -eq $env:APP_TOKEN) {
  $env:APP_TOKEN = "__NONE__"
}

Set-Location $projectRoot
s deploy -y
