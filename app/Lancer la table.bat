@echo off
title Shadowrun - Table de jeu
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe. Installe-le depuis https://nodejs.org puis relance ce fichier.
  pause
  exit /b 1
)
echo Mise a jour des dependances...
call npm install --no-audit --no-fund
echo Construction de l'interface...
call npm run build
if errorlevel 1 (
  echo La construction de l'interface a echoue.
  pause
  exit /b 1
)
start "" /min cmd /c "timeout /t 3 >nul & start http://localhost:3000"
node --experimental-strip-types --disable-warning=ExperimentalWarning server/index.ts
pause
