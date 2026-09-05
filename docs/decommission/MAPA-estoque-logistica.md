# MAPA DE DEPENDÊNCIAS DO GIGA — domínio ESTOQUE + LOGÍSTICA

> **REGISTRO HISTORICO (censo de 31/07/2026) — nao descreve o codigo de hoje.** As dependencias listadas foram migradas pro Postgres ou removidas; o ERP foi DESLIGADO em 27/08/2026. Estado atual: `CLAUDE.md` na raiz.

Levantamento (31/07/2026). Escopo: `src/realignment/`, `src/stock/`, `src/stock-mirror/`,
`src/stock-conferidor/`, `src/pick-orders/`, `src/routing/`, `src/trocas/`, `src/wc-returns/`.
Nada foi alterado — só leitura. Todas as linhas foram conferidas no código.

---

## Resumo

1. **75 dependências** do Giga nos 8 módulos: 64 chamadas `this.erp.*`, 8 chamadas ao `RealignmentPricingService` (pool MySQL PRÓPRIO, fora do `ErpService`), 2 queries cruas dentro desse pool e 1 `runReadOnly` em SQL cru. Concentração: **realignment = 45** (35 `erp.*` + 8 `pricing.*` + 2 do pool próprio), pick-orders 11, stock 10, stock-conferidor 4, stock-mirror 1, routing 2, trocas 1, wc-returns 1.
2. **10 são ESCRITA de estoque** (`decreaseStock` ×2, `increaseStock` ×2, `decreaseStockAsync` ×3, `increaseStockAsync` ×3) — todas já gravam no Flow primeiro e replicam pro Giga com fila; nenhuma é "só Giga". Mais 2 leituras do conferidor que **gravam de volta nos espelhos do Flow** (`puxarDoGiga`, `importarNegativos`).
3. **Substituto:** 18 já resolvidas por espelho ativo (`GIGA_MIRROR_READS` / outbox), 11 em migração no modo sombra (`findCodigoByRefCorTam`, `batchFindCodigosByRefCorTam`), 41 com o dado JÁ no espelho mas **sem código escrito** (`wincred_produtos` tem `dataAlt`, `descricaoCompleta`, `ref+cor`, `plusSize`, `ean`, `vendaUn` — tudo indexado), 5 são só leitura de env (`isWriteEnabled`).
4. **As 3 mais críticas:** (a) `shipment.service.ts:750` `decreaseStock` + `:2053` `increaseStock` — o par que move estoque de verdade no realinhamento; (b) `shipment.service.ts:271` `getPdvProductInfo` — **único bipe do sistema que NÃO passa pelo `WincredCatalogService`**, vai direto no pool do Giga, então Giga pendurado = triagem sem bipar; (c) `triage.service.ts:337` `resolveSkuInfo` — o `info.codigo` que ele devolve é gravado em `TransferOrder.codigoBipado` e é ELE que baixa estoque no fechamento; errar aqui baixa o CODIGO errado.
5. **Achado colateral:** `src/stock-mirror/` inteiro é órfão — puxa `estoque` FULL do Giga por loja pra tabela nativa `stock`, que **nenhum outro módulo lê**; o botão `POST /admin/stock-mirror/sync` não checa `ESTOQUE_SYNC_GIGA` e o `decrement()` nunca é chamado. Candidato a desligar antes de qualquer outra coisa.

---

## Tabela

