# MAPA DE DEPENDÊNCIAS DO GIGA — PRODUTOS · CADASTROS · INTEGRAÇÕES

> **REGISTRO HISTORICO (censo de 31/07/2026) — nao descreve o codigo de hoje.** As dependencias listadas foram migradas pro Postgres ou removidas; o ERP foi DESLIGADO em 27/08/2026. Estado atual: `CLAUDE.md` na raiz.

> Levantamento puro (31/07/2026). Nada foi alterado em `src/`.
> Escopo: `products/`, `products-editor/`, `product-registration/`,
> `product-classification/`, `site-publish/`, `purchase-orders/`, `catalog/`,
> `loja-catalog/`, `wincred-mirror/`, `woocommerce/`, `wp-db/` + **todos os crons
> de sincronização com o Giga** do backend.

## Resumo em 5 linhas

1. **Restam 5 escritas que só existem no Giga**: `inserirGrupo` e `inserirSubgrupo`
   (sem nenhum substituto no Flow — a sequência de código de grupo/subgrupo é
   `MAX(CODIGO)+1` no MySQL) e `updateProdutosCampos` (a única que ainda pode ser
   a escrita **primária**, quando `PRODUCT_NATIVE_WRITES=0`). `inserirProdutosBatch`
   e `deleteProdutos` já são **réplica** — o Flow grava primeiro e cai no
   `erp_outbox` (`produto_cadastro` / `produto_exclusao`) se o Giga estiver fora.
2. **A leitura de produto do PDV/live já está migrada**: `WincredCatalogService` lê
   `wincred_produtos`/`wincred_estoque` e só cai no Giga em miss/EAN/erro; e
   `listarGrupos/Subgrupos/Fornecedores/CoresDistintas/TamanhosDistintos/
   findSkuByAnyEan/getEansBySkus/getStockTotalBySkus/getStockBySkusDetailed` já
   desviam pro espelho com `GIGA_MIRROR_READS=1` (flag ativa em produção).
3. **Três telas ainda leem 100% do Giga ao vivo, sem redirect nenhum**:
   Classificação de Produtos (`getRefCatalogSnapshot`), Publicar no Site
   (`searchRefsForPublish` + `getRefColorForQueue` + `getGigaFacetsForPublish`) e
   o enriquecimento do editor quando `PRODUCT_NATIVE_READS=0`. São o maior bloco
   de trabalho restante do domínio.
4. **`loja-catalog/`, `woocommerce/` e `wp-db/` NÃO tocam o Giga** (confirmado por
   varredura): loja-catalog lê só Postgres, woocommerce só a REST do WooCommerce,
   wp-db abre pool próprio no MySQL do **WordPress** (host `WP_DB_HOST`, mesmo
   servidor físico do Giga mas banco diferente).
5. **Dos crons de sync**, 2 continuam obrigatórios enquanto o Giga for escrito por
   fora (`wincred-mirror` incremental de 10min e `giga-mirror` horário); 2 já estão
   **desligados por padrão** desde a "constituição 14/07" (os dois `syncEstoque`,
   gated por `ESTOQUE_SYNC_GIGA=1`); e o full de 3h + o estoque horário viram
   redundantes assim que ninguém mais digitar no Wincred desktop. Nenhum deles é
   substituído pelo `giga_raw` — aquilo é foto de arquivo, não sync.

---

## Como ler a coluna RISCO

| Nível | Significado |
|---|---|
| **CRITICA** | Escrita que cria/altera/apaga produto ou cadastro no ERP |
| **ALTA** | Trava cadastro, publicação ou o caminho quente do PDV se cair |
| **MEDIA** | Tela ou relatório degrada |
| **BAIXA** | Diagnóstico / admin raro |
| **OBSOLETA** | Ferramenta de incidente já encerrado — ninguém usa no dia a dia |

---

## Tabela de dependências

