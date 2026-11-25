@echo off
title Shadowrun - Table de jeu
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe. Installe-le depuis https://nodejs.org puis relance ce fichier.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Premiere installation des dependances...
  call npm install
)
start "" /min cmd /c "timeout /t 3 >nul & start http://localhost:3000"
node server/index.js
pause
