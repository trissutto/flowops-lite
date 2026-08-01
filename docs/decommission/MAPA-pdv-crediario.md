# MAPA DE DEPENDÊNCIAS DO GIGA — domínio PDV + CREDIÁRIO

Escopo: `backend/src/pdv/`, `backend/src/crediarios/`, `backend/src/clientes-giga/` (+ crons desses módulos).
Levantamento em 31/07/2026, branch `fix/faturamento-ano-anterior-espelho`. Nenhum arquivo de `src/` foi alterado.
Base: 103 ocorrências de `this.erp` nos 3 módulos (98 tocam o Giga de fato; 5 são guards de env / helper puro).

## Resumo

1. **98 dependências reais do Giga** nos 3 módulos, em 15 arquivos — 63 no `pdv/`, 30 no `crediarios/`, 5 no `clientes-giga/`.
2. **33 são ESCRITA** no MySQL legado (INSERT/UPDATE/DELETE em `caixa`, `movimento`, `estoque`, `clientes`, `fechamento`, `produtos` + 2 DDL de índice).
3. **52 já têm substituto funcionando no Flow** (SIM), **24 têm substituto parcial** (PARCIAL — tabela existe mas o caminho ainda vai no Giga), **22 não têm nada** (NAO — inclui os 5 ETLs de espelho, que por definição precisam do Giga, e 8 de schema-discovery/DDL/diagnóstico).
4. **As 3 mais críticas**: `pdv.controller.ts:1825` (`createCrediarioParcelas` — INSERT das parcelas na venda a crediário, síncrono, SEM outbox e SEM tabela nativa); `crediario-baixa.service.ts:2278` (`markCrediarioParcelaPaid` — baixa de dinheiro recebido, inline porque `CREDIARIO_ERP_OUTBOX` é default OFF); `pdv.controller.ts:981-1131` (`customer-info` — até 9 `runReadOnly` em cascata na tabela `clientes`, 10s de timeout cada, no caminho da venda a crediário: Giga pendurado = PDV pendurado por ~90s).
5. Menção honrosa: `marcados.service.ts:208` (`insertCaixaMarcado`) é a única escrita que faz `throw` e **aborta a operação** se o Giga falhar — todas as outras degradam para fila/log.

### Convenções desta tabela

- **LEITURA/ESCRITA/SQL-CRU**: SQL-CRU = SQL montado à mão passado por `runReadOnly`/`readAllPages`/`pool.query` (não é um método tipado do `ErpService`).
- `decreaseStock`/`increaseStock`/`*Async` **já gravam no Flow E no Giga** (Flow é a fonte; Giga vai por `enqueueStockDelta` → outbox). Nunca são "só Giga".
- A tabela `Stock` do Flow tem `syncedAt` — é **espelho** sincronizado de hora em hora, não fonte independente. Isso limita o quanto "SIM" vale nas linhas de estoque.
- `caixa.NUMERO` é FLOAT no Giga: toda leitura precisa de `CAST(... AS UNSIGNED)`. Consta como risco onde aplicável.
- `giga_raw.*` (cópia crua das 37 tabelas, feita 31/07) é **snapshot único, não sincronizado** — serve de arquivo histórico, nunca de substituto operacional.

---

## src/pdv/

### erp-outbox.service.ts — cron 30s (`@Cron(EVERY_30_SECONDS)`, kill-switch `PDV_ERP_OUTBOX=0`)

Este é o worker que replica pro Giga o que já foi gravado no Flow. Todas as escritas aqui são **réplica com retry/backoff** — se o Giga cair, a fila espera, a operação não trava.

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/pdv/erp-outbox.service.ts | 214 | ESCRITA | `inserirProdutosBatch` / `produtos` | Replica cadastro de produto novo no Wincred (job `produto_cadastro`) | ALTA | SIM — `product` + `wincred_produtos` já gravados antes de enfileirar |
| src/pdv/erp-outbox.service.ts | 257 | ESCRITA | `deleteProdutos` / `produtos` | Replica exclusão de produto (job `produto_exclusao`) | MEDIA | SIM — Flow já apagou |
| src/pdv/erp-outbox.service.ts | 296 | ESCRITA | `applyStockDeltaGigaOnly` / `estoque` | Replica delta de estoque (job `estoque_delta`) | CRITICA | SIM — delta já aplicado em `giga_estoque`/`wincred_estoque` no ato |
| src/pdv/erp-outbox.service.ts | 333 | ESCRITA | `upsertClienteGiga` / `clientes` | Replica cliente criado/editado no Flow (job `cliente_upsert`) | ALTA | SIM — `giga_clientes.flowIsSource` é a fonte |
| src/pdv/erp-outbox.service.ts | 400 | ESCRITA | `markCrediarioParcelaPaid` / `movimento` | Replica baixa de crediário (job `crediario_baixa`) | CRITICA | SIM — `CrediarioBaixa` + write-through em `wincred_movimento_aberto` |
| src/pdv/erp-outbox.service.ts | 440 | ESCRITA | `markCrediarioParcelaUnpaid` / `movimento` | Replica estorno de crediário (job `crediario_estorno`) | CRITICA | SIM — idem |

