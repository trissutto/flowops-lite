@echo off
cd /d "%~dp0backend"
echo.
echo  =============================================================
echo   Resetando lojas com os dados do WinCred
echo  =============================================================
echo.
call npm run reset-stores
echo.
pause
