# FlowOps Lite

Versão simplificada do FlowOps para rodar **sem Docker**, **sem PostgreSQL**, **sem Redis**.

Usa apenas **Node.js** (que você já tem) e cria um arquivo SQLite local para o banco.

## Como rodar

1. Duplo clique em **`start.bat`**

Pronto. Ele:
- Instala dependências (só na primeira vez, ~2-3 min)
- Cria o banco SQLite local (`backend/prisma/dev.db`)
- Popula dados iniciais (admin + 6 lojas)
- Sobe o backend em http://localhost:3001
- Sobe o frontend em http://localhost:3000
- Abre o navegador

## Credenciais

- Login: `admin@flowops.local`
- Senha: `admin123`

## Para desligar

Duplo clique em **`stop.bat`** ou feche as duas janelas de terminal que abriram (Backend e Frontend).

## Diferenças pra versão Full

| Recurso | Full (Docker) | Lite |
|---|---|---|
| Banco | PostgreSQL | SQLite (arquivo local) |
| Cache | Redis | Memória (in-process) |
| Filas | BullMQ + Redis | Execução síncrona |
| Capacidade | Até ~2000 pedidos/dia | Até ~500 pedidos/dia |

Para o seu volume atual (até 200 pedidos/dia), a Lite é mais que suficiente. Se crescer muito, dá pra migrar pra versão Full depois sem reescrever nada — só trocar o `provider` do Prisma e instalar Docker.