Delegações (contadas nas linhas do `pdv.service.ts`): `:134` → `erpStepGravarCaixa`, `:141` → `erpStepBaixarEstoque`, `:151` → `erpStepFecharMarcados`.

### pdv.service.ts — venda do PDV

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/pdv/pdv.service.ts | 314 | ESCRITA | `marcarVendaWincredCancelada` / `caixa` | Cancelamento de venda: `UPDATE caixa SET MARCADO='SIM'` por `OBS_PEDIDO='flowops-XXXXXXXX'` — tira do faturamento | ALTA | PARCIAL — `PdvSale.status='canceled'` já é a fonte, mas o cancelamento NÃO propaga pro espelho `giga_caixa_mov` (só o cron horário corrige) |
| src/pdv/pdv.service.ts | 349 | ESCRITA | `gravarVendaPdv` / `caixa` | Estorno de estoque no cancelamento: grava linhas com `qty` NEGATIVA na caixa, com a vendedora original | ALTA | PARCIAL — mesma coisa; o negativo existe só no Giga |
| src/pdv/pdv.service.ts | 2434 | — | `isWriteEnabled` | Guard de env (`ERP_WRITE_ENABLED`), não toca no MySQL | BAIXA | n/a |
| src/pdv/pdv.service.ts | 2442 | ESCRITA | `deleteCaixaMarcadoRow` / `caixa` | Passo 3 do sync: fecha marcados puxados pra venda (DELETE da linha `MARCADO='SIM'`) | ALTA | SIM — tabela nativa `marcados` recebe `status='fechado'` na sequência (linha 2454) |
| src/pdv/pdv.service.ts | 2483 | ESCRITA | `gravarVendaPdv` / `caixa` + `fechamento` | Passo 1 do outbox: grava a venda inteira na caixa do Wincred (com rateio do desconto geral) | CRITICA | SIM — a venda finaliza só no Postgres (`PdvSale`); isto é réplica com retry. ⚠️ mas royalties/faturamento ainda LEEM a `caixa` |
| src/pdv/pdv.service.ts | 2596 | — | `isWriteEnabled` | Guard de env | BAIXA | n/a |
| src/pdv/pdv.service.ts | 2628 | ESCRITA | `decreaseStock` / `estoque` | Passo 2 do outbox: baixa de estoque da venda (`allowNegative`+`skipNotFound`) | CRITICA | SIM — dual-write Flow+Giga com fila; guard `sale.stockDecreasedAt` |
| src/pdv/pdv.service.ts | 3011 | — | `isWriteEnabled` | Guard de env no `reconcileStockBacklog` | BAIXA | n/a |
| src/pdv/pdv.service.ts | 3020 | ESCRITA | `decreaseStock` / `estoque` | `reconcileStockBacklog` — rede de segurança que baixa estoque de vendas com `stockDecreasedAt=null` | ALTA | SIM — dual-write |
| src/pdv/pdv.service.ts | 3171 | — | `isWriteEnabled` | Guard de env no `reconcileManualStockBacklog` | BAIXA | n/a |
| src/pdv/pdv.service.ts | 3195 | ESCRITA | `decreaseStock` / `estoque` | `reconcileManualStockBacklog` — baixa item-a-item dos itens com desconto manual | ALTA | SIM — dual-write |
| src/pdv/pdv.service.ts | 1082 | LEITURA | `catalog.getPdvProductInfo` → `produtos`/`estoque` | Bipe do PDV: espelho `wincred_produtos` primeiro, **fallback Giga ao vivo** em miss/EAN/preço zerado/erro | CRITICA | SIM — `WincredCatalogService`, kill-switch `PDV_MIRROR_READS=0` |
| src/pdv/pdv.service.ts | 1390 | LEITURA | `catalog.getPdvProductInfo` | Enriquecimento de item já existente (mesmo caminho espelho→Giga) | ALTA | SIM |

