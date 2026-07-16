# ============================================================
#  KD Database - Emergency Self-Host via Cloudflare Tunnel
#  Run your PC as a server with Cloudflare as the public exit.
#
#  Usage   : double-click start-hosting.bat
#  One-time: winget install --id Cloudflare.cloudflared -e
# ============================================================
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $proj

Write-Host ""
Write-Host "============================================" -ForegroundColor DarkGray
Write-Host "  KD Database  --  Emergency Hosting" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor DarkGray
Write-Host ""

# Step 1: Check Node.js
$nodeOk = (Get-Command node -ErrorAction SilentlyContinue) -ne $null
if (-not $nodeOk) {
  Write-Host "[ERROR] Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
  Read-Host "Press Enter to exit"; exit 1
}

# Step 2: Check cloudflared
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) { $cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe" }
if (-not $cf -or -not (Test-Path $cf)) {
  Write-Host "[ERROR] cloudflared not found." -ForegroundColor Red
  Write-Host ""
  Write-Host "Install it once with (run in PowerShell):" -ForegroundColor Yellow
  Write-Host "  winget install --id Cloudflare.cloudflared -e" -ForegroundColor White
  Write-Host ""
  Read-Host "Press Enter to exit"; exit 1
}

# Step 3: Start KD server on port 3000
$port = 3000
$portUsed = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($portUsed) {
  Write-Host "[OK] KD server already running at http://localhost:$port" -ForegroundColor Green
} else {
  Write-Host "[...] Starting KD server on port $port ..." -ForegroundColor Cyan
  Start-Process node `
    -ArgumentList '--no-warnings', 'shell/server.js' `
    -WorkingDirectory $proj `
    -WindowStyle Minimized
  # Wait up to 15 seconds for server to be ready
  $waited = 0
  while ($waited -lt 15) {
    Start-Sleep -Seconds 1
    $waited++
    $check = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($check) { break }
  }
  if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Server did not respond after 15 seconds." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
  }
  Write-Host "[OK] KD server ready at http://localhost:$port" -ForegroundColor Green
}

# Step 4: Open the named Cloudflare Tunnel
#
# This used to be `cloudflared tunnel --url http://localhost:3000` -- a "quick
# tunnel", which mints a NEW random *.trycloudflare.com name on every single run.
# That meant the URL had to be re-shared each time, and worse: every user's
# saved session vanished, because a new hostname is a new origin to the browser
# and localStorage is per-origin.
#
# Now it runs the named tunnel "kd-database", which is permanently bound to
# https://kdb.kdemployment.com. Routing + hostname live in ~/.cloudflared/config.yml.
$tunnelName = 'kd-database'
$publicUrl  = 'https://kdb.kdemployment.com'

# Fail early with a useful message rather than a cloudflared stack trace.
if (-not (Test-Path "$env:USERPROFILE\.cloudflared\cert.pem")) {
  Write-Host "[ERROR] Not logged in to Cloudflare." -ForegroundColor Red
  Write-Host "  Run once:  cloudflared tunnel login   (pick kdemployment.com)" -ForegroundColor Yellow
  Read-Host "Press Enter to exit"; exit 1
}
if (-not (Test-Path "$env:USERPROFILE\.cloudflared\config.yml")) {
  Write-Host "[ERROR] Missing ~/.cloudflared/config.yml (tunnel routing)." -ForegroundColor Red
  Read-Host "Press Enter to exit"; exit 1
}

Write-Host ""
Write-Host "============================================" -ForegroundColor DarkGray
Write-Host "  Opening Cloudflare Tunnel ..." -ForegroundColor Yellow
Write-Host ""
Write-Host "  $publicUrl" -ForegroundColor Green
Write-Host ""
Write-Host "  This address never changes -- share it once." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  !! Keep this window OPEN -- closing it" -ForegroundColor Red
Write-Host "  !! takes the site offline immediately." -ForegroundColor Red
Write-Host "============================================" -ForegroundColor DarkGray
Write-Host ""

& $cf tunnel run $tunnelName

Write-Host ""
Write-Host "[INFO] Tunnel closed -- site is now offline." -ForegroundColor DarkGray
Read-Host "Press Enter to exit"