### `src/realignment/` — 45 dependências

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/realignment/realignment-auto.service.ts` | 166 | LEITURA | `erp.searchRefsByDateRange` → `produtos` (DATAALT) | cron do realinhamento automático lista as REFs cadastradas no dia-alvo | MEDIA | PARCIAL — `wincred_produtos.dataAlt` é indexada; falta escrever a query |
| `src/realignment/realignment.controller.ts` | 93 | LEITURA | `erp.searchByDescriptionGrouped` → `produtos` (DESCRICAOCOMPLETA LIKE) | busca REFs por nome na retaguarda (`GET /realignment/search-refs`) | MEDIA | PARCIAL — `wincred_produtos.descricaoCompleta` é indexada |
| `src/realignment/realignment.controller.ts` | 122 | LEITURA | `erp.searchRefsByDateRange` → `produtos` | `GET /realignment/search-refs-by-date` — REFs cadastradas no intervalo | MEDIA | PARCIAL — idem `wincred_produtos.dataAlt` |
| `src/realignment/realignment.controller.ts` | 147 | LEITURA | `erp.searchRefsComSobraPorSku` → `produtos` + `estoque` | lista REFs com sobra (candidatas a realinhamento) | MEDIA | PARCIAL — `wincred_produtos` + `wincred_estoque` |
| `src/realignment/realignment.controller.ts` | 172 | SQL-CRU | `erp.diagnoseRefsByDate` → `produtos` + `information_schema` | diagnóstico admin de por que a busca por data volta 0 | BAIXA | PARCIAL — `giga_raw.produtos` |
| `src/realignment/realignment.controller.ts` | 824 | SQL-CRU | `erp.diagnoseSku` → `produtos` (LIKE em CODIGO/REF/EAN/DESCRICAO) | diagnóstico de "SKU não encontrado" na triagem | BAIXA | PARCIAL — `wincred_produtos` / `giga_raw.produtos` |
| `src/realignment/realignment.service.ts` | 148 | LEITURA | `erp.searchByRef` → `produtos` + subselect `estoque` | monta o preview do plano: todas as variações cor×tam da REF, com `TOTAL_EST` pra **deduplicar CODIGO repetido** | ALTA | PARCIAL — `wincred_produtos` + `wincred_estoque`; a regra de dedup por estoque precisa ser portada junto |
| `src/realignment/realignment.service.ts` | 296 | LEITURA | `erp.getStockBySkusDetailed` → `estoque` | estoque por loja de cada SKU do plano — é o que decide **qual loja cede a peça** | CRITICA | SIM — `giga_estoque` já intercepta com `GIGA_MIRROR_READS=1` |
| `src/realignment/realignment.service.ts` | 601 | LEITURA | `erp.getStockBySkusDetailed` → `estoque` | revalida o estoque na confirmação do plano | CRITICA | SIM — mesmo espelho |
| `src/realignment/realignment.service.ts` | 1197 | LEITURA | `erp.findCodigoByRefCorTam` → `produtos`+`estoque` | resolve o SKU pra precificar a obrigação inter-loja (÷2,5) | MEDIA | EM MIGRAÇÃO — `sombra.service.ts:209` (Postgres, modo sombra) |
| `src/realignment/realignment.service.ts` | 1199 | LEITURA | `erp.getProductPricesBySkus` → `produtos` (VENDAUN) | preço da peça pra gravar a `InterStoreObligation` | MEDIA | PARCIAL — `sombra.service.ts:455` existe mas **não está ligado** no `ErpService` |
| `src/realignment/shipment.service.ts` | 271 | LEITURA | `erp.getPdvProductInfo` → `produtos` (+`caixa` no fallback de preço) | valida/resolve o código bipado ao adicionar peça na remessa | **CRITICA** | PARCIAL — `WincredCatalogService.getPdvProductInfo` (espelho-primeiro) existe e **todo o resto do sistema usa**; este é o único call-site que chama o `ErpService` direto |
| `src/realignment/shipment.service.ts` | 463 | LEITURA | `erp.getStockByRefCorTamInStoreBatch` → `produtos`+`estoque` | precheck em lote do estoque na origem antes de fechar a remessa (só alerta) | MEDIA | PARCIAL — versão batch não existe em Postgres |
| `src/realignment/shipment.service.ts` | 477 | LEITURA | `erp.getStockByRefCorTamInStore` → `produtos`+`estoque` | fallback individual do precheck quando o batch falha | MEDIA | PARCIAL — `sombra.service.ts:489` existe, **não ligado** |
| `src/realignment/shipment.service.ts` | 546 | LEITURA | `erp.batchFindCodigosByRefCorTam` → `produtos`+`estoque` | resolve SKU em lote no precheck | ALTA | EM MIGRAÇÃO — `sombra.service.ts:307` |
| `src/realignment/shipment.service.ts` | 683 | LEITURA | `erp.batchFindCodigosByRefCorTam` | resolve SKU em lote no `closeAndSend` — define **o que vai ser baixado** | CRITICA | EM MIGRAÇÃO — `sombra.service.ts:307` |
| `src/realignment/shipment.service.ts` | 700 | LEITURA | `erp.findCodigoByRefCorTam` | fallback individual do `closeAndSend` | CRITICA | EM MIGRAÇÃO — `sombra.service.ts:209` |
| `src/realignment/shipment.service.ts` | **750** | **ESCRITA** | `erp.decreaseStock` → `estoque` (+ Flow) | **baixa o estoque da loja origem ao fechar a remessa** (`allowNegative`, `skipNotFound`) | **CRITICA** | SIM — Flow é a fonte (`mirrorStockApplyDelta`), Giga vai por réplica/outbox |
| `src/realignment/shipment.service.ts` | 867 | SQL-CRU | `pricing.getPricesByCodigos` → `produtos` (pool próprio) | preço p/ obrigação inter-loja no fechamento | MEDIA | PARCIAL — `wincred_produtos.vendaUn` / `product.vendaUn` |
| `src/realignment/shipment.service.ts` | 868 | SQL-CRU | `pricing.getPricesByRefs` → `produtos` (AVG por REF) | fallback de preço por REF | MEDIA | PARCIAL — idem |
| `src/realignment/shipment.service.ts` | 1040 | LEITURA | `erp.searchByDescriptionPlusCorTam` → `produtos` | rota admin `refresh-skus`: reresolve CODIGO pela descrição+cor+tam | ALTA | PARCIAL — `wincred_produtos.descricaoCompleta` indexada |
| `src/realignment/shipment.service.ts` | 1055 | LEITURA | `erp.findCodigoByRefCorTam` | 2ª estratégia do `refresh-skus` | ALTA | EM MIGRAÇÃO |
| `src/realignment/shipment.service.ts` | 1130 | LEITURA | `erp.resolveSkuInfo` → `produtos` (+EAN) | bipe do RECEBIMENTO: normaliza o código/EAN lido pelo scanner | ALTA | PARCIAL — `sombra.service.ts:406` existe, **não ligado** |
| `src/realignment/shipment.service.ts` | 1174 | LEITURA | `erp.batchFindAllCodigosByRefCorTam` → `produtos` | cache (60s) de TODOS os CODIGOs candidatos pra casar o bipe com o item | ALTA | PARCIAL — precisa da variante "todos os códigos", não só o de maior estoque |
| `src/realignment/shipment.service.ts` | 1236 | LEITURA | `erp.findCodigoByRefCorTam` | estratégia E4 do bipe (1 query por item pendente — lenta) | ALTA | EM MIGRAÇÃO |
| `src/realignment/shipment.service.ts` | 1500 | LEITURA | `erp.batchFindCodigosByRefCorTam` | resolve SKU no `reprocess-stock-increase` (admin) | ALTA | EM MIGRAÇÃO |
| `src/realignment/shipment.service.ts` | 1514 | LEITURA | `erp.findCodigoByRefCorTam` | fallback individual do mesmo reprocesso | ALTA | EM MIGRAÇÃO |
| `src/realignment/shipment.service.ts` | **1529** | **ESCRITA** | `erp.increaseStock` → `estoque` (+ Flow) | reaplica a ENTRADA no destino (rota admin de reprocesso; `force` duplica) | **CRITICA** | SIM — Flow fonte + réplica/outbox |
| `src/realignment/shipment.service.ts` | 1677 | LEITURA | `erp.batchFindCodigosByRefCorTam` | resolve SKU no `reprocess-stock-decrease` (admin) | ALTA | EM MIGRAÇÃO |
| `src/realignment/shipment.service.ts` | 1691 | LEITURA | `erp.findCodigoByRefCorTam` | fallback individual do mesmo reprocesso | ALTA | EM MIGRAÇÃO |
| `src/realignment/shipment.service.ts` | **1707** | **ESCRITA** | `erp.decreaseStock` → `estoque` (+ Flow) | reaplica a BAIXA na origem (rota admin; `force` duplica) | **CRITICA** | SIM — Flow fonte + réplica/outbox |
| `src/realignment/shipment.service.ts` | 2025 | LEITURA | `erp.findCodigoByRefCorTam` | resolve SKU dos itens sem `codigoBipado` no `confirmReceived` | CRITICA | EM MIGRAÇÃO |
| `src/realignment/shipment.service.ts` | **2053** | **ESCRITA** | `erp.increaseStock` → `estoque` (+ Flow) | **dá ENTRADA no estoque da loja destino ao confirmar o recebimento** | **CRITICA** | SIM — Flow fonte + réplica/outbox |
| `src/realignment/triage.service.ts` | 102 | LEITURA | `erp.resolveSkuInfo` → `produtos` (+EAN) | resolve a peça bipada no provador antes de sugerir destino; `null` = 404 na tela | ALTA | PARCIAL — `sombra.service.ts:406`, **não ligado** |
| `src/realignment/triage.service.ts` | 121 | LEITURA | `erp.getStockBySkuAndStores` → `estoque` | estoque do SKU em cada loja candidata (evita mandar pra quem já tem) | ALTA | SIM — `giga_estoque` via `GIGA_MIRROR_READS` |
| `src/realignment/triage.service.ts` | 122 | LEITURA | `erp.getRecentSalesByRefAndStores` → `caixa` JOIN `produtos` | giro da REF nos últimos 30d por candidata — critério de destino | MEDIA | PARCIAL — `giga_caixa_mov` existe (usado em `salesByStoreLastDaysFromMirror`), essa query não foi portada |
| `src/realignment/triage.service.ts` | **337** | LEITURA | `erp.resolveSkuInfo` → `produtos` (+EAN) | resolve o SKU e grava `info.codigo` em `TransferOrder.codigoBipado` — **é esse código que baixa estoque no fechamento** | **CRITICA** | PARCIAL — `sombra.service.ts:406`, **não ligado** |
| `src/realignment/realignment-report.service.ts` | 121 | SQL-CRU | `pricing.getPricesByCodigos` → `produtos` (pool próprio) | preço das peças no relatório de transferências | MEDIA | PARCIAL — `wincred_produtos.vendaUn` |
| `src/realignment/realignment-report.service.ts` | 122 | SQL-CRU | `pricing.getPricesByRefs` → `produtos` | fallback de preço por REF no mesmo relatório | MEDIA | PARCIAL — idem |
| `src/realignment/realignment-report.service.ts` | 413 | SQL-CRU | `pricing.getPricesByCodigos` | preço no relatório por loja | MEDIA | PARCIAL — idem |
| `src/realignment/realignment-report.service.ts` | 414 | SQL-CRU | `pricing.getPricesByRefs` | fallback por REF | MEDIA | PARCIAL — idem |
| `src/realignment/realignment-report.service.ts` | 563 | SQL-CRU | `pricing.getPricesByCodigos` | preço no 3º corte do relatório | MEDIA | PARCIAL — idem |
| `src/realignment/realignment-report.service.ts` | 564 | SQL-CRU | `pricing.getPricesByRefs` | fallback por REF | MEDIA | PARCIAL — idem |
| `src/realignment/realignment-pricing.service.ts` | 113 | SQL-CRU | `SELECT CODIGO, VENDAUN FROM produtos WHERE CODIGO IN (...)` — **pool MySQL próprio** (`connectionLimit: 2`, `queueLimit: 0`) | a query real por trás de `getPricesByCodigos`; roda FORA do `ErpService`, com pool separado | ALTA | PARCIAL — `wincred_produtos.vendaUn` resolve o dado; o pool paralelo é passivo de arquitetura (já pendurou a transferência, ver comentário em `shipment.service.ts:268`) |
| `src/realignment/realignment-pricing.service.ts` | 158 | SQL-CRU | `SELECT REF, AVG(VENDAUN) FROM produtos GROUP BY REF` — mesmo pool próprio | query real por trás de `getPricesByRefs` | ALTA | PARCIAL — idem |

### `src/stock/` — 10 dependências

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/stock/stock.service.ts` | 49 | LEITURA | `erp.getStock` → `estoque` | estoque (cache 30s) que alimenta o **roteamento do pedido do site** — decide qual loja separa | CRITICA | SIM — `giga_estoque` via `GIGA_MIRROR_READS`; ainda tem 2º fallback pro `wincred_estoque` (`catalog.getStockFromMirror`) |
| `src/stock/stock.service.ts` | 81 | LEITURA | `erp.getStock` → `estoque` | `getStockLive` — consulta sem cache, só pra tela de diagnóstico | BAIXA | SIM — mesmo caminho |
| `src/stock/stock.controller.ts` | 109 | LEITURA | `erp.getStockRawBySku` → `estoque` | `GET /stock/diagnose` — linhas cruas por loja, detecta duplicata | BAIXA | PARCIAL — `giga_raw.estoque` / `wincred_estoque` |
| `src/stock/stock.controller.ts` | 124 | LEITURA | `erp.getProduct` → `produtos` | nome+preço do SKU na mesma tela de diagnóstico | BAIXA | PARCIAL — `wincred_produtos` |
| `src/stock/stock.controller.ts` | 186 | SQL-CRU | `erp.listTablesLike` → `information_schema` + `SHOW COLUMNS` | `GET /stock/giga-tables` — inventário de schema do Giga | BAIXA | PARCIAL — `giga_raw` já tem a cópia crua das tabelas |
| `src/stock/diagnose.controller.ts` | 40 | SQL-CRU | `erp.listTablesLike` | `GET /diagnose/giga-tables` — **endpoint sem JWT**, só com `secret` | BAIXA | PARCIAL — `giga_raw` |
| `src/stock/diagnose.controller.ts` | 53 | SQL-CRU | `erp.listTablesLike('credi')` | diagnóstico de crediário (1/4) | BAIXA | PARCIAL — `giga_raw` |
| `src/stock/diagnose.controller.ts` | 54 | SQL-CRU | `erp.listTablesLike('parcel')` | diagnóstico de crediário (2/4) | BAIXA | PARCIAL — `giga_raw` |
| `src/stock/diagnose.controller.ts` | 55 | SQL-CRU | `erp.listTablesLike('cobr')` | diagnóstico de crediário (3/4) | BAIXA | PARCIAL — `giga_raw` |
| `src/stock/diagnose.controller.ts` | 56 | SQL-CRU | `erp.listTablesLike('receb')` | diagnóstico de crediário (4/4) | BAIXA | PARCIAL — `giga_raw` |

