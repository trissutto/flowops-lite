@echo off
REM =========================================================================
REM  FlowOps — Iniciar servidor
REM =========================================================================
REM  Abre 2 janelas: uma pro backend, uma pro frontend.
REM  Fechou as duas, FlowOps parou. Pra manter rodando o dia inteiro,
REM  deixe as 2 janelas abertas (minimizadas tudo bem).
REM =========================================================================

title FlowOps - Servidor
color 0A

echo.
echo ==========================================================
echo    Iniciando FlowOps ^(backend + frontend^)
echo ==========================================================
echo.

REM Descobre o IP da LAN
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R /C:"IPv4.*192\." /C:"IPv4.*10\." /C:"IPv4.*172\."') do (
    set LANIP=%%A
    goto :got_ip
)
:got_ip
set LANIP=%LANIP: =%

echo Backend iniciando na porta 3001...
start "FlowOps Backend" cmd /k "cd /d %~dp0..\backend && npm run start:prod"

echo Aguardando backend subir ^(5s^)...
timeout /t 5 /nobreak >nul

echo Frontend iniciando na porta 3000...
start "FlowOps Frontend" cmd /k "cd /d %~dp0..\frontend && npm run start"

echo Aguardando frontend subir ^(8s^)...
timeout /t 8 /nobreak >nul

echo.
echo ==========================================================
echo    FlowOps RODANDO
echo ==========================================================
echo.
echo Nesta maquina     :  http://localhost:3000
if defined LANIP (
    echo Outras da rede    :  http://%LANIP%:3000
)
echo.
echo Abrindo navegador...
start http://localhost:3000

echo.
echo IMPORTANTE: nao feche as duas janelas pretas que abriram.
echo Enquanto elas estiverem abertas, o FlowOps esta ligado.
echo.
echo Pra desligar: feche as duas janelas ou clique em 4-parar-flowops.bat
echo.
pause
