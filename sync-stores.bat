@echo off
cd /d "%~dp0backend"
echo.
echo  =============================================================
echo   Sincronizando lojas reais do ERP gigasistemas21
echo  =============================================================
echo.
call npm run sync-stores
echo.
pause
