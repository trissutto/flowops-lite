@echo off
REM ============================================================
REM  FlowOps Lite - Subir repo no GitHub (primeira vez)
REM  Uso: clica duas vezes no arquivo
REM ============================================================
setlocal EnableDelayedExpansion
chcp 65001 >nul
title FlowOps - Subir para GitHub

cd /d "%~dp0"

echo.
echo ============================================================
echo   FlowOps Lite  -  Subir repo para o GitHub
echo ============================================================
echo.

REM ---- 1. Checa se git esta instalado ----
where git >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Git nao encontrado.
  echo.
  echo   Baixa e instala: https://git-scm.com/download/win
  echo   Depois roda esse .bat de novo.
  echo.
  pause
  exit /b 1
)

REM ---- 2. Init se ainda nao for repo ----
if not exist ".git" (
  echo [1/6] git init...
  git init -b main
  if errorlevel 1 goto :erro
) else (
  echo [1/6] ja e repo git - ok
)

REM ---- 3. Config basica (so local) ----
git config user.email >nul 2>&1
if errorlevel 1 (
  echo.
  set /p GIT_EMAIL=Seu email do GitHub:
  set /p GIT_NAME=Seu nome:
  git config user.email "!GIT_EMAIL!"
  git config user.name "!GIT_NAME!"
)

REM ---- 4. Add + commit ----
echo.
echo [2/6] git add .
git add .
if errorlevel 1 goto :erro

echo [3/6] git commit...
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "chore: initial FlowOps Lite commit"
  if errorlevel 1 goto :erro
) else (
  echo   (sem mudancas pra commitar - ok)
)

REM ---- 5. Pede URL do repo remoto ----
echo.
echo ============================================================
echo   AGORA CRIA O REPO NO GITHUB (se ainda nao criou):
echo.
echo   1. Abre  https://github.com/new
echo   2. Repository name:  flowops-lite
echo   3. Marca  Private
echo   4. NAO marca  "Add a README"
echo   5. NAO marca  "Add .gitignore"
echo   6. Clica  Create repository
echo   7. Copia a URL que aparece (algo tipo
echo      https://github.com/trissutto/flowops-lite.git )
echo ============================================================
echo.

git remote get-url origin >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%u in ('git remote get-url origin') do set EXISTING_URL=%%u
  echo Remote ja configurado: !EXISTING_URL!
  set /p USE_EXISTING=Usar esse mesmo? [S/N]:
  if /i "!USE_EXISTING!"=="S" goto :push
  git remote remove origin
)

set /p REPO_URL=Cola a URL do repo aqui e aperta ENTER:
if "!REPO_URL!"=="" (
  echo [ERRO] URL vazia.
  pause
  exit /b 1
)

echo [4/6] git remote add origin !REPO_URL!
git remote add origin !REPO_URL!
if errorlevel 1 goto :erro

:push
echo [5/6] git branch -M main
git branch -M main

echo [6/6] git push -u origin main
echo.
echo OBS: vai abrir popup do GitHub pedindo login (navegador).
echo      Autoriza e fecha - o push continua sozinho.
echo.
git push -u origin main
if errorlevel 1 goto :erro

echo.
echo ============================================================
echo   SUCESSO!  Repo no ar.
echo.
echo   Proximo passo: conectar esse repo no Railway.
echo   Leia  DEPLOY.md  pra ver como.
echo ============================================================
echo.
pause
exit /b 0

:erro
echo.
echo ============================================================
echo   DEU ERRO.  Le a mensagem acima e me chama.
echo ============================================================
pause
exit /b 1
