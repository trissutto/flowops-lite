# Auditoria 03/09/2026 — Enterrar o Wincred de vez

**Pedido do dono:** varrer TODO o sistema e achar relatórios/cadastros que ainda tocam o antigo servidor (Wincred/Giga/KingHost), com plano de enterro.

**Método:** workflow de 64 agentes — 7 auditores de censo (5 grupos de backend + frontend + infra/docs), verificação **adversarial** de cada achado vivo (rebaixou 27 classificações exageradas) e um crítico de completude que recuperou **7 módulos que a varredura inicial não viu**. 1.303 operações de leitura de código. Mais: consultas read-only ao Postgres de produção (heroic-mercy) pra medir `erp_outbox` e o estrago retroativo do achado nº 1. Os 3 achados-manchete foram reconferidos linha a linha manualmente.

## Placar

| Selo | Qtde | Significado |
|---|---|---|
| 🔴 TRAVA | **23** | caminho vivo que estoura erro na operação |
| 🟡 MENTE | **23** | caminho vivo que devolve vazio/zero calado |
| ⚰️ MUSEU | **80** | código inalcançável — onda de deleção |
| 📄 DOC/ENV | **41** | documentação/env/texto de tela desatualizado |
| ✅ OK | **89** | conferido e são (caminho Flow-first, guard correto) |
| **Total** | **256** | |

---

## 🚨 Achado nº 1 — estorno MASTER some com o estoque (e diz que devolveu)

`backend/src/pdv/pdv.service.ts:1328` — o passo 2b do estorno master de venda finalizada devolve o estoque chamando **`this.erp.gravarVendaPdv` com qty negativa — direto no Giga morto**. Três agravantes, todos confirmados manualmente:

1. Com o pool trancado, `gravarVendaPdv` **retorna `{ok:false, error:'Pool ERP não inicializado'}` sem lançar** (`erp.service.ts:10530`) — o catch nunca dispara.
2. O chamador **não confere o retorno**: carimba `status:'ok', 'N item(ns) devolvido(s) ao estoque'` incondicionalmente.
3. **Não existe devolução no Flow** em nenhum outro passo — e o Flow é a fonte do estoque desde 14/07. Ou seja: a venda baixou o estoque no bipe, o estorno nunca devolve, e a tela jura que devolveu.

**Estrago retroativo (medido em produção):** felizmente mínimo — só **2 estornos master de venda finalizada desde 14/07** (loja 15, R$ 1,00 e loja 19, R$ 23,90, ambos em 01/08; **zero** pós-28/08). É uma mina armada, não uma cratera. Correção: trocar por `increaseStockAsync` no Flow conferindo `r.applied`, reportar falha de verdade no passo — e devolver as 2 peças de 01/08.

Bônus no mesmo fluxo: o passo 2 (`marcarVendaWincredCancelada`, linha 1293) falha SEMPRE e mostra **falso alarme "Marque manual no Wincred!"** em todo estorno — remover o passo (o `giga_caixa_mov` já é alimentado pelo Flow e o cancelamento sai dos relatórios pela fonte nativa).

## O que o banco de produção mostrou (`erp_outbox`)

- **Jobs novos ainda nascem todo dia**: vendas de 03/09 às 23h23 UTC criaram jobs `venda`, `crediario_criacao`, `crediario_baixa` — todos imediatamente `done` com *"skipped: replica pro Giga desligada"*. O crítico confirmou: **todos** os enqueuers desaguam no descarte com motivo (`erp-outbox.service.ts:103-109`) — nada acumula, mas é peso morto crescendo.
- ⚠️ **O cron do outbox NÃO pode morrer na faxina**: o kind `venda` é hoje o **veículo da baixa de estoque NO FLOW**. Deletar são os 11 processors de réplica, não o cron.
- **Presos pré-enterro** (limpar na Onda 2): 32 `marcado_remover` failed (até 04/08), 32 `estoque_delta` failed (até 25/08), 1 `estoque_delta` travado em `processing` desde 27/08.

---

## 🔴 TRAVA — 23 caminhos vivos que estouram erro