### `src/products/`

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/products/products.service.ts | 321 | LEITURA | `erp.getStockTotalBySkus` → `estoque` | estoque ERP dos SKUs de um produto WooCommerce ao abrir a ficha | MEDIA | **JÁ MIGRADO** — `GIGA_MIRROR_READS=1` desvia pra `giga_produto`+`giga_estoque` (erp.service.ts:3286) |
| src/products/products.service.ts | 878 | LEITURA | `erp.getStockTotalBySkus` | pre-scan em lote do bulk sync de estoque ERP→WooCommerce | MEDIA | **JÁ MIGRADO** (idem) |
| src/products/products.service.ts | 1668 | LEITURA | `erp.describeProductsTable` → `SHOW COLUMNS FROM produtos` + `SELECT * LIMIT 3` | diagnóstico de schema (`GET /produtos/erp-schema/produtos`) | BAIXA | NAO — é introspecção do MySQL; morre junto com o Giga |
| src/products/products.service.ts | 1672 | LEITURA | `erp.describeSalesTable` → `SHOW COLUMNS FROM caixa` | idem para vendas (`GET /produtos/erp-schema/produtos-vendidos`) | BAIXA | NAO |
| src/products/products.service.ts | 1686 | LEITURA | `erp.getStockTotalBySkus` | teste manual de estoque (`GET /produtos/erp-stock-test`) | BAIXA | **JÁ MIGRADO** |
| src/products/products.service.ts | 2003 | LEITURA | `erp.getStockTotalBySkus` | auditoria de SKU (preview do sku-fix) | BAIXA | **JÁ MIGRADO** |
| src/products/products.service.ts | 2356 | LEITURA | `erp.getStockTotalBySkus` | varredura sku-audit por produto WC | BAIXA | **JÁ MIGRADO** |
| src/products/venda-certa-auto-match.service.ts | 107 | LEITURA (dentro de CRON) | `erp.findVendaCertaMatches` → JOIN `caixa`×`produtos` (erp.service.ts:3807) | cron de 30min confirma VENDA_CERTA achando o cupom da venda no caixa do Giga | MEDIA | PARCIAL — `giga_caixa_mov` tem a caixa detalhada e `product`/`giga_produto` o REF/cor/tam; a query precisa ser reescrita (hoje **sem** redirect) |
| src/products/stock-sync-cron.service.ts | 36 | CRON | `products.startBulkSync()` | 3h da manhã: empurra estoque ERP→WooCommerce | MEDIA | **JÁ MIGRADO** na origem (o estoque lido já vem do espelho) |

