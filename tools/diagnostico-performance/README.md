# Diagnóstico de performance — script read-only

Script que **só lê** (nenhum comando altera dado/schema/config). Serve para
transformar hipótese de gargalo em número real e decidir **o que atacar
primeiro**.

Rodar com a **loja fechada** para fotografar o estado após um dia de operação.

## Arquivo

| Script | Onde rodar | Responde |
|---|---|---|
| `postgres.sql` | Postgres do Railway (`psql` ou console SQL) | bloat dos espelhos, conexões vs teto, cache hit, índices faltando/ociosos, queries mais caras |

## Como rodar

```
psql "postgresql://...url-do-railway..." -f tools/diagnostico-performance/postgres.sql
```

Copie **toda a saída** e mande de volta — a partir dela definimos a ordem das
próximas correções (com números, não com achismo).

## O que cada número decide

- **`postgres.sql` [4]** — `dead_pct` alto em `giga_caixa_diario` ou `giga_caixa_mov`
  indica a recarga delete-all + insert que **o próprio Flow** faz de hora em hora
  (a caixa diária inteira + 35 dias da caixa detalhada, montadas a partir das vendas
  do sistema) — é essa que precisa virar staging+swap.
  ⚠️ `giga_produto`, `giga_transferencia`, `giga_transferencia_item` e as
  `wincred_*` estão **congeladas** — nada as recarrega, então `dead_pct` alto NELAS
  é outra coisa, não recarga. Os prefixos são herança de nome: hoje são tabelas
  **nativas do Flow**.
- **`postgres.sql` [1]** — se as conexões encostarem no `max_connections`, fixar
  `connection_limit` na `DATABASE_URL` e revisar transações longas.
- **`postgres.sql` [5]/[8]** — confirmam quais relatórios/telas varrem tabela
  inteira (candidatos a índice além dos já criados).

Nada aqui roda dentro da aplicação — é script avulso de operação.

---

> **Havia um `giga-mysql.sql` aqui.** Ele media o lock na tabela `caixa` do MySQL
> do Giga (KingHost) para decidir se valia tirar o PDV do ERP ao vivo. Aquele
> servidor foi **desligado em 27/08/2026** e a resposta hoje é definitiva: o PDV
> lê e escreve no Postgres do Flow. O script foi removido porque só sabia
> conectar numa máquina que não existe mais.
