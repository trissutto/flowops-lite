# FlowOps

Sistema de gestão operacional da rede **Lurd's Plus Size**: PDV de loja, Live Commerce,
CRM, crediário, roteamento de pedidos entre as lojas físicas e o e-commerce próprio.

> **Briefing completo**: `CLAUDE.md` na raiz (arquitetura, flags de ambiente, convenções).
> Este README cobre só como subir o projeto.

## Stack

- **Backend**: NestJS 10 + TypeScript + Prisma + BullMQ + Socket.IO
- **Frontend**: Next.js 14 + React 18 + Tailwind (`frontend/`) — retaguarda e PDV
- **E-commerce**: Next.js (`ecommerce/`) — site público
- **Banco**: PostgreSQL 16 — **fonte da verdade de tudo** (estoque, venda, catálogo,
  crediário, clientes, financeiro)
- **Cache / filas**: Redis 7
- **Deploy**: Railway (backend + Postgres) + Vercel (frontends). Docker Compose só local.

> ⚰️ **Não existe mais ERP externo.** O MySQL Giga/Wincred e o WordPress/WooCommerce
> legado dividiam um servidor dedicado que foi **desligado em 27/08/2026**. As travas em
> `backend/src/common/replica-giga.ts` impedem até a criação do pool. As tabelas com
> prefixo `wincred_*` / `giga_*` são **espelhos nativos no Postgres, alimentados pelo
> próprio Flow** — o nome é herança, elas não falam com ERP nenhum.

## Setup local (5 minutos)

```bash
# 1. Clone e entre no projeto
cd flowops

# 2. Configure variáveis
cp .env.example .env
# Edite .env e preencha ao menos DATABASE_URL e JWT_SECRET
# (o docker-compose lê o .env da RAIZ; se for rodar o backend fora do
#  docker, copie o mesmo arquivo pra backend/.env)

# 3. Suba tudo
docker compose up -d --build

# 4. Aplique o schema + seed
#    Este repo NÃO tem histórico de migrations: o schema é aplicado por
#    `db push` — inclusive em produção (start:prod faz isso).
#    `prisma migrate deploy` aqui sai com sucesso SEM criar uma tabela.
docker compose exec backend npx prisma db push
docker compose exec backend npm run seed

# 5. Acesse
# Frontend:  http://localhost:3000
# Backend:   http://localhost:3001
# Postgres:  localhost:5432 (flowops/flowops)
# Redis:     localhost:6379
```

Login padrão criado pelo seed:
- **Email**: `admin@flowops.local`
- **Senha**: `admin123` (troque imediatamente)

## Estrutura do repositório

```
flowops/
├── backend/              # NestJS
│   ├── src/
│   │   ├── auth/         # JWT, guards, RBAC
│   │   ├── orders/       # CRUD de pedidos + histórico
│   │   ├── stores/       # Lojas e performance
│   │   ├── stock/        # Estoque (Postgres)
│   │   ├── routing/      # ⭐ Engine de distribuição inteligente
│   │   ├── pdv/          # PDV de loja: venda, devolução, crediário, NFC-e
│   │   ├── live-pdv/     # Live Commerce
│   │   ├── queue/        # BullMQ workers
│   │   ├── websocket/    # Socket.IO gateway
│   │   └── prisma/       # Prisma service
│   └── prisma/schema.prisma
├── frontend/             # Next.js 14
│   └── src/
│       ├── app/          # App Router
│       ├── components/
│       └── lib/
├── ecommerce/            # Site público (Next.js)
├── docs/                 # Documentação (boa parte é registro histórico — ver CLAUDE.md)
├── docker-compose.yml
├── .env.example
└── README.md
```

## Comandos úteis

```bash
# Logs em tempo real
docker compose logs -f backend
docker compose logs -f frontend

# Entrar no container do backend
docker compose exec backend sh

# Rodar testes
docker compose exec backend npm test

# Aplicar mudança de schema (após mudar prisma/schema.prisma)
# NÃO use `migrate dev`: sem histórico de migrations ele oferece RESETAR o banco.
docker compose exec backend npx prisma db push

# Prisma Studio (UI para o DB)
docker compose exec backend npx prisma studio

# Derrubar tudo (mantém dados)
docker compose down

# Derrubar e apagar dados
docker compose down -v
```

## Expor webhook localmente (desenvolvimento)

**Local não precisa de webhook de pagamento**: um cron de reconciliação pergunta o status
direto ao gateway (`backend/src/pagbank/pagbank-pix-reconcile.service.ts`).

Se quiser testar o webhook mesmo assim:

```bash
ngrok http 3001
# ponha a URL no .env: BACKEND_PUBLIC_URL=https://xxxx.ngrok-free.app
# o backend monta sozinho <url>/api/pagbank/webhook em cada cobrança
```

- O segredo do Pagar.me é cadastrado na tela `/pagarme/config` (Basic auth), não em env —
  a rota é `POST /pagarme/webhook`.
- ⚠️ **Não cadastre a URL do ngrok no painel do gateway**: a conta lá é a mesma da
  produção, e você desviaria aviso de pagamento real pro seu notebook.

## Atualizar o schema com segurança

O deploy roda `prisma db push --accept-data-loss` no boot (`start:prod`). Antes de subir
schema novo, rode `prisma migrate diff` contra a produção pra ver o que o push vai
derrubar — índices `trgm` já caíram assim.

## Estado do sistema

O sistema está **em produção** na rede inteira desde 2026. Arquitetura, flags de
ambiente, convenções de trabalho e histórico de incidentes: **`CLAUDE.md`** na raiz.
Como subir na nuvem do zero: `DEPLOY.md`.