### returns.service.ts — devoluções e trocas

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/pdv/returns.service.ts | 159 | — | `skuVariants` | Helper de string puro (gera variantes de zero-padding) — **não toca no MySQL** | BAIXA | n/a |
| src/pdv/returns.service.ts | 415 | ESCRITA | `increaseStockAsync` / `estoque` | Devolução normal: repõe estoque (Flow na hora + outbox pro Giga) | CRITICA | SIM — dual-write assíncrono (`ERP_STOCK_WRITES_ASYNC`) |
| src/pdv/returns.service.ts | 1250 | ESCRITA | `increaseStockAsync` / `estoque` | Retry em lote dos itens com `stockReturnedAt=null` (admin `/pdv/admin/returns-stock-retry`) | ALTA | SIM |
| src/pdv/returns.service.ts | 1327 | LEITURA | `lookupSaleHistoryByStoreAndSku` / `caixa`+`produtos` | Devolução manual (peça vendida no Giga sem cupom Flow): histórico 60d da loja + preço | ALTA | SIM — `giga_caixa_mov` via `caixaMovUsable()`, gated `GIGA_MIRROR_READS`; cai pro Giga se o espelho não cobrir a janela |
| src/pdv/returns.service.ts | 1424 | ESCRITA | `increaseStockAsync` / `estoque` | Devolução manual: repõe 1 unidade | ALTA | SIM |
| src/pdv/returns.service.ts | 1730 | ESCRITA | `increaseStockAsync` / `estoque` | Devolução em lote (múltiplas vendas, 1 chamada consolidada) | CRITICA | SIM |

### marcados.service.ts — "provar em casa"

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/pdv/marcados.service.ts | 208 | ESCRITA | `insertCaixaMarcado` / `caixa` | Cria a marcação: 1 linha por item com `MARCADO='SIM'`, compartilhando o CONTROLE. **`throw` se falhar — a operação aborta** | CRITICA | PARCIAL — `marcados` nativo é gravado logo depois (l. 251) mas o REGISTRO que identifica a peça nasce no Giga |
| src/pdv/marcados.service.ts | 235 | SQL-CRU | `caixa` | Recaptura os `REGISTRO` recém-inseridos por `NUMERO`+`CLIENTE`+`MARCADO='SIM'` pra gravar no nativo | ALTA | PARCIAL — existe só porque a chave vem do Giga |
| src/pdv/marcados.service.ts | 275 | — | `isWriteEnabled` | Guard de env | BAIXA | n/a |
| src/pdv/marcados.service.ts | 281 | ESCRITA | `decreaseStockAsync` / `estoque` | Baixa o estoque das peças marcadas (peça saiu da loja) | CRITICA | SIM — dual-write assíncrono |
| src/pdv/marcados.service.ts | 383 | SQL-CRU | tabela `clientes` (detectada) | Fallback: busca cliente por CPF (3 formatos) quando o espelho `giga_clientes` não achou | ALTA | SIM — espelho `giga_clientes` é o caminho primário (l. 340-366) |
| src/pdv/marcados.service.ts | 438 | SQL-CRU | `caixa` | Fallback: marcados ativos do cliente (`MARCADO='SIM' AND CLIENTE=N`) pra calcular o limite | CRITICA | SIM — tabela `marcados` (flag `MARCADOS_NATIVE_READS=1`, default OFF); **rede de segurança proposital: espelho vazio cai pro Giga pra não liberar venda acima do limite** |
| src/pdv/marcados.service.ts | 643 | SQL-CRU | `caixa` | Badge "em marca" na busca de clientes: `GROUP BY CLIENTE` com teto de 6s (`Promise.race`) | MEDIA | SIM — `marcado.groupBy` nativo |
| src/pdv/marcados.service.ts | 746 | — | `isWriteEnabled` | Guard de env | BAIXA | n/a |
| src/pdv/marcados.service.ts | 760 | ESCRITA | `increaseStock` / `estoque` | Devolução de peça marcada: estoque volta pra loja | CRITICA | SIM — dual-write |
| src/pdv/marcados.service.ts | 779 | ESCRITA | `deleteCaixaMarcadoRow` / `caixa` | DELETE da linha marcada (tira do nome da cliente) | CRITICA | PARCIAL — o DELETE no Giga É a operação; o nativo só acompanha (l. 798) |
| src/pdv/marcados.service.ts | 939 | — | `isWriteEnabled` | Guard de env (baixa sem financeiro) | BAIXA | n/a |
| src/pdv/marcados.service.ts | 954 | ESCRITA | `deleteCaixaMarcadoRow` / `caixa` | Baixa SEM financeiro (defeito/furto/perda): remove a marcação, não devolve estoque | ALTA | PARCIAL — idem |
| src/pdv/marcados.service.ts | 1087 | SQL-CRU | `caixa` LEFT JOIN `clientes` | Fallback da tela de marcados da retaguarda (full-scan em `MARCADO`, JOIN com `CAST(LOJA AS UNSIGNED)`) | MEDIA | SIM — leitura nativa da tabela `marcados` (flag) |
| src/pdv/marcados.service.ts | 1145 | SQL-CRU | `caixa` | Fallback do "puxar marcado pra venda" quando o espelho não tem os REGISTROs | ALTA | SIM — nativo com fallback proposital |
| src/pdv/marcados.service.ts | 1199 | LEITURA | `catalog.getPdvProductInfo` | Enriquece a peça puxada (espelho→Giga) | MEDIA | SIM |