### `src/stock-mirror/` — 1 dependência

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/stock-mirror/stock-mirror.service.ts` | 65 | LEITURA | `erp.getEstoqueFullByLoja` → `estoque` (full por loja) | `fullSyncFromGiga` — puxa o estoque inteiro do Giga pra tabela nativa `stock` (botão `POST /admin/stock-mirror/sync`, tela `/retaguarda/estoque`) | **OBSOLETA** | N/A — a tabela `stock` **não é lida por nenhum outro módulo** (só o próprio `stock-mirror`), o `decrement()` da linha 215 nunca é chamado, e esse sync **não checa `ESTOQUE_SYNC_GIGA`** (a flag que desligou o full Giga→Flow em 14/07) |

### `src/stock-conferidor/` — 4 dependências

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/stock-conferidor/stock-conferidor.service.ts` | 109 | LEITURA | `erp.getEstoqueGigaCompleto` → `estoque` (tudo, incl. zero/negativo) | lado Giga da conferência Flow×Giga; se voltar vazio, aborta a tela | MEDIA | NAO — por definição precisa do Giga ao vivo (é o objeto da conferência) |
| `src/stock-conferidor/stock-conferidor.service.ts` | 261 | LEITURA→ESCRITA no Flow | `erp.getEstoqueGigaCompleto` | `puxarDoGiga`: relê o Giga e **grava o valor em `wincred_estoque` + `giga_estoque` + `StockMovement`** (1 SKU/loja, manual, auditado) | ALTA | NAO — é a correção manual; o risco é sobrescrever a fonte (Flow) com o Giga |
| `src/stock-conferidor/stock-conferidor.service.ts` | 329 | LEITURA→ESCRITA no Flow | `erp.getEstoqueGigaCompleto` | `importarNegativos`: traz **em lote** todo estoque negativo do Giga pros espelhos do Flow | **CRITICA** | NAO — escrita em massa no estoque do Flow a partir de leitura do Giga |
| `src/stock-conferidor/stock-conferidor.service.ts` | 440 | SQL-CRU | `erp.runReadOnly(SELECT ... FROM caixa WHERE CAST(CODIGO AS UNSIGNED)=? AND LOJA=?)` (maxRows 20, 20s) | últimas 20 vendas do SKU no Giga, como contexto do histórico da tela | MEDIA | PARCIAL — `giga_caixa_mov` tem o dado (atenção: `caixa.NUMERO` é FLOAT, histórico achatado no espelho) |

