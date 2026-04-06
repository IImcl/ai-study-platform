$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location "$ROOT\backend"

if (!(Test-Path ".\.venv\Scripts\Activate.ps1")) {
  Write-Host "Creating venv..."
  py -m venv .venv
}

. .\.venv\Scripts\Activate.ps1

Write-Host "Installing requirements..."
pip install -r requirements.txt | Out-Host

if (Test-Path "requirements-dev.txt") {
  pip install -r requirements-dev.txt | Out-Host
}

Write-Host "Starting backend on http://127.0.0.1:5000 ..."
waitress-serve --listen=127.0.0.1:5000 app:app