### marcados-mirror.service.ts — cron `@Cron('40 * * * *')`, gated `WINCRED_MIRROR_CRON_ENABLED=1`

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/pdv/marcados-mirror.service.ts | 80 | LEITURA | `readAllPages` / `caixa` | Importa TODA a caixa com `MARCADO='SIM'` (paginado 10k, 90s) pro nativo `marcados`; aborta se truncar | ALTA | NAO — **é o próprio ETL do espelho**. Morre junto com o Giga; a partir daí `marcados` precisa ser fonte |

### cash.service.ts — caixa/fechamento

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/pdv/cash.service.ts | 1844 | ESCRITA | `atualizarBandeiraFechamento` / `caixa`+`fechamento` | Edição master de pagamento: acha o `NUMERO` por `OBS_PEDIDO` e troca a bandeira/valor no `fechamento` | ALTA | NAO — **não existe espelho da tabela `fechamento`**; o Flow tem `PdvSalePayment` mas nada replica bandeira pro Giga fora daqui |
| src/pdv/cash.service.ts | 2434 | ESCRITA | `atualizarBandeiraFechamento` / `caixa`+`fechamento` | Troca de bandeira isolada (operadora errou) | ALTA | NAO — idem |

### crediario-print.service.ts — carnê/promissória

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/pdv/crediario-print.service.ts | 582 | SQL-CRU | tabela `clientes` | `diagCliente` (`GET /pdv/diag-cliente`): 3 tentativas de CPF pra descobrir nomes de coluna | BAIXA | SIM — `giga_clientes.rawJson` tem a linha inteira |
| src/pdv/crediario-print.service.ts | 690 | SQL-CRU | tabela `clientes` | Dados completos da cliente pro carnê (CPF só dígitos) | ALTA | SIM — `giga_clientes` (nome/endereço/bairro/cidade/CEP + rawJson) |
| src/pdv/crediario-print.service.ts | 698 | SQL-CRU | tabela `clientes` | Tentativa 2: CPF formatado | ALTA | SIM |
| src/pdv/crediario-print.service.ts | 707 | SQL-CRU | tabela `clientes` | Tentativa 3: `REPLACE` no DB | ALTA | SIM |

### active-sellers.controller.ts

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/pdv/active-sellers.controller.ts | 93 | LEITURA | `getFuncionariosAtivosByLoja` / `funcionarios` | `GET /pdv/vendedoras-ativas/wincred` — lista funcionários ativos da loja | MEDIA | SIM — `wincred_funcionarios` já é lido primeiro dentro do `ErpService` (gated `GIGA_MIRROR_READS`) |
| src/pdv/active-sellers.controller.ts | 123 | LEITURA | `getFuncionariosAtivosByLoja` / `funcionarios` | `POST /pdv/vendedoras-ativas/sync-from-wincred` — replace-all da lista local | MEDIA | SIM — idem |

### pdv-diag.controller.ts — diagnóstico admin (todos `@UseGuards(JwtAuthGuard)`)

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/pdv/pdv-diag.controller.ts | 105 | SQL-CRU | `movimento` | Busca a parcela por `NUMEROCOMPRA`+`PARCELA` pra baixa retroativa manual | BAIXA | PARCIAL — `wincred_movimento_aberto` só tem abertas; parcela paga só em `giga_raw.movimento` (congelado) |
| src/pdv/pdv-diag.controller.ts | 141 | ESCRITA | `markCrediarioParcelaPaid` / `movimento` | **Baixa retroativa manual de parcela** (`GET|POST /pdv-diag/baixa-retroativa`) — grava PAGO+data+juros+multa | ALTA | PARCIAL — existe `CrediarioBaixa`+outbox, mas este endpoint escreve direto no Giga sem passar por eles |
| src/pdv/pdv-diag.controller.ts | 195 | SQL-CRU | `INFORMATION_SCHEMA.COLUMNS` | Lista colunas de `movimento` pro `GET /pdv-diag/find` | BAIXA | NAO — metadado do MySQL |
| src/pdv/pdv-diag.controller.ts | 205 | SQL-CRU | `movimento` | `COUNT(*)` por coluna procurando um valor (loop sobre TODAS as colunas) | BAIXA | NAO |
| src/pdv/pdv-diag.controller.ts | 211 | SQL-CRU | `movimento` | Amostra de 3 linhas da coluna que casou | BAIXA | NAO |
| src/pdv/pdv-diag.controller.ts | 254 | SQL-CRU | `movimento` | `GET /pdv-diag/parcela` — linha completa por REGISTRO+CONTROLE | BAIXA | PARCIAL — espelho só tem as abertas |

