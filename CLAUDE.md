# FlowOps Lite — contexto do projeto (Lurd's Plus Size)

Sistema da rede de lojas **Lurd's Plus Size** (moda plus size, várias lojas físicas + e-commerce): PDV de loja, Live Commerce, CRM de clientes, crediário, integração com o ERP legado **Giga/Wincred** e com WooCommerce (lurds.com.br). Dono/operador: Thiago Rissutto.

## Stack e deploy

| Camada | Tecnologia | Onde roda |
|---|---|---|
| Frontend | Next.js 14 (`frontend/`) | Vercel (flowops-lite.vercel.app) — hard-refresh nos PCs após deploy |
| Backend | NestJS + Prisma (`backend/`) | Railway (projeto heroic-mercy) — `start:prod` roda `prisma db push` (schema aplica sozinho no deploy) |
| Banco Flow | Postgres (Railway) | fonte da verdade de vendas/CRM/live |
| ERP legado | MySQL "Giga/Wincred" | servidor dedicado KingHost (162.215.213.154), COMPARTILHADO com o WordPress |
| Realtime | socket.io (`backend/src/websocket`) | rooms por loja + admins |

Deploy do backend reinicia em ~30s — **evitar horário de loja aberta**. `JWT_SECRET` é fixo (não desloga ninguém).

## ⚠️ ARQUITETURA DE ESTABILIDADE (leia antes de mexer em qualquer coisa de venda/live)

### O problema raiz
O Giga MySQL **PENDURA** (não dá erro — `.catch` não pega) quando o firewall por IP da KingHost derruba o IP dinâmico do Railway. Isso derrubou a live de 01/07/2026. Pool em `backend/src/erp/erp.service.ts`: `connectionLimit: 15`, **`queueLimit: 0` (fila ilimitada — requests empilham e congelam o app)**, `connectTimeout: 12s`, SEM circuit-breaker (removido 24/06). A defesa é tirar o Giga do caminho crítico, não confiar em erro/timeout.

### Espelho Wincred (Postgres) — `backend/src/wincred-mirror/`
- Tabelas `wincred_produtos`, `wincred_estoque`, grupos/subgrupos/fornecedores/codigos.
- Sync: incremental **10min** (por DATAALT) para PRODUTOS, full geral **3h da manhã**.
- ⚠️ **ESTOQUE Giga→Flow está DESLIGADO** (env `ESTOQUE_SYNC_GIGA=1` reativa). Desde 14/07 o **FLOW é a FONTE do estoque** — puxar do Giga só sobrescreveria a verdade do Flow na janela da fila do outbox. O Giga recebe réplica de tudo (backup) e **ninguém digita mais no Wincred desktop** (confirmado pelo dono em 31/07), então o pull não teria informação nova pra trazer. Vale pro full **e pro trecho de estoque do incremental** (esse ficou de fora da trava até 31/07). Recuperação: botão manual da tela (`force=true`) ou a env.
- Conferência (não sync): `backend/scripts/giga-etl/divergencia-estoque.js` compara os dois bancos peça por peça. Medição de 31/07: **99,70% idênticos**, 0,1% de diferença em peças.
- Gated por env **`WINCRED_MIRROR_CRON_ENABLED=1`** (sem ela o espelho NÃO atualiza).
- **Espelha o catálogo INTEIRO** (filtro PLUS_SIZE removido em 02/07) — o fallback Giga cobre só EAN/recém-cadastrado/preço zerado.
- `codigo` normalizado SEM zeros à esquerda (`normalizeCodigo`).
- **`vendaUn` está em REAIS — NUNCA dividir por 100.** O caminho antigo do Giga parecia centavos porque o `parsePrice` remove o ponto ("80.00"→8000) e divide de volta. Dividir o Decimal do Prisma derrubou preços 100× (bug de 01/07, corrigido).
- Admin: tela `/retaguarda/wincred-mirror` (status + botões de sync) e `POST /admin/wincred-mirror/sync/all` (primeira carga, ~2-4min).

