# ============================================================
#  KD Database — self-host + Cloudflare Tunnel (free, no expiry)
#  Double-click start-hosting.bat (which runs this script).
#  It starts the local server and opens a public https URL.
# ============================================================
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $proj

# Locate cloudflared (PATH first, then the winget install location)
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) { $cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe" }
if (-not (Test-Path $cf)) {
  Write-Host "cloudflared not found. Install it once with:" -ForegroundColor Yellow
  Write-Host "  winget install --id Cloudflare.cloudflared -e" -ForegroundColor Yellow
  Read-Host "Press Enter to exit"; exit 1
}

# Start the KD app server (separate window) if port 3000 is free
$portUsed = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if (-not $portUsed) {
  Write-Host "Starting KD server on http://localhost:3000 ..." -ForegroundColor Cyan
  Start-Process node -ArgumentList '--no-warnings','shell/server.js' -WorkingDirectory $proj
  Start-Sleep -Seconds 2
} else {
  Write-Host "KD server already running on port 3000." -ForegroundColor Cyan
}

Write-Host ""
Write-Host "Opening public tunnel — the https URL appears below. Share that URL." -ForegroundColor Green
Write-Host "Keep this window OPEN; closing it takes the site offline." -ForegroundColor Yellow
Write-Host ""

# Run the quick tunnel in the foreground (prints the *.trycloudflare.com URL)
& $cf tunnel --url http://localhost:3000
