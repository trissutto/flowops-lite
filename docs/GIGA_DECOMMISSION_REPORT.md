# GIGA — relatório de descomissionamento

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
| 2 | Desligar o `stock-mirror` | `src/stock-mirror/` | Módulo **órfão**: puxa a tabela `estoque` inteira do Giga pra uma tabela que ninguém lê. Tira carga hoje, custo zero |
| 3 | Plugar 3 tradutores prontos | `sombra.service.ts:406,455,489` | `resolveSkuInfo`, preços e estoque por REF já escritos e validados, sem hook. Cobre 5 pontos, 3 no caminho crítico da triagem |
| 4 | `customer-info` pelo espelho | `pdv.controller.ts:981-1131` | Hoje dispara **até 9 consultas em cascata** com 10s de timeout cada: Giga pendurado = PDV parado ~90s. O espelho `giga_clientes` já tem a ficha inteira |
| 5 | Congelar o mapa de colunas | `crediarios.service.ts:129,190` | `SHOW COLUMNS` no Giga em 5 caminhos quentes, com `force=true`. Guardar num `SystemSetting` corta a ida ao MySQL sem tocar em regra |
| 6 | Remover ~17 pontos obsoletos | vários | Ferramentas do incidente DATAALT (encerrado) + endpoints sem nenhum chamador no frontend. Confirmado por grep |
| 7 | `USE_LOCAL_CATALOG=1` | — | Mata `getStockDistribution`; o substituto Postgres já existe em `wincred-mirror.service.ts:952` |

---

## Riscos que o mapeamento revelou

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

## A pergunta que decide a sprint

**Alguém ainda digita no Wincred desktop?**

O sync incremental de 10 minutos e o horário **não podem ser desligados**
enquanto qualquer loja cadastrar produto ou dar entrada de estoque por lá — eles
são a única forma de o Flow saber o que foi digitado.

- **Se ainda usam:** o alvo realista não é desligar o Giga, é reduzir a
  dependência a esse único fluxo de entrada.
- **Se não usam mais:** o caminho fica livre, e os ETLs morrem no corte.

Sem essa resposta, qualquer cronograma de desligamento é chute.

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
Todas para o padrão do outbox. Depende da **decisão de propriedade do
estoque**, que é operacional, não técnica.

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