### `src/products-editor/` — a tela `/retaguarda/editor-produtos`

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/products-editor/products-editor.service.ts | 125 | SQL-CRU | `erp.runReadOnly` → `SELECT CODIGO, REF, DESCRICAOCOMPLETA, MARCA, COR, TAMANHO, VENDAUN FROM produtos WHERE CODIGO IN (...)` | enriquece a busca do editor com dados frescos do Giga — **só no ramo `PRODUCT_NATIVE_READS=0`** | MEDIA | SIM — o ramo nativo já existe no mesmo método (linha 105, tabela `product`); é só ligar a flag |
| src/products-editor/products-editor.service.ts | 261 | SQL-CRU | `erp.runReadOnly` → `SELECT REGISTRO, DATA, HORA, LOJA, NOMECLIENTE, VENDEDOR, QUANTIDADE, VALORTOTAL, MARCADO FROM caixa WHERE CAST(CODIGO AS UNSIGNED)=?` | histórico de vendas/marcados de uma variação (`GET /products-editor/historico`) | MEDIA | PARCIAL — `giga_caixa_mov` cobre a janela do espelho; `giga_raw.caixa` cobre o histórico inteiro |
| src/products-editor/products-editor.service.ts | **505** | **ESCRITA** | `erp.updateProdutosCampos` (erp.service.ts:8621) | **réplica** da edição pro Giga quando `PRODUCT_NATIVE_WRITES=1` (Flow já gravou em `product`) | CRITICA | PARCIAL — o Flow já é fonte; falta enfileirar no `erp_outbox` (hoje falha só vira linha de auditoria `REPLICA_GIGA_ERRO`) |
| src/products-editor/products-editor.service.ts | **522** | **ESCRITA** | `erp.updateProdutosCampos` | **escrita PRIMÁRIA** quando `PRODUCT_NATIVE_WRITES=0` — Giga é a fonte e o Flow só espelha depois | CRITICA | PARCIAL — depende de ligar `PRODUCT_NATIVE_WRITES=1` |
| src/products-editor/products-editor.service.ts | **625** | **ESCRITA** | `erp.updateProdutosCampos` | réplica da "marca em massa" (aplica marca em TODOS os resultados da busca, sem teto de 5.000) | CRITICA | PARCIAL (idem 505) |
| src/products-editor/products-editor.service.ts | **631** | **ESCRITA** | `erp.updateProdutosCampos` | escrita primária da marca em massa (`PRODUCT_NATIVE_WRITES=0`) | CRITICA | PARCIAL (idem 522) |
| src/products-editor/products-editor.service.ts | 791 | **ESCRITA** | `erp.restoreDataAlt` (erp.service.ts:8739) → `UPDATE produtos SET DATAALT` | restaura data de cadastro em lotes de 2.000 — ferramenta do incidente DATAALT de 14/07 | OBSOLETA | NAO — incidente encerrado; endpoint pode ser removido |
| src/products-editor/products-editor.service.ts | 860 | SQL-CRU | `erp.runReadOnly` → `SELECT CODIGO FROM produtos WHERE DATAALT >= '2026-07-13'` (paginado, 40k/página) | lista códigos "sujos" pra restauração via backup | OBSOLETA | NAO |
| src/products-editor/products-editor.service.ts | 947 | SQL-CRU | mesma query de códigos sujos | leva-caixa da restauração DATAALT | OBSOLETA | NAO |
| src/products-editor/products-editor.service.ts | 984 | LEITURA | `erp.caixaCodigoIndexed` → `SHOW INDEX FROM caixa` | checa se dá pra varrer a caixa antes de tentar | OBSOLETA | NAO |
| src/products-editor/products-editor.service.ts | 990 | LEITURA | `erp.getFirstSaleDatesChunk` → `SELECT CODIGO, MIN(DATA) FROM caixa` | primeira venda por código (prova de idade) | OBSOLETA | PARCIAL — `giga_caixa_mov` / `giga_raw.caixa` |
| src/products-editor/products-editor.service.ts | 1079 | SQL-CRU | `erp.runReadOnly` → `SELECT CODIGO, DATAALT FROM produtos` (catálogo INTEIRO paginado, 15×40k) | auditoria por arquivo do backup de 12/07 | OBSOLETA | NAO |
| src/products-editor/products-editor.service.ts | **1178** | **ESCRITA** | `erp.deleteProdutos` (erp.service.ts:8704) → `DELETE FROM produtos` + `DELETE FROM estoque` | exclusão de produto — **Flow primeiro** (`product`, `wincred_produtos`, `wincred_estoque`, `giga_estoque`), réplica inline no Giga com fallback pro outbox `produto_exclusao` | CRITICA | **SIM** — Flow já é a fonte; outbox cobre o Giga fora |
| src/products-editor/products-editor.service.ts | 1279 | **ESCRITA** | `erp.increaseStock` | movimentação manual de estoque — ENTRADA (tela do editor) | ALTA | SIM — `increaseStock` já faz write-through no espelho e enfileira `estoque_delta` |
| src/products-editor/products-editor.service.ts | 1284 | **ESCRITA** | `erp.decreaseStock` | movimentação manual — SAÍDA | ALTA | SIM (idem) |

