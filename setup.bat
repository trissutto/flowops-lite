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
echo    FlowOps  - Setup automatizado ^(ambiente LOCAL^)
echo    Rede Lurd's Plus Size
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
  echo       ATENCAO: se este .env.bak veio de um setup antigo, apague depois -
  echo                ele guarda credencial de servidor que foi desligado.
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
  echo # ---- ERP legado e site antigo: NAO CONFIGURE ----
  echo # Encerrados em 27/08/2026: o WordPress/WooCommerce da KingHost foi
  echo # apagado e o MySQL do ERP Giga/Wincred ^(no host do fornecedor^) parou de
  echo # aceitar o IP do Railway. Nenhum dos dois responde. Nao ha ERP_HOST /
  echo # ERP_USER / ERP_PASSWORD nem WP_DB_* / WC_* / FLOWOPS_WP_* pra preencher.
  echo # A fonte da verdade e o Postgres deste DATABASE_URL. As travas vivem em
  echo # backend/src/common/replica-giga.ts. Nao religar.
  echo.
  echo # ---- Aplicacao ----
  echo PORT=3001
  echo NODE_ENV=development
  echo LOG_LEVEL=info
  echo FRONTEND_URL=http://localhost:3000
) > .env

echo       .env criado. Ajuste JWT_SECRET antes de qualquer uso serio.
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
REM  Este repo NAO tem historico de migrations: o schema e aplicado por
REM  `prisma db push` ^(o proprio start:prod do backend faz isso^). Rodar
REM  `migrate deploy` aqui saia com sucesso sem criar UMA tabela, e o seed
REM  logo abaixo estourava.
echo [5/6] Aplicando o schema do Prisma ^(db push^)...
docker compose exec -T backend npx prisma db push
if errorlevel 1 (
  echo.
  echo [AVISO] O db push pode ter falhado. Tentando novamente em 5s...
  timeout /t 5 /nobreak >nul
  docker compose exec -T backend npx prisma db push
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
echo     - Trocar JWT_SECRET no .env
echo     - Local NAO precisa de webhook de pagamento: um cron de reconciliacao
echo       pergunta pro gateway ^(pagbank-pix-reconcile.service.ts^).
echo       Se quiser testar o webhook: ngrok http 3001 e ponha no .env
echo       BACKEND_PUBLIC_URL=^<url-https-do-ngrok^> - o backend monta sozinho
echo       ^<url^>/api/pagbank/webhook em cada cobranca. O segredo do Pagar.me
echo       e cadastrado na tela /pagarme/config, nao em env.
echo       NAO cadastre a URL do ngrok no painel do gateway: a conta la e a
echo       mesma da producao e voce desviaria aviso de pagamento real.
echo     - Briefing do projeto: CLAUDE.md na raiz.
echo.
echo    Comandos uteis:
echo     docker compose logs -f backend   ^(ver logs do backend^)
echo     docker compose down              ^(desligar tudo^)
echo     setup.bat                        ^(reiniciar tudo^)
echo  =============================================================
echo.
pause
endlocal
