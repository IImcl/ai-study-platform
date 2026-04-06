$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Backend
Start-Process powershell -ArgumentList "-NoExit","-Command", `
  "cd `"$root\backend`"; .\.venv\Scripts\Activate.ps1; py app.py"

# Frontend
Start-Process powershell -ArgumentList "-NoExit","-Command", `
  "cd `"$root\frontend`"; py -m http.server 8080"

Start-Sleep -Seconds 2
Start-Process "http://localhost:8080"
