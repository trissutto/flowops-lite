# MAPA de dependências do GIGA — RELATÓRIOS + FINANCEIRO

> **REGISTRO HISTORICO (censo de 31/07/2026) — nao descreve o codigo de hoje.** As dependencias listadas foram migradas pro Postgres ou removidas; o ERP foi DESLIGADO em 27/08/2026. Estado atual: `CLAUDE.md` na raiz.

Levantamento puro (nada foi alterado). Escopo: `backend/src/intelligence/`,
`backend/src/faturamento/`, `backend/src/financeiro/`, `backend/src/dre/`,
`backend/src/contas-pagar/`, `backend/src/commissions/` (a pasta se chama
`commissions/`, não `comissoes/`), `backend/src/sellers/`.

Data do levantamento: 31/07/2026 · branch `fix/faturamento-ano-anterior-espelho`.

---

## Resumo (5 linhas)

1. **67 pontos de contato com o Giga** neste domínio: 64 chamadas `this.erp.<método>`, 3 acessos ao pool MySQL cru (`(this.erp as any).pool`) em `contas-pagar/`.
2. **41 já desviam sozinhos pro espelho** com `GIGA_MIRROR_READS=1` (ligada em prod) — DRE, royalties, faturamento por loja/timeseries, top vendedoras, resumos de venda, grupos/subgrupos. **Não são pendência.**
3. **26 pendências REAIS** (23 distintas por método): 10 em `intelligence/`, 7 no `GigaMirrorService`, 3 em `contas-pagar/` (SQL cru no pool), 2 diagnósticos de `faturamento/`, 1 em `commissions/`, e 1 caso híbrido (`getSalesByStoresInRange` com `?year=` fura o espelho de propósito). Dessas, **5 são OBSOLETAS** (endpoint sem nenhum chamador em `frontend/src`, grep confirmado): `/faturamento/schema-caixa`, `/faturamento/diagnostico`, `/intelligence/sku-trace/:sku`, `/intelligence/rupturas` e `/intelligence/parados` (os dois últimos só como endpoint solo — o cálculo gêmeo dentro de `store/:code` é usado).
4. **As 3 mais críticas** — todas no `financeiro/giga-mirror.service.ts`, que é o **único cordão umbilical** que alimenta os 41 já migrados: `getCaixaMovRows` (:237 → `giga_caixa_mov`, base de faturamento/DRE/comissão), `getSalesGrossDailyByStore` (:401 → `giga_caixa_diario`, base dos royalties 8%+4% cobrados das filiais) e `getGigaTransfersDetailed`/`getGigaTransferItems` (:376/:419 → débito de mercadoria da conta corrente). Fora dele, a mais crítica é `commissions.service.ts:873` (SQL cru na `caixa`, número de comissão do RH, sem espelho e sem fallback).
5. **Risco escondido do "já migrado":** os 41 sites NÃO ficam corretos se o Giga cair — o espelho simplesmente **congela e responde dado velho, sem erro**. E o gate `caixaMovUsable()` (erp.service.ts:652) **volta pro Giga AO VIVO** sempre que o período pedido começa antes do início real do espelho (`GIGA_CAIXA_MOV_FROM`) — comparação "ano anterior" continua batendo no MySQL.

---

## Tabela

