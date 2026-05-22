@echo off
REM Baixa os ultimos N pedidos do WooCommerce e importa no SQLite
REM Uso:  backfill.bat         (padrao 100 pedidos)
REM       backfill.bat 50      (50 pedidos)
chcp 65001 >nul
cd /d "%~dp0backend"

if "%1"=="" (
  set QTD=100
) else (
  set QTD=%1
)

echo.
echo  =============================================================
echo    FlowOps LITE - Backfill de pedidos WooCommerce
echo    Baixando os ultimos %QTD% pedidos de www.lurds.com.br
echo  =============================================================
echo.

REM Instala dotenv caso ainda nao esteja
call npm list dotenv >nul 2>&1
if errorlevel 1 (
  echo Instalando dotenv...
  call npm install dotenv
  echo.
)

call npm run backfill -- %QTD%

echo.
pause