### `src/product-registration/` — Cadastro Dinâmico de Produtos

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/product-registration/product-registration.service.ts | 33 | LEITURA | `erp.listarGrupos` | grupos do formulário | BAIXA | **JÁ MIGRADO** → `wincred_grupos` (erp.service.ts:7786) |
| src/product-registration/product-registration.service.ts | 34 | LEITURA | `erp.listarCoresDistintas(300)` | sugestões de cor | BAIXA | **JÁ MIGRADO** → `groupBy` em `wincred_produtos` (erp.service.ts:8274) |
| src/product-registration/product-registration.service.ts | 35 | LEITURA | `erp.listarTamanhosDistintos(200)` | sugestões de tamanho | BAIXA | **JÁ MIGRADO** (erp.service.ts:8312) |
| src/product-registration/product-registration.service.ts | 36 | LEITURA | `erp.listarFornecedores(500)` | dropdown de fornecedor | BAIXA | **JÁ MIGRADO** → `wincred_fornecedores` (erp.service.ts:8424) |
| src/product-registration/product-registration.service.ts | 42 | LEITURA | `erp.listarSubgrupos(grupo)` | subgrupos do grupo escolhido | BAIXA | **JÁ MIGRADO** → `wincred_subgrupos` (erp.service.ts:7824) |
| src/product-registration/product-registration.service.ts | **47** | **ESCRITA** | `erp.inserirGrupo` (erp.service.ts:8207) | transação: `SELECT COALESCE(MAX(CODIGO),0)+1 FROM grupos FOR UPDATE` → `INSERT INTO grupos (CODIGO, GRUPO)`; nome UPPER, 30 chars | CRITICA | **NAO** — não existe tabela nativa de grupos nem sequência no Flow. **Bloqueador do desligamento.** |
| src/product-registration/product-registration.service.ts | **52** | **ESCRITA** | `erp.inserirSubgrupo` (erp.service.ts:8239) | transação: `MAX(CODIGO)+1 FROM subgrupos FOR UPDATE` → `INSERT INTO subgrupos (CODIGO, SUBGRUPO, GRUPO)` | CRITICA | **NAO** — mesmo bloqueio |
| src/product-registration/product-registration.service.ts | **151** | **ESCRITA** | `erp.inserirProdutosBatch` (erp.service.ts:8815) | **réplica** do cadastro: 1 transação MySQL, `INSERT IGNORE INTO produtos` (CODIGO, GRUPO, NOMEGRUPO, DESCRICAOPDV, DESCRICAOCOMPLETA, CUSTO, VENDAUN, MARGEM, FORNECEDOR, UNIDADE='UN', ESTOQUE, SUBGRUPO, COR, TAMANHO, MARCA, REF, TRIBUTO, NCM, PLUS_SIZE, CFOP, DATAALT=CURDATE(), OPERADOR='FLOWOPS'); `INSERT IGNORE` = retry idempotente | CRITICA | **SIM** — desde 14/07 o Flow grava PRIMEIRO (`gravarNoFlow`, linha 126: `product` com `flowIsSource=true` + `wincred_produtos`); Giga fora → outbox `produto_cadastro`. **Corrige a nota antiga "cadastro grava só no Giga".** |
| src/product-registration/product-registration.service.ts | 434 | (nativo) | `EanSequence` | reserva de EAN-13 prefixo 8 em transação Postgres | — | **JÁ 100% FLOW** — a tabela `codigos` do Giga só é espelhada pra lookup de EAN antigo |

### `src/product-classification/` — tela Classificação de Produtos (BÁSICO/MODA)

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/product-classification/product-classification.service.ts | 90 | LEITURA | `erp.getRefCatalogSnapshot` (erp.service.ts:2976) → `produtos` agrupado por REF com `GROUP_CONCAT` das descrições | monta o snapshot de REFs da tela (cacheado em memória com TTL) — **100% Giga ao vivo, SEM redirect de espelho** | ALTA | PARCIAL — `wincred_produtos` (ou `product`) tem REF/descrição/marca/fornecedor/grupo/plus_size; falta reescrever o GROUP BY em Postgres |
| src/product-classification/product-classification.service.ts | 363 | LEITURA | `erp.debugProdutosByTerm` (erp.service.ts:3076) → `SELECT ... HEX(REF) FROM produtos WHERE ... LIKE` | diagnóstico "por que a REF não aparece" | BAIXA | PARCIAL — mesma reescrita em `wincred_produtos` |
| (dado) | — | — | `product_classification` | a classificação em si já é 100% do Flow, não toca o Giga | — | **JÁ NATIVO** |