### pdv.controller.ts

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/pdv/pdv.controller.ts | 169 | LEITURA | `catalog.getPdvProductInfo` | `GET /pdv/product` — bipe direto (espelho→Giga) | CRITICA | SIM — `WincredCatalogService` |
| src/pdv/pdv.controller.ts | 981 | SQL-CRU | tabela `clientes` | `GET /pdv/customer-info` tentativa 1: resolve por `CustomerGigaLink` (loja+código) | ALTA | PARCIAL — `giga_clientes` tem a ficha inteira, o endpoint não a usa |
| src/pdv/pdv.controller.ts | 997 | SQL-CRU | tabela `clientes` | Tentativa 2: CPF normalizado (`REPLACE` recursivo) na loja | ALTA | PARCIAL |
| src/pdv/pdv.controller.ts | 1009 | SQL-CRU | tabela `clientes` | Tentativa 3: código do cliente direto | ALTA | PARCIAL |
| src/pdv/pdv.controller.ts | 1020 | SQL-CRU | tabela `clientes` | Tentativa 3b: CPF via `LIKE '%...%'` | ALTA | PARCIAL |
| src/pdv/pdv.controller.ts | 1044 | SQL-CRU | tabela `clientes` | Tentativa 4b: telefone (últimos 9 dígitos), só match único | ALTA | PARCIAL |
| src/pdv/pdv.controller.ts | 1059 | SQL-CRU | tabela `clientes` | Tentativa 4c: nome exato | ALTA | PARCIAL |
| src/pdv/pdv.controller.ts | 1067 | SQL-CRU | tabela `clientes` | Tentativa 4c-bis: nome `LIKE` | ALTA | PARCIAL |
| src/pdv/pdv.controller.ts | 1095 | SQL-CRU | tabela `clientes` | Tentativa 5: CPF SEM filtro de loja, só pra dizer "o cadastro é da loja YY" | MEDIA | PARCIAL |
| src/pdv/pdv.controller.ts | 1131 | SQL-CRU | tabela `clientes` | Diagnóstico do "não achou" (busca por primeiro nome) | BAIXA | PARCIAL |
| src/pdv/pdv.controller.ts | 1355 | SQL-CRU | tabela `clientes` | `GET /pdv/customer-search` — completa o autocomplete do PDV com resultados do Giga (após o CRM) | MEDIA | PARCIAL — `giga_clientes`/`wincred_clientes` cobririam |
| src/pdv/pdv.controller.ts | 1554 | LEITURA | `getTableSchema` / `funcionarios`… | `GET /pdv/funcionarios-search`: sonda 5 nomes de tabela pra achar a de funcionários | MEDIA | SIM — `wincred_funcionarios` |
| src/pdv/pdv.controller.ts | 1591 | SQL-CRU | tabela de funcionários | Busca vendedora por nome/loja (popup "CONFIRMAR VENDA" do PDV) | ALTA | SIM — `wincred_funcionarios` |
| src/pdv/pdv.controller.ts | 1825 | ESCRITA | `createCrediarioParcelas` / `movimento` | **`POST /pdv/sales/:id/crediario`: INSERT das N parcelas no `movimento` do Giga.** Síncrono, sem outbox — se falhar, `BadRequestException` e a venda não vira crediário | CRITICA | **NAO** — não existe tabela nativa de parcelas; `wincred_movimento_aberto` é espelho read-only e o outbox não tem kind de criação |
| src/pdv/pdv.controller.ts | 2226 | LEITURA | `inspectTableIndexes` / `SHOW INDEX` | `GET /pdv/admin/erp-indexes` (admin) — auditoria de índices de `estoque`/`caixa`/`produtos`/`movimento` | BAIXA | NAO — metadado do MySQL |
| src/pdv/pdv.controller.ts | 2263 | ESCRITA | `createIndexIfNotExists` / DDL | `POST /pdv/admin/erp-create-index` (admin) — `CREATE INDEX` no Giga | BAIXA | NAO — DDL do MySQL |

---

## src/crediarios/

