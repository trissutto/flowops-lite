@echo off
REM =========================================================================
REM  FlowOps — Gerador de atalho pras maquinas cliente
REM =========================================================================
REM  Roda NESTA maquina (o servidor) e gera um arquivo .url que as
REM  colaboradoras copiam pro Desktop delas. Dois cliques = abre o FlowOps.
REM =========================================================================

title FlowOps - Gerador de atalho
color 0B
setlocal ENABLEDELAYEDEXPANSION

REM Descobre IP da LAN (192.x, 10.x ou 172.x)
set "LANIP="
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R /C:"IPv4.*192\." /C:"IPv4.*10\." /C:"IPv4.*172\."') do (
    if not defined LANIP set "LANIP=%%A"
)
set "LANIP=%LANIP: =%"

if not defined LANIP (
    echo.
    echo *** Nao foi possivel detectar o IP desta maquina na LAN. ***
    echo.
    echo Abra o cmd e rode:  ipconfig
    echo Procure a linha "Endereco IPv4" do adaptador da rede do escritorio
    echo e digite aqui:
    echo.
    set /p LANIP="IP: "
)

echo.
echo ==========================================================
echo    IP do servidor detectado: %LANIP%
echo    URL do FlowOps: http://%LANIP%:3000
echo ==========================================================
echo.

REM Gera o atalho .url na area de trabalho desta maquina
set "SHORTCUT=%USERPROFILE%\Desktop\FlowOps.url"
(
    echo [InternetShortcut]
    echo URL=http://%LANIP%:3000
    echo IconIndex=0
) > "%SHORTCUT%"

echo Atalho criado em:
echo   %SHORTCUT%
echo.
echo O QUE FAZER AGORA:
echo   1. Copie o arquivo "FlowOps.url" para um pendrive
echo      ^(ou envie por email/WhatsApp^).
echo   2. Nas 4 maquinas das colaboradoras, cole no Desktop.
echo   3. Dois cliques no atalho = abre o FlowOps ja logado no IP certo.
echo.
echo IMPORTANTE:
echo   - Estas maquinas precisam estar na MESMA rede Wi-Fi/cabo desta aqui.
echo   - O servidor ^(esta maquina^) precisa estar ligado e com o FlowOps rodando.
echo   - Se o IP desta maquina mudar ^(Wi-Fi trocou, etc^), gere o atalho de novo.
echo.
pause