### `src/site-publish/` — fila de publicação no site

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/site-publish/site-publish.service.ts | 55 | LEITURA | `erp.searchRefsForPublish` (erp.service.ts:4828) → `produtos` (+ colunas detectadas dinamicamente) | busca REFs no Giga pra montar a fila (`GET /site-publish/giga-search`) — **sem redirect** | ALTA | PARCIAL — `wincred_produtos` + `wincred_estoque` + `wincred_codigos` têm tudo (inclusive EAN); falta reescrever |
| src/site-publish/site-publish.service.ts | 60 | LEITURA | `erp.getGigaFacetsForPublish` (erp.service.ts:4731) → DISTINCT de grupo/subgrupo/fornecedor | dropdowns da tela (`GET /site-publish/facets`) | MEDIA | SIM — `wincred_grupos`, `wincred_subgrupos`, `wincred_fornecedores` |
| src/site-publish/site-publish.service.ts | 79 | LEITURA | `erp.getRefColorForQueue` (erp.service.ts:5153, chama `searchRefsForPublish`) | congela o snapshot REF+COR ao entrar na fila: tamanhos, códigos, EANs, estoque, custo e os 3 preços | ALTA | PARCIAL (mesma reescrita do 55) |
| src/site-publish/site-publish.service.ts | 301 | LEITURA | `erp.getRefColorForQueue` | descrição fresca do Wincred antes de gerar texto por IA | MEDIA | PARCIAL |
| src/site-publish/wc-catalog.service.ts, ai-enrichment.service.ts | — | — | (nenhum) | só WooCommerce REST e Anthropic API — **não tocam o Giga** | — | — |

### `src/purchase-orders/` — pedidos de compra / recebimento

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/purchase-orders/purchase-orders.controller.ts | 44 | LEITURA | `erp.listarFornecedores(limit)` | dropdown de fornecedor | BAIXA | **JÁ MIGRADO** |
| src/purchase-orders/purchase-orders.controller.ts | 49 | LEITURA | `erp.listarGrupos` | dropdown de grupo | BAIXA | **JÁ MIGRADO** |
| src/purchase-orders/purchase-orders.controller.ts | 62 | LEITURA | `erp.listarSubgrupos` | dropdown de subgrupo | BAIXA | **JÁ MIGRADO** |
| src/purchase-orders/purchase-orders.service.ts | 55 / 63 / 72 | LEITURA | `listarGrupos` / `listarSubgrupos` / `listarFornecedores` | `diagnoseLookups()` — usado quando o dropdown vem vazio | BAIXA | **JÁ MIGRADO** |
| src/purchase-orders/purchase-orders.service.ts | **535** (`{gigaAsync}` na 552) | **ESCRITA (indireta)** | `productReg.processar` → `inserirProdutosBatch` ou outbox | recebimento de compra AUTO-CADASTRA cada item novo; em lote usa `gigaAsync=true` (vai direto pro outbox pra não pendurar a tela) | CRITICA | **SIM** — Flow primeiro + outbox |
| src/purchase-orders/purchase-orders.service.ts | 578 / 579 | **ESCRITA** | `erp.increaseStockAsync` / `erp.increaseStock` | entrada de estoque do recebimento | ALTA | SIM — write-through no espelho + `estoque_delta` |
| src/purchase-orders/purchase-orders.service.ts | **755** | **ESCRITA (indireta)** | `productReg.processar` | rota "cadastrar-faltantes" (recadastra sem repetir entrada de estoque) | CRITICA | **SIM** |

### `src/catalog/` — catálogo do app/site do cliente

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/catalog/catalog.service.ts | 1012 | LEITURA | `erp.getStockBySkusDetailed` | `checkAvailability` — em quais lojas a peça tem estoque, pra sugerir loja/frete | MEDIA | **JÁ MIGRADO** → `giga_estoque` sob `GIGA_MIRROR_READS=1` (erp.service.ts:3366) |

### `src/wincred-mirror/` — o espelho e as leituras do PDV

