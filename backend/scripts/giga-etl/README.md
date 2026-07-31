# ETL Giga (MySQL) → Flow (Postgres)

Copia o banco do Giga **inteiro** — todas as tabelas, todo o histórico — pro
schema `giga_raw` do Postgres do Flow.

Decisão do dono (31/07/2026): *"independente do Giga tocar, vamos trazer todas
as tabelas e dados pois em algum momento vamos precisar."*

## O que ele é, e o que não é

**É** uma cópia crua e fiel. Todas as tabelas, sem filtro, sem regra de
negócio, nomes de coluna em minúsculo.

**Não é** fonte da verdade de nada. Os 20 espelhos curados que já existem
(`wincred_produtos`, `giga_caixa_mov`, `wincred_estoque`…) continuam sendo
quem o sistema lê — eles têm normalização de código, filtro de `MARCADO`,
regra de data. O `giga_raw` é arquivo e ponto de partida das migrações
futuras.

Por isso vive em schema separado: `DROP SCHEMA giga_raw CASCADE` desfaz tudo
sem encostar em nada que a operação usa.

## Segurança

Só faz `SELECT` no MySQL. **Nada é escrito no Giga.**

## Uso

```bash
cd backend

# Windows (PowerShell)
$env:GIGA_ETL_MYSQL_URL = "mysql://usuario:senha@162.215.213.154:3306/banco"
$env:GIGA_ETL_PG_URL    = "postgresql://usuario:senha@host:5432/railway"

# 1) Inventário primeiro — não copia nada, só lista tamanho e engine
npx ts-node scripts/giga-etl/etl.ts --so-listar

# 2) Carga completa
npx ts-node scripts/giga-etl/etl.ts

# Uma tabela só (refaz mesmo se já estiver marcada como pronta)
npx ts-node scripts/giga-etl/etl.ts --tabela caixa

# Ignorar o progresso e recomeçar do zero
npx ts-node scripts/giga-etl/etl.ts --refazer
```

A `GIGA_ETL_PG_URL` é a URL **pública** do Postgres do Railway (aba Connect →
Public Network). A privada só funciona de dentro do Railway.

## Retomável

O progresso fica em `giga_raw._etl_controle`. Caiu na tabela 40 de 60? Roda de
novo e ele continua da 40. Carga de horas não pode recomeçar do zero por causa
de uma queda de rede.

Tabela que falhar **não interrompe as outras** — o erro é registrado e o
resumo final lista o que faltou.

## Conferir depois

```sql
-- o que foi copiado, quanto e em quanto tempo
SELECT tabela, linhas, duracao_s, erro
  FROM giga_raw._etl_controle ORDER BY linhas DESC NULLS LAST;

-- total geral
SELECT SUM(linhas) FROM giga_raw._etl_controle WHERE erro IS NULL;
```

Compare com o `COUNT(*)` da origem. Divergiu = rode aquela tabela de novo com
`--tabela <nome>`.

## Decisões de tipo que valem saber

Estão comentadas em `tipos.ts`, mas as três que mordem:

**`datetime` vira `timestamp` sem fuso.** O Giga grava hora local. Converter
pra `timestamptz` faria o Postgres assumir UTC e deslocar tudo em 3 horas —
venda das 21h viraria meia-noite do dia seguinte e o faturamento por dia
mudaria de dia.

**`0000-00-00` vira NULL.** Data zerada é legal no MySQL e impossível no
Postgres. Em ERP de 20 anos ela SEMPRE aparece.

**`time` vira `text`.** O `TIME` do MySQL aceita `838:59:59` (duração, não
hora do dia); o `time` do Postgres recusa acima de 24h e a carga quebraria
numa linha só.

## Depois da carga

Isto é a **Fase 0** do `docs/PLANO-SAIDA-GIGA-NATIVO.md`. Ter o dado no
Postgres não muda o comportamento do sistema — ele continua lendo o MySQL. O
que muda é que a partir daqui nada se perde se o Giga morrer, e todas as fases
seguintes têm de onde partir.
