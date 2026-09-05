# Inventário — telas que tocam o Giga

> **REGISTRO HISTORICO (31/07/2026) — inventario ENCERRADO, nao ha o que decidir aqui.** Todas as telas ja leem do Postgres; o ERP foi DESLIGADO em 27/08/2026. Estado atual: `CLAUDE.md` na raiz.

Levantado em 31/07/2026 a partir do código (não de suposição): todas as chamadas
`this.erp.*` do backend, agrupadas por módulo, cruzadas com os 20 espelhos que
já existem no Postgres do Flow.

**Como usar:** passe pela coluna "decisão" marcando `MANTÉM` (a tela serve, só
troca a fonte de dado), `REFAZ` (o processo mudou, vale redesenhar) ou
`APOSENTA` (ninguém usa mais). O veredito técnico já está preenchido — você só
responde a parte de negócio.

---

## A descoberta principal

**O dado praticamente todo já está no Flow. O que não foi feito é reescrever a
consulta.**

Existem 20 espelhos no Postgres: `wincred_produtos`, `wincred_estoque`,
`wincred_codigos` (EANs), `wincred_grupos`, `wincred_subgrupos`,
`wincred_fornecedores`, `wincred_funcionarios`, `wincred_clientes`,
`wincred_movimento_aberto` (crediário), `giga_produto`, `giga_estoque`,
`giga_caixa_mov` (venda linha a linha), `giga_caixa_diario`,
`giga_transferencia`, `giga_transferencia_item`, `giga_clientes`,
`giga_cliente_seq`, `giga_pagar` (contas a pagar), mais os dois de controle.

Isso muda a natureza do trabalho. Não é "precisamos das tabelas" — é
"precisamos reescrever a query e decidir quem é dono do estoque".

---

## Os quatro grupos

### Grupo A — já lê do espelho (nada a fazer)

Estes métodos já desviam sozinhos pro Postgres quando `GIGA_MIRROR_READS=1`,
com recuo pro Giga em caso de erro:

`getStock` · `getStockBySkuAndStores` · `getStockBySkusDetailed` ·
`getStockTotalBySkus` · `getFaturamentoPorLoja` · `getFaturamentoTimeseries` ·
`getSalesByDay` · `getSalesByMonth` · `getSalesByStoresInRange` ·
`getSalesByStoreLastDays` · `getSalesGrossByStores` · `getSalesSummary` ·
`getMonthSalesByYear` · `getTopMarcas` · `getTopRefsBySales` ·
`getTopVendedoras` · `getUniqueClientesCount` · `getVendasCaixa` ·
`getFuncionariosAtivosByLoja` · `getFuncionariosRawAll` · `findSkuByAnyEan` ·
`getEansBySkus` · `listarGrupos` · `listarSubgrupos` · `listarFornecedores` ·
`listarCoresDistintas` · `listarTamanhosDistintos` ·
`lookupSaleHistoryByStoreAndSku`

### Grupo B — o dado está no espelho, a query não foi reescrita

**É o grupo grande, e é onde recriar telas melhores compensa.** Sem risco de
dado faltando: é trabalho de reescrever SQL contra o Postgres.

### Grupo C — escrita, depende de decisão sua

`decreaseStock` · `increaseStock` · `decreaseStockAsync` · `increaseStockAsync` ·
`applyStockDeltaGigaOnly` · `gravarVendaPdv` · `insertCaixaMarcado` ·
`deleteCaixaMarcadoRow` · `createCrediarioParcelas` · `markCrediarioParcelaPaid` ·
`markCrediarioParcelaUnpaid` · `inserirProdutosBatch` · `inserirGrupo` ·
`inserirSubgrupo` · `updateProdutosCampos` · `deleteProdutos` ·
`upsertClienteGiga` · `atualizarBandeiraFechamento`

Escrita não tem espelho — tem **dono**. Enquanto o PDV das lojas gravar a venda
no Giga, o estoque real mora lá, e nenhuma tela de estoque sai de verdade.

### Grupo D — falta espelho novo

Só o **histórico completo do crediário**: existe `wincred_movimento_aberto`
(parcelas em aberto), não o movimento fechado. As telas de crediário que usam
`runReadOnly` com SQL cru dependem disso.

---

## Tela por tela

Mapeamento tela↔módulo é inferido do código — **corrija onde eu errei**, isso
faz parte da triagem.