> As linhas abaixo em `wincred-catalog.service.ts` são **o fallback**, não o
> caminho normal: o espelho responde primeiro e só cai pro Giga em miss/EAN/
> preço zerado/erro, ou com `PDV_MIRROR_READS=0`.

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/wincred-mirror/wincred-catalog.service.ts | 116 | LEITURA (fallback) | `erp.getPdvProductInfo` | bipe do PDV — fallback quando o espelho dá miss (EAN alfanumérico, recém-cadastrado) ou preço zerado | ALTA | **JÁ MIGRADO** (primário = `wincred_produtos`) |
| src/wincred-mirror/wincred-catalog.service.ts | 177 | LEITURA (fallback) | `erp.searchProductsLike` | busca do dropdown do PDV | ALTA | **JÁ MIGRADO** |
| src/wincred-mirror/wincred-catalog.service.ts | 321 | LEITURA (fallback) | `erp.searchByRef` | Consulta de loja por REF | MEDIA | **JÁ MIGRADO** |
| src/wincred-mirror/wincred-catalog.service.ts | 417 | LEITURA (fallback) | `erp.searchByCodeAndExpandRef` | consulta por código/EAN (EAN não existe no espelho → cai sempre) | MEDIA | PARCIAL — depende do `EAN_MIRROR` estar preenchido |
| src/wincred-mirror/wincred-catalog.service.ts | 437 | LEITURA (fallback) | `erp.searchByDescriptionGrouped` | consulta por descrição | MEDIA | **JÁ MIGRADO** |
| src/wincred-mirror/wincred-catalog.service.ts | 540 | LEITURA (fallback) | `erp.getStockBySkusDetailed` | estoque detalhado da consulta | MEDIA | **JÁ MIGRADO** |
| src/wincred-mirror/wincred-mirror.service.ts | 144 | SQL-CRU | `(erp as any).pool` → `SELECT COUNT(*) FROM <tabela>` | `countMysql` — total no Wincred pra status/paginação | BAIXA | n/a (é o próprio sync) |
| src/wincred-mirror/wincred-mirror.service.ts | 276 / 297 | SQL-CRU (CRON) | `SELECT` de 26 colunas `FROM produtos` (leitura ÚNICA, ~352k linhas) | `syncProdutos` — full replace de `wincred_produtos` | ALTA | n/a |
| src/wincred-mirror/wincred-mirror.service.ts | 411 / 428 | SQL-CRU (CRON) | `SELECT CODIGO, ESTOQUE, LOJA FROM estoque LIMIT/OFFSET` | `syncEstoque` — **DESLIGADO por padrão** desde 14/07 (`ESTOQUE_SYNC_GIGA=1` reativa) | BAIXA | n/a |
| src/wincred-mirror/wincred-mirror.service.ts | 537 / 558 / 667 | SQL-CRU (CRON) | `SELECT ... FROM produtos WHERE DATAALT >= ?` + `SELECT ... FROM estoque WHERE CODIGO IN (...)` | `syncIncremental` — o de 10 minutos | ALTA | n/a |
| src/wincred-mirror/wincred-mirror.service.ts | 789 / 793 / 811 | SQL-CRU | `SELECT CODIGO FROM produtos` / `SELECT CODIGO, LOJA, ESTOQUE FROM estoque` | `getDivergencias` — tela de diagnóstico do espelho | BAIXA | n/a |
| src/wincred-mirror/wincred-mirror.service.ts | 871 / 884 / 899 / 930 | SQL-CRU (CRON) | `SELECT * FROM grupos` / `subgrupos` / `fornecedores` / `codigos` | syncs das tabelas pequenas | MEDIA | n/a |
| src/wincred-mirror/wincred-mirror.service.ts | 1176 | SQL-CRU | `(erp as any).pool` | `getStockDistribution` (usa espelho `wincred_produtos` na 1059, pool só pra complemento) | BAIXA | — |

### `src/loja-catalog/`, `src/woocommerce/`, `src/wp-db/` — CONFIRMADO SEM GIGA

| módulo | veredito | evidência |
|---|---|---|
| `src/loja-catalog/` | **zero Giga** | lê só Postgres via `$queryRawUnsafe`: `wincred_produtos` (loja-catalog.service.ts:95, 474, 485, 500, 511), `wincred_estoque` (98, 486, 512), `site_produto` (497, 508), + `fit_product`/`product_photos`. `site-sync.service.ts:140` também usa `wincred_produtos`. |
| `src/woocommerce/` | **zero Giga** | grep por `erp`/`Erp`/`Giga` nos 6 arquivos → 0 resultados. `wc-poller.service.ts:39` faz `@Cron(EVERY_MINUTE)` contra `/wp-json/wc/v3/orders`. |
| `src/wp-db/` | **não é o Giga** | `wp-db.service.ts:26` abre pool próprio (`WP_DB_HOST`, pool 5, `connectTimeout` 12s) no MySQL do **WordPress**. Mesmo servidor dedicado KingHost, banco diferente. Consumidores: `carrinhos-abandonados`, `realignment.service.ts:43`, `stock.controller.ts:19`. |

