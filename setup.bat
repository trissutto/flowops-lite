@echo off
REM ================================================================
REM  FlowOps - Setup automatico (Windows)
REM  Rode este arquivo de dentro da pasta flowops/
REM
REM  Pre-requisitos:
REM   - Docker Desktop instalado e aberto  (https://docker.com/products/docker-desktop)
REM   - Windows 10/11 com WSL2 habilitado
REM ================================================================

chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

color 0B
echo.
echo  =============================================================
echo    FlowOps  - Setup automatizado
echo    Loja: www.lurds.com.br
echo  =============================================================
echo.

REM ---------- 1. Verificar Docker ----------
echo [1/6] Verificando Docker...
docker --version >nul 2>&1
if errorlevel 1 (
  color 0C
  echo.
  echo [ERRO] Docker nao encontrado.
  echo        Instale o Docker Desktop em https://docker.com/products/docker-desktop
  echo        e abra o Docker Desktop antes de rodar novamente.
  echo.
  pause
  exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
  color 0C
  echo.
  echo [ERRO] O Docker Desktop nao esta rodando.
  echo        Abra o Docker Desktop, aguarde iniciar completamente, e rode novamente.
  echo.
  pause
  exit /b 1
)
echo       Docker OK.
echo.

REM ---------- 2. Gerar .env ----------
echo [2/6] Gerando arquivo .env...
if exist ".env" (
  echo       Arquivo .env ja existe. Fazendo backup em .env.bak
  copy /Y ".env" ".env.bak" >nul
)

(
  echo # ===============================================
  echo # FlowOps - configuracao Lurds
  echo # Gerado automaticamente por setup.bat
  echo # NAO COMMITAR ESTE ARQUIVO NO GIT.
  echo # ===============================================
  echo.
  echo # ---- Banco interno ^(Postgres^) ----
  echo DATABASE_URL=postgresql://flowops:flowops@postgres:5432/flowops
  echo.
  echo # ---- Redis ^(filas + cache^) ----
  echo REDIS_URL=redis://redis:6379
  echo.
  echo # ---- Autenticacao ----
  echo JWT_SECRET=lurds-flowops-change-me-to-64-random-chars-abcdef1234567890
  echo JWT_ACCESS_TTL=15m
  echo JWT_REFRESH_TTL=7d
  echo.
  echo # ---- WordPress / WooCommerce - MySQL direto ----
  echo # ^(usado para reconciliacao e backfill de pedidos existentes^)
  echo WP_DB_HOST=162.215.213.154
  echo WP_DB_PORT=3306
  echo WP_DB_USER=lurds_apps
  echo WP_DB_PASSWORD=Z+6rxNPi]Cd0
  echo WP_DB_DATABASE=lurds_site
  echo.
  echo # ---- WooCommerce REST API ----
  echo # Chaves geradas em 18/04/2026 no WP Admin (chave "FlowOps", perm Leitura/Escrita)
  echo WC_URL=https://www.lurds.com.br
  echo WC_CONSUMER_KEY=ck_61711ebaf05ca4af7795f90b833d2c6f7e01531a
  echo WC_CONSUMER_SECRET=cs_543d16070b4ef7d8f8d7989eb4dadb8da3659baf
  echo WC_WEBHOOK_SECRET=lurds-flowops-webhook-hmac-secret-2026
  echo.
  echo # ---- ERP gigasistemas21 ^(MySQL, somente leitura^) ----
  echo ERP_HOST=mysql.gigasistemas.com.br
  echo ERP_PORT=3306
  echo ERP_USER=gigasistemas21
  echo ERP_PASSWORD=lurds152634
  echo ERP_DATABASE=gigasistemas21
  echo.
  echo # ---- Aplicacao ----
  echo PORT=3001
  echo NODE_ENV=development
  echo LOG_LEVEL=info
  echo FRONTEND_URL=http://localhost:3000
) > .env

echo       .env criado com as credenciais Lurds + gigasistemas21.
echo.

REM ---------- 3. Subir containers ----------
echo [3/6] Subindo containers ^(Postgres + Redis + Backend + Frontend^)...
echo       Na primeira vez demora alguns minutos pra baixar as imagens.
echo.
docker compose down >nul 2>&1
docker compose up -d --build
if errorlevel 1 (
  color 0C
  echo.
  echo [ERRO] Falha ao subir os containers. Veja a saida acima.
  pause
  exit /b 1
)
echo.
echo       Containers rodando.
echo.

REM ---------- 4. Aguardar Postgres ----------
echo [4/6] Aguardando Postgres ficar pronto...
set /a tries=0
:waitpg
set /a tries+=1
docker compose exec -T postgres pg_isready -U flowops >nul 2>&1
if errorlevel 1 (
  if !tries! GEQ 30 (
    color 0C
    echo.
    echo [ERRO] Postgres nao respondeu em 60 segundos.
    echo        Rode: docker compose logs postgres
    pause
    exit /b 1
  )
  timeout /t 2 /nobreak >nul
  goto waitpg
)
echo       Postgres OK.
echo.

REM ---------- 5. Migrations + Seed ----------
echo [5/6] Rodando migrations do Prisma...
docker compose exec -T backend npx prisma migrate deploy
if errorlevel 1 (
  echo.
  echo [AVISO] Migrations podem ter falhado. Tentando novamente em 5s...
  timeout /t 5 /nobreak >nul
  docker compose exec -T backend npx prisma migrate deploy
)
echo.

echo       Populando dados iniciais ^(admin + lojas^)...
docker compose exec -T backend npm run seed
echo.

REM ---------- 6. Abrir navegador ----------
echo [6/6] Abrindo navegador em http://localhost:3000 ...
timeout /t 3 /nobreak >nul
start "" "http://localhost:3000"

color 0A
echo.
echo  =============================================================
echo    FlowOps rodando!
echo.
echo    Frontend:   http://localhost:3000
echo    Backend:    http://localhost:3001/api
echo.
echo    Login:      admin@flowops.local
echo    Senha:      admin123   ^(TROQUE IMEDIATAMENTE^)
echo.
echo    Proximos passos:
echo     1. Baixe o ngrok: https://ngrok.com/download
echo     2. Em outro terminal rode: ngrok http 3001
echo     3. Copie a URL HTTPS ^(ex: https://xxxx.ngrok-free.app^)
echo     4. Cadastre o webhook em:
echo        https://www.lurds.com.br/wp-admin/admin.php?page=wc-settings^&tab=advanced^&section=webhooks
echo        URL: ^<url-ngrok^>/api/webhooks/woocommerce
echo        Segredo: lurds-flowops-webhook-hmac-secret-2026
echo.
echo    Comandos uteis:
echo     docker compose logs -f backend   ^(ver logs do backend^)
echo     docker compose down              ^(desligar tudo^)
echo     setup.bat                        ^(reiniciar tudo^)
echo  =============================================================
echo.
pause
endlocal
