# FlowOps

Sistema inteligente de gestão operacional de pedidos — integra WooCommerce, ERP gigasistemas21 e rede de lojas físicas.

## Stack

- **Backend**: NestJS 10 + TypeScript + Prisma + BullMQ + Socket.IO
- **Frontend**: Next.js 14 + React 18 + Tailwind + shadcn/ui
- **Banco**: PostgreSQL 16 (estado do sistema)
- **Cache / filas**: Redis 7
- **ERP**: MySQL gigasistemas21 (somente leitura)
- **Deploy**: Docker Compose (local) → VPS/Cloud (produção)

## Setup local (5 minutos)

```bash
# 1. Clone e entre no projeto
cd flowops

# 2. Configure variáveis
cp .env.example .env
# Edite .env e preencha WC_*, ERP_*, JWT_SECRET

# 3. Suba tudo
docker compose up -d --build

# 4. Rode migrations + seed
docker compose exec backend npx prisma migrate deploy
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
│   │   ├── stock/        # Cache e query do ERP
│   │   ├── routing/      # ⭐ Engine de distribuição inteligente
│   │   ├── woocommerce/  # Webhook + cliente REST
│   │   ├── erp/          # MySQL gigasistemas21 client
│   │   ├── queue/        # BullMQ workers
│   │   ├── websocket/    # Socket.IO gateway
│   │   └── prisma/       # Prisma service
│   └── prisma/schema.prisma
├── frontend/             # Next.js 14
│   └── src/
│       ├── app/          # App Router
│       ├── components/
│       └── lib/
├── docs/                 # Documentação
│   ├── FlowOps-Arquitetura.docx
│   └── integracao-woocommerce.md
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

# Nova migration (após mudar prisma/schema.prisma)
docker compose exec backend npx prisma migrate dev --name minha_mudanca

# Prisma Studio (UI para o DB)
docker compose exec backend npx prisma studio

# Derrubar tudo (mantém dados)
docker compose down

# Derrubar e apagar dados
docker compose down -v
```

## Expor webhook localmente (desenvolvimento)

O WooCommerce precisa de URL HTTPS pública para disparar webhooks. Use ngrok:

```bash
ngrok http 3001
# copie a URL https://xxxx.ngrok-free.app
# cadastre em WP Admin → WooCommerce → Ajustes → Avançado → Webhooks
```

Veja `docs/integracao-woocommerce.md` para o passo a passo completo.

## Roadmap

Veja `docs/FlowOps-Arquitetura.docx`, seção 10, para o plano faseado de ~19 dias até produção.

## Status dos módulos nesta entrega

| Módulo | Status |
|---|---|
| Scaffold + Docker | ✅ Pronto |
| Prisma schema | ✅ Pronto |
| Routing Engine (core) | ✅ Pronto + testes |
| Auth (JWT) | 🟡 Estrutura base |
| WooCommerce webhook | 🟡 Estrutura base |
| ERP client | 🟡 Estrutura base |
| Frontend | 🟡 Login + dashboard skeleton |
| Queue workers | 🟡 Estrutura base |

Marcados 🟡 têm estrutura funcional mas precisam ser finalizados nas próximas iterações (ver TODOs no código).
