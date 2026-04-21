@echo off
REM ============================================================
REM  Diagnóstico ERP Gigasistemas — standalone
REM ------------------------------------------------------------
REM  Conecta direto no MySQL usando credenciais do backend/.env
REM  e cospe o schema + amostra de linhas da tabela informada.
REM
REM  Uso:
REM    - Duplo clique: inspeciona PRODUTOSVENDIDOS (default)
REM    - diagnostico-erp.bat NOME_DA_TABELA: inspeciona outra
REM ============================================================

setlocal
cd /d "%~dp0"

echo.
echo ====================================
echo   DIAGNOSTICO ERP — Gigasistemas
echo ====================================
echo.

REM Verifica se node esta instalado
where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado no PATH.
  echo Instale de https://nodejs.org e tente de novo.
  echo.
  pause
  exit /b 1
)

REM Verifica se backend existe
if not exist "..\..\backend\.env" (
  echo [ERRO] Nao encontrei backend\.env
  echo Esperado em: ..\..\backend\.env
  echo.
  pause
  exit /b 1
)

REM Verifica se mysql2 esta instalado
if not exist "..\..\backend\node_modules\mysql2\promise.js" (
  echo [AVISO] mysql2 nao esta instalado no backend.
  echo Rodando npm install no backend...
  echo.
  pushd "..\..\backend"
  call npm install
  popd
  if errorlevel 1 (
    echo [ERRO] Falha no npm install. Veja o log acima.
    pause
    exit /b 1
  )
)

REM Roda o script Node
node diagnostico-erp.js %*

echo.
pause
endlocal