### `src/intelligence/` — telas `/retaguarda/inteligencia-estoque` e `/retaguarda/distribuicao-estoque` (admin-only)

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/intelligence/intelligence.service.ts` | 83 | LEITURA | `getStockTotalByStores` → `estoque` ⋈ `produtos` | peças em estoque por loja na visão geral (com filtro plusSize/ano de cadastro) | MEDIA | **SIM** — `wincred_estoque` ⋈ `wincred_produtos` (tem `plusSize` e `dataAlt`); método ainda não tem branch de espelho |
| `src/intelligence/intelligence.service.ts` | 84 | LEITURA | `getSalesByStoresInRange` → `caixa` | vendas por loja no período da visão geral | **PARCIAL — JÁ MIGRADO só sem `year`** | Espelho `giga_caixa_mov` cobre; `erp.service.ts:5696` pula o espelho de propósito quando `?year=` é passado (`GET /intelligence/overview?year=`) → **vai pro Giga vivo** |
| `src/intelligence/intelligence.service.ts` | 161 | LEITURA | `getStockByYearByStore` → `estoque` ⋈ `produtos` (DATAALT) | matriz LOJA × ANO de cadastro pro relatório PDF de estoque | MEDIA | **SIM** — `wincred_produtos.dataAlt` + `wincred_estoque` |
| `src/intelligence/intelligence.service.ts` | 229 | LEITURA | `getStockRawBySku` → `estoque` | estoque cru por SKU (sem filtro `ESTOQUE>0`) pro diagnóstico "tem estoque mas dá ruptura" | BAIXA | **SIM** — `giga_estoque` / `wincred_estoque` (o valor de diagnóstico é justamente ver o dado do Giga, então migrar muda o sentido da tela) |
| `src/intelligence/intelligence.service.ts` | 365 | LEITURA | `traceSkuStock` → `produtos` + `estoque` | trace passo-a-passo da resolução de SKU (padding de zeros) pra debugar | **OBSOLETA** — `GET /intelligence/sku-trace/:sku` não tem chamador em `frontend/src` (grep confirmado) | **PARCIAL** — `getStockFromMirror` (erp.service.ts:100) já replica a mesma lógica anti-colisão no espelho; falta a versão "trace" |
| `src/intelligence/intelligence.service.ts` | 453 | LEITURA | `getTopRefsBySales` | top REFs vendidas | **JÁ MIGRADO (flag ativa)** | espelho `giga_caixa_mov` (erp.service.ts:5773) |
| `src/intelligence/intelligence.service.ts` | 471 | LEITURA | `getRupturas` → `caixa` ⋈ `produtos` ⋈ `estoque` | REFs que venderam e zeraram o estoque | **OBSOLETA** — o endpoint solo `GET /intelligence/rupturas` não tem chamador no front (a tela usa o mesmo cálculo via `store/:code`, linha 546) | **SIM** — `giga_caixa_mov` + `wincred_produtos`/`wincred_estoque`; sem branch de espelho hoje |
| `src/intelligence/intelligence.service.ts` | 487 | LEITURA | `getParados` → `estoque` ⋈ `produtos` + subquery `caixa` | REFs com estoque alto e sem venda há N dias (candidatas a realinhamento) | **OBSOLETA** — idem, `GET /intelligence/parados` sem chamador no front (usado via `store/:code`, linha 549) | **SIM** — mesmas tabelas espelhadas; sem branch hoje |
| `src/intelligence/intelligence.service.ts` | 537 | LEITURA | `getStockTotalByStores` | idem 83, agora dentro do dashboard da loja (`GET /intelligence/store/:code`) | MEDIA | **SIM** — igual à linha 83 |
| `src/intelligence/intelligence.service.ts` | 538, 539 | LEITURA | `getSalesByStoresInRange` | vendas do período e do período anterior (sem `year`) | **JÁ MIGRADO (flag ativa)** | `giga_caixa_mov` |
| `src/intelligence/intelligence.service.ts` | 540, 543 | LEITURA | `getTopRefsBySales` | top REFs por peças e por valor | **JÁ MIGRADO (flag ativa)** | `giga_caixa_mov` |
| `src/intelligence/intelligence.service.ts` | 546 | LEITURA | `getRupturas` | rupturas dentro do dashboard da loja | MEDIA | **SIM** — igual à linha 471 |
| `src/intelligence/intelligence.service.ts` | 549 | LEITURA | `getParados` | parados dentro do dashboard da loja | MEDIA | **SIM** — igual à linha 487 |
| `src/intelligence/intelligence.service.ts` | 553 | LEITURA | `getSalesByDay` | série diária de vendas | **JÁ MIGRADO (flag ativa)** | `giga_caixa_mov` (erp.service.ts:5959) |
| `src/intelligence/intelligence.service.ts` | 557 | LEITURA | `getTopMarcas` | top marcas do período | **JÁ MIGRADO (flag ativa)** | `giga_caixa_mov` (erp.service.ts:6261) |
| `src/intelligence/intelligence.service.ts` | 558 | LEITURA | `getSalesSummary` | resumo (peças/valor/cupons/ticket) | **JÁ MIGRADO (flag ativa)** | `giga_caixa_mov` (erp.service.ts:5906) |
| `src/intelligence/intelligence.service.ts` | 627 | LEITURA | `getHeatmap` → `estoque` ⋈ `produtos` (2 queries) | matriz REF × LOJA de estoque pro realinhamento manual | MEDIA | **SIM** — `wincred_estoque` ⋈ `wincred_produtos` |
| `src/intelligence/intelligence.service.ts` | 671, 672, 675, 676, 716, 717 | LEITURA | `getSalesSummary`, `getSalesByDay`, `getTopMarcas`, `getTopRefsBySales` | relatório de vendas (`GET /intelligence/sales-report`), período atual + anterior | **JÁ MIGRADO (flag ativa)** | `giga_caixa_mov` |
| `src/intelligence/intelligence.service.ts` | 673 | LEITURA | `getSalesByStoresInRange` (sem `year`) | vendas por loja no relatório | **JÁ MIGRADO (flag ativa)** | `giga_caixa_mov` |
| `src/intelligence/intelligence.service.ts` | 813–828 | LEITURA | `getSalesSummary` ×2, `getSalesByStoresInRange` ×2, `getTopMarcas`, `getTopRefsBySales`, `getSalesByMonth`, `getUniqueClientesCount` ×2, `getMonthSalesByYear` ×5 | dashboard estratégico (`GET /intelligence/strategic-dashboard`) com YoY e 5 anos de histórico | **JÁ MIGRADO (flag ativa)** — ⚠️ ver nota 2 | `giga_caixa_mov`; **os anos antigos (y-4, y-3, y-2) caem pro Giga vivo** pelo gate de cobertura `caixaMovUsable` |
| `src/intelligence/intelligence.controller.ts` | 203 | LEITURA | `getStockDistribution` → `produtos` ⋈ `estoque` | grade de distribuição de estoque por loja (1 linha por CÓDIGO) | MEDIA | **SIM, já pronto** — `WincredMirrorService.getStockDistribution` (`wincred-mirror.service.ts:952`); só é usado com `?source=mirror` ou `USE_LOCAL_CATALOG=1` (hoje default = Giga) |
| `src/intelligence/intelligence.controller.ts` | 230 | LEITURA | `getStockDistributionByRef` → `produtos` + `estoque` (2 queries) | visão RAIZ por REF+COR com DATAALT/grupo/subgrupo, base do classificador | MEDIA | **PARCIAL** — dados existem em `wincred_produtos`+`wincred_estoque`; não há versão espelho desse método |
| `src/intelligence/intelligence.controller.ts` | 257 | LEITURA | `getSalesByRef` → `caixa` ⋈ `produtos` (180d) | vendas históricas por REF por loja — escolhe a loja consolidadora no realinhamento | MEDIA | **SIM** — `giga_caixa_mov` ⋈ `wincred_produtos` (ambos já espelhados); sem branch hoje |
| `src/intelligence/intelligence.controller.ts` | 267 | LEITURA | `listarGrupos` | filtro de categoria | **JÁ MIGRADO (flag ativa)** | `wincred_grupos` (erp.service.ts:7786) |
| `src/intelligence/intelligence.controller.ts` | 278 | LEITURA | `listarSubgrupos` | cascata do filtro | **JÁ MIGRADO (flag ativa)** | `wincred_subgrupos` (erp.service.ts:7824) |

### `src/faturamento/` — tela `/retaguarda/faturamento`

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/faturamento/faturamento.service.ts` | 142 | LEITURA | `getFaturamentoPorLoja` → `caixa` | faturamento por loja da tela principal | **JÁ MIGRADO (flag ativa)** | `giga_caixa_mov` (erp.service.ts:9972) |
| `src/faturamento/faturamento.service.ts` | 455 | LEITURA | `getVendasCaixa` → `caixa` | lista de vendas detalhadas de loja que ainda usa PDV Wincred legado | **JÁ MIGRADO (flag ativa)** | `giga_caixa_mov` (erp.service.ts:10287) |
| `src/faturamento/faturamento.service.ts` | 550, 551 | LEITURA | `getFaturamentoPorLoja` (ano anterior + meta do mês) | comparação YoY e meta | **JÁ MIGRADO (flag ativa)** — ⚠️ ver nota 2 | `giga_caixa_mov`; o ano anterior só fica no espelho se `GIGA_CAIXA_MOV_FROM` cobrir (foi exatamente o incidente de 31/07) |
| `src/faturamento/faturamento.service.ts` | 552, 553 | LEITURA | `getFaturamentoTimeseries` → `caixa` | série do gráfico (atual + ano anterior) | **JÁ MIGRADO (flag ativa)** — ⚠️ ver nota 2 | `giga_caixa_diario` via `mirrorCaixaCovers` (erp.service.ts:10482) |
| `src/faturamento/faturamento.controller.ts` | 141 | LEITURA / SQL-CRU | `getCaixaSchemaDiagnostic` → `SHOW COLUMNS FROM caixa` + `SUM()` por coluna + amostra | diagnóstico admin: descobre qual coluna da `caixa` bate com o "TOTAL VENDAS" do Wincred | **OBSOLETA** — `GET /faturamento/schema-caixa` não tem chamador em `frontend/src` (grep confirmado); só por curl | **SIM** — `giga_raw.caixa` (cópia crua com todas as colunas); o espelho curado `giga_caixa_mov` NÃO serve (não tem `VALORBRUTO`/`DESCONTO`) |
| `src/faturamento/faturamento.controller.ts` | 172 | LEITURA / SQL-CRU | `diagnosticoFaturamento` → `caixa` (contagens por estado de `MARCADO`, linhas negativas, 3 somas) | diagnóstico admin de divergência com o Wincred; o próprio código diz "uso temporário" | **OBSOLETA** — `GET /faturamento/diagnostico` não tem chamador em `frontend/src` (grep confirmado) | **SIM** — `giga_raw.caixa`; candidato a remoção |