---

## CRONS E SINCRONIZAÇÕES

### A. Crons que FALAM com o Giga (MySQL)

| arquivo:linha | agendamento | o que sincroniza | destino no Postgres | ainda necessário depois da cópia crua? |
|---|---|---|---|---|
| `src/wincred-mirror/wincred-mirror.cron.ts:30` | `*/10 * * * *` | `produtos` alterados por `DATAALT` + estoque desses códigos | `wincred_produtos`, `wincred_estoque` | **SIM, enquanto alguém digitar no Wincred desktop.** O `giga_raw` é foto única — não substitui sync contínuo. Vira desnecessário no dia em que 100% da escrita de produto for pelo Flow. Gated por `WINCRED_MIRROR_CRON_ENABLED=1`. |
| `src/wincred-mirror/wincred-mirror.cron.ts:57` | `23 * * * *` (minuto 23) | estoque FULL (venda no Giga muda estoque sem tocar DATAALT) | `wincred_estoque` | **NÃO — já é no-op.** `syncEstoque` (service.ts:406) retorna cedo sem `ESTOQUE_SYNC_GIGA=1`: "Flow é a fonte" desde a constituição 14/07. Só o botão manual (`force=true`) roda. |
| `src/wincred-mirror/wincred-mirror.cron.ts:76` | `EVERY_DAY_AT_3AM` | full geral: grupos → subgrupos → fornecedores → codigos → produtos → estoque | 6 tabelas `wincred_*` | **PARCIAL.** Rede de segurança contra `DATAALT` bugada. Enquanto o incremental existir, mantém; quando o Flow for a única escrita, cai fora junto. |
| `src/financeiro/giga-mirror.service.ts:112` | `EVERY_HOUR` | transferências, caixa diário, itens de transferência, **catálogo `produtos` (throttle 6h)**, estoque (desligado), caixa detalhada (janela 3 dias), funcionários | `giga_transferencia`, `giga_caixa_diario`, `giga_transferencia_item`, **`giga_produto`**, `giga_estoque`, `giga_caixa_mov`, `wincred_funcionarios` | **SIM.** É a única fonte de `giga_produto` (usado pelo `getStockTotalBySkus` do mirror-reads e pela grade da live) e de `giga_caixa_mov`. Substituível pelo `giga_raw` só pro **histórico**; o incremental continua. |
| `src/financeiro/giga-mirror.service.ts:478` | (dentro do horário) | `syncEstoque` Giga→Flow | `giga_estoque` | **NÃO — já é no-op** sem `ESTOQUE_SYNC_GIGA=1` (mesma constituição 14/07). |
| `src/financeiro/giga-mirror.service.ts:58` | `onModuleInit` (+8s / +15s / +30s) | backfill inicial se espelho vazio, backfill de `ref_base` em `giga_produto`, backfill/extensão de `giga_caixa_mov` | idem | **PARCIAL.** O backfill de histórico da `caixa_mov` é exatamente o que o `giga_raw` já tem — dá pra trocar por um `INSERT ... SELECT` no Postgres, sem ida ao Giga. |
| `src/product-native/product-native.service.ts:148` | `0 38 * * * *` (minuto 38) | **NÃO toca o Giga** — copia `wincred_produtos` → `product` (nativa), aplicando curadoria (gênero, `liveOk`), respeitando `flowIsSource` | `product` | SIM, enquanto o espelho for a fonte da nativa. É Postgres→Postgres. |
| `src/product-native/product-native.service.ts:138` | `onModuleInit` (+25s) | incremental de boot (Postgres→Postgres) | `product` | SIM |
| `src/products/venda-certa-auto-match.service.ts:51` | `EVERY_30_MINUTES` | **lê** `caixa`×`produtos` no Giga pra confirmar VENDA_CERTA | `TransferOrder.saleStatus` | **NÃO precisa ser no Giga** — dá pra reescrever contra `giga_caixa_mov` + `product`. Hoje é ida ao vivo. |
| `src/products/stock-sync-cron.service.ts:36` | `0 3 * * *` | bulk sync de estoque ERP→**WooCommerce** (a leitura já vem do espelho) | WooCommerce | SIM (é integração de saída, não sync do Giga) |

