# GIGA — relatório de descomissionamento

> **REGISTRO HISTORICO (31/07/2026) — descomissionamento CONCLUIDO.** As ~292 dependencias medidas aqui nao existem mais: ERP DESLIGADO em 27/08/2026 e codigo migrado/removido em 09/2026. Estado atual: `CLAUDE.md` na raiz.

Etapa 1 a 3 da Sprint Especial, consolidadas. Levantamento feito no código em
31/07/2026 por quatro varreduras paralelas, com `arquivo:linha` verificado.

---

## O número

**~292 dependências do Giga** no backend.

| Domínio | Dependências | Escritas | Já migradas |
|---|---|---|---|
| PDV + crediário + clientes | 98 | **33** | 52 com substituto |
| Estoque + logística | 75 | 10 | 18 ativas, 11 em sombra |
| Relatórios + financeiro | 67 | 3 | **41** (flag `GIGA_MIRROR_READS`) |
| Produtos + cadastros | 52 | 7 | parcial |

**A operação já está mais migrada do que parecia**: 41 leituras de relatório e
faturamento já respondem do Postgres com a flag que está ativa em produção, e
o estoque já grava nos dois lados com fila de retry.

---

## Os três bloqueios duros

São os que **não têm substituto nenhum** e precisam ser CONSTRUÍDOS antes de
qualquer remoção. Enquanto existirem, o Giga não desliga.

### 1. Parcelas do crediário

`pdv.controller.ts:1825` → `createCrediarioParcelas` grava as N parcelas na
tabela `movimento` do Giga. Síncrono, **sem outbox e sem tabela nativa**.

**Giga fora do ar = a loja não vende a crediário.** É a única escrita da
operação sem absolutamente nada do lado do Flow.

### 2. Grupos e subgrupos de produto

`erp.service.ts:8207` e `:8239` → `SELECT MAX(CODIGO)+1 FOR UPDATE` + INSERT
nas tabelas `grupos`/`subgrupos`. **Não existe tabela nativa nem sequência no
Postgres.** Bloqueia o cadastro de produto novo com categoria nova.

### 3. Fechamento de caixa

`cash.service.ts:1844` e `:2434` → troca de bandeira de cartão na tabela
`fechamento`. **Essa tabela não tem espelho nenhum** — nem leitura espelhada,
nem fila.

---

## Ganhos imediatos — o que dá pra fazer sem construir nada

Ordenado por relação valor/risco.

| # | O que | Onde | Ganho |
|---|---|---|---|
| 1 | Ligar `CREDIARIO_ERP_OUTBOX=1` | `crediario-baixa.service.ts:1702` | A infra está **inteira e pronta** (kinds no outbox + write-through no espelho); só a flag está OFF. Tira a baixa de parcela do caminho síncrono |
| 2 | ~~Desligar o `stock-mirror`~~ | `src/stock-mirror/` | ❌ **ERRO DESTE RELATÓRIO, retirado em 31/07.** Ver abaixo |
| 3 | Plugar 3 tradutores prontos | `sombra.service.ts:406,455,489` | `resolveSkuInfo`, preços e estoque por REF já escritos e validados, sem hook. Cobre 5 pontos, 3 no caminho crítico da triagem |
| 4 | `customer-info` pelo espelho | `pdv.controller.ts:981-1131` | Hoje dispara **até 9 consultas em cascata** com 10s de timeout cada: Giga pendurado = PDV parado ~90s. O espelho `giga_clientes` já tem a ficha inteira |
| 5 | Congelar o mapa de colunas | `crediarios.service.ts:129,190` | `SHOW COLUMNS` no Giga em 5 caminhos quentes, com `force=true`. Guardar num `SystemSetting` corta a ida ao MySQL sem tocar em regra |
| 6 | Remover ~17 pontos obsoletos | vários | Ferramentas do incidente DATAALT (encerrado) + endpoints sem nenhum chamador no frontend. Confirmado por grep |
| 7 | `USE_LOCAL_CATALOG=1` | — | Mata `getStockDistribution`; o substituto Postgres já existe em `wincred-mirror.service.ts:952` |

### Correção: o `stock-mirror` NÃO é órfão