### Leituras do PDV pelo espelho — `WincredCatalogService`
Bipe (`addItem`, `GET /pdv/product`) e busca do dropdown (`GET /products/erp-search`) leem o espelho primeiro; fallback pro Giga ao vivo em: miss (não-plus/EAN/recém-cadastrado), preço zerado (Giga tem fallback via `caixa`), erro. Kill-switch: `PDV_MIRROR_READS=0`. `StockService` também cai pro espelho se o Giga falhar.

### Outbox de escrita no ERP — `backend/src/pdv/erp-outbox.service.ts`
A venda **finaliza só no Postgres** e enfileira job em `erp_outbox`; cron de 30s grava no Wincred (caixa via `gravarVendaPdv` + baixa de estoque via `decreaseStock`) com retry/backoff (30s→1h, ~3 dias). Idempotência: `caixaDoneAt`/`stockDoneAt` no job (retry NUNCA duplica INSERT na caixa) + `sale.stockDecreasedAt` (compartilhado com o `POST /pdv/backlog/reconcile`, que segue como rede de segurança). Admin: `GET /pdv/erp-outbox` e `POST /pdv/erp-outbox/retry`. Kill-switch: `PDV_ERP_OUTBOX=0` (volta ao inline legado).

### Pagamento da Live — SERVER-SIDE, sem polling no navegador
O flood que derrubou a live: polling per-browser no PagBank a cada 6s empilhando ciclos → REMOVIDO. A confirmação agora é `LivePdvPayReconcileCron` (15s): lê carrinhos `awaiting_payment` (1 query, máx 50/ciclo, guard de overlap), roda `checkPayment` (DB primeiro — o webhook já gravou; gateway ao vivo só com throttle de 8s/carrinho) → `onCartPaid` → socket `live-pdv:cart-paid` + ordens de separação. Botão manual = fallback humano. **Decisão do dono (02/07): manter assim; NÃO voltar polling no front.** Evolução futura: webhook chamar `onCartPaid` direto e o cron cair pra 60s.

### Rastreio do objeto — `backend/src/tracking/`
Fonte única de "onde a peça está" e de "chegou". `TrackingService` consulta em **cascata**: SRO dos Correios (contrato próprio) → **Mais Envios** (a maioria das etiquetas) → LinkeTrack (só se houver token). Nenhum provedor cobre tudo: objeto de outro contrato volta `SRO-009` com zero eventos. `RastreioSyncCron` (30min) mantém a tabela `rastreio_objetos`, e as LISTAS leem de lá — nunca da API. Quando o rastreio confirma a entrega, o pedido vira `delivered` + `deliveredAt` (**pedido dividido só fecha quando TODAS as caixas chegam**).
⚠️ `Accept-Language: pt-BR` é obrigatório no SRO — sem ele, HTTP 400 em 100% das chamadas. Era essa a causa de 0 pedidos entregues em 90 dias e de 3 avisos "seu pedido chegou" em 22.678 pedidos (18/08).
⚠️ **Regra da estreia**: objeto que entra no radar JÁ entregue é notícia velha — aparece na tela mas NÃO dispara aviso pra cliente.

### GigaMirrorService (financeiro) — `backend/src/financeiro/giga-mirror.service.ts`
Cron de 1h espelha transferências/vendas/estoque pro financeiro. Conta corrente lê 100% do espelho.

### O que AINDA bate no Giga ao vivo (pendente de migração)
- **Crediário**: `listAllOpen` (runReadOnly até 5.000 linhas/30s — a query mais pesada do sistema) + `markCrediarioParcelaPaid/Unpaid` + `createCrediarioParcelas` na venda.
- **Devoluções/trocas/marcados**: `increaseStock`/`insertCaixaMarcado` síncronos.
- **Consulta de loja** (`searchByRef` etc.), realinhamento, royalties (`getSalesGrossByStores`), site-publish, pick-orders (EANs).
- **Cadastro de produtos ESCREVE no Giga** (`inserirProdutosBatch/Grupo/Subgrupo`) — mas o CÓDIGO do produto novo já é 100% do Flow: EAN-13 prefixo 8 gerado pela `EanSequence` (Postgres, transação) em `product-registration/`; a tabela `codigos` do Giga NÃO é consultada pra sequência (só espelhada pra lookup de EAN antigo). Grupos/subgrupos ainda são do Giga.

