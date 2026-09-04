# Runbook — desligar a KingHost

Objetivo: apagar o servidor dedicado da KingHost **sem parar a operação**,
movendo o que vive nele em vez de reescrever o sistema.

A decisão (31/07/2026): mover o banco, não migrar o código. As ~250 chamadas
ao Giga continuam existindo e funcionando — só mudam de endereço. A saída do
Giga pro Flow segue depois, no ritmo certo (ver `INVENTARIO-TELAS-GIGA.md`).

---

## O que vive naquele servidor

| Item | Quem depende | Se morrer sem migrar |
|---|---|---|
| **MySQL Giga/Wincred** | ~250 chamadas em 16 módulos | PDV não vende, crediário para, cadastro para |
| **MySQL WordPress** | 12 módulos (`WP_DB_*`, `WC_URL`) | entrada e sync de pedidos do site param |
| **Site WordPress** (PHP) | clientes | `lurds.com.br` fora do ar |
| **`wp-content/uploads`** | site antigo **e o novo** | produto sem foto no R2 fica sem imagem nos dois |

⚠️ A última linha surpreende: `loja-catalog.service.ts` usa foto do R2 quando
existe e **cai pra URL do WordPress** quando não existe. Enquanto a migração de
imagem não terminar, o site novo também depende daquele disco.

---

## BLOCO A — MySQL do Giga → Railway (crítico, faz primeiro)

### A1. Inventário (roda ANTES de tudo, do seu PC)

O seu PC tem acesso liberado por IP ao Giga. Rode `backend/scripts/_arquivo-giga/01-inventario.ps1`.

Ele responde as três coisas que mudam o plano:
- **tamanho total** (decide quanto tempo o dump leva)
- **engine das tabelas** — se houver MyISAM, `--single-transaction` NÃO garante
  consistência e o dump precisa travar as tabelas (= operação parada durante o dump)
- **contagem por tabela** — é o número que a verificação vai comparar depois

### A2. Provisionar o MySQL no Railway

No projeto `heroic-mercy`: **New → Database → MySQL**. Ele nasce na mesma rede
privada do backend e do Postgres.

Anote as variáveis que o Railway gera (`MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`,
`MYSQLPASSWORD`, `MYSQLDATABASE`).

> Ganho de brinde: o banco passa a ficar ao lado da aplicação. O incidente
> crônico do projeto — firewall da KingHost derrubando o IP dinâmico do Railway
> e pendurando o pool, que derrubou a live em 01/07 — **deixa de existir**.

### A3. Congelar as escritas antes do dump

O dump é uma foto. Venda que acontecer depois da foto e antes da virada some.
Por isso, na janela de corte (lojas fechadas):

1. Confira a fila do outbox vazia: `GET /pdv/erp-outbox` — se houver job
   pendente, `POST /pdv/erp-outbox/retry` e espere zerar.
2. Desligue os crons do espelho: `WINCRED_MIRROR_CRON_ENABLED=0` no Railway.
3. Só então dispare o dump.

### A4. Dump e restore

`backend/scripts/_arquivo-giga/02-dump.ps1` e `03-restore.ps1`. O dump sai comprimido; o
restore aponta pro MySQL novo.

### A5. Verificar ANTES de virar

`backend/scripts/_arquivo-giga/04-verificar.ps1` compara contagem de linhas tabela a tabela
entre origem e destino. **Qualquer divergência = não vira.** Investigue antes.

### A6. Virar

No Railway, serviço `flowops-lite`, troque:

```
ERP_HOST     → o host do MySQL novo
ERP_PORT     → a porta nova
ERP_USER     → o usuário novo
ERP_PASSWORD → a senha nova
ERP_DATABASE → o database novo
```

Religue `WINCRED_MIRROR_CRON_ENABLED=1`.

### A7. Teste de fumaça (antes de liberar as lojas)

1. Bipar uma peça no PDV — preço e estoque aparecem?
2. Fechar uma venda de treinamento (`isTraining`) — grava e baixa estoque?
3. Abrir o crediário de uma loja — a lista de parcelas em aberto carrega?
4. `GET /pdv/erp-outbox` — a fila drenou?

Só depois disso a KingHost pode apagar.

**Rollback:** as variáveis antigas de volta e o servidor velho de novo. Por isso
a KingHost só desliga DEPOIS do teste de fumaça passar — não antes.

---

## BLOCO B — WordPress

Duas saídas, e a escolha é de negócio:

**B1. Aposentar** — o site novo assume `lurds.com.br`. Só funciona se o catálogo
com fotos reais estiver pronto; hoje ainda há placeholder. Some a entrada de
pedidos do WooCommerce e os módulos que leem `WC_URL`/`WP_DB_*` precisam ser
desligados ou apontados pro catálogo nativo.

**B2. Mover pra outro host** — dump do MySQL do WP + cópia de `wp-content` +
apontar o DNS. Mantém tudo funcionando exatamente como está, e a migração pro
site novo segue sem prazo.

Pro prazo de amanhã, **B2 é o caminho seguro**: mover é reversível, aposentar
não.

---

## BLOCO C — Fotos (`wp-content/uploads`)

Independente de B, as imagens precisam sair daquele disco, porque o site NOVO
depende delas como fallback.

Caminho: copiar `wp-content/uploads` inteiro pro R2 (mesmo bucket das fotos
próprias), e apontar o fallback do `loja-catalog.service.ts` pro R2 em vez do
domínio antigo. Enquanto isso não acontece, produto sem foto no R2 fica sem
imagem.

---

## Ordem recomendada pra amanhã

1. **Agora (hoje):** inventário (A1) — é leitura, não muda nada, e diz se o
   plano cabe no tempo
2. **Amanhã cedo:** provisionar o MySQL (A2) e fazer um dump de ENSAIO com as
   lojas abertas — não vira nada, só mede o tempo real e valida o restore
3. **Amanhã à noite, lojas fechadas:** congelar (A3), dump final (A4),
   verificar (A5), virar (A6), fumaça (A7)
4. **Só então** desligar a KingHost — com o WordPress já movido (B2) ou
   aposentado (B1)

O ensaio do passo 2 é o que transforma a virada da noite em rotina em vez de
aposta: quando chegar a hora, já se sabe quanto tempo leva e que o restore
funciona.
