@echo off
REM Double-click this to put KD Database online (server + Cloudflare Tunnel).
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0start-hosting.ps1"
pause