### Crediário (o foco mais denso de defeito vivo)
| Onde | O que quebra | Plano |
|---|---|---|
| `crediarios/crediarios.service.ts:587` | **Cobrança inteira**: `GET /crediarios/vencidos` + `/vencidos-clientes` dão 500 E o cron `CobrancaAutoService` (5min) **morre calado — campanha ativa de WhatsApp nunca dispara** | migrar `listOverdue` pra `wincred_movimento_aberto` + `crediario_parcelas` (mesma união do `listAbertasDoEspelho`) |
| `crediarios/crediario-baixa.service.ts:2005` | `previewBaixa` — **o coração da baixa no PDV** (`/preview`, `/dinheiro`, `/pix`, `/pix-link`, `/split`): parcela fora do espelho estoura "Pool ERP não inicializado" | miss = "paga ou inexistente" → BadRequest amigável; deletar a conferência Giga |
| `crediario-baixa.service.ts:1590` | Recebimentos: clicar em cliente cujo miss "cai pro Giga por segurança" → 500 | miss no espelho = `[]` (sem parcela aberta); deletar ramo Giga |
| `crediario-baixa.service.ts:585` | diff espelho×Giga (admin) | deletar |
| `crediario-baixa.service.ts:1161` | tela `/retaguarda/clientes-duplicados` (listar + unificar) | migrar unificação pra fusão nativa de clientes; deletar caminho |
| `crediarios.service.ts:906` | `GET /crediarios/diagnose` (schema de banco morto) | deletar |

### PDV e vendedoras
| Onde | O que quebra | Plano |
|---|---|---|
| `pdv/marcados.service.ts:557` | abrir cliente SEM ficha no espelho na tela de marcados → 400 "Tabela de clientes não detectada no Giga" | remover fallback; miss = "não encontrado" |
| `pdv/marcados-mirror.service.ts:75` | botão "Restos dos marcados do Giga" → 500 seco | migrar pra `giga_caixa_mov` (coluna `marcado` existe) ou deletar botão+endpoint |
| `sellers/sellers.service.ts:43` | `POST /sellers/import-from-wincred` (pool direto) | migrar pra `wincred_funcionarios` ou deletar |
| FE `retaguarda/comissoes:292` | botão "conferência RH" → `/commissions/relatorio-rh/conferencia` morto | remover botão ou apontar pro `giga_caixa_mov` |

### Telas admin contra fonte morta (falham em TODO clique — tirar do menu já resolve o grosso)
| Tela | Backend morto |
|---|---|
| `/relatorios/giga` (Explorer, em DOIS hubs) | `/erp-query/*` |
| `/retaguarda/conferidor-estoque` (em TRÊS menus) | `stock-conferidor/conferir` (`:115`) |
| `/retaguarda/divergencias` | `wincred-mirror/divergencias` + sync |
| `/clientes-crm/sincronizacao` | `customers-giga-etl.service:226` (5 endpoints ETL) |
| `/retaguarda/estoque` (syncAll) | `stock-mirror/sync` |
| `/retaguarda/crediario-juros` (criar índice MySQL) | `create-index-movimento` |
| `/retaguarda/contas-pagar` abas Divergências/Associação | `contas-pagar-migracao:92` / `contas-pagar-associacao:55` (pool direto) |
| `/carrinhos-abandonados` (+ aba em /marketing) | `abandoned-carts:300` — plugin WP + WC REST em host apagado |
| botão "importar do site antigo" | `loja-catalog/site-sync:243` |

## 🟡 MENTE — 23 caminhos vivos que devolvem vazio calado

### Operação de venda (PDV)
| Onde | A mentira | Plano |
|---|---|---|
| `pdv/pdv.service.ts:1328` | **manchete acima** — estorno master "devolvido ao estoque" | `increaseStockAsync` no Flow + conferir retorno |
| `pdv/pdv.service.ts:1293` | falso alarme "Marque manual no Wincred!" em todo estorno | remover passo |
| `pdv/pdv.controller.ts:1380` | `customer-info`: cliente que não existe vira "Giga indisponível — tente de novo" (e trava fechamento de crediário) | miss do espelho = resposta final "não encontrado — cadastre" |
| `pdv/pdv.controller.ts:2126` | `funcionarios-search` (popup de vendedora em loja sem whitelist) devolve lista VAZIA — `wincred_funcionarios` existe no Postgres | migrar busca pro espelho/Seller |
| `wincred-mirror/wincred-catalog.service.ts:122` | fallback do bipe devolve null → preço-zero e EAN legado viram "não encontrado" | miss → cair pra `product`/`wincred_produtos` (coluna `ean`), aceitar preço-zero com aviso |