### `src/pick-orders/` — 11 dependências

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/pick-orders/pick-orders.controller.ts` | 35 | LEITURA (env) | `erp.isWriteEnabled` (`ERP_WRITE_ENABLED`) | expõe pra UI se a baixa real está ligada ou em shadow | BAIXA | N/A — leitura de env, não toca o Giga |
| `src/pick-orders/pick-orders.service.ts` | 974 | LEITURA | `erp.getEansBySkus` → `produtos` (EAN13/EAN/CODBARRAS…) | EANs dos itens pra separadora bipar a peça certa | ALTA | SIM — `wincred_codigos` via `GIGA_MIRROR_READS` (+ atalho local pro EAN prefixo 8 do Flow) |
| `src/pick-orders/pick-orders.service.ts` | 1034 | LEITURA | `erp.findSkuByAnyEan` → `produtos` | resolve o EAN bipado pro SKU do pedido | ALTA | SIM — mesmo espelho |
| `src/pick-orders/pick-orders.service.ts` | 1042 | SQL-CRU | `erp.debugProductEans` → `SHOW COLUMNS` + `produtos` | dump de EANs do SKU quando o bipe não casa (debug na UI) | BAIXA | PARCIAL — `giga_raw.produtos` |
| `src/pick-orders/pick-orders.service.ts` | 1159 | LEITURA (env) | `erp.isWriteEnabled` | gate shadow/real do `runAutoDebit` | BAIXA | N/A |
| `src/pick-orders/pick-orders.service.ts` | **1185** | **ESCRITA** | `erp.decreaseStockAsync` → `estoque` (+ Flow) | **baixa automática** do estoque da loja ao aprovar o débito | **CRITICA** | SIM — Flow fonte + outbox (`ERP_STOCK_WRITES_ASYNC=0` volta ao inline) |
| `src/pick-orders/pick-orders.service.ts` | 1631 | LEITURA (env) | `erp.isWriteEnabled` | gate shadow/real da aprovação manual | BAIXA | N/A |
| `src/pick-orders/pick-orders.service.ts` | **1642** | **ESCRITA** | `erp.decreaseStockAsync` | baixa na **aprovação manual** do débito pela retaguarda | **CRITICA** | SIM — Flow fonte + outbox |
| `src/pick-orders/pick-orders.service.ts` | 1762 | LEITURA (env) | `erp.isWriteEnabled` | rotula o log agregado da aprovação em lote | BAIXA | N/A |
| `src/pick-orders/pick-orders.service.ts` | 2899 | LEITURA (env) | `erp.isWriteEnabled` | gate shadow/real do `autoDebit` disparado pelo `shipped` | BAIXA | N/A |
| `src/pick-orders/pick-orders.service.ts` | **2943** | **ESCRITA** | `erp.decreaseStockAsync` | baixa disparada pela confirmação de envio (inclusive pelo cron dos Correios) | **CRITICA** | SIM — Flow fonte + outbox |

### `src/routing/` — 2 dependências

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/routing/routing.service.ts` | **676** | **ESCRITA** | `erp.increaseStockAsync` → `estoque` (+ Flow) | **estorna o estoque da loja antiga** ao trocar o pedido de loja depois de já ter saído (`shipped`/`delivered`) | **CRITICA** | SIM — Flow fonte + outbox |
| `src/routing/sales-stats.service.ts` | 56 | LEITURA | `erp.getSalesByStoreLastDays` → `caixa` | vendas por loja nos últimos 30d (cache 1h) → meta de cessão do roteamento | MEDIA | SIM — já cai em `giga_caixa_mov` (`caixaMovUsable` → `salesByStoreLastDaysFromMirror`) |