### crediarios.service.ts — cobrança por WhatsApp

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/crediarios/crediarios.service.ts | 129 | LEITURA | `getTableSchema` / `movimento` | `detectColumns()` — autodetecção dos nomes de coluna via `SHOW COLUMNS` (cache por boot). **Pré-requisito de quase todo o crediário** | CRITICA | NAO — schema-discovery do MySQL; some junto com o Giga (o espelho já tem colunas fixas) |
| src/crediarios/crediarios.service.ts | 190 | LEITURA | `getTableSchema` / `clientes`… | `detectClientesTable()` — sonda 5 candidatas (`clientes`, `cadcli`…) e mapeia colunas | CRITICA | NAO — idem |
| src/crediarios/crediarios.service.ts | 302 | SQL-CRU | tabela `clientes` | `diagnoseClientesPhones` — cobertura de telefone (COUNT/SUM na tabela inteira) | BAIXA | NAO — diagnóstico |
| src/crediarios/crediarios.service.ts | 320 | SQL-CRU | tabela `clientes` | Amostra de 5 clientes do mesmo diagnóstico | BAIXA | NAO |
| src/crediarios/crediarios.service.ts | 374 | SQL-CRU | tabela `clientes` | `fetchPhonesByClienteIds` — telefone+nome por lista de códigos (escopado por loja) | ALTA | SIM — `wincred_clientes` (loja, codCliente, nome, telefone, telefone2) |
| src/crediarios/crediarios.service.ts | 488 | SQL-CRU | `movimento` | `listOverdue` — parcelas VENCIDAS e não pagas por loja (teto 5.000 linhas / 30s) | ALTA | PARCIAL — `wincred_movimento_aberto` tem as abertas, mas este caminho ainda vai no Giga |
| src/crediarios/crediarios.service.ts | 792 | LEITURA | `getTableSchema` / `movimento` | `diagnoseRawColumns` — schema bruto pra debug | BAIXA | NAO |
| src/crediarios/crediarios.service.ts | 798 | SQL-CRU | `movimento` | `SELECT * FROM movimento LIMIT 5` do mesmo diagnóstico | BAIXA | NAO |

### cobranca-auto.service.ts — cron `@Cron(EVERY_5_MINUTES)`

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/crediarios/cobranca-auto.service.ts | 162 | LEITURA (indireta) | `listOverdueByCustomer` → `movimento`+`clientes` | Cron de campanhas de cobrança: a cada 5 min chama `listOverdueByCustomer`, que cai em `crediarios.service.ts:488` (varredura do `movimento`) | ALTA | PARCIAL — `wincred_movimento_aberto` cobriria; a rota `listOverdue` ainda não usa espelho |