### `src/financeiro/` — conta corrente, royalties e o **espelho** (`GigaMirrorService`)

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/financeiro/financeiro.service.ts` | 297 | LEITURA | `getSalesGrossByStores` → `caixa` | venda bruta por filial pra calcular royalties 8% + marketing 4% | **JÁ MIGRADO (flag ativa)** | `giga_caixa_diario` (erp.service.ts:3668, com gate de cobertura) |
| `src/financeiro/giga-mirror.service.ts` | 237 | LEITURA | `getCaixaMovRows` → `caixa` (item a item) | **alimenta `giga_caixa_mov`** — o espelho de onde saem faturamento, DRE, comissões, top vendedoras e clientes únicos | **CRITICA** | **NÃO** — é a própria ponte. `giga_raw.caixa` é arquivo histórico, não substitui o incremental. Última coisa a desligar |
| `src/financeiro/giga-mirror.service.ts` | 401 | LEITURA | `getSalesGrossDailyByStore` → `caixa` | **alimenta `giga_caixa_diario`** — base dos royalties cobrados das filiais e do crédito da conta corrente | **CRITICA** | **NÃO** — é a própria ponte |
| `src/financeiro/giga-mirror.service.ts` | 376 | LEITURA | `getGigaTransfersDetailed` → `transferencias` | **alimenta `giga_transferencia`** — débito de mercadoria cobrado de cada filial na conta corrente | **CRITICA** | **NÃO** — é a própria ponte; nenhuma transferência do Giga nasce no Flow ainda |
| `src/financeiro/giga-mirror.service.ts` | 419 | LEITURA | `getGigaTransferItems` → itens de `transferencias` | **alimenta `giga_transferencia_item`** — detalhe (peça a peça) do débito acima | ALTA | **NÃO** — é a própria ponte |
| `src/financeiro/giga-mirror.service.ts` | 351 | LEITURA | `getFuncionariosRawAll` → `funcionarios` | **alimenta `wincred_funcionarios`** — resolve nome da vendedora no ranking do Giga | MEDIA | **NÃO** (é a ponte). Nota: quando o cadastro de funcionária for 100% Flow (`Seller`), este sync some |
| `src/financeiro/giga-mirror.service.ts` | 453 | LEITURA | `getGigaProdutos` → `produtos` | **alimenta `giga_produto`** (catálogo enxuto usado por live/routing/conta corrente) | MEDIA | **REDUNDANTE** — `wincred_produtos` (sync do `wincred-mirror/`) já tem tudo isso e mais; candidato a consolidação de espelhos |
| `src/financeiro/giga-mirror.service.ts` | 486 | LEITURA | `getGigaEstoque` → `estoque` | **alimenta `giga_estoque`** (fallback de estoque da live) | MEDIA | **REDUNDANTE** — `wincred_estoque` cobre o mesmo grão (codigo × loja) |
| `src/financeiro/conta-corrente.service.ts` | — | — | *(nenhuma)* | importa `ErpService` mas **não faz nenhuma chamada**; lê 100% do Postgres (`gigaTransferencia`, `gigaTransferenciaItem`, `gigaCaixaDiario`, `gigaProduto`) | **OBSOLETA** | injeção morta — o `import`/`private readonly erp: ErpService` (linhas 11 e 68) pode sair |

### `src/dre/` — painel DRE por loja

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/dre/dre.service.ts` | 604 | LEITURA | `getFaturamentoPorLoja` → `caixa` | linha de FATURAMENTO do DRE (por loja, competência) | **JÁ MIGRADO (flag ativa)** — mas **CRITICA por natureza** (número que vai pro contador) | `giga_caixa_mov`; o DRE herda o gate de cobertura — período anterior ao início do espelho vai pro Giga vivo |