Este relatório afirmou que `src/stock-mirror/` puxava a tabela `estoque` inteira
do Giga periodicamente para uma tabela sem leitores. **Errado nos dois pontos**,
verificado em 31/07 antes de desligar qualquer coisa:

- **Não há cron.** Nenhum `@Cron` no módulo; o cabeçalho do arquivo registra
  "cron 4x/dia (TODO Fase 5)" que nunca foi implementado. O único gatilho é o
  `POST /admin/stock-mirror/sync`, um clique de admin. **Não existe a carga
  periódica que eu descrevi** — o peso no Giga é sob demanda.
- **A tabela é lida por tela viva.** `Stock` e `StockMovement` alimentam
  `GET /admin/stock-mirror/summary` e `/list`, consumidos por
  `frontend/src/app/retaguarda/estoque/page.tsx:64,83`. O `stock-conferidor`
  (`stock-conferidor.service.ts:432`) lê `stock_movements` para explicar cada
  divergência.

Desligar teria quebrado a tela de estoque da retaguarda. Nada foi alterado.

**Lição:** "órfão" foi conclusão de grep, não de verificação. A regra de nunca
remover antes de comprovar substituto foi o que evitou o estrago — e é por isso
que os Blocos F e G ficam para o fim.

### Entregue em 31/07: mapa de colunas do crediário congelado

Item 5 da tabela, feito. `crediarios.service.ts` agora resolve o mapa em dois
níveis — memória → `SystemSetting` → Giga — em vez de ir ao MySQL toda vez.

O nível do Postgres é o que importa: o backend reinicia a cada deploy (~30s), e
o cache em memória sozinho zerava junto. Cada detecção custava **3 queries**
(`SHOW COLUMNS` + `SELECT * LIMIT 1` + `COUNT(*)` numa `movimento` de 700k+
linhas); os ~10 chamadores sem `force` deixam de tocar no Giga.

Degradação: Giga fora **com** cache devolve o último mapa bom, em vez de
derrubar o crediário; Giga fora **sem** cache se comporta exatamente como hoje.
`force=true` continua indo ao Giga e reescreve os dois níveis. `EMPTY_MAP` nunca
é persistido.

**Pendente de decisão sua:** `crediario-baixa.service.ts:350` usa `force=true`
com um comentário sobre "timeouts que cacheavam EMPTY_MAP" — medo que já era
infundado e que agora é impossível por construção. Trocar por `false` tiraria o
caminho mais quente do crediário de cima do Giga. É mudança em chamador, não na
origem do mapa; ficou parada esperando aprovação.

---

## Riscos que o mapeamento revelou

### ⚠️ Ligar `GIGA_LEITURA_FLOW` muda a ESCALA do preço, não só a fonte

O risco mais perigoso encontrado em 31/07, porque não parece um risco: a flag
promete "mesma resposta, outra origem", e em `getProductPricesBySkus` **não é**.

O caminho do Giga **divide por 100** quando a coluna escolhida é `VENDAUN`. O
espelho **não divide** — `wincred_produtos.vendaUn` já está em reais. Mesma
peça, dois números com 100× de diferença. É a mesma família do incidente de
01/07, em que a blusa de R$ 80 virou R$ 0,80 no bipe.

O detalhe que decide: **a divisão do lado do Giga já é reconhecida como
errada**. Dois módulos desviam dela de propósito e dizem por quê —
`financeiro.service.ts:134` e `shipment.service.ts:863` mandam a obrigação
intercompany pro `RealignmentPricingService` citando "R$ 1,90 em vez de R$ 190".

Ou seja: virar a flag provavelmente **conserta** o preço da obrigação
intercompany. Mas isso é **mudança de valor financeiro**, não troca transparente
de fonte, e vai aparecer como divergência em massa no placar da sombra — que é
o comportamento certo, não um alarme falso.

**Antes de ligar:** conferir qual coluna o `pickCol` escolhe em produção hoje, e
tratar a virada como correção de preço (com quem confere o acerto avisado), não
como migração invisível.

### Zero à esquerda: o mesmo tropeço, de novo

Ao plugar `resolveSkuInfo`, o Flow passou a devolver `codigo` **sem zeros à
esquerda** — e `getPdvProductInfo` consultava o Giga com `WHERE CODIGO = ?`
exato. Com a flag ligada, o igual não acharia a linha e **o bipe sairia com
preço 0**: exatamente o sintoma de 01/07, por um caminho novo.

