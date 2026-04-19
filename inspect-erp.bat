@echo off
cd /d "%~dp0backend"
echo.
echo  =============================================================
echo   Inspecionando ERP mysql.gigasistemas.com.br
echo  =============================================================
echo.
call npm run inspect-erp
echo.
pause