### `src/contas-pagar/` — SQL cru direto no pool MySQL (não passa por método do `ErpService`)

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/contas-pagar/contas-pagar-migracao.service.ts` | 91 (queries em 94 e 103) | SQL-CRU | `(this.erp as any).pool` → `SELECT COUNT(*) FROM pagar` + `SELECT * FROM pagar ORDER BY REGISTRO LIMIT/OFFSET` | espelha a `pagar` inteira do Giga em `giga_pagar` (TRUNCATE + createMany), passo 1 da migração one-shot | BAIXA (job admin, one-shot — GIGA congelado desde 11/07) | **SIM** — `giga_pagar` já está populada; `giga_raw.pagar` guarda a cópia crua completa. Botão pode ser aposentado |
| `src/contas-pagar/contas-pagar-migracao.service.ts` | 187 (query em 189) | SQL-CRU | `(this.erp as any).pool` → `SELECT CODIGO, RAZAOSOCIAL FROM fornecedores` | fallback de nome de fornecedor — só executa se `wincred_fornecedores` estiver VAZIA | BAIXA | **SIM** — `wincred_fornecedores` é o caminho primário (linha 182); este ramo é rede de segurança |
| `src/contas-pagar/contas-pagar-associacao.service.ts` | 55 (query em 57) | SQL-CRU | `(this.erp as any).pool` → `SELECT CODIGO, NOME, CPF, CARGO, LOJA FROM funcionarios` | `POST /contas-pagar/associacao/importar-giga`: importa funcionárias ativas do Giga pra `Seller` (cria inativa) | BAIXA (botão admin raro) | **PARCIAL** — `wincred_funcionarios` **não tem CPF nem CARGO**; `giga_raw.funcionarios` tem tudo → migrar pra lá |

### `src/commissions/` — motor de comissão (a pasta `comissoes/` não existe)

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/commissions/commissions.service.ts` | 873 | SQL-CRU (`runReadOnly`) | `SELECT VENDEDOR, COUNT(*), SUM(VALORTOTAL) FROM caixa WHERE LOJA=… AND DATAFEC BETWEEN … AND MARCADO<>'SIM' GROUP BY VENDEDOR` | conferência RH "Flow × Wincred" vendedora a vendedora, pra explicar a diferença de comissão | ALTA (número de dinheiro do RH; é o **único** ponto do domínio comissão que ainda bate no Giga vivo) | **SIM** — `giga_caixa_mov` tem `vendedora`/`vendedora_code`/`data_fec`/`marcado`/`valor_total`, exatamente as colunas usadas. ⚠️ o SQL monta `LOJA`/datas por **interpolação de string** (sanitizados por regex antes, mas é concatenação) |