| Tela | Módulo | Grupo | O que ainda vai ao Giga | Decisão |
|---|---|---|---|---|
| `minha-loja/realinhamento` | realignment | B + C | resolver REF+cor+tam → código (12 chamadas), busca por descrição, preço, sobra; **escrita de estoque** | |
| `retaguarda/realinhamento` | realignment | B + C | idem | |
| `retaguarda/remessas` | realignment | B + C | idem + baixa/entrada na confirmação | |
| `minha-loja/transferencia` | realignment | B + C | idem | |
| `minha-loja/recebimento` | realignment | C | entrada de estoque | |
| `minha-loja/consultar` | stock | B | `getProduct`, `getStockRawBySku` | |
| `retaguarda/estoque` | stock | A + B | leitura já espelhada; `getStockRawBySku` não | |
| `retaguarda/inteligencia-estoque` | intelligence | B | `getHeatmap`, `getParados`, `getRupturas`, `getStockDistribution`, `traceSkuStock` | |
| `retaguarda/inteligencia-vendas` | intelligence | A + B | maioria espelhada; `getSalesByRef` não | |
| `retaguarda/dashboard-estrategico` | intelligence | A | espelhado | |
| `retaguarda/distribuicao-estoque` | intelligence | B | `getStockDistributionByRef`, `getStockTotalByStores` | |
| `retaguarda/faturamento` | faturamento | A | espelhado (2024 entra com `GIGA_CAIXA_MOV_FROM`) | |
| `minha-loja/pdv` | pdv | C | **grava venda, baixa estoque, cria parcela do crediário** | |
| `retaguarda/marcados` | pdv | C | `insertCaixaMarcado`, `deleteCaixaMarcadoRow` | |
| `retaguarda/crediario` | crediarios | C + D | `runReadOnly` (movimento completo), baixa de parcela | |
| `retaguarda/crediario-juros` | crediarios | D | idem | |
| `retaguarda/editor-produtos` | products-editor | B + C | `caixaCodigoIndexed`, `getFirstSaleDatesChunk`; **escreve campos no Giga** | |
| `retaguarda/cadastro-produtos` | product-registration | C | **cria produto/grupo/subgrupo no Giga** (o código EAN já é do Flow) | |
| `retaguarda/publicar-site` | site-publish | B | `searchRefsForPublish`, `getGigaFacetsForPublish`, `getRefColorForQueue` | |
| `retaguarda/venda-certa` | products | B | `findVendaCertaMatches` | |
| `retaguarda/clientes` | clientes-giga | B + C | leitura tem `wincred_clientes`; **escreve cadastro no Giga** | |
| `retaguarda/trocas-site` | trocas | C | `increaseStockAsync` | |
| separação / `saidas-site` | pick-orders | A + C | EAN espelhado; **baixa de estoque** não | |
| roteamento de pedidos | routing | A + C | vendas espelhadas; entrada de estoque não | |
| `retaguarda/almoxarifado` | purchase-orders | A | espelhado | |
| `retaguarda/financeiro` | financeiro | — | é quem ALIMENTA os espelhos, não consome | |

---

## O caminho recomendado

**Pacote 1 — Grupo B puro, sem tocar em escrita.** Reescrever as consultas de
catálogo/estoque/venda contra o Postgres. Ganho imediato: as telas param de
pendurar quando o Giga cai, e ficam instantâneas. Risco baixo — se a query nova
errar, o dado errado aparece na tela, mas nada é gravado errado.

Aqui entra a oportunidade que você levantou: essas telas foram desenhadas em
volta das limitações do Giga (busca por código exato, `CAST(CODIGO AS UNSIGNED)`
em todo JOIN, REF reciclada agrupando errado). Reescrever a query é o momento
natural de redesenhar a tela — o custo marginal é pequeno.

**Pacote 2 — a decisão de propriedade do estoque.** Esta é sua, não minha:
quando o Flow passa a ser o dono do estoque e o Giga vira espelho (a inversão
que você já decidiu em 14/07, mas que ainda não valeu pro estoque)? Sem ela, o
Grupo C inteiro fica onde está.

**Pacote 3 — espelho do movimento do crediário.** Único dado que realmente
falta. Fica por último porque é a única coisa que depende de tabela nova.

---

## Latência dos espelhos (importa pra decidir)

| Espelho | Atualiza | Consequência de ler dele |
|---|---|---|
| `wincred_produtos` | 10 min (incremental por DATAALT) | produto novo pode não aparecer na hora |
| `wincred_estoque` | de hora em hora (minuto 23) | pode sugerir mover peça vendida há 40 min |
| `giga_caixa_mov` | 3 dias reprocessados a cada ciclo | venda de hoje aparece rápido |
| `wincred_movimento_aberto` | conforme o cron do crediário | — |

Para realinhamento, o estoque de hora em hora é o ponto sensível. A saída é
listar do espelho (rápido) e reconferir no Giga só na confirmação do
movimento — o operador vê a lista instantânea e a checagem cara acontece uma
vez, no clique que importa.