### crediario-baixa.service.ts — recebimento de crediário

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/crediarios/crediario-baixa.service.ts | 422 | SQL-CRU | `readAllPages` / `movimento` | `listAllOpenInstallments` **fallback**: varre TODAS as parcelas abertas paginado (10k/página, 60s) — historicamente a query mais pesada do sistema | CRITICA | SIM — `wincred_movimento_aberto` é o caminho primário (l. 328-345, `PDV_MIRROR_READS`) |
| src/crediarios/crediario-baixa.service.ts | 455 | SQL-CRU | tabela `clientes` | Filtro de clientes-cartão (VISANET/MASTERCARD…) por nome, no caminho Giga | MEDIA | SIM — `wincred_clientes` |
| src/crediarios/crediario-baixa.service.ts | 567 | SQL-CRU | `readAllPages` / `movimento` | `diff` de validação espelho × Giga (decide se dá pra ligar `CREDIARIO_NATIVE_READS`) | BAIXA | NAO — por definição precisa do Giga vivo |
| src/crediarios/crediario-baixa.service.ts | 941 | SQL-CRU | `readAllPages` / `clientes` | `listAllClientes` — base de clientes da loja pro autocomplete (paginado) | ALTA | PARCIAL — `wincred_clientes` tem nome/fones; falta CPF/avaliação (que estão em `giga_clientes`) |
| src/crediarios/crediario-baixa.service.ts | 1021 | SQL-CRU | `readAllPages` / `clientes` | `listClientesDuplicados` — clientes da loja pra achar cadastros duplicados | BAIXA | SIM — `giga_clientes` (loja, codigo, nome, cpf, telefone) |
| src/crediarios/crediario-baixa.service.ts | 1080 | SQL-CRU | `movimento` | Conta parcelas abertas por código (mostra onde o crediário está pendurado) | BAIXA | SIM — `wincred_movimento_aberto` |
| src/crediarios/crediario-baixa.service.ts | 1117 | SQL-CRU | tabela `clientes` | Busca as fichas origem/destino da unificação | BAIXA | SIM — `giga_clientes` |
| src/crediarios/crediario-baixa.service.ts | 1130 | SQL-CRU | `movimento` + `caixa` | 3 `COUNT(*)` de impacto da unificação (linhas de movimento, abertas, caixa) | BAIXA | PARCIAL — espelho só tem abertas; `giga_caixa_mov` cobre a caixa recente |
| src/crediarios/crediario-baixa.service.ts | 1176 | — | `isWriteEnabled` | Guard de env | BAIXA | n/a |
| src/crediarios/crediario-baixa.service.ts | 1180 | ESCRITA | `pool.getConnection()` + 4 `UPDATE` em `movimento`, `caixa`, `clientes` | **Unificação de cadastros duplicados**: transação MySQL crua que move parcelas e histórico de compras de um código pro outro e marca o origem `#UNIF>` | ALTA | NAO — escrita direta no Giga, fora do outbox; só o reflexo nos espelhos é best-effort (l. 1221) |
| src/crediarios/crediario-baixa.service.ts | 1340 | SQL-CRU | tabela `clientes` | `searchClientes` **fallback** (autocomplete por nome/código) | ALTA | SIM — `wincred_clientes` é o primário (l. 1278, `CREDIARIO_NATIVE_READS`) |
| src/crediarios/crediario-baixa.service.ts | 1454 | SQL-CRU | `movimento` | Parcelas abertas de UM código de cliente (fallback do nativo) | ALTA | SIM — `wincred_movimento_aberto` (l. 1360-1411) |
| src/crediarios/crediario-baixa.service.ts | 1549 | SQL-CRU | tabela `clientes` | `listOpenInstallmentsByCustomer`: resolve código quando a busca é numérica | ALTA | SIM — `wincred_clientes` |
| src/crediarios/crediario-baixa.service.ts | 1562 | SQL-CRU | tabela `clientes` | Idem, busca por NOME (`LIKE`) | ALTA | SIM |
| src/crediarios/crediario-baixa.service.ts | 1590 | SQL-CRU | tabela `clientes` | Filtro de clientes-cartão pelos códigos resolvidos | MEDIA | SIM |
| src/crediarios/crediario-baixa.service.ts | 1643 | SQL-CRU | `movimento` | Parcelas abertas dos códigos resolvidos (LIMIT 500) | ALTA | SIM — espelho |
| src/crediarios/crediario-baixa.service.ts | 1797 | SQL-CRU | `movimento` | `preview` da baixa: confere no Giga se a parcela **já está paga** antes de cobrar | CRITICA | PARCIAL — o espelho só sabe de abertas; a checagem "já pagou" precisa da autoridade |
| src/crediarios/crediario-baixa.service.ts | 2278 | ESCRITA | `markCrediarioParcelaPaid` / `movimento` | **Baixa da parcela no Wincred** (`PAGO='S'` + data + valor + juros + multa). Inline porque `CREDIARIO_ERP_OUTBOX` é **default OFF** (l. 1702) | CRITICA | SIM (desligado) — `CrediarioBaixa` no Postgres + job `crediario_baixa` no outbox + write-through no espelho; **basta ligar a flag** |
| src/crediarios/crediario-baixa.service.ts | 2516 | ESCRITA | `markCrediarioParcelaUnpaid` / `movimento` | Estorno da baixa (`PAGO='N'`). Idem: inline com a flag OFF | CRITICA | SIM (desligado) — job `crediario_estorno` |

### crediario-mirror.service.ts — crons `*/10 * * * *` e `0 4 * * *`, gated `WINCRED_MIRROR_CRON_ENABLED=1`

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/crediarios/crediario-mirror.service.ts | 91 | — | `(erp as any).pool` | Só checa se o pool existe (guard) | BAIXA | n/a |
| src/crediarios/crediario-mirror.service.ts | 132 | LEITURA | `readAllPages` / `movimento` | **ETL das parcelas abertas** (10 em 10 min): replace atômico de `wincred_movimento_aberto`; aborta se truncar | CRITICA | NAO — é o alimentador do espelho |
| src/crediarios/crediario-mirror.service.ts | 196/211 | SQL-CRU | `pool.query` / tabela `clientes` | **ETL de clientes slim** (1x/dia 4h + carona na 1ª carga): replace de `wincred_clientes`, `LIMIT 300000`, timeout 180s | ALTA | NAO — alimentador do espelho |

### crediario-baixa.controller.ts

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/crediarios/crediario-baixa.controller.ts | 114 | ESCRITA | `createIndexIfNotExists` / DDL | `POST /crediarios/baixa/admin/create-index-movimento` (admin) — cria índice `(PAGO, VENCIMENTO)` no `movimento` | BAIXA | NAO — DDL do MySQL |

