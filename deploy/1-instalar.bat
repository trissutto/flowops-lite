@echo off
REM =========================================================================
REM  FlowOps — Instalador Windows (Servidor)
REM =========================================================================
REM  Uso: clique duas vezes neste arquivo.
REM  O que faz:
REM   1) Confere se Node.js esta instalado (oferece download se nao)
REM   2) Instala dependencias do backend e frontend
REM   3) Cria banco SQLite (prisma db push)
REM   4) Faz build de producao do frontend
REM   5) Abre porta 3000 e 3001 no firewall do Windows
REM =========================================================================

title FlowOps - Instalador
color 0B
setlocal ENABLEDELAYEDEXPANSION

echo.
echo ==========================================================
echo    FlowOps - Instalador
echo ==========================================================
echo.
echo Esta instalacao vai preparar a maquina atual para rodar
echo o FlowOps como servidor. As outras maquinas da rede vao
echo acessar pelo navegador (http://IP-DESTA-MAQUINA:3000).
echo.
pause

REM --- 1. Checa Node.js -----------------------------------------------------
echo.
echo [1/5] Verificando Node.js...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo *** Node.js nao encontrado. ***
    echo Abrindo pagina de download. Baixe a versao LTS ^(botao verde^),
    echo instale com as opcoes padroes, feche este instalador e rode de novo.
    echo.
    start https://nodejs.org/pt-br/download/
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node --version') do set NODE_VERSION=%%v
echo     Node %NODE_VERSION% OK

REM --- 2. Instala deps do backend ------------------------------------------
echo.
echo [2/5] Instalando dependencias do backend ^(pode demorar 2-3 min^)...
cd /d "%~dp0..\backend"
if not exist "package.json" (
    echo ERRO: pasta backend nao encontrada em %CD%
    pause
    exit /b 1
)
call npm install --no-audit --no-fund --loglevel=error
if %ERRORLEVEL% NEQ 0 (
    echo *** Falha no npm install do backend. ***
    pause
    exit /b 1
)

echo.
echo [2/5] Gerando Prisma Client e banco de dados...
call npx prisma generate
call npx prisma db push --accept-data-loss
if %ERRORLEVEL% NEQ 0 (
    echo *** Falha ao configurar o banco SQLite. ***
    pause
    exit /b 1
)

REM --- 3. Instala deps do frontend -----------------------------------------
echo.
echo [3/5] Instalando dependencias do frontend ^(mais 2-3 min^)...
cd /d "%~dp0..\frontend"
call npm install --no-audit --no-fund --loglevel=error
if %ERRORLEVEL% NEQ 0 (
    echo *** Falha no npm install do frontend. ***
    pause
    exit /b 1
)

REM --- 4. Build de producao do frontend ------------------------------------
echo.
echo [4/5] Compilando frontend para producao...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo *** Falha no build do frontend. ***
    pause
    exit /b 1
)

REM --- 5. Firewall ---------------------------------------------------------
echo.
echo [5/5] Liberando portas 3000 e 3001 no Windows Firewall...
echo      ^(pode pedir permissao de administrador^)
powershell -Command "Start-Process '%~dp0abrir-firewall.bat' -Verb RunAs -Wait" 2>nul

REM --- Sucesso -------------------------------------------------------------
echo.
echo ==========================================================
echo    INSTALACAO CONCLUIDA
echo ==========================================================
echo.
echo Proximos passos:
echo   1. Clique duas vezes em  2-iniciar-flowops.bat
echo   2. Aguarde abrir o navegador com o FlowOps
echo   3. Pra gerar o atalho das outras maquinas, rode:
echo      3-gerar-atalho-cliente.bat
echo.
pause