### Plano "sair da Giga" (ordem)
1. ✅ bipe+busca espelho · 2. ✅ outbox venda · 3. ✅ estoque hourly + fallback · 4. ✅ filtro PLUS_SIZE removido (02/07) · 5. espelhar `movimento` (crediário) · 6. devoluções/marcados no outbox · 7. `queueLimit` finito + timeout por query · 8. 🔶 tabela nativa `Product` criada (13/07, flags `PRODUCT_NATIVE_READS`/`PRODUCT_NATIVE_WRITES`; gerador de código já era nativo via EanSequence) — falta migrar leituras restantes (site-publish, pick-orders, realinhamento) e grupos/subgrupos · 9. desligar.

## ENV flags importantes (Railway → flowops-lite → Variables)

| Flag | Default | Efeito |
|---|---|---|
| `WINCRED_MIRROR_CRON_ENABLED` | off | `1` liga os crons do espelho (OBRIGATÓRIA em prod) |
| `ESTOQUE_SYNC_GIGA` | **off** | `1` reativa o pull de estoque Giga→Flow (full + incremental). **Deixar off**: o Flow é a fonte do estoque desde 14/07; ligar sobrescreve a verdade do Flow na janela da fila |
| `PDV_MIRROR_READS` | on | `0` desliga leitura pelo espelho (bipe/busca voltam 100% Giga) |
| `PDV_ERP_OUTBOX` | on | `0` volta escrita da venda inline |
| `MARCADOS_FLOW_FIRST` | on | `0` volta o marcado a gravar no Giga PRIMEIRO — incluindo o `throw` que derrubava a operação inteira com o Giga fora. Com a flag ligada (padrão) o Flow grava, o Giga é réplica via outbox (`marcado_criar`/`marcado_remover`) |
| `CREDIARIO_FLOW_FIRST` | on | `0` volta a criar as parcelas direto na `movimento` do Giga (síncrono — não vende a crediário com o Giga fora). Ligada: parcelas nascem em `crediario_parcelas` com REGISTRO/CONTROLE da faixa **900.000.000+**, réplica via outbox `crediario_criacao` |
| `CATEGORIA_FLOW_FIRST` | on | `0` volta grupo/subgrupo a numerar com `MAX+1` no Giga. Ligada: faixa **9000+** do Flow, réplica via outbox `categoria_criar` |
| `ERP_STOCK_WRITES_ASYNC` | on | `0` volta TODAS as escritas de estoque secundárias (devoluções, trocas, marcados, realinhamento) ao inline — espera o Giga |
| `ERP_STOCK_WRITEBACK_GIGA` | **off** | `1` volta o Giga a carimbar o saldo DELE por cima de `giga_estoque`/`wincred_estoque` (write-through do `decreaseStockOnce`/`increaseStockOnce` + `refreshMirrorStock` da grade da live). Era o caminho pelo qual toda divergência Giga×Flow virava "correção" silenciosa segundos DEPOIS do movimento — bipe da peça no pedido e o saldo voltava (caso BMM-100 VINHO 52, São José, 19/08). Desde 22/08 a MESMA flag governa os caminhos MANUAIS de adotar o saldo do Giga: `puxarDoGiga`/`importarNegativos` do conferidor (botões saíram da tela) e `fullSyncFromGiga` do stock-mirror. **Deixar off**: o Flow é a fonte do estoque desde 14/07 |
| `ERP_WRITE_ENABLED` / `PDV_ERP_WRITE_ENABLED` | — | shadow mode das escritas no Wincred (loga SQL sem executar) |
| `PDV_FINALIZE_ASYNC` | false | legado (só vale com outbox desligado) |
| `MAISENVIOS_FORCA_SEDEX` | **off** | `1` volta a etiqueta do Mais Envios a sair SEDEX SEMPRE (comportamento até 15/08, que postava expresso em pedido de PAC pago — 11 casos em 180 dias). Off = a etiqueta segue o serviço que a cliente pagou, igual ao caminho Correios |
| `SITE_PROMO_50` | on | `0` desliga a promoção de 50% AUTOMÁTICA do site (peça de MODA cadastrada até 31/12/2023 — a mesma regra do caixa, `common/promo-julho.ts`). O `precoPromo` digitado por peça continua valendo. Quem decide é o `PromoSiteService`, consultado pelos DOIS lados: a vitrine que mostra e a trava do carrinho que cobra — divergir aí faz o checkout recusar o pedido |
| `PAGARME_LINK_HORAS` | 72 | Validade do link de pagamento da loja (era 24h chumbado no front). Teto da Pagar.me = 7 dias (168). A janela da lista "links pendentes" do PDV acompanha (+24h) |
| `PONTO_IP_CHECK` | on | `0` desliga a regra "celular só bate ponto no WiFi da loja" (batida `pwa_selfie` vs IPs do heartbeat do PDV Electron; fail-open se não há IP <48h) |
| `RASTREIO_SYNC` | on | `0` desliga o acompanhamento do objeto (cache `rastreio_objetos` para de atualizar; a tela mostra o último dado conhecido e nenhum pedido vira ENTREGUE sozinho) |
| `RASTREIO_SYNC_LOTE` | 60 | Teto de objetos por ciclo (cron de 30min). A escada por idade já rarefaz o que é velho: até 3 dias de hora em hora, 4-10 dias de 4h, 11-30 dias 1x/dia, entregue nunca mais |
| `META_ADS_TOKEN` / `META_ADS_CONTAS` | — | Espelho de gasto do Meta (`meta_ads_gasto_dia`, cron `7 * * * *`). Sem elas a linha do dinheiro do Meta **some** da cascata — nunca mostra zero |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | — | Espelho de gasto/conversão do Google (`google_ads_gasto_dia`, cron `17 * * * *`). Token do **MCC**, aprovado pelo Google — é o passo que depende do dono |
| `GOOGLE_ADS_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` | — | OAuth de leitura (escopo `adwords`). O refresh token não vence sozinho, mas morre se a senha da conta Google mudar |
| `GOOGLE_ADS_CONTAS` | — | `customer_id` sem hífen, separados por vírgula. Contas da conexão: `8681042744` (Ecomm 2024), `8925231246` (Plus Size Ecomm), `9564998046` (Lojas físicas) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | — | Id do MCC (provavelmente `1458258153`). Só quando a conta lida está dentro de um centro de clientes |
| `GOOGLE_ADS_API_VERSION` | `v25` | Versão da API. Vive ~1 ano e o endpoint some com 404 seco — subir aqui evita deploy de código |