### Crediário e CRM
| Onde | A mentira | Plano |
|---|---|---|
| `crediarios/crediarios.service.ts:477` | enriquecimento de telefone da cobrança falha calado | lookup em `wincred_clientes`/Customer nativo |
| `crediario-baixa.service.ts:1755` | busca de pendências (também alimenta aba crediário do PDV) | miss = `[]`; deletar ramo Giga (linhas 1711-1883) |
| `customers/customers-crm.service.ts:1336` | ficha do CRM mostra **0 marcados** calado — tabela nativa `marcados` tem o dado | migrar pra tabela nativa |
| espelho `wincred_clientes` | **congelado em 27/08** — cliente novo sem telefone/fora da lista, sem erro | reapontar pra fonte nativa |

### Relatórios e inteligência
| Onde | A mentira | Plano |
|---|---|---|
| `reports/site-saidas.service.ts:166` | relatório **Saídas do Site**: enriquecimento devolve `[]` e os filtros ref/cor/tamanho descartam TUDO calados | espelho `wincred_produtos` (mesmo movimento do commit 919585f) |
| `intelligence.service.ts:84` | overview com filtro `year` **zera vendas** calado | implementar `year` no ramo espelho ou tirar filtro |
| `intelligence.service.ts:229` | sku-diagnose mostra estoque 0 pra peça que existe | `wincred_estoque`/`giga_estoque` |
| `intelligence.service.ts:627` | heatmap (único endpoint sem ramo espelho) sempre vazio | `giga_estoque`+`wincred_produtos` |
| `intelligence.service.ts:824` | comparativo 5 anos mostra **R$ 0** nos anos fora da cobertura | anos sem dado = null/"sem dado", nunca 0 |
| `faturamento/faturamento.service.ts:517` | drill-down "PDV Wincred legado" vazio | deletar fallback; período sem cobertura = aviso explícito |
| `orders/orders.controller.ts:3324` | routing-debug marca red-flag "suspicious" FALSA em todo SKU | espelho sem filtro >0, ou deletar comparativo raw |

### Logística e outros
| Onde | A mentira | Plano |
|---|---|---|
| `realignment/triage.service.ts:127` | triagem perde o critério "venda 30d" calado | `giga_caixa_mov` (venda por REF×loja) |
| `realignment/realignment.service.ts:1038` | fotos das peças na fila da loja (WpDb morto) | fonte de fotos oficial do Flow ou remover campo |
| `purchase-orders/purchase-orders.service.ts:1507` | etiqueta da reposição sai sem ref/preço | `buscarProdutoPorCodigo` do Postgres (commit 919585f) |
| `carrinhos-abandonados/carrinhos-abandonados.service.ts:49` | `/minha-loja/carrinhos-abandonados` mostra "0 carrinhos" (CartFlows/WP morto) — os carrinhos REAIS moram em outra tela | apontar pra fonte nativa ou remover rota |
| `products/products.service.ts:1671` | endpoints erp-schema (o próprio comentário manda remover) | deletar |
| `erp/ncm-audit.service.ts:120` | auditoria NCM carrega catálogo ZERADO sem aviso | reapontar pra `product` nativa (NCM vive lá) ou deletar módulo |
| FE `transferencias-rede-franquia:853` | botão "Sincronizar Giga" responde **200 sem fazer nada** e a tela segue pedindo o sync | aviso "espelho congelado em 25/08" ou erro claro |

---

## ⚰️ MUSEU — 80 achados, os clusters de deleção

