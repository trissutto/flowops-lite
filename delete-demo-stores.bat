@echo off
cd /d "%~dp0backend"
echo.
echo  =============================================================
echo   Removendo lojas demo (LJ01..LJ06) do banco
echo  =============================================================
echo.
call npm run delete-demo-stores
echo.
pause
