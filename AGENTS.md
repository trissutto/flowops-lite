# AGENTS.md — FlowOps Lite (Lurd's Plus Size)

> **O briefing do projeto é o `CLAUDE.md` da raiz. Leia ele antes de qualquer coisa.**
>
> Este arquivo já foi uma CÓPIA do `CLAUDE.md`. A cópia ficou dois meses para trás e
> passou a descrever um ERP que não existe mais — quem lesse só ela decidiria errado.
> Por isso deixou de ser cópia: aqui ficam apenas os fatos que nenhuma sessão pode
> errar, e o resto mora num lugar só.

## O que é

Sistema da rede **Lurd's Plus Size** (moda plus size, lojas físicas + e-commerce):
PDV de loja, Live Commerce, CRM, crediário, logística/realinhamento, financeiro e o
site próprio em `ecommerce/`. Dono/operador: Thiago Rissutto.

| Camada | Onde |
|---|---|
| Retaguarda/PDV (`frontend/`) | Next.js 14 → Vercel |
| Site público (`ecommerce/`) | Next.js → Vercel |
| Backend (`backend/`) | NestJS + Prisma → Railway (projeto heroic-mercy) |
| **Banco** | **Postgres (Railway) — fonte da verdade de TUDO** |
| Realtime | socket.io (`backend/src/websocket`) |

## ⚰️ O ERP legado morreu — 27/08/2026

O MySQL **Giga/Wincred** e o **WordPress/WooCommerce** legado dividiam o servidor
dedicado da KingHost. Esse servidor foi **desligado em 27/08/2026, por ordem do dono**,
e não existe mais. As travas em `backend/src/common/replica-giga.ts` impedem até a
**criação do pool** MySQL (`gigaDesligado()` é o default), e os crons que puxavam de lá
são no-op silencioso (`pullGigaLigado()`).

Consequências, sem exceção:

- **Nunca sugerir religar**, reconectar, "conferir no Giga" ou "lançar no Wincred".
  Não há máquina do outro lado — instrução assim manda a vendedora fazer o impossível.
- **Nenhum caminho novo** pode depender do MySQL legado, do WooCommerce ou do WP.
- Um pool morto **não dá erro**: devolve vazio/`[]` calado. Código que lia de lá e
  virava zero na tela já custou incidente. Leitura vem do Postgres e erro **sobe**.

## 🚨 Nome de ERP ≠ ERP

Muita coisa ainda **se chama** Giga/Wincred. É herança de nome, não de destino:

| Parece | É hoje |
|---|---|
| tabelas `wincred_produtos`, `wincred_estoque`, `giga_estoque`, `giga_caixa_mov`… | **espelhos nativos no Postgres, alimentados pelo PRÓPRIO Flow**. Não falam com ERP nenhum. |
| `backend/src/wincred-mirror/` + `WincredCatalogService` | serviço de catálogo/estoque que lê **Postgres**. Os crons de sync com o ERP são no-op. |
| `backend/src/erp/` | módulo legado que sobrou; o pool não é criado. |
| envs `ERP_*`, `PDV_ERP_OUTBOX`, `ERP_WRITE_ENABLED` | nomes velhos que hoje governam caminhos **do Flow** (ver a tabela de flags no `CLAUDE.md` antes de mexer em qualquer uma). |

**Nunca escreva que esses dados "vêm do Giga".** Vêm do Postgres do Flow.

## Onde está a verdade hoje

Estoque, venda, catálogo, crediário, clientes, financeiro, comissão, fiscal: **Postgres
do Flow**, e só. O Flow é a fonte do estoque desde 14/07/2026; a saída do ERP terminou
em 27/08/2026.

## Antes de escrever código

1. Ler o **`CLAUDE.md`** da raiz: arquitetura, flags de ambiente, convenções de
   trabalho, janela de deploy e histórico de incidentes.
2. Se for frontend, ler também `.claude/agents/_CONTEXTO-FLOWOPS.md`.
3. Se algo aqui divergir do `CLAUDE.md`, o **`CLAUDE.md` ganha** — e corrija este.

## Registro histórico (não é instrução)

Como era e por que acabou: `docs/auditorias/2026-09-03-enterro-wincred.md` (censo do
enterro), `docs/RUNBOOK-SAIDA-KINGHOST.md`, `docs/PLANO-SAIDA-GIGA-NATIVO.md`,
`docs/GIGA_DECOMMISSION_REPORT.md` e `backend/scripts/_arquivo-giga/README.md`.
Tudo isso é **passado**: descreve um sistema que não roda mais.
