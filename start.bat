@echo off
REM ==========================================================
REM  FlowOps Lite - Start (Windows, sem Docker)
REM  Requer apenas: Node.js 20+ (voce ja tem)
REM  Rode este arquivo de dentro da pasta flowops-lite/
REM ==========================================================
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

color 0B
echo.
echo  =============================================================
echo    FlowOps LITE - Versao sem Docker / sem Redis / SQLite
echo    Loja: www.lurds.com.br
echo  =============================================================
echo.

REM ---- 1. Checar Node ----
echo [1/5] Verificando Node.js...
node --version >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
  pause
  exit /b 1
)
for /f %%i in ('node --version') do echo       Node %%i OK.
echo.

REM ---- 2. Instalar deps backend ----
echo [2/5] Instalando dependencias do backend ^(pode demorar 2-3 min na primeira vez^)...
cd backend
if not exist node_modules (
  call npm install
  if errorlevel 1 (
    color 0C
    echo [ERRO] Falha no npm install do backend.
    cd ..
    pause
    exit /b 1
  )
) else (
  echo       node_modules ja existe, pulando install.
)
echo.

REM ---- 3. Prisma: gerar client + criar banco SQLite ----
echo [3/5] Configurando banco SQLite e rodando migrations...
call npx prisma generate
call npx prisma db push --accept-data-loss
if errorlevel 1 (
  color 0C
  echo [ERRO] Falha ao criar banco SQLite.
  cd ..
  pause
  exit /b 1
)
echo.

REM ---- 4. Seed ----
echo [4/5] Populando dados iniciais ^(admin + lojas^)...
call npm run seed
echo.

cd ..

REM ---- 5. Instalar deps frontend ----
echo [5/5] Instalando dependencias do frontend...
cd frontend
if not exist node_modules (
  call npm install
  if errorlevel 1 (
    color 0C
    echo [ERRO] Falha no npm install do frontend.
    cd ..
    pause
    exit /b 1
  )
) else (
  echo       node_modules ja existe, pulando install.
)
cd ..

echo.
color 0A
echo  =============================================================
echo    Tudo instalado!
echo.
echo    Agora vou abrir 2 terminais:
echo     - Um pro Backend  ^(http://localhost:3001^)
echo     - Um pro Frontend ^(http://localhost:3000^)
echo.
echo    NAO feche esses terminais enquanto estiver usando o sistema.
echo    Pra desligar, feche as duas janelas ou aperte Ctrl+C em cada.
echo  =============================================================
echo.

REM ---- Abrir backend e frontend em terminais separados ----
start "FlowOps Backend"  cmd /k "cd /d %~dp0backend && npm run start:dev"
timeout /t 3 /nobreak >nul
start "FlowOps Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

echo Aguardando 15s pro frontend subir...
timeout /t 15 /nobreak >nul

echo Abrindo navegador em http://localhost:3000 ...
start "" "http://localhost:3000"

echo.
echo  =============================================================
echo    Login:  admin@flowops.local
echo    Senha:  admin123
echo  =============================================================
echo.
pause
endlocal
