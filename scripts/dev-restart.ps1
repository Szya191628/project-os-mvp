# Project OS MVP - local dev service restart
# Usage: powershell -ExecutionPolicy Bypass -File scripts\dev-restart.ps1
# Starts: PostgreSQL (docker) + API (8787) + Web dev server (5173)
# Logs are written to tmp\run\ per project convention.

$ErrorActionPreference = "Stop"

$proj = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $proj "tmp\run"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

# Resolve node executable
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "D:\360Downloads\node.exe" }
if (-not (Test-Path $node)) { throw "node executable not found; please set \$node manually" }

# 1) Stop previous listeners on 8787 / 5173
foreach ($port in @(8787, 5173)) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
      try {
        Stop-Process -Id $_ -Force -ErrorAction Stop
        Write-Host "[stop] port $port <- pid $_"
      } catch { }
    }
}

# 2) Ensure the PostgreSQL container is running
docker compose -f (Join-Path $proj "docker-compose.yml") up -d db

# 3) Start API and web dev server as detached processes
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$api = Start-Process -FilePath $node `
  -ArgumentList "`"$proj\node_modules\tsx\dist\cli.mjs`"", "`"$proj\server\src\main.ts`"" `
  -WorkingDirectory $proj `
  -RedirectStandardOutput "$runDir\api-$ts.stdout.log" `
  -RedirectStandardError  "$runDir\api-$ts.stderr.log" `
  -WindowStyle Hidden -PassThru

$web = Start-Process -FilePath $node `
  -ArgumentList "`"$proj\node_modules\vite\bin\vite.js`"" `
  -WorkingDirectory $proj `
  -RedirectStandardOutput "$runDir\web-$ts.stdout.log" `
  -RedirectStandardError  "$runDir\web-$ts.stderr.log" `
  -WindowStyle Hidden -PassThru

Write-Host "[start] api pid=$($api.Id)  web pid=$($web.Id)"
Start-Sleep -Seconds 8

# 4) Health checks
$checks = @(
  @{ Name = "api /healthz"; Url = "http://127.0.0.1:8787/healthz" },
  @{ Name = "api /readyz";  Url = "http://127.0.0.1:8787/readyz" },
  @{ Name = "web /";        Url = "http://127.0.0.1:5173/" }
)
foreach ($c in $checks) {
  try {
    $r = Invoke-WebRequest -Uri $c.Url -TimeoutSec 8 -UseBasicParsing
    Write-Host ("[ok]   {0}: {1}" -f $c.Name, $r.StatusCode)
  } catch {
    Write-Host ("[fail] {0}: {1}" -f $c.Name, $_.Exception.Message)
  }
}

Write-Host "Logs: $runDir"
Write-Host "Note: the API prints no startup banner; verify readiness via /readyz."