- **`erp/erp.service.ts`**: 123 métodos públicos — 12 órfãos sem chamador nenhum + ~100 cujo chamador está em ramo morto. O arquivo de 10k+ linhas encolhe pra um toco.
- **11 processors de réplica do erp-outbox** (atrás do guard `replicaGigaLigada` — o cron FICA, só pro kind `venda`/baixa Flow).
- **Módulos inteiros**: `wp-db/`, `woocommerce/` (wc-poller + cron 03:00 bulk sync, no-op), `site-publish/`, `cpf-woo`, `cpf-rest`, `clientes-giga` (syncAll), `wc-fotos-import`, `cutover/`, `sombra.service` (GIGA_SOMBRA off), `erp-query.controller`.
- **Editor de produtos**: 4 fluxos de restauração DATAALT + auditoria de arquivo + leva-caixa.
- **Diagnósticos de schema**: giga-tables ×3, wp-diagnose, reposicao/diagnose, 4 endpoints pdv-diag.
- **Guards corretos que viram deleção**: `fullSyncFromGiga`, `puxarDoGiga`/`importarNegativos`, syncs do wincred-mirror.
- **Frontend**: SideNav morta (não renderizada) linkando diagnostico-erp/publicar-site/auditoria-ncm; telas `giga-sombra`, `diagnostico-erp`, `auditoria-paridade`, `vendedoras-pdv` (só por URL direta).
- **Scripts**: ~30 arquivos com mysql2 — `giga-etl/` inteira, `dump-giga.js` (ferramenta do backup final — **arquivar, não deletar**), inspect-erp, sync-stores, reset-stores, unificar-refs-compostas, `scripts/kinghost/*.ps1`, tools/diagnostico-erp; ~60 `diag-*.js` one-off só-Postgres = lixo.

## 📄 DOC/ENV — 41 achados

**Textos de tela mentindo em fluxo VIVO** (o pior tipo — 57 menções só no PDV): toasts "parcelas criadas no Giga"/"Cadastre no Wincred"/"Wincred OK"; devolução "estoque volta pro Giga" e **"faça entrada manual no Gigasistemas"** (impossível — não existe mais onde); separação/triagem/recebimento "baixa Giga"/"conserte no Wincred"; ficha do pedido "Real (Giga)"; as 4 telas de baixa prometendo "UPDATE -1 no Gigasistemas" (aplicam no Flow). Nesses fluxos o backend está CERTO — só o texto mente.

**Docs**: CLAUDE.md e AGENTS.md descrevem o Giga como peça viva (stack, seção "ARQUITETURA DE ESTABILIDADE" inteira, tabela de envs, mapa de módulos) → reescrever como história. `.env.example`/`DEPLOY.md`/`setup.bat` ensinam a apontar pro servidor apagado. `docs/integracao-woocommerce.md` → arquivar. RUNBOOK-SAIDA-KINGHOST e rastro do dump → **manter**.

**Envs letra morta** (remover do Railway e do CLAUDE.md): `ESTOQUE_SYNC_GIGA`, `ERP_STOCK_WRITEBACK_GIGA` (mantendo os asserts), `PDV_ERP_WRITE_ENABLED`, `ERP_STOCK_WRITES_ASYNC`, `GIGA_SOMBRA`, `GIGA_VERBOSE`, `GIGA_PRECO_COL`/`GIGA_PRODUTO_DATA_COL`. `mysql2` sai do package.json **só na faxina final** (ErpService ainda dá require).

## ⚠️ O que NÃO pode ser varrido na empolgação

| Env | Por quê fica |
|---|---|
| as 4 trancas do `replica-giga.ts` | são a TRANCA. Ficam pra sempre |
| `ERP_WRITE_ENABLED` | apesar do nome, **governa a baixa de estoque NO FLOW** — desligar derruba o estoque da rede |
| `PDV_ERP_OUTBOX` | o job `venda` do outbox é o veículo da baixa no Flow |
| `WINCRED_MIRROR_CRON_ENABLED` | gateia crons 100% Postgres (product-native, espelho nativo do crediário) |
| `PDV_MIRROR_READS`, `GIGA_MIRROR_READS=1`, `GIGA_LEITURA_FLOW=1` | espelho-primeiro; confirmadas em prod; `0`/ausente hoje QUEBRARIA o PDV |
| `ERP_MULTA_PERCENT` | é negócio vivo do crediário — **nunca varrer env por prefixo** |