## Convenções de trabalho (Thiago)

- **SEMPRE entregar em branch + push + PR pra main** — não perguntar "commit ou testar local?". Deploy é passo manual dele. `gh` CLI NÃO está instalado — dar o link `https://github.com/trissutto/flowops-lite/pull/new/<branch>`.
- Telas com recorte de tempo: filtro **De/Até** (`type=date`) + atalhos Hoje/Ontem/7 dias/Mês — NUNCA dropdown de períodos fixos.
- Preview local: `.claude/launch.json` sobe o frontend na 3000; backend real não roda local — usar mock na 3001 (endpoints com prefixo `/api`; ver scratchpad de sessões anteriores como referência).
- PDV tema CLARO: fundo #FAFAF7, dourado como acento (#D4AF37/#B8912B/#8C7325, hover #FBF6E6), **verde #2E7D46 só pra dinheiro** (total, Finalizar). Vendedora escolhida no popup de confirmação da venda (F9/seletor de canto removidos).
- Giga `produtos`: data é `DATAALT` (única); JOIN com estoque/caixa SEMPRE via `CAST(CODIGO AS UNSIGNED)` (padding de zeros inconsistente).
- CRM: escopo de loja = `originStoreId` **OU** `targetStoreId` (cliente do site atribuído por CEP) — lista e ficha usam o MESMO critério (divergência já causou drawer travado em "Carregando...").
- Modo treinamento NUNCA toca Giga/estoque/NFC-e (flag `isTraining` + header de sessão).

## Fila de tarefas da loja + ciclo da remessa (11/08)

