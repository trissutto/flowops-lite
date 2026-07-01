# Diagnóstico de performance — scripts read-only

Dois scripts que **só leem** (nenhum altera dado/schema/config). Servem para
transformar as hipóteses da auditoria em números reais e decidir **qual gargalo
de escala atacar primeiro**.

Rodar com a **loja fechada** para fotografar o estado após um dia de operação.

## Arquivos

| Script | Onde rodar | Responde |
|---|---|---|
| `postgres.sql` | Postgres do Railway (`psql` ou console SQL) | bloat do espelho, conexões vs teto, cache hit, índices faltando/ociosos, queries mais caras |
| `giga-mysql.sql` | MySQL do Giga (KingHost, usuário só-leitura) | lock na `caixa` (serialização das finalizações), tamanho das tabelas quentes, full scans, slow queries |

## Como rodar

**Postgres:**
```
psql "postgresql://...url-do-railway..." -f tools/diagnostico-performance/postgres.sql
```

**Giga (MySQL):**
```
mysql -h 162.215.213.154 -u <ERP_USER> -p <ERP_DATABASE> < tools/diagnostico-performance/giga-mysql.sql
```

Copie **toda a saída** dos dois e mande de volta — a partir dela definimos a
ordem das próximas correções (com números, não com achismo).

## O que cada número decide

- **`giga-mysql.sql` [3]/[4]** — se a `caixa` for grande e houver lock waits no
  pico, o gargalo #1 de escala é **tirar o PDV do Giga ao vivo** (gerar o número
  do cupom local + ler do espelho). Prioridade máxima.
- **`postgres.sql` [4]** — se `giga_*`/`wincred_*` tiverem `dead_pct` alto, o
  espelho horário (delete-all + insert) precisa virar staging+swap.
- **`postgres.sql` [1]** — se as conexões encostarem no `max_connections`, fixar
  `connection_limit` na `DATABASE_URL` e revisar as transações longas do sync.
- **`postgres.sql` [5]/[8]** — confirmam quais relatórios/telas varrem tabela
  inteira (candidatos a índice além dos já criados).

Nada aqui roda dentro da aplicação — são scripts avulsos de operação.
