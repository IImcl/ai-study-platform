$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location "$ROOT\frontend"

Write-Host "Starting frontend on http://localhost:8080 ..."
py -m http.server 8080