**Diretriz de UX (dono):** a loja não escolhe tela — a home `/minha-loja` abre com a fila **"O QUE FAZER AGORA"** (pedidos a separar, caixas abertas, remessas chegando, peças de realinhamento). Vermelho = parado, amarelo = a fazer, teto de 10 linhas + "ver as outras N". Toda tela nova pra loja segue esse padrão: **tarefa clicável > menu**, e nenhum passo manual entra sem alerta de esquecimento.

**Regra de ouro contra alarme falso:** tarefa só entra se for pendência real PRA AQUELA loja — alarme falso mata a confiança na fila inteira. Foi o que aconteceu com "Gerar etiqueta" (removida em 11/08): a medição mostrou que só **5 de 203** remessas em trânsito têm etiqueta do sistema e mesmo assim **639 caixas chegaram em 30 dias** (média 4,1 dias). Etiqueta é EXCEÇÃO na operação — quem precisa gera pelo painel "Caixas fechadas" da tela Realinhar.

**O ciclo da remessa tem 2 pontas, e as duas somem em silêncio:**
1. **Caixa ABERTA** — o estoque só sai da origem no **"Fechar e enviar"**. Imprimir etiqueta/PDF com a caixa aberta abre o modal "Etiqueta na mão! Fechar agora?" (casos Piracicaba REM-1116 e Santos REM-732, esta 8 dias aberta).
2. **Caixa EM TRÂNSITO** — a peça só volta a existir quando o destino **dá entrada**. Entre um e outro ela não está no estoque de ninguém: some da Consulta e não vende no site. Em 11/08 havia **198 remessas / 1.057 peças** nesse limbo (a mais antiga de 15/05).

**Mutirão da matriz** — `/retaguarda/remessas` mostra as caixas paradas (3+ dias) com ação de 1 clique: **"Chegou"** (`POST /realignment/shipments/admin/:id/receber`) e **"Nunca saiu"** (`POST .../reabrir`). As duas delegam pros mesmos métodos da loja, resolvendo a loja pela própria remessa — mesmo efeito no estoque, sem duplicar lógica. Lista: `GET /realignment/shipments/admin/paradas?minDias=3`.

**Volume normal da rede (medido 30d):** 777 remessas / 9.293 peças — 594 TRANSFERENCIA + 183 REALINHAMENTO. Pedido do SITE é minoria das paradas (38 remessas, 71 peças).

## Mapa rápido dos módulos (backend/src)

- `pdv/` — PDV loja física: vendas (`pdv.service`), outbox, devoluções (`returns`), marcados, crediário print, NFC-e, caixa/sangria.
- `live-pdv/` — Live Commerce da apresentadora: grade cor×tamanho, carrinhos por @, PIX PagBank/link Pagar.me, reconcile de pagamento, separação por loja de origem.
- `wincred-mirror/` — espelho + `WincredCatalogService` (leituras do PDV).
- `erp/` — pool MySQL Giga + todas as queries legadas (5.000+ linhas).
- `financeiro/` — GigaMirror, conta corrente (espelho), royalties (ainda Giga vivo).
- `customers/` — CRM (base mestra `Customer`, dedup por telefone/@, clientes da live gravam com origem 'live').
- `products/`, `stock/`, `routing/`, `pick-orders/`, `realignment/` — consulta/vitrine/pedidos site/realinhamento (maioria ainda Giga vivo).

## Histórico de incidentes (não repetir)

- **Live 01/07**: Giga pendurado (busca) + polling PagBank empilhando → derrubou a live várias vezes. Origem das mudanças de arquitetura acima.
- **Preço ÷100 (01/07)**: espelho dividia `vendaUn` por 100 — blusa R$ 80 virou R$ 0,80 no bipe. Vendas de teste afetadas foram canceladas.
- **Ficha do CRM travada**: lista mostrava cliente que a ficha negava (404) + drawer sem catch → "Carregando..." eterno.
- **Treino baixou estoque real** (jun/26, loja 15): backfill sem filtro `isTraining` — hoje filtrado.
- **Sorocaba multi-PC** (jun/26): reciclagem de venda órfã fazia 2 PCs controlarem a mesma venda → removida (sempre cria venda nova).
- **Socket com token velho** (jun/26): singleton reaproveitava JWT antigo → loja via pedidos de outra loja. Fix: compara token e reconecta.