### B. Crons de sync do Giga FORA do domínio de produtos (contexto, não mexer aqui)

| arquivo:linha | agendamento | o que faz |
|---|---|---|
| `src/crediarios/crediario-mirror.service.ts:50` | `*/10 * * * *` | parcelas de crediário em aberto (`erp.readAllPages`, linha 132) |
| `src/crediarios/crediario-mirror.service.ts:76` | `0 4 * * *` | clientes do crediário |
| `src/crediario-nativo/crediario-nativo.service.ts:35` | `10 4 * * *` | crediário nativo |
| `src/clientes-giga/clientes-giga.service.ts:40` | `40 4 * * *` | clientes do Giga (inclui ESCRITA via `upsertClienteGiga`, linhas 582/632) |
| `src/pdv/marcados-mirror.service.ts:35` | `40 * * * *` | marcados ("provar em casa") |
| `src/pdv/erp-outbox.service.ts:45` | `EVERY_30_SECONDS` | **processa a fila de escrita** — kinds `venda`, `produto_cadastro`, `produto_exclusao`, `estoque_delta`, `cliente_upsert`, `crediario_baixa`, `crediario_estorno` (linhas 91-98) |
| `src/realignment/realignment-auto.service.ts:123` | `0 6 * * *` | realinhamento lê `erp.searchRefsByDateRange` (linha 166) |
| `src/loja-catalog/site-sync.service.ts:117` | `0 35 4 * * *` | WooCommerce→`site_produto` (não é Giga, mas o WP divide servidor com ele) |

### C. Sobre o `giga_raw`

Não é um sync — é **ETL manual** (`scripts/giga-etl/etl.ts`, schema `giga_raw`,
tabelas descobertas por `information_schema.TABLES`, resumível via
`giga_raw._etl_controle`, checkpoint em `scripts/giga-etl/checkpoint.ts`).
O próprio README (`scripts/giga-etl/README.md:14-18`) declara: *"Não é fonte da
verdade de nada"* — os espelhos curados continuam sendo quem o sistema lê.
Consequência prática para este mapa: **o `giga_raw` cobre histórico e migração,
mas não elimina nenhum cron incremental.**

---

## Ordem sugerida de ataque (do bloqueio pro resto)

1. **`inserirGrupo` / `inserirSubgrupo`** — únicas escritas sem substituto algum.
   Precisa de tabelas nativas `ProductGroup`/`ProductSubgroup` + sequência no
   Postgres (mesmo padrão do `EanSequence`), com dual-write pro Giga.
2. **Ligar `PRODUCT_NATIVE_WRITES=1`** — tira o `updateProdutosCampos` do papel de
   escrita primária (linhas 522 e 631 do editor) e deixa só como réplica; depois
   mover a réplica pro `erp_outbox` como já é o cadastro/exclusão.
3. **Reescrever as 3 telas 100%-Giga**: `getRefCatalogSnapshot` (classificação),
   `searchRefsForPublish`/`getRefColorForQueue`/`getGigaFacetsForPublish`
   (site-publish). Todos os campos existem em `wincred_produtos` +
   `wincred_estoque` + `wincred_codigos` + `wincred_grupos/subgrupos/fornecedores`.
4. **`findVendaCertaMatches`** — reescrever contra `giga_caixa_mov` + `product`.
5. **Remover as ferramentas do incidente DATAALT** (7 pontos marcados OBSOLETA no
   `products-editor`) — hoje são o que mais varre o catálogo inteiro do Giga.
6. **Diagnósticos** (`describeProductsTable`, `describeSalesTable`,
   `debugProdutosByTerm`, `caixaCodigoIndexed`) morrem junto com o Giga — não
   precisam de substituto, só de remoção no dia do desligamento.