### `src/trocas/` — 1 dependência

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/trocas/trocas.service.ts` | **1214** | **ESCRITA** | `erp.increaseStockAsync` → `estoque` (+ Flow) | **entrada da peça devolvida** no estoque da loja receptora ao aprovar a conferência da troca (grava `stockReturnedAt`/`stockError` por item) | **CRITICA** | SIM — Flow fonte + outbox |

### `src/wc-returns/` — 1 dependência

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/wc-returns/wc-returns.service.ts` | **321** | **ESCRITA** | `erp.increaseStockAsync` → `estoque` (+ Flow) | **estorno de estoque** da devolução do e-commerce na loja receptora | **CRITICA** | SIM — Flow fonte + outbox |

---

## Notas de leitura

**Sobre "ESCRITA".** As 10 escritas acima chamam `decreaseStock`/`increaseStock`/`*Async`, que desde a constituição de 14/07 aplicam o delta nos espelhos do Flow (`giga_estoque` + `wincred_estoque`, via `ErpService.mirrorStockApplyDelta`, `erp.service.ts:235`) e só depois replicam pro Giga — inline nas versões síncronas (com fila no outbox se o Giga falhar) ou direto pro outbox nas `*Async`. **Nenhuma delas é "só Giga".** O que ainda amarra: as versões síncronas (`decreaseStock`/`increaseStock`, usadas só no realinhamento) esperam o Giga responder antes de retornar; as `*Async` não.

