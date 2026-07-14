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
- Sync: incremental **10min** (por DATAALT), estoque **full de hora em hora** (minuto 23 — venda no Giga muda estoque SEM tocar DATAALT), full geral **3h da manhã**.
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
| `PDV_MIRROR_READS` | on | `0` desliga leitura pelo espelho (bipe/busca voltam 100% Giga) |
| `PDV_ERP_OUTBOX` | on | `0` volta escrita da venda inline |
| `ERP_WRITE_ENABLED` / `PDV_ERP_WRITE_ENABLED` | — | shadow mode das escritas no Wincred (loga SQL sem executar) |
| `PDV_FINALIZE_ASYNC` | false | legado (só vale com outbox desligado) |

## Convenções de trabalho (Thiago)

- **SEMPRE entregar em branch + push + PR pra main** — não perguntar "commit ou testar local?". Deploy é passo manual dele. `gh` CLI NÃO está instalado — dar o link `https://github.com/trissutto/flowops-lite/pull/new/<branch>`.
- Telas com recorte de tempo: filtro **De/Até** (`type=date`) + atalhos Hoje/Ontem/7 dias/Mês — NUNCA dropdown de períodos fixos.
- Preview local: `.claude/launch.json` sobe o frontend na 3000; backend real não roda local — usar mock na 3001 (endpoints com prefixo `/api`; ver scratchpad de sessões anteriores como referência).
- PDV tema CLARO: fundo #FAFAF7, dourado como acento (#D4AF37/#B8912B/#8C7325, hover #FBF6E6), **verde #2E7D46 só pra dinheiro** (total, Finalizar). Vendedora escolhida no popup de confirmação da venda (F9/seletor de canto removidos).
- Giga `produtos`: data é `DATAALT` (única); JOIN com estoque/caixa SEMPRE via `CAST(CODIGO AS UNSIGNED)` (padding de zeros inconsistente).
- CRM: escopo de loja = `originStoreId` **OU** `targetStoreId` (cliente do site atribuído por CEP) — lista e ficha usam o MESMO critério (divergência já causou drawer travado em "Carregando...").
- Modo treinamento NUNCA toca Giga/estoque/NFC-e (flag `isTraining` + header de sessão).

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