---

## src/clientes-giga/

### clientes-giga.service.ts — cron `@Cron('40 4 * * *')`, gated `WINCRED_MIRROR_CRON_ENABLED=1`

| arquivo | linha | tipo | método/tabela | o que faz | risco | substituto no Flow |
|---|---|---|---|---|---|---|
| src/clientes-giga/clientes-giga.service.ts | 101 | LEITURA | `getTableSchema` / `clientes`… | `detectTable()` — sonda as 5 candidatas e acha a coluna de código | ALTA | NAO — schema-discovery |
| src/clientes-giga/clientes-giga.service.ts | 132/143 | SQL-CRU | `pool.query` / tabela `clientes` | **ETL completo**: `SELECT *` paginado (10k/página, teto 500k) → `giga_clientes` com `rawJson` da linha inteira. Full-replace só do que veio do Giga (`flowIsSource=false`) | ALTA | NAO — é o ETL do espelho |
| src/clientes-giga/clientes-giga.service.ts | 582 | ESCRITA | `upsertClienteGiga` / `clientes` | Réplica imediata da ficha quando a cópia entre lojas encontra cadastro já existente (idempotência do caso Pamela) | ALTA | SIM — `giga_clientes.flowIsSource=true` é a fonte; outbox `cliente_upsert` garante o retry |
| src/clientes-giga/clientes-giga.service.ts | 632 | ESCRITA | `upsertClienteGiga` / `clientes` | Réplica imediata da ficha copiada pra outra loja (caixa com a cliente na frente: 3s em vez de 35s) | ALTA | SIM — idem |
| src/clientes-giga/clientes-giga.service.ts | 768 | SQL-CRU | `caixa` | Resumo da cliente: marcados AO VIVO (`MARCADO='SIM' AND CLIENTE=N AND LOJA=..`) quando o nativo está vazio — rede de segurança antes de liberar limite | ALTA | SIM — tabela `marcados` (flag `MARCADOS_NATIVE_READS`, default OFF) |

---

## Observações que mudam a ordem do desligamento

1. **`createCrediarioParcelas` é o único write-path da operação que não tem NADA no Flow.** Todo o resto (venda, estoque, cliente, produto, baixa, estorno) já tem tabela nativa e/ou kind de outbox. Enquanto isso não existir, "desligar o Giga" significa "não vender a crediário".
2. **`detectColumns()`/`detectClientesTable()` (crediarios.service.ts:129 e :190) são um gargalo escondido**: são `SHOW COLUMNS` no Giga chamados com `force=true` em vários caminhos quentes (`crediario-baixa.service.ts:350`, `:540`, `:1417`, `:1508`, `pdv-diag:95`). Mesmo quando a leitura sai do espelho, o mapa de colunas ainda pode ir buscar o schema no MySQL. Os espelhos já têm colunas fixas — dá pra congelar esse mapa num `SystemSetting` e cortar a dependência sem tocar em regra de negócio.
3. **`CREDIARIO_ERP_OUTBOX` e `CREDIARIO_NATIVE_READS` estão default OFF e `MARCADOS_NATIVE_READS` também.** Grande parte do "PARCIAL" desta tabela vira "SIM" só ligando flag — depois de rodar o diff de validação (`diffAbertasEspelhoVsGiga`, `crediario-baixa.service.ts:494`, endpoint `GET /crediarios/baixa/diff/abertas` em `crediario-baixa.controller.ts:208`).
4. **`fechamento` não tem espelho nenhum.** As duas escritas de `cash.service.ts` são as únicas do escopo que tocam essa tabela e não têm nem espelho de leitura nem fila.
5. **Os 5 ETLs (`marcados-mirror:80`, `crediario-mirror:132` e `:211`, `clientes-giga:143`, mais o `wincred-mirror` fora deste escopo) são o oposto de uma dependência a eliminar**: são a ponte. Eles precisam sobreviver até o dia do corte e morrer *no* corte — quando as tabelas que eles alimentam (`marcados`, `wincred_movimento_aberto`, `wincred_clientes`, `giga_clientes`) passam a ser fonte de escrita, não de espelho.
6. **`caixa.NUMERO` FLOAT**: nenhuma das leituras deste escopo faz `CAST(NUMERO AS UNSIGNED)` — `marcados.service.ts:235` compara `NUMERO = ${controle}` (numérico, ok) e `marcados-mirror.service.ts:105` faz `Number(row.NUMERO)` (converte no JS, também ok). O risco real está nas leituras que já foram para o espelho `giga_caixa_mov`, que ainda carrega histórico achatado.