**Sobre `Stock` (nativa) vs espelhos.** O `Stock` do schema tem `syncedAt` e é escrito **exclusivamente** pelo `StockMirrorService`. A verdade operacional do estoque (PDV, bipe, live, site, conferidor) mora em `wincred_estoque`/`giga_estoque`. Ou seja: a divergência por `syncedAt` não afeta o desempate de estoque de hoje — o `stock-mirror` está desconectado do fluxo.

**Sobre o modo sombra.** ⚠️ **Corrigido em 09/2026.** O texto original dizia que `resolveSkuInfo`, `getProductPricesBySkus` e `getStockByRefCorTamInStore` "não têm hook no `ErpService`" e eram código morto — **falso hoje**: os cinco métodos do `SombraService` têm hook e são o caminho que RESPONDE. Também não existe mais modo comparação: `GIGA_SOMBRA` e o placar foram removidos. Sobrou só `GIGA_LEITURA_FLOW=1`, **obrigatória em produção** — e ela não tem recuo nenhum, porque o caminho legado devolve vazio SEM erro (não há banco atrás).

**Sobre `getPdvProductInfo` em `shipment.service.ts:271`.** Os outros 10 call-sites do sistema (PDV, live-pdv, marcados, nfe-transfer, pick-orders) chamam `catalog.getPdvProductInfo` (espelho primeiro, Giga só no miss). O realinhamento chama `erp.getPdvProductInfo` direto. Trocar por `catalog.` é uma linha e tira a triagem do caminho crítico do Giga — mas muda o comportamento em produto recém-cadastrado (latência do espelho), então precisa do mesmo cuidado do checklist "3 causas de sumiu".

**Sobre o pool paralelo.** `RealignmentPricingService` (`realignment-pricing.service.ts:35`) abre um **segundo pool MySQL** pro Giga, fora do `ErpService`: 2 conexões, `queueLimit: 0`, `connectTimeout: 12s`, sem circuit-breaker. Ele atende 8 call-sites (6 no relatório, 2 no fechamento de remessa) e mais 2 fora do escopo deste mapa (`financeiro.service.ts:142-143`, e o import em `live-pdv.service.ts:54`). O comentário em `shipment.service.ts:268` registra que foi justamente esse pool que pendurou a transferência durante a reconstrução das tabelas do Giga. Todo o dado que ele busca (`VENDAUN`) já está em `wincred_produtos.vendaUn`.
