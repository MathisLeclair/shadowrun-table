@echo off
title Shadowrun Table
cd /d "%~dp0"
where node >/dev/null 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org, then run this file again.
  pause
  exit /b 1
)
echo Updating dependencies...
call npm install --no-audit --no-fund
echo Building the interface...
call npm run build
if errorlevel 1 (
  echo The interface build failed.
  pause
  exit /b 1
)
start "" /min cmd /c "timeout /t 3 >/dev/null & start http://localhost:3000"
node --experimental-strip-types --disable-warning=ExperimentalWarning server/index.ts
pause