### `src/sellers/`

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| `src/sellers/sellers.service.ts` | 660 | LEITURA | `getTopVendedoras` → `caixa` | ranking de vendedoras do Giga ao lado do ranking do Flow | **JÁ MIGRADO (flag ativa)** | `giga_caixa_mov` (erp.service.ts:6010) |

---

## Notas importantes (armadilhas confirmadas no código)

**Nota 1 — "já migrado" ≠ "independente do Giga".**
Os 41 sites acima leem `giga_caixa_mov` / `giga_caixa_diario` / `wincred_*`, que são
alimentados **exclusivamente** pelo `GigaMirrorService` (cron horário) e pelo
`wincred-mirror/`. Se o Giga pendurar, nada quebra e nada avisa: as telas
respondem com o último dado sincronizado. O sync preserva o espelho de propósito
em caso de falha (`giga-mirror.service.ts:352` — "Giga vazio/fora → preserva o
espelho"), o que é certo pra disponibilidade e perigoso pra confiança no número.

**Nota 2 — gate de cobertura devolve a consulta pro Giga vivo.**
`caixaMovUsable()` (`erp.service.ts:652`) só usa o espelho quando
`inicio >= min(data)` do `giga_caixa_mov` — calculado com `ORDER BY data ASC OFFSET 100`
pra pular lixo do incidente DATAALT (`erp.service.ts:638-644`). Consulta que começa
antes disso (YoY do faturamento, DRE de exercício anterior, `getMonthSalesByYear`
de y-4/y-3/y-2 no dashboard estratégico) **vai pro MySQL ao vivo**. Mesmo padrão
em `mirrorCaixaCovers()` (`erp.service.ts:86`) pro `giga_caixa_diario`.

**Nota 3 — `?year=` fura o espelho de propósito, e o botão existe na tela.**
`getSalesByStoresInRange` (`erp.service.ts:5696`) pula o espelho quando o filtro
`year` (ano de cadastro da peça) é informado, porque o espelho não implementa esse
JOIN. Não é teórico: `/retaguarda/inteligencia-estoque` tem os botões de ano
(`frontend/src/app/retaguarda/inteligencia-estoque/page.tsx:490`) que setam
`params.set('year', …)` na linha 205 → `GET /intelligence/overview?year=2024`
bate direto no Giga ao vivo.

**Nota 4 — os 3 acessos de `contas-pagar/` usam `(this.erp as any).pool`.**
Não passam por nenhum método do `ErpService`, então não aparecem em busca por
`this.erp.get*` e **não têm** timeout/`maxRows`/circuit-breaker do `runReadOnly`.
Rodam com `timeout: 60_000`/`120_000` do driver, em job de background.

**Nota 5 — espelhos redundantes.**
`giga_produto`/`giga_estoque` (sync do `GigaMirrorService`) cobrem o mesmo terreno
de `wincred_produtos`/`wincred_estoque` (sync do `wincred-mirror/`), com menos
colunas. Duas idas ao Giga pro mesmo dado — consolidar corta 2 das 7 dependências
do `GigaMirrorService`.

---

## Ordem sugerida de ataque (do mais barato pro mais caro)

1. **Grátis** — ligar `USE_LOCAL_CATALOG=1`: mata `getStockDistribution` (o substituto já existe e está testado).
2. **Barato** — deletar os 5 endpoints OBSOLETOS (nenhum chamador no front): `/faturamento/schema-caixa`, `/faturamento/diagnostico`, `/intelligence/sku-trace/:sku`, `/intelligence/rupturas`, `/intelligence/parados`; remover a injeção morta de `ErpService` em `conta-corrente.service.ts`; apontar `importarFuncionariasGiga` pro `giga_raw.funcionarios`; aposentar o botão de espelho da `pagar`.
3. **Médio** — portar `commissions.service.ts:873` pro `giga_caixa_mov` (colunas já existem, some o último Giga vivo do domínio comissão) e dar branch de espelho aos 6 métodos de estoque do `intelligence/` (`getStockTotalByStores`, `getStockByYearByStore`, `getRupturas`, `getParados`, `getHeatmap`, `getStockDistributionByRef`, `getSalesByRef`) sobre `wincred_produtos`/`wincred_estoque`/`giga_caixa_mov`.
4. **Caro** — esticar `GIGA_CAIXA_MOV_FROM` até cobrir todo o histórico consultável, pra que o gate da Nota 2 nunca mais volte pro Giga; e só então atacar o `GigaMirrorService`, que exige que transferências e caixa nasçam no Flow (outbox) em vez de serem copiadas do Giga.