**Risco latente descoberto**: os caminhos vivos do crediário dependem de `CREDIARIO_NATIVE_READS=1` e `CREDIARIO_ERP_OUTBOX=1` com **defaults OFF no código** (e fora do CLAUDE.md) — se a env sumir, parcela paga continuaria aberta, calado. Mesma família: ramo default de `PRODUCT_NATIVE_WRITES` off faria TODA edição de produto virar 500. **Inverter os defaults é item da Onda 1.**

## ✅ OK — 89 confirmações (o que a auditoria PROVOU que está são)

- **Todas as escritas de estoque** (venda, devolução, marcado, pedido online, live, remessa, reconciles) são Flow-first e inertes quanto ao Giga; o incidente "500 na entrada depois de somar" está morto (`applyStockDeltaInTx` na MESMA transação).
- **Cadastros 100% Flow**: produto novo (nativa+espelhos, EAN prefixo 8), grupos/subgrupos faixa 9000+, fornecedores 90.000+ — réplicas enfileiradas e descartadas com motivo.
- **O dinheiro grande é são**: faturamento, DRE, royalties, metas, conta corrente e quase toda a Inteligência leem espelhos alimentados pelo PRÓPRIO Flow (`giga_caixa_mov` ← `pdv_sales`).
- **As 4 trancas confirmadas na nascente** + todos os crons legados no-op + fluxos Flow-first do clientes-giga OK + specs que PROVAM o comportamento sem Giga.

---

## Plano de enterro — 3 ondas

### Onda 1 — corrigir os 46 vivos (🔴+🟡), nesta ordem
1. **Estorno master** (estoque no Flow + conferir retorno + remover falso alarme) e devolver as 2 peças de 01/08.
2. **Crediário**: cobrança (vencidos + cron de campanhas), Recebimentos e previewBaixa (miss = resposta amigável, nunca descer pro pool), telefones da cobrança, **inverter defaults** `CREDIARIO_NATIVE_READS`/`CREDIARIO_ERP_OUTBOX` (e `PRODUCT_NATIVE_WRITES`).
3. **PDV vivo**: customer-info, funcionarios-search, fallback do bipe.
4. **Relatórios**: saídas do site, triagem (venda 30d), intelligence ×4, faturamento drill, routing-debug, CRM histórico marcados, etiquetas da reposição, fotos do realinhamento.
5. **Menus**: remover os links das 9 telas-TRAVA (barato e elimina o grosso dos 500 visíveis); carrinhos-abandonados aponta pra fonte nativa.

Regra de ouro de TODA migração: miss do espelho = **resposta vazia ou erro honesto que SOBE** — nunca catch devolvendo vazio (foi assim que os 4 casos da família anterior nasceram).

### Onda 2 — deletar os 80 ⚰️ em PRs pequenos por módulo
`wp-db/` → `woocommerce/` → `site-publish/` → `cpf-*` → `clientes-giga` → ETL do CRM → conferidor/divergencias/sombra/erp-query → restaurações do editor → ~112 métodos do ErpService → scripts (arquivando `dump-giga.js` e `giga-etl/` úteis). Drenar os 65 jobs presos e **gatear o enqueue de réplicas natimortas** por `replicaGigaLigada()` — preservando o kind `venda` (baixa Flow).

### Onda 3 — reescrever a história
CLAUDE.md/AGENTS.md (Giga vira seção "história", com os avisos vitais da tabela acima), textos de tela (os 57 do PDV primeiro), envs letra morta fora do Railway, `.env.example`/DEPLOY/setup, `mysql2` fora do package.json por último.

---

*Auditoria executada em 03/09/2026 · workflow `enterro-wincred-auditoria` (64 agentes, verificação adversarial, crítico de completude) · achados brutos completos no journal da sessão · auditorias anteriores do tema: inventário 22/08, atestado de óbito 28/08, família "fonte morta com cara de não-existe" fechada 31/08.*
