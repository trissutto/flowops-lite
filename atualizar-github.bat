@echo off
REM ============================================================
REM  FlowOps Lite - Enviar mudancas pro GitHub (rapido)
REM ============================================================
chcp 65001 >nul
title FlowOps - Atualizar GitHub

cd /d "%~dp0"

echo.
echo ============================================================
echo   Enviando mudancas pro GitHub...
echo ============================================================
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Git nao encontrado.
  pause
  exit /b 1
)

if not exist ".git" (
  echo [ERRO] Essa pasta ainda nao e um repo git.
  echo Use primeiro o script  subir-github.bat
  pause
  exit /b 1
)

git add .
git diff --cached --quiet
if errorlevel 1 (
  set /p MSG=Mensagem curta do commit (ou ENTER pra usar 'update'):
  if "%MSG%"=="" set MSG=chore: update
  git commit -m "%MSG%"
  git push
  echo.
  echo ============================================================
  echo   ENVIADO! O Railway ja esta fazendo o redeploy sozinho.
  echo ============================================================
) else (
  echo.
  echo Nada pra commitar - tudo ja sincronizado.
)

echo.
pause