Corrigido junto (`erp.service.ts:7784` e `:7831` agora usam `CODIGO IN (?)` com
`skuVariants`). Fica o padrão: **toda leitura que passa a responder do Flow tem
que ser auditada nos chamadores**, porque a normalização de código viaja com o
valor. É a terceira das três causas de "sumiu" já catalogadas.

### Espelho congelado não avisa

`giga-mirror.service.ts:352` preserva o espelho de propósito quando o Giga
responde vazio. Se o Giga cair, **faturamento, DRE e royalties respondem com
dado velho, sem erro nenhum**. Ninguém percebe.

**Ação:** carimbar a idade do dado na resposta e alertar acima de um limite.

### Segundo pool MySQL fora do ErpService

`realignment-pricing.service.ts:35` abre pool próprio pro Giga (2 conexões,
`queueLimit: 0`, **sem circuit breaker**), atendendo 10 pontos. O comentário em
`shipment.service.ts:268` registra que foi esse pool que pendurou a
transferência num incidente anterior.

Todo o dado que ele busca (`VENDAUN`) já está em `wincred_produtos.vendaUn`.

### Bipe que não passa pelo espelho

`shipment.service.ts:271` usa `erp.getPdvProductInfo` direto — é o **único bipe
do sistema que não passa pelo `WincredCatalogService`**. Os outros 10 usam o
espelho primeiro. Giga pendurado = a triagem não bipa.

### Escrita que aborta a operação

`marcados.service.ts:208` (`insertCaixaMarcado`) é a única escrita que faz
`throw` e **derruba a operação** se o Giga falhar. Todas as outras degradam
para fila ou log.

### O gate de cobertura devolve a consulta pro Giga

`caixaMovUsable()` (`erp.service.ts:652`) só usa o espelho quando o período
começa depois do início real do `giga_caixa_mov`. Comparação ano a ano do
faturamento, DRE de exercício anterior e os anos y-4/y-3/y-2 do dashboard
**continuam batendo no MySQL** — mesma classe do incidente corrigido em
`fix/faturamento-ano-anterior-espelho`.

### Comissão por interpolação de string

`commissions/commissions.service.ts:873` — SQL cru na `caixa` montado por
interpolação, número que vai pro RH, sem espelho e sem recuo (só um
`Promise.race` de 20s).

---

## A pergunta que decidia a sprint — RESPONDIDA (31/07)

**Alguém ainda digita no Wincred desktop?** → **NÃO.** (dono, 31/07)

O sync incremental de 10 minutos e o horário existiam para capturar o que era
digitado no desktop. Sem digitação, **eles não têm fonte de informação nova**: o
Giga só muda porque o próprio FlowOps escreve nele. Os 5 ETLs mapeados como "a
ponte" deixam de ser dependência e morrem no corte.

---

## Medição de 31/07 — o estoque do Flow está certo?

Com a resposta acima, a pergunta virou empírica, e foi medida peça por peça
contra o Giga ao vivo (`scripts/giga-etl/divergencia-estoque.js`):

| | |
|---|---|
| Pares codigo+loja comparados | **286.460** |
| Idênticos | **285.605 — 99,70%** |
| Divergentes | 855 |
| Soma de peças (Giga / Flow) | 213.107 / 213.311 |
| Diferença total | **204 peças — 0,1%** |
| Maior diferença numa peça | 10 |

### De onde vêm as 855

- **152** — o Giga está **negativo** (impossível na vida real). O Flow está certo.
- **425** — Flow menor: já baixou; o Giga não recebeu.
- **278** — Flow maior.

A fila **não é o problema**: nas últimas 24h foram 152 jobs de venda e 43 de
estoque, **16 a 19 segundos de média e zero retentativa**.

### Os 10 jobs presos

Não são falha de infraestrutura — são o **Giga recusando eventos que já
aconteceram na loja**:

- `Estoque insuficiente: ... tem 0, pediu 1` — a peça saiu com a cliente; o Giga
  se recusa a ficar negativo.
- `Registro não encontrado: SKU=MANUAL-...` — item lançado à mão no PDV, que
  **não existe no Giga e nunca vai existir**. Esses jobs jamais teriam sucesso.

