# FlowOps Lite — contexto do projeto (Lurd's Plus Size)

Sistema da rede de lojas **Lurd's Plus Size** (moda plus size, várias lojas físicas + e-commerce próprio): PDV de loja, Live Commerce, CRM de clientes, crediário, catálogo/vitrine, logística e financeiro. Dono/operador: Thiago Rissutto.

**O sistema é autossuficiente desde 27/08/2026.** O WordPress/WooCommerce hospedado na KingHost foi APAGADO nessa data, e o MySQL do ERP Giga/Wincred (que ficava no host do fornecedor, **não** na KingHost) parou de aceitar o IP do Railway em 25/08 — **nenhum dos dois é alcançável, e não existe caminho de código que tente** (4 trancas em `backend/src/common/replica-giga.ts`). Hoje a fonte da verdade de **estoque, venda, catálogo, crediário, clientes e financeiro** é o **Postgres do Flow**, e só ele. Ver a seção [O ERP legado — encerrado](#o-erp-legado--encerrado-em-27082026) antes de tocar em qualquer coisa que tenha `giga`/`wincred` no nome.

## Stack e deploy

| Camada | Tecnologia | Onde roda |
|---|---|---|
| Frontend | Next.js 14 (`frontend/`) | Vercel (flowops-lite.vercel.app) — hard-refresh nos PCs após deploy |
| E-commerce | **Next.js 15** (`ecommerce/`) | Vercel — lurds.com.br (site próprio). ⚠️ Major diferente do `frontend/`: `params`/`searchParams` são assíncronos aqui |
| PDV desktop | Electron (`desktop-app/`) | PCs de loja — manda o heartbeat de IP que a regra de ponto usa |
| Backend | NestJS + Prisma (`backend/`) | Railway (projeto heroic-mercy) — `start:prod` roda `prisma db push` (schema aplica sozinho no deploy) |
| Banco Flow | **Postgres (Railway)** | **fonte única da verdade** — estoque, venda, catálogo, crediário, CRM, live, financeiro |
| Realtime | socket.io (`backend/src/websocket`) | rooms por loja + admins |

Deploy do backend reinicia com downtime (~40-60s) — **evitar horário de loja aberta** (ver janela de deploy nas convenções). `JWT_SECRET` é fixo (não desloga ninguém).

## 🚨 AVISOS VITAIS — leia antes de mexer/limpar env do ERP

O nome de várias envs herdou a era do ERP e **mente sobre o que elas fazem**. Antes de "limpar env do Giga", leia esta tabela inteira. **Nunca varra env por prefixo `ERP_`/`GIGA_`/`WINCRED_`.**

| Env | O nome sugere | O que ela REALMENTE governa hoje |
|---|---|---|
| `ERP_WRITE_ENABLED` | escrita no ERP morto | **A SAÍDA DA PEÇA no pedido do site e na live.** É a porta crua do **bipe da separação** (`pick-scan.service.ts` → `skipReason()` devolve `'shadow'` e nada sai do estoque), do estorno de card inteiro, do `approveDebit`/auto/lote do pick-order e da baixa da peça da live. Desligar não para a venda da loja física — para a peça de sair: ela vai na sacola da cliente e o estoque continua dizendo que está na arara. **Fica LIGADA (`true`) e não se mexe.** Quem quiser desligar só a baixa no bipe usa `PICK_SCAN_DEBIT=0` (`pick-scan.service.ts`, default `1`, mesmo estrago com motivo `'killswitch'`). ⚠️ A falha dela é CALADA na operação: a pista é o bipe gravado com baixa pulada (`debitSkippedReason='shadow'`) na linha do tempo do pedido. As duas entraram no painel de flags na Onda 3 — com `ERP_WRITE_ENABLED` off o boot agora grita em `error`. |
| `PDV_ERP_OUTBOX` | fila de réplica pro ERP | O job `kind='venda'` do `erp_outbox` é hoje o **VEÍCULO da baixa de estoque no Flow** (`erp-outbox.service.ts` roda `erpStepBaixarEstoque` mesmo com a réplica desligada). `0` **NÃO desliga a baixa** — ela volta a rodar inline na finalização (`postFinalizeErpSync`) —, mas tira a fila com retry: a falha vira só um `logger.warn`, `stockDecreasedAt` fica nulo e a venda segue sem baixa até alguém rodar o reconcile. O que não pode acontecer é o **cron de 30s ser deletado** junto com os processors de réplica na faxina. |
| `WINCRED_MIRROR_CRON_ENABLED` | crons do ERP | Gateia crons que hoje são **100% Postgres**: `product-native` (espelho→tabela nativa `product`, INSERT..SELECT dentro do banco) e `crediario-mirror` (que agora mantém `wincred_movimento_aberto` em dia a partir da tabela NATIVA `crediario_parcelas`). Sem ela os espelhos envelhecem calados. **OBRIGATÓRIA em produção.** |
| `ERP_GIGA_OFF`, `ERP_REPLICA_GIGA`, `ERP_PULL_GIGA`, `KINGHOST_WP` | trancas | São **A TRANCA** (`backend/src/common/replica-giga.ts`). Ficam pra sempre. **Nunca religar** — não há servidor alcançável; religar só reintroduz espera de 12s por conexão em cada chamada e crons que apagariam dado bom. |
| `ERP_MULTA_PERCENT` | coisa do ERP | É **negócio VIVO do crediário** (`crediario-baixa.service.ts`, default 2,0%). Não tem nada a ver com o ERP morto. |

### Defaults invertidos na Onda 1 (03/09) — e por quê

`CREDIARIO_NATIVE_READS`, `CREDIARIO_ERP_OUTBOX`, `PRODUCT_NATIVE_READS`, `PRODUCT_NATIVE_WRITES` e `GIGA_MIRROR_READS` eram **default-OFF no código** e `=1` no Railway. Isso fazia sentido enquanto existia um ERP atrás pra segurar a queda: default-off = "só liga quando provar". Depois de 27/08 não há mais nada atrás — **default-off virou alçapão** se a env sumisse do Railway (novo ambiente, variável apagada por engano):

- as duas **LEITURAS** falham **em silêncio** — `GIGA_MIRROR_READS` off devolve Map VAZIO sem erro (`erp.service.ts`: `if (!this.pool) return out;`) e `CREDIARIO_NATIVE_READS` off deixa a parcela paga continuar aberta sem erro nenhum;
- as **ESCRITAS** falham **alto**, e é o sintoma que aparece primeiro: `PRODUCT_NATIVE_WRITES` off faz TODA edição de produto virar 500, e `CREDIARIO_ERP_OUTBOX` off manda a baixa inline pro MySQL morto — a vendedora fica esperando um servidor que não responde pra dar uma baixa que já estava gravada.

Hoje o default no código é **LIGADO** e concorda com produção. `=0` ainda desliga, mas não use.

**Onde conferir o estado EFETIVO** (abrir o `.ts` mostra o DEFAULT, não o que o Railway tem — foi esse o erro de diagnóstico de 25/07): **`GET /api/health/migracao`**, aberto de propósito SEM login, responde o que está valendo AGORA. No boot a mesma coisa sai no log do Railway com o prefixo `MigrationFlags`.

⚠️ Esperado: quando a env não existe no Railway, o boot carimba `⚠ LIGADA POR OMISSÃO` nessas cinco. É informação, não alarme — depois da inversão o default LIGADO é a decisão, e o alçapão seria o contrário. (O painel foi ajustado na Onda 3 pra dizer isso: antes ele mandava "comece desligando estas" quando algo sumisse da tela, conselho que hoje faria o dado sumir de vez.)

## ⚠️ ARQUITETURA DE ESTABILIDADE (leia antes de mexer em venda/live/estoque)

### O Flow é a fonte — a "constituição de 14/07"

Toda escrita de estoque aplica **primeiro no Postgres**, na hora: `erp.decreaseStock`/`increaseStock` chamam `mirrorStockApplyDelta`, que atualiza `giga_estoque` **e** `wincred_estoque` no mesmo movimento. Com a tranca fechada — o normal — **acaba aí**: os dois métodos ainda têm um ramo `replicaGigaLigada()` embaixo, mas ele nunca é alcançado. Grade da live, separação e PDV veem em segundos. `applyStockDeltaInTx` faz o mesmo **dentro da transação do caller** — é assim que a linha do `pick_order_scans` e a saída da peça commitam juntas (bipe registrado sem estoque baixado deixa de existir).

🚨 **`success: true` NÃO quer dizer "todos os itens saíram".** Dentro da transação (`applyStockDeltaInTx`) o erro **SOBE** e derruba o commit do caller, de propósito. **Fora dela**, a falha de um item vira log `[flow-estoque]` e o item simplesmente não entra no `applied` — o retorno continua `success: true`. Quem chama tem que conferir o **`applied` contra o que pediu**, nunca o `success`. Hoje `erpStepBaixarEstoque` só testa `r.success` e carimba `stockDecreasedAt` — é o mesmo padrão "carimbou feito com o estoque parado" que a Onda 1 consertou no estorno master, ainda vivo no caminho da venda.

⚠️ **Regra de ouro de qualquer migração/leitura**: miss do espelho = **resposta vazia ou erro honesto que SOBE**. Nunca `catch` devolvendo vazio — foi assim que nasceu a família inteira de "fonte morta com cara de não-existe" (peça que existe aparecendo como esgotada, parcela paga voltando a dever).

### Leituras do estoque — `StockService` + `WincredCatalogService`

`wincred_estoque` é a fonte de leitura (`STOCK_WINCRED_FIRST`, on) — a **MESMA** tabela que site e PDV leem. O routing decidia por outra (`giga_estoque` via ErpService) e podia ver um número que ninguém mais via. Cache in-process de 30s; o routing pede `fresh: true` (decisão de qual loja separa não pode usar número velho).

O **bipe** (`getPdvProductInfo`) é **100% Postgres desde a Onda 1**: EAN legado resolve pela coluna `ean` das próprias tabelas, preço zerado volta como ENCONTRADO (a ponta avisa) e erro do espelho **sobe** como 500 honesto em vez de virar "produto não existe" com a cliente na frente.

- `codigo` normalizado SEM zeros à esquerda (`normalizeCodigo`).
- **`vendaUn` está em REAIS — NUNCA dividir por 100.** Dividir o Decimal do Prisma derrubou preços 100× (bug de 01/07, corrigido).
- Cadastro do produto lê da tabela **nativa `product`** (`PRODUCT_NATIVE_READS`, on); estoque e EAN continuam nos espelhos.
- **Quem alimenta os espelhos hoje**: ninguém "repuxa" `wincred_produtos` de lugar nenhum — quem escreve nele é o próprio Flow (`product-registration.service.ts`, `products-editor.service.ts`), e `wincred_estoque` é mantido pelo delta de cada movimento (`mirrorStockApplyDelta`). Admin: `/retaguarda/wincred-mirror` mostra contagem e idade de cada tabela; **os botões de importação continuam na tela mas são resquício — respondem erro** (os crons de 10min/3h do `wincred-mirror.cron.ts` são no-op atrás de `pullGigaLigado()`). Não use "Sincronizar tudo" como recuperação: saldo errado se resolve contando a peça e corrigindo no Flow.

### Outbox — `backend/src/pdv/erp-outbox.service.ts`

A venda **finaliza no Postgres** e enfileira job em `erp_outbox`; cron de 30s processa. Com a réplica desligada (`ERP_REPLICA_GIGA` off — o normal), **todo kind é descartado com motivo gravado** (`status: done`, nunca DELETE — a linha fica pra auditoria) **exceto `venda`**, que carrega o passo `erpStepBaixarEstoque`: esse é do Flow e **não é pulado pela réplica desligada**. Idempotência por `stockDoneAt` no job + `sale.stockDecreasedAt`. Venda cancelada, de treino ou sumida fecha o job como `done` sem baixar nada (correto).

⚠️ **Se a baixa falhar**, o job re-agenda com backoff (30s→1h, até ~3 dias / 100 tentativas) e depois vira `failed`. Nesse estado a **venda está fechada com o estoque parado e ninguém é avisado** — não há alarme, só a linha na fila. Onde olhar: `GET /pdv/erp-outbox` mostra a fila, `POST /pdv/erp-outbox/retry` re-enfileira, e a varredura retroativa é `GET /pdv/admin/reconcile-stock/preview` (confere) + `POST /pdv/admin/reconcile-stock/execute` (aplica), que pega venda finalizada sem `stockDecreasedAt` e ignora treino. Kill-switch: `PDV_ERP_OUTBOX=0` (ver avisos vitais — não desligue).

### Pagamento da Live — SERVER-SIDE, sem polling no navegador

O flood que derrubou a live de 01/07: polling per-browser no PagBank a cada 6s empilhando ciclos → REMOVIDO. A confirmação é `LivePdvPayReconcileCron` (15s): lê carrinhos `awaiting_payment` (1 query, máx 50/ciclo, guard de overlap), roda `checkPayment` (DB primeiro — o webhook já gravou; gateway ao vivo só com throttle de 8s/carrinho) → `onCartPaid` → socket `live-pdv:cart-paid` + ordens de separação. Botão manual = fallback humano. **Decisão do dono (02/07): manter assim; NÃO voltar polling no front.**

### Rastreio do objeto — `backend/src/tracking/`

Fonte única de "onde a peça está" e de "chegou". `TrackingService` consulta em **cascata**: SRO dos Correios (contrato próprio) → **Mais Envios** (a maioria das etiquetas) → LinkeTrack (só se houver token). Nenhum provedor cobre tudo: objeto de outro contrato volta `SRO-009` com zero eventos. `RastreioSyncCron` (30min) mantém a tabela `rastreio_objetos`, e as LISTAS leem de lá — nunca da API. Quando o rastreio confirma a entrega, o pedido vira `delivered` + `deliveredAt` (**pedido dividido só fecha quando TODAS as caixas chegam**).
⚠️ `Accept-Language: pt-BR` é obrigatório no SRO — sem ele, HTTP 400 em 100% das chamadas. Era essa a causa de 0 pedidos entregues em 90 dias e de 3 avisos "seu pedido chegou" em 22.678 pedidos (18/08).
⚠️ **Regra da estreia**: objeto que entra no radar JÁ entregue é notícia velha — aparece na tela mas NÃO dispara aviso pra cliente.

### Financeiro — `backend/src/financeiro/giga-mirror.service.ts`

Nome herdado; hoje o serviço **espelha o próprio Flow**. Cron de 1h roda `espelharCaixaMovDoFlow`: as vendas e devoluções do `pdv_sales`/`pdv_returns` viram linhas de `giga_caixa_mov` (registro sintético `f<md5>`/`r<md5>`, corte em 25/08/2026 — antes disso a tabela é história e ninguém toca). **É a espinha dos relatórios**: faturamento, DRE, Inteligência, metas e o **ranking de vendedoras do PDV** leem daí. ⚠️ A **COMISSÃO não** — ela conta direto em `pdv_sales`/`pdv_returns` (`commission-engine.service.ts`); quem for debugar diferença de comissão está no espelho errado. **Royalty/franquias** leem a outra tabela, `giga_caixa_diario` (`conta-corrente.service.ts`, `franquias.service.ts`), montada por `vendaDiariaDoFlow`. Conta corrente lê 100% do espelho.

🚨 **`syncCaixa` faz `deleteMany({})` da `giga_caixa_diario` INTEIRA a cada hora** e recria com o que a fonte devolver. Na primeira execução com a fonte nova isso já apagou de jan/2025 a abr/2026 (7.678 → 921 linhas); hoje só não repete porque `vendaDiariaDoFlow` é uma **UNIÃO** (venda do Flow onde existe + histórico remontado do próprio `giga_caixa_mov`). E essa tabela é **A BASE DO ROYALTY** (agosto: R$ 102,6 mil → R$ 114,7 mil depois da decisão do dono de 27/08). Quem mexer em `vendaDiariaDoFlow` sem saber apaga histórico de royalty de novo, calado.

Os trechos que ainda PUXARIAM do ERP (`syncTransferencias`, `syncItens`, `syncCaixaMovRange`, `syncFuncionarios`, `syncProdutos` e o ramo de pull do `syncCaixa`) estão atrás de `pullGigaLigado()` e são no-op — **preservam o último retrato** em vez de apagar com um SELECT vazio.

### Crediário — nativo no Postgres

São **duas tabelas** e vale saber qual é qual: a **NATIVA** é `crediario_parcelas` (onde a parcela nasce e onde a ficha da cliente lê); o **ESPELHO DAS ABERTAS** é `wincred_movimento_aberto` (o que a tela de recebimentos/cobrança lê).

Parcelas nascem em `crediario_parcelas` (faixa REGISTRO/CONTROLE **900.000.000+**, `CREDIARIO_FLOW_FIRST`); `CREDIARIO_NATIVE_READS` liga as leituras nativas.

🚨 **A baixa tem write-through: tira a parcela do espelho NA HORA** (`marcarPagasNoEspelho`, chamado pelo `crediario-baixa`). É essa invariante — **"está no espelho" = "está em aberto AGORA"** — que impede BAIXA DUPLA. Não remova o write-through achando que o cron cobre: sem ele abre uma janela de 10 minutos pra cobrar a mesma parcela duas vezes.

O cron `crediario-mirror-abertas` (10min) roda `espelharDaNativa()` e **cobre só o resto**: lê da nativa apenas as parcelas ABERTAS e não canceladas (`pago:false, cancelado:false` — a tabela inteira tem ~711 mil linhas) e, desde 01/09, **grava só a DIFERENÇA** (`diffEspelhoAbertas`) em vez de replace — o replace somava ~12,6 milhões de escritas/dia. Acima de 30% de mudança cai num full replace de segurança. Guarda: leitura vazia NÃO substitui espelho cheio.

Fora do espelho, `previewBaixa` ainda **confere a nativa antes de negar** — é a janela da parcela nascida no Flow há menos de 10min, e é a aplicação concreta da regra de ouro do erro honesto.

O cron `crediario-nativo-sync` das 04:10 é **no-op** — ele apagaria as parcelas com `flowIsSource=false` e recarregaria de uma fonte que não recebe mais as baixas: **cliente que pagou hoje voltaria devendo amanhã**.

## O ERP legado — encerrado em 27/08/2026

> Esta seção é **história**. Nada aqui roda. Ela existe pra quem abrir o repo daqui a um ano e perguntar "por que essas tabelas se chamam `giga_*` e `wincred_*`?".

**O que era.** Giga/Wincred era um ERP desktop com banco **MySQL no host do FORNECEDOR** (`mysql.gigasistemas.com.br` — Gigasistemas). Por anos foi a fonte de catálogo, estoque, caixa e crediário — o Flow nasceu ao lado dele e foi migrando por partes. ⚠️ **Eram duas máquinas diferentes**: o `162.215.213.154` era o servidor da **KingHost**, onde vivia o WordPress/WooCommerce do site velho. A doc antiga dizia que os dois dividiam a hospedagem e isso já custou um commit errado — em 22/08 o log de produção mostrou o `ErpService` conectando e gravando venda enquanto o `WpDbService` levava `EHOSTUNREACH 162.215.213.154:3306`. Um responder e o outro não é prova de endereços diferentes.

**Por que morreu.** O MySQL **PENDURAVA** (não dava erro — `.catch` não pegava) quando o firewall por IP derrubava o IP dinâmico do Railway: cada chamada segurava uma vaga do pool por 12s e o app congelava. Foi assim que a live de 01/07/2026 caiu várias vezes. A partir de **25/08 18:09** o servidor do ERP passou a recusar o login do Railway de vez (`Access denied for user 'gigasistemas21'@...`) — em 27/08 isso era **262 de 500 linhas** do log de produção. Em **27/08 o dono encerrou** ("já saímos dele faz um mês"): a **KingHost apagou o WordPress**, e o caminho do sistema até o MySQL do fornecedor foi trancado no código. A máquina do fornecedor não é "inexistente" — ela é **inalcançável pelo sistema** (o firewall recusa o IP do Railway, e as 4 trancas abaixo impedem até a tentativa). O **dump completo (37/37 tabelas) foi tirado de lá em 28/08**, pelo IP residencial do dono, e é o acervo.

**Como está trancado.** `backend/src/common/replica-giga.ts` tem 4 guards, cada um com o incidente que o motivou:

| Guard | Env | O que impede |
|---|---|---|
| `gigaDesligado()` | `ERP_GIGA_OFF` (default **1**) | O pool MySQL **nem é criado** (guard no `onModuleInit` do `erp.service.ts`). `this.pool` fica nulo e todo método que o consulta sai na hora, sem esperar 12s. |
| `replicaGigaLigada()` | `ERP_REPLICA_GIGA` | Nada é copiado pro ERP. O outbox descarta a réplica com motivo gravado. |
| `pullGigaLigado()` | `ERP_PULL_GIGA` | Nenhum cron puxa dado de lá. Impede o pior caso: `deleteMany` + recarga de uma fonte parada apagando a verdade do Flow. |
| `wordpressLegadoLigado()` | `KINGHOST_WP` | Nada bate no WP/WC morto (poller de pedidos, sync de conteúdo, fotos antigas). |

**O nome das tabelas é herança, não endereço.** `wincred_produtos`, `wincred_estoque`, `giga_estoque`, `giga_caixa_mov`, `giga_caixa_diario`, `giga_produto`, `wincred_movimento_aberto` são **tabelas nativas do Postgres do Flow**, hoje alimentadas **pelo próprio Flow**. Elas NÃO falam com ERP nenhum. Nunca escreva na doc, no comentário ou na tela que um dado "vem do Giga" — não vem.

**Espelhos congelados (pendência conhecida, não defeito novo):** `wincred_clientes` e `wincred_funcionarios` pararam no último sync de 25/08 — nome/telefone de cliente de crediário só existiam lá. Cliente novo entra sem telefone na tela de recebimentos. A fonte definitiva é a base `Customer` do Flow; a migração está pendente.

**Onde está o acervo.** `backend/scripts/_arquivo-giga/` — a ferramenta e o runbook do **backup final** do MySQL (inventário, dump, restore, verificação), com README explicando cada passo. O runbook completo é `docs/RUNBOOK-SAIDA-KINGHOST.md`. É por aí que se começa se um dia alguém precisar restaurar o dump pra responder uma pergunta de auditoria. `mysql2` ainda está no `package.json` porque o `ErpService` (toco de ~10,6k linhas em desmonte) ainda dá `import` — sai na faxina final.

### As 3 ondas do enterro

| Onda | Quando | PR | O quê |
|---|---|---|---|
| Censo | 03/09 | — | Auditoria de 256 achados (23 TRAVA, 23 MENTE, 80 MUSEU, 41 DOC/ENV, 89 OK) — **`docs/auditorias/2026-09-03-enterro-wincred.md`** |
| **1 — os vivos** | 03/09 | [#1174](https://github.com/trissutto/flowops-lite/pull/1174) | 46 caminhos que ainda apontavam pro ERP morto, migrados pro Postgres. O pior: o **estorno master** "devolvia" estoque chamando o MySQL morto, não conferia o retorno `{ok:false}` (que não lança) e carimbava "devolvido" com o estoque parado. Também: cobrança do crediário (a tela dava 500 e o cron de campanhas de WhatsApp morria calado), `previewBaixa`, `customer-info`, busca de vendedora, bipe, Saídas do Site, Inteligência ×4, faturamento, triagem. E a **inversão dos defaults** acima. |
| **2 — o museu** | 04/09 | [#1175](https://github.com/trissutto/flowops-lite/pull/1175) | **136 arquivos de código inalcançável DELETADOS** (178 tocados: mais 31 modificados, 10 scripts só-Postgres salvos pra fora da `giga-etl/` e 1 novo) — ~19 mil linhas de código/doc. Saíram: `carrinhos-abandonados/` (CartFlows do WP), `cutover/`, `stock-conferidor/`, `cpf-woo`/`cpf-rest`, `customers-giga-etl`, `wc-poller`, `erp-query`, `ncm-audit.service`, `StockController`, `giga-etl/`, ~60 `diag-*.js`, e 5 telas mortas do frontend. 15 métodos órfãos do `ErpService` (11.850 → 11.084 linhas). Fila `erp_outbox` drenada: 65 jobs presos marcados com motivo datado (UPDATE, não DELETE). |
| **3 — a história** | 05/09 | — | Documentação e textos de tela contando a verdade (este documento incluído) **+ a faxina final do `ErpService`** (11.084 → ~10,6k: saíram `mirrorStockWriteThrough`, `getGigaEstoque`, `getEstoqueGigaCompleto`, `listAllTables`, `listTablesLike`, `pingHealth`, `restoreDataAlt`, `caixaCodigoIndexed`, `getFirstSaleDatesChunk`, `isPdvWriteEnabled`) e dos serviços-sombra (`sombra.service` −210, `wincred-mirror.service` −223, `live-pdv.service` −113; `erp/sombra.controller.ts` e `customers-app/order-app-hooks.service.ts` deletados). **Tem mudança de comportamento neste PR** — não é só doc. |

**Ficou de propósito na Onda 2** (a prova de museu falhou):

- `site-publish/` — 18 rotas VIVAS em `/retaguarda/publicar-site`.
- `wc-fotos-import` — dele ficam vivos só dois métodos, `pintarBolinha` (mutirão de bolinha) e `marcaDaFamilia` (auto-publicar), **ambos Postgres puro**; as rotas de importar foto do site antigo saíram na Onda 2 (sobram 4 chamadas `this.wp.*` em métodos que perderam a rota).
- `wp-db/` — **não é Postgres**: é o cliente **MySQL do WordPress morto**, com pool inerte pela tranca `KINGHOST_WP`. Ficou só porque o `wc-fotos-import` **injeta o `WpDbService`** (apagar a pasta quebraria o módulo). **Não apagar, e não mexer no guard.**
- `customers-etl` — `runWooSync` lê a tabela `Order` do Postgres apesar do nome.

## ENV flags importantes (Railway → flowops-lite → Variables)

> As envs dos **avisos vitais** acima (`ERP_WRITE_ENABLED`, `PDV_ERP_OUTBOX`, `WINCRED_MIRROR_CRON_ENABLED`, as 4 trancas, `ERP_MULTA_PERCENT`) não se repetem aqui — leia aquela seção antes de mexer em env.

| Flag | Default | Efeito |
|---|---|---|
| `PDV_MIRROR_READS` | on | **`0` é ALÇAPÃO, não chave — não use.** Ainda penduram nela: a lista de abertas/clientes do crediário (`crediario-baixa.service.ts` cai no `this.erp.*` "→ Giga ao vivo" = lista vazia sem erro) e a busca do dropdown / Consulta de loja (`wincred-catalog.service.ts` cai em `searchProductsLike`/`searchByRef`/… mortos, ou devolve `[]` seco). Com `0` a cobrança fica sem parcela e a Consulta diz que a peça não existe, **em silêncio** — a família que a regra de ouro proíbe. **Não vale mais pro bipe**: desde a Onda 1 o bipe é só Postgres |
| `PRODUCT_NATIVE_READS` / `PRODUCT_NATIVE_WRITES` | **on** | Catálogo lê e a edição grava na tabela nativa `product`. Ver "defaults invertidos" |
| `CREDIARIO_NATIVE_READS` / `CREDIARIO_ERP_OUTBOX` | **on** | Crediário lê o espelho nativo; baixa/estorno passam pela fila. Ver "defaults invertidos" |
| `GIGA_MIRROR_READS` | **on** | Estoque + faturamento bruto leem os espelhos do Postgres. Ver "defaults invertidos" |
| `CREDIARIO_FLOW_FIRST` | on | Parcelas nascem em `crediario_parcelas`, faixa 900.000.000+. `0` é caminho legado morto — não use |
| `CATEGORIA_FLOW_FIRST` | on | Grupo/subgrupo numeram na faixa **9000+** do Flow. `0` é caminho legado morto |
| `MARCADOS_NATIVE_READS` | **off** | **LETRA MORTA com história**: o único consumidor (`useNative()` do `marcados.service.ts`) não tem chamador nenhum — os marcados já leem a fonte certa por outro caminho, e ligar/desligar esta env não muda NADA. Ela fica registrada aqui por dois motivos: (1) o painel `migration-flags` ainda a exibe como flag sensível, o que sugere um risco que não existe (remoção pendente, chip aberto); (2) foi ela que, ao **ficar ligada em produção por omissão** sem ninguém decidir, motivou o carimbo `⚠ LIGADA POR OMISSÃO` do painel |
| `STOCK_WINCRED_FIRST` | on | `wincred_estoque` é a fonte de leitura do routing/consulta — a MESMA que site e PDV leem |
| `ERP_STOCK_WRITES_ASYNC` / `PO_RECEIVE_ERP_OUTBOX` | on | Escritas secundárias de estoque e recebimento de pedido de compra vão por fila. `0` só tira a fila — **não muda a fonte e não espera ninguém**: com a réplica desligada `decreaseStock`/`increaseStock` saem na primeira linha aplicando só o Postgres |
| `PDV_FINALIZE_ASYNC` | false | Legado (só vale com o outbox desligado) |
| `MAISENVIOS_FORCA_SEDEX` | **off** | `1` volta a etiqueta do Mais Envios a sair SEDEX SEMPRE (comportamento até 15/08, que postava expresso em pedido de PAC pago — 11 casos em 180 dias). Off = a etiqueta segue o serviço que a cliente pagou, igual ao caminho Correios |
| `SITE_PROMO_50` | on | `0` desliga a promoção de 50% AUTOMÁTICA do site (peça de MODA cadastrada até 31/12/2023 — a mesma regra do caixa, `common/promo-julho.ts`). Quem decide é o `PromoSiteService`, consultado pelos DOIS lados: a vitrine que mostra e a trava do carrinho que cobra — divergir aí faz o checkout recusar o pedido. ⚠️ O `precoPromo`/`precoDe` digitados por peça MORRERAM em 26/08 ("o site segue o preço da loja SEMPRE") — promoção manual agora é baixar o `vendaUn` no editor de produtos |
| `SITE_PRECO_DE_DIAS` | 90 | Janela do "de/por" AUTOMÁTICO do site: quando o preço da LOJA cai (o editor de produtos audita ANTES→DEPOIS em `product_edit_audit`), a vitrine mostra "de \<preço anterior\> por \<preço atual\>" sozinha por até N dias. Aumento de preço não vira "de". Precedência da âncora: 50% do caixa → **DE REGISTRADO** (`product.precoDe`, colunas DE/POR do editor "Preço em bloco", 26/08 — sai riscado no site E no PDV com "cliente economizou R$ X") → histórico automático |
| `RETIRADA_ETIQUETA_APOS_ENVIO_DIAS` | 3 | Por quantos dias a **retirada em outra loja** ainda tira etiqueta DEPOIS que a vendedora fechou o card no "📦 Enviei pra loja X". Existe porque `shipped` é ponto final do card (`NEXT_ALLOWED`) e o `afterShipped` já rodou o acerto das duas pernas — voltar o card seria desfazer dinheiro pra imprimir papel; o que falta é a ETIQUETA, e ela continua saindo. Janela curta de propósito: havia **33 cards nesse estado desde abril** (27/08). `0` desliga. Régua única em `common/etiqueta-retirada.ts` (com spec), consultada pelo `JuntadaService` E pelo `listMine` — tela e porta não podem divergir |
| `PAGARME_LINK_HORAS` | 72 | Validade do link de pagamento da loja (era 24h chumbado no front). Teto da Pagar.me = 7 dias (168). A janela da lista "links pendentes" do PDV acompanha (+24h) |
| `AVISOS_VIA_EVOLUTION` | on | `0` volta o aviso da cliente (troca, pós-venda, crediário, leads, PDV) a sair pela **sessão Baileys** do backend (`/data/wa-site`, pareada por QR em `/config/whatsapp`). Ligada (padrão): sai pela **instância do Evolution** — o mesmo WhatsApp do inbox, número `5513996256238` = `Store.whatsapp` da 13/SITE e da 01. A Baileys ficou 11 dias caída sem ninguém ver (18 códigos de postagem saíram por e-mail em 25/08); agora ela é só reserva |
| `COBRANCAS_ONLINE_DIAS` | 7 | Janela da lista **"aguardando pagamento"** (`GET /pdv/cobrancas-online` — PIX PagBank + link Pagar.me juntos, no botão 💳 do PDV e na aba "Pagto pendente" da /separacao). 7 dias porque as 48h/96h do widget antigo sumiam justamente com a venda que ninguém resolveu (loja 13 tinha 12 penduradas, a mais velha de 7 dias) |
| `CARRINHO_ESPERA_MIN` | 60 | Quanto tempo depois do INÍCIO do checkout um carrinho vira "abandonado" (aba Carrinhos + modal do PDV). Antes havia um piso de 30min escrito só num ramo da query — e a tela sempre pede `status=all`, então ele NUNCA rodava: a cliente aparecia na fila enquanto ainda estava na tela de pagamento. Conta do `createdAt`, não do último toque. `0` desliga a espera |
| `PONTO_IP_CHECK` | on | `0` desliga a regra "celular só bate ponto no WiFi da loja" (batida `pwa_selfie` vs IPs do heartbeat do PDV Electron; fail-open se não há IP <48h) |
| `RASTREIO_SYNC` | on | `0` desliga o acompanhamento do objeto (cache `rastreio_objetos` para de atualizar; a tela mostra o último dado conhecido e nenhum pedido vira ENTREGUE sozinho) |
| `RASTREIO_SYNC_LOTE` | 60 | Teto de objetos por ciclo (cron de 30min). A escada por idade já rarefaz o que é velho: até 3 dias de hora em hora, 4-10 dias de 4h, 11-30 dias 1x/dia, entregue nunca mais |
| `ROUTING_JUNTADA_FORA_ESTADO` | on | `0` desliga a juntada OBRIGATÓRIA do pedido de fora de SP (CEP 2+). Ligada: pedido interestadual nunca sai em 2+ pacotes — a engine elege âncora (menos remessas pagas > mais peças > mais à frente na rota do carro) e o resto vira feeder. Medido 29/08: 18 pedidos/30d saíam divididos pra fora, 21 fretes a mais |
| `ROUTING_JUNTADA_MOTOBOY` | on | `0` desliga a âncora única do motoboy. Ligada: motoboy sempre despacha de UMA loja |
| `PACOTES_GATE_DENTRO_SP` | **OFF — CANCELADO pelo dono 31/08** | O gate "matriz libera" do pedido DENTRO de SP em 2+ pacotes travou a operação no 1º dia (LP-000999 com etiqueta paga travada no "Já postei") e foi cancelado. `1` religa (versão recalibrada: só segura a COMPRA da etiqueta; "Já postei"/reimpressão nunca travam). A cotação juntar × liberar segue em Remessas como informação; carimbo em `Order.pacotesLiberadosEm` |
| `ENVIO_EXIGE_BIPE` | on | `0` desliga a trava "peça sem bipe não embarca" (updateStatus→shipped + etiqueta reconferem o card CONTRA O AGORA; card legado com bipes de navegador passa). Destravamento = bipe tardio: o card aceita bipar peça faltante em qualquer status |
| `ROUTING_ANTI_OVERBOOKING` | **on desde 29/08** | `false`/ausente volta ao modo antigo (pedido em fila não desconta estoque). Ligada: pick-orders ativos de outros pedidos saem do estoque que o routing enxerga |
| `ROUTING_RETRY_AWAITING` | on | `0` desliga o cron (10min) que re-roteia pedidos em `awaiting_stock` quando a rede volta a cobrir (remessa deu entrada, devolução, realinhamento) |
| `TRILHO_ENVIO_LEGADO` | off | `1` reabre os atalhos antigos de status (new/separating → shipped direto). Fechados em 29/08: envio só existe DEPOIS do finish |
| — | — | **Peça é peça (29/08)**: toda entrada de pedido (site, e-commerce, pedido online) explode linha de quantity N em N linhas de 1 — troca, cancelamento, rateio e bipe operam POR LINHA. Legado corrigível via `backend/scripts/fix-linha-multi-qtd.js` |
| — | — | **Rota do carro (litoral)**: a ordem em `realignment_rota_propria` agora é o SENTIDO do veículo (coleta Itanhaém → Praia Grande → termina em Santos). A âncora da juntada é sempre a loja mais À FRENTE entre as envolvidas — carga não anda pra trás. O trio também conta como UM estoque só no routing (REGRA 2.5): peças espalhadas nas 3 viram 1 pacote |
| `META_ADS_TOKEN` / `META_ADS_CONTAS` | — | Espelho de gasto do Meta (`meta_ads_gasto_dia`, cron `7 * * * *`). Sem elas a linha do dinheiro do Meta **some** da cascata — nunca mostra zero. `META_ADS_CONTAS` é só **e-commerce**: é o gasto que `/retaguarda/campanhas` divide por receita do site |
| `META_ADS_CONTAS_LOJA` | — | Contas de **loja física** (hoje `157208321008735` = 01 Locais). O espelho coleta igual, mas a tela de ROAS as **exclui** (`$3` da `campanhas-roas.sql`) — anúncio de loja não existe pra vender no site, e somar afunda o ROAS do e-commerce com custo que não é dele. O retorno delas aparece no quadro "tráfego de lojas" como **custo por contato**. Régua única em `common/contas-de-anuncio.ts`. ⚠️ Antes de 26/08/2026 essa conta não era coletada: **R$ 41,5 mil em 30 dias fora de qualquer relatório**, com as sessões que ela comprava aparecendo como tráfego de graça |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | — | Espelho de gasto/conversão do Google (`google_ads_gasto_dia`, cron `17 * * * *`). Token do **MCC**, aprovado pelo Google — é o passo que depende do dono |
| `GOOGLE_ADS_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` | — | OAuth de leitura (escopo `adwords`). O refresh token não vence sozinho, mas morre se a senha da conta Google mudar |
| `GOOGLE_ADS_CONTAS` | — | `customer_id` sem hífen, separados por vírgula. Contas da conexão: `8681042744` (Ecomm 2024), `8925231246` (Plus Size Ecomm), `9564998046` (Lojas físicas) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | — | Id do MCC (provavelmente `1458258153`). Só quando a conta lida está dentro de um centro de clientes |
| `GOOGLE_ADS_API_VERSION` | `v25` | Versão da API. Vive ~1 ano e o endpoint some com 404 seco — subir aqui evita deploy de código |
| `GOOGLE_ADS_CONVERSAO_ACTION_ID` | — | Id de uma ação de conversão do tipo **UPLOAD_CLICKS** (Ferramentas → Conversões → Nova → **Importar** → Outras fontes de dados/CRM → Acompanhar conversões de cliques). 🚨 **A ação do gtag/GTM NÃO serve** — `Compra [OK]` (6807548872) é `WEBPAGE` e recusa 100% do lote com `INVALID_CONVERSION_ACTION_TYPE`, respondendo HTTP 200. O serviço confere o tipo e se recusa a arrancar |
| `GOOGLE_ADS_CONVERSAO_CONTA` | 1ª de `GOOGLE_ADS_CONTAS` | Conta dona da ação de conversão, quando não for a primeira da lista |
| `GOOGLE_ADS_CONVERSAO_UPLOAD` | on | `0` desliga o envio de conversão pro Google (o espelho de gasto continua) |

### Letra morta — podem sair do Railway

Estas envs governavam caminhos que dependiam do MySQL desligado. Ligar qualquer uma delas não muda nada — deixá-las no Railway só confunde a próxima pessoa que for auditar. São **dois casos diferentes**, e a distinção importa pra quem for mexer no código:

- **O código nem lê mais** (o leitor saiu nas Ondas 1-3, não há guard nenhum — sobrou nada): `ESTOQUE_SYNC_GIGA` · `ERP_STOCK_WRITEBACK_GIGA` · `PDV_ERP_WRITE_ENABLED` · `GIGA_SOMBRA` · `GIGA_SOMBRA_VERBOSE` · `GIGA_PRECO_COL` · `GIGA_PRODUTO_DATA_COL`. (Se existir uma `GIGA_VERBOSE` no Railway: esse nome **nunca** foi lido pelo código — apagar sem dó.)
- **O código lê, mas o guard trava antes** (aqui **o guard FICA** — é ele que garante o no-op): `ERP_HOST`/`ERP_PORT`/`ERP_USER`/`ERP_PASSWORD`/`ERP_DATABASE`, lidas só depois de `gigaDesligado()` no `onModuleInit` do `erp.service.ts` e no `realignment-pricing.service.ts`.

`WC_URL`/`WC_CONSUMER_KEY`/`WC_CONSUMER_SECRET` e `FLOWOPS_WP_BASE`/`FLOWOPS_WP_KEY` também apontam pro host apagado, mas **ainda têm chamadores** (`WooCommerceService`, rotas legadas de `abandoned-carts`) — só saem junto com a limpeza desses caminhos, senão o que muda é só o texto do erro.

⚠️ `ERP_WRITE_ENABLED` **NÃO** entra nesta lista — leia os avisos vitais. `GIGA_LEITURA_FLOW=1` também **não**: ela é OBRIGATÓRIA em produção (é o que faz bipe, remessa, preço do realinhamento e pré-check de saldo responderem do Postgres; sem ela o caminho legado responde vazio SEM erro).

## Convenções de trabalho (Thiago)

- 🚨 **COMMIT, MERGE NA MAIN E DEPLOY SÃO AUTOMÁTICOS** (ordem do dono, 22/08/2026). Terminou e verificou? Commita, `git push origin <branch>:main` e deixa subir. **NÃO perguntar** "posso mergear/deployar?", não parar no link do PR, não montar preview só pra pedir aprovação. A autorização é pra não PERGUNTAR — verificar antes (build + teste + SQL em Postgres) continua obrigatório. `gh` CLI **ESTÁ** instalado e autenticado (v2.97.0, conta trissutto): o caminho normal é `gh pr create` + `gh pr merge --squash --delete-branch`. Se o classificador bloquear o push na main, avisar e entregar na branch com o link manual `https://github.com/trissutto/flowops-lite/pull/new/<branch>`.
- 🕐 **Janela de deploy do BACKEND (incidente 01/09)**: 3 deploys entre 09:07 e 10:15 = 3 restarts do backend com loja aberta = reclamação "sistema travando muito" das lojas. O deploy do Railway é COM downtime (~40-60s: o volume anexado impede overlap) e ainda esfria os caches (catálogo remonta em ~17s, espelho frio). Regra: merge que toca `backend/` em horário de loja aberta é só pra **hotfix que não pode esperar** — o resto ACUMULA e sobe em janela (almoço ~13h ou depois das 19h30). Vários PRs prontos = mergear em sequência na MESMA janela (1 restart útil em vez de N espalhados). Commits de docs/frontend/scripts NÃO reiniciam o backend (railway.json tem `watchPatterns: ["backend/**", "railway.json"]` desde 01/09; o Vercel já tinha `ignoreCommand`) — esses podem subir a qualquer hora. Não é pergunta pro dono, é agendamento: a autorização de deploy continua automática.
- **Ordem da vitrine por categoria**: a página de categoria abre em NOVIDADES. Categoria de CAMPANHA (vitrine montada por cima do catálogo via `categoriasExtras`) pode pedir a grade AGRUPADA pelas subcategorias — botão de camadas em `/retaguarda/categorias` (`SiteCategoria.agruparPorSub`), blocos na `ordem` das subcategorias, mesma ordem dos chips. Ligado na **Linha Conforto** em 31/08 (34 blusas e depois 3 vestidos, que antes caíam nas posições 7, 8 e 12). Régua em `common/ordem-por-subcategoria.ts`. ⚠️ Com o agrupamento ligado o **bloco ganha da ordem manual** de `/retaguarda/ordem-vitrine` — a curadoria passa a ordenar DENTRO da família.
- Telas com recorte de tempo: filtro **De/Até** (`type=date`) + atalhos Hoje/Ontem/7 dias/Mês — NUNCA dropdown de períodos fixos.
- Preview local: `.claude/launch.json` sobe o frontend na 3000; backend real não roda local — usar mock na 3001 (endpoints com prefixo `/api`).
- PDV tema CLARO: fundo #FAFAF7, dourado como acento (#D4AF37/#B8912B/#8C7325, hover #FBF6E6), **verde #2E7D46 só pra dinheiro** (total, Finalizar). Vendedora escolhida no popup de confirmação da venda (F9/seletor de canto removidos).
- **Texto de tela não pode mandar fazer o impossível**: nada de "digite no Wincred", "faça entrada manual no Gigasistemas", "conserte no Giga". Não existe mais onde. Se o backend grava no Postgres, o texto diz o que o Postgres faz.
- CRM: escopo de loja = `originStoreId` **OU** `targetStoreId` (cliente do site atribuído por CEP) — lista e ficha usam o MESMO critério (divergência já causou drawer travado em "Carregando...").
- Modo treinamento NUNCA toca estoque/NFC-e (flag `isTraining` + header de sessão).

## Fila de tarefas da loja + ciclo da remessa (11/08)

**Diretriz de UX (dono):** a loja não escolhe tela — a home `/minha-loja` abre com a fila **"O QUE FAZER AGORA"** (pedidos a separar, caixas abertas, remessas chegando, peças de realinhamento). Vermelho = parado, amarelo = a fazer, teto de 10 linhas + "ver as outras N". Toda tela nova pra loja segue esse padrão: **tarefa clicável > menu**, e nenhum passo manual entra sem alerta de esquecimento. **Desde 25/08 (ordem do dono) a fila vive FECHADA** atrás de uma barra vermelha baixa (40px) logo acima do painel de botões: a barra diz quantas tarefas existem e quantas estão PARADAS, e um clique abre a lista inteira ali mesmo — o alarme continua na tela, o que saiu foi a parede de linhas empurrando os botões pra fora da primeira dobra.

**Regra de ouro contra alarme falso:** tarefa só entra se for pendência real PRA AQUELA loja — alarme falso mata a confiança na fila inteira. Foi o que aconteceu com "Gerar etiqueta" (removida em 11/08): a medição mostrou que só **5 de 203** remessas em trânsito têm etiqueta do sistema e mesmo assim **639 caixas chegaram em 30 dias** (média 4,1 dias). Etiqueta é EXCEÇÃO na operação — quem precisa gera pelo painel "Caixas fechadas" da tela Realinhar.

**O ciclo da remessa tem 2 pontas, e as duas somem em silêncio:**
1. **Caixa ABERTA** — o estoque só sai da origem no **"Fechar e enviar"**. Imprimir etiqueta/PDF com a caixa aberta abre o modal "Etiqueta na mão! Fechar agora?" (casos Piracicaba REM-1116 e Santos REM-732, esta 8 dias aberta).
2. **Caixa EM TRÂNSITO** — a peça só volta a existir quando o destino **dá entrada**. Entre um e outro ela não está no estoque de ninguém: some da Consulta e não vende no site. Em 11/08 havia **198 remessas / 1.057 peças** nesse limbo (a mais antiga de 15/05).

**Mutirão da matriz** — `/retaguarda/remessas` mostra as caixas paradas (3+ dias) com ação de 1 clique: **"Chegou"** (`POST /realignment/shipments/admin/:id/receber`) e **"Nunca saiu"** (`POST .../reabrir`). As duas delegam pros mesmos métodos da loja, resolvendo a loja pela própria remessa — mesmo efeito no estoque, sem duplicar lógica. Lista: `GET /realignment/shipments/admin/paradas?minDias=3`.

**Volume normal da rede (medido 30d):** 777 remessas / 9.293 peças — 594 TRANSFERENCIA + 183 REALINHAMENTO. Pedido do SITE é minoria das paradas (38 remessas, 71 peças).

## Mapa rápido dos módulos (backend/src)

- `pdv/` — PDV loja física: vendas (`pdv.service`), outbox (`erp-outbox.service` — **veículo da baixa de estoque**), devoluções (`returns`), marcados, crediário print, NFC-e, caixa/sangria, cobranças online, metas.
- `live-pdv/` — Live Commerce da apresentadora: grade cor×tamanho, carrinhos por @, PIX PagBank/link Pagar.me, reconcile de pagamento, separação por loja de origem.
- `erp/` — **toco em desmonte** (`erp.service.ts`, ~10,6k linhas): o pool MySQL nunca é criado (guard `gigaDesligado` no `onModuleInit`), mas o arquivo ainda hospeda os métodos de estoque flow-first (`decreaseStock`/`increaseStock`/`applyStockDeltaInTx`/`mirrorStockApplyDelta`) que a rede inteira chama. **Não é módulo morto — é o dono da baixa de estoque.** A Onda 2 tirou 15 métodos órfãos (11.850 → 11.084) e a **Onda 3 tirou os órfãos restantes** (11.084 → ~10,6k).
- `wincred-mirror/` — espelhos `wincred_produtos`/`wincred_estoque` + `WincredCatalogService` (bipe e busca do PDV, hoje 100% Postgres). Os botões de importação da tela são resquício e respondem erro; quem escreve nos espelhos é o próprio Flow.
- `product-native/`, `products-editor/`, `product-search/` — tabela nativa `product` (fonte do catálogo), edição e busca.
- `product-registration/` — cadastro de peça nova. O **código do produto É o EAN-13 de prefixo 8**, gerado pela `EanSequence` do Postgres dentro de transação — não sai de tabela do ERP. ⚠️ `wincred_codigos` é OUTRA coisa (código de vendedora/operador, lida por 9 serviços) e **nunca serviu de sequência de produto**.
- `crediario-nativo/`, `crediarios/` — `crediario_parcelas` nativa, criação na venda, baixa/estorno, cobrança e espelho de abertas.
- `financeiro/` — `giga-mirror.service` (nome herdado: **espelha o Flow**, alimenta `giga_caixa_mov`), conta corrente, DRE, royalties.
- `customers/`, `crm/`, `person-identity/` — CRM (base mestra `Customer`, dedup por telefone/@, clientes da live com origem 'live').
- `products/`, `stock/`, `routing/`, `pick-orders/`, `realignment/` — consulta/vitrine/roteamento de pedidos do site/separação/realinhamento. **Todos leem Postgres.**
- `site-publish/`, `site-categorias/`, `site-vitrines/`, `site-banners/`, `loja-catalog/` — vitrine do e-commerce próprio.
- `tracking/`, `correios/`, `mais-envios/`, `nfe/`, `trocas/` — logística, etiqueta, nota e pós-venda.
- `site-metrics/`, `telemetria/`, `intelligence/`, `reports/`, `faturamento/`, `dre/` — medição, ROAS (Meta/Google) e relatórios.
- `abandoned-carts/` — carrinhos abandonados. As rotas **`ecommerce/list` e `ecommerce/stats` são as vivas** (site novo, Postgres, régua em `common/carrinho-abandonado.ts`); as rotas antigas (`GET /abandoned-carts`, `wc-pending/*`) ainda falam CartFlows/WC REST num host morto — pendência. **Não confundir** com o módulo `carrinhos-abandonados/`, que era 100% WordPress e foi deletado na Onda 2.
- `clientes-giga/` — **nome herdado, módulo VIVO**: consulta, ficha, edição, cadastro, cópia entre lojas e limpeza sobre a tabela nativa `giga_clientes` do Postgres (~18 rotas em `/admin/clientes-giga` e `/pdv/clientes-giga`). A tabela nasceu como zona de pouso da `clientes` do ERP; hoje é a fonte. A IMPORTAÇÃO (`syncAll` + cron das 04:40) foi deletada na Onda 2 — não há de onde importar.
- `wp-db/`, `woocommerce/` — **restos do site velho**. `WpDbService` sai na primeira linha (`wordpressLegadoLigado()`) e só continua existindo porque `product-photos/wc-fotos-import.service.ts` o injeta pra servir `pintarBolinha`/`marcaDaFamilia` (100% Postgres, mutirão de bolinha e auto-publicar). `WooCommerceService` é cliente REST de um host que não existe mais; ainda tem chamadores em `orders.controller` (pedido LEGADO do site velho) e `pdv.controller` (foto por SKU) — pendência das próximas faxinas, não caminho vivo.

## Histórico de incidentes (não repetir)

- **Live 01/07**: MySQL do ERP pendurado (busca) + polling PagBank empilhando → derrubou a live várias vezes. Origem das mudanças de arquitetura acima.
- **Preço ÷100 (01/07)**: espelho dividia `vendaUn` por 100 — blusa R$ 80 virou R$ 0,80 no bipe. Vendas de teste afetadas foram canceladas.
- **Estorno que não devolvia (achado 03/09)**: o estorno master chamava o MySQL morto, não conferia o retorno `{ok:false}` (que não lança) e carimbava "N item(ns) devolvido(s) ao estoque" com o estoque parado. Só 2 casos desde 14/07 — mina armada, não cratera. Corrigido na Onda 1.
- **Cron que ressuscitava dívida**: o sync das 04:10 apagaria as parcelas com `flowIsSource=false` e recarregaria de uma fonte que já não recebia as baixas — cliente que pagou hoje voltaria devendo amanhã. Trancado por `pullGigaLigado()`.
- **Fonte morta com cara de "não existe"**: pool trancado devolve `[]`/`{ok:false}` **sem lançar** — `.catch` nunca dispara. Peça que existe virava esgotada, filtro descartava tudo calado, relatório mostrava R$ 0. A cura é sempre a mesma: ler o espelho **e deixar o erro SUBIR**.
- **Ficha do CRM travada**: lista mostrava cliente que a ficha negava (404) + drawer sem catch → "Carregando..." eterno.
- **Treino baixou estoque real** (jun/26, loja 15): backfill sem filtro `isTraining` — hoje filtrado.
- **Sorocaba multi-PC** (jun/26): reciclagem de venda órfã fazia 2 PCs controlarem a mesma venda → removida (sempre cria venda nova).
- **Socket com token velho** (jun/26): singleton reaproveitava JWT antigo → loja via pedidos de outra loja. Fix: compara token e reconecta.