Sete já bateram as 100 tentativas. É dívida cosmética num **réplica**, não perda:
a verdade está no Flow.

---

## A descoberta que muda o plano

**A decisão de propriedade do estoque já foi tomada — em 14/07.**

`wincred-mirror.service.ts:400` traz, em comentário, a constituição do dono:

> FLOW é a FONTE do estoque e ninguém mais mexe em estoque no Wincred desktop.
> O full Giga→Flow fica DESLIGADO por padrão — só sobrescreveria a verdade do
> Flow na janela da fila do outbox.

O `syncEstoque` full está **off por padrão** desde então (`ESTOQUE_SYNC_GIGA=1`
reativa). Ou seja: o Flow é dono do estoque há 17 dias, e depois de 17 dias
sozinho ainda bate 99,70% com o Giga. **O "bloqueio operacional" do Bloco D não
existe** — ele foi resolvido antes de ser mapeado.

### O furo que isso revelou

O **incremental** de 10 minutos não estava atrás da mesma trava e continuava
puxando estoque do Giga por cima do Flow para todo código com `DATAALT` recente
— exatamente o estrago que o full foi desligado para evitar, numa fatia menor.
Sem ninguém digitando no Wincred, esse pull não traz informação nova: no melhor
caso é round-trip, no pior troca o valor fresco do Flow pelo velho do Giga.

**Corrigido em 31/07**: o trecho de estoque do incremental passou para a mesma
flag `ESTOQUE_SYNC_GIGA`, e o estado do sync agora grava
`DESLIGADO — Flow é a fonte do estoque` em vez de `OK`, para a tela de status
não jurar que sincronizou.

### O que substitui o sync

Reconciliação, não cópia. `divergencia-estoque.js` já é o relatório: roda contra
os dois bancos, aponta peça e loja. Enquanto o Giga existir, ele é a conferência
periódica — e quando o Giga sair, deixa de fazer sentido junto com ele.

---

## Sobre a cópia crua (`giga_raw`)

37 tabelas, 4.015.836 linhas, snapshot de 31/07/2026, conferido contra a
origem (contagem + soma das colunas numéricas).

**É arquivo histórico, não substituto operacional.** Não é sincronizado. Serve
para: garantir que nada se perde se o Giga morrer, e ser ponto de partida das
migrações. Nenhuma consulta de produção deve ler dele — as consultas usam os
espelhos CURADOS (`wincred_*`, `giga_*`), que têm normalização de código,
filtro de `MARCADO` e regra de data.

---

## Ordem de ataque proposta

**Bloco A — sem construir nada (dias)**
Os 7 ganhos imediatos da tabela acima. Cada um com flag e reversível.

**Bloco B — leituras restantes (1-2 semanas)**
As ~41 leituras que têm o dado no espelho mas não têm código escrito. Cada uma
entra em dupla execução (Etapa 4) antes de virar. Ordem: realinhamento →
inteligência → publicar site → venda certa.

**Bloco C — construir o que falta (1 semana)**
Tabela nativa de parcelas do crediário, de grupos/subgrupos, e espelho de
`fechamento`. Sem isso o Bloco D não existe.

**Bloco D — escritas (2-3 semanas)**
Todas para o padrão do outbox. ~~Depende da decisão de propriedade do
estoque.~~ **Essa decisão já foi tomada em 14/07 e está implementada** (ver
acima): o Flow é dono do estoque, com 99,70% de aderência medida. O que resta
aqui é mecânico — pôr as escritas restantes na fila.

**Bloco E — desligar**
Fila drenada e vazia por dias, ninguém lendo, e o Giga apaga.

**Blocos F (remoção) e G (limpeza) — depois, em sprint própria.**
O código que lê o Giga *é* o fallback. Enquanto ele existir, consulta nova que
erre degrada em vez de quebrar. Apagar cedo remove a rede em troca de estética.

---

## Mapas detalhados

Todos em `docs/decommission/`:

- `MAPA-pdv-crediario.md` — 98 dependências
- `MAPA-estoque-logistica.md` — 75
- `MAPA-relatorios-financeiro.md` — 67
- `MAPA-produtos-cadastros.md` — 52
