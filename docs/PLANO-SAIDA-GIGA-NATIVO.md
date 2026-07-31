# Plano — sair do Giga de verdade (dados no Postgres, sistema nativo)

Decisão do dono (31/07/2026): não é mover o MySQL de servidor — é **trazer
todos os dados pro Postgres e o sistema rodar nativo**, sem MySQL nenhum no
fim.

Este documento é o mapa. O inventário de telas (`INVENTARIO-TELAS-GIGA.md`) é
o companheiro: aquele lista o que cada tela usa, este diz em que ordem atacar.

---

## A boa notícia que o levantamento trouxe

O Giga tem **~14 tabelas que o sistema realmente usa** — não são centenas. E
**11 delas já têm espelho** no Postgres:

| Tabela do Giga | Usos no código | Espelho hoje | Estado |
|---|---|---|---|
| `produtos` | 88 | `wincred_produtos`, `giga_produto` | completo |
| `caixa` | 48 | `giga_caixa_mov`, `giga_caixa_diario` | **parcial — desde 2025** |
| `estoque` | 40 | `wincred_estoque`, `giga_estoque`, `Stock` | completo (é cópia) |
| `funcionarios` | 9 | `wincred_funcionarios` | completo |
| `clientes` | 8 | `wincred_clientes`, `giga_clientes` | completo |
| `fornecedores` | 6 | `wincred_fornecedores` | completo |
| `grupos` / `subgrupos` | 9 | `wincred_grupos`, `wincred_subgrupos` | completo |
| `transferencias` | 3 | `giga_transferencia(_item)` | completo |
| `codigos` (EAN) | — | `wincred_codigos` | completo |
| `pagar` | — | `giga_pagar` | completo |
| `movimento` (crediário) | vários | `wincred_movimento_aberto` | **parcial — só em aberto** |
| `fechamento` | 5 | — | **sem espelho** |
| `estorno` | 1 | — | **sem espelho** |

Ou seja: o buraco de DADO é pequeno — histórico completo da `caixa`, o
`movimento` fechado do crediário, e duas tabelas que ninguém espelhou.

**O trabalho não está em copiar dado. Está em trocar quem manda.**

---

## Fase 0 — Carga completa (2 a 3 dias · risco zero)

Trazer TODAS as tabelas, TODO o histórico. Completar as parciais e criar as
três que faltam.

Por que fazer isso primeiro, mesmo com o sistema ainda lendo do MySQL:

- se o MySQL morrer amanhã, nada se perde;
- é pré-requisito de toda fase seguinte;
- não muda comportamento nenhum — só escreve em tabelas novas.

**Risco: zero.** Nada no sistema passa a ler dali ainda.

**Bloqueio atual:** falta o inventário (tamanho e engine). Sem ele não dá pra
dimensionar a carga da `caixa`, que é a maior.

---

## Fase 1 — Leituras (1 a 2 semanas · risco baixo)

Os ~40 métodos que ainda consultam o Giga ao vivo passam a ler do Postgres,
módulo a módulo, cada um atrás de flag com recuo pro Giga.

Ordem sugerida, do mais seguro pro mais delicado:

1. **Consulta e catálogo** — `searchByRef`, `searchByDescription*`,
   `resolveSkuInfo`, `findCodigoByRefCorTam` e os batches. É o grupo mais
   usado e o mais simples: o dado já está em `wincred_produtos`.
2. **Realinhamento (leitura)** — 31 das 35 chamadas. Aqui vale redesenhar a
   tela junto: ela foi desenhada em volta dos defeitos do Giga (busca por
   código exato, `CAST` em todo JOIN, REF reciclada agrupando errado).
3. **Inteligência/dashboards** — `getHeatmap`, `getParados`, `getRupturas`,
   `getStockDistribution`. Consulta pesada que hoje pendura o Giga.
4. **Site-publish, venda-certa, clientes** — cauda.

**Ganho imediato, antes de qualquer escrita migrar:** as telas param de
pendurar quando o Giga cai, e ficam instantâneas.

**Risco baixo:** se a consulta nova errar, aparece dado errado na tela — nada
é gravado errado. E a flag volta atrás em segundos.

---

## Fase 2 — A decisão do estoque (bloqueia a Fase 3)

**Esta é a fase que não é técnica.**

Hoje a tabela `Stock` do Postgres tem um campo `syncedAt — último sync do
Giga`. Ela é cópia. O estoque real mora no Giga porque é lá que o PDV das
lojas grava a venda.

Inverter significa: o Flow passa a ser dono, e o Giga vira réplica alimentada
por fila. E a virada precisa de um instante em que os dois estejam iguais —
na prática, **um fechamento com conferência**, provavelmente fora do horário
de loja, possivelmente com inventário de aferição nas lojas maiores.

Enquanto essa decisão não acontece, **nenhuma escrita migra** — e o Giga não
morre.

---

## Fase 3 — Escritas (2 a 3 semanas · risco alto, exige a Fase 2)

As 18 escritas passam pro padrão que o PDV já usa na venda: **grava no
Postgres e enfileira a réplica no Giga** (`erp_outbox`). O Giga vira espelho
com fila, exatamente como a diretriz de 14/07 já dizia.

Por ordem de risco:

| Escrita | Onde | Observação |
|---|---|---|
| `decreaseStock` / `increaseStock` | pdv, realinhamento, trocas, routing, pick-orders | o coração — depende da Fase 2 |
| `gravarVendaPdv` | pdv | já tem outbox; falta o estoque acompanhar |
| `createCrediarioParcelas`, `markCrediarioParcela*` | pdv, crediarios | depende do espelho completo do `movimento` |
| `insertCaixaMarcado`, `deleteCaixaMarcadoRow` | pdv | marcados |
| `inserirProdutosBatch`, `inserirGrupo/Subgrupo` | product-registration | o código EAN já é do Flow |
| `upsertClienteGiga` | pdv, clientes-giga | CRM já é do Flow |

---

## Fase 4 — Desligar

Fila do outbox drenada e vazia por alguns dias, ninguém lendo do MySQL, e o
Giga apaga.

---

## Cronograma honesto

| Fase | Trabalho | Pode rodar em paralelo com o site? |
|---|---|---|
| 0 — carga | 2-3 dias | sim |
| 1 — leituras | 1-2 semanas | sim |
| 2 — decisão do estoque | dias (não é código) | — |
| 3 — escritas | 2-3 semanas | não, exige atenção total |
| 4 — desligar | 1 dia | — |

**Total realista: 5 a 8 semanas.** Não uma semana.

---

## A consequência prática pro prazo da KingHost

Se a saída nativa leva 5-8 semanas e a KingHost precisa apagar antes disso,
**mover o MySQL continua sendo necessário** — não como alternativa a este
plano, mas como o passo que tira o prazo de cima dele.

São 3-5 horas que compram semanas de tranquilidade, e o Giga passa a rodar ao
lado da aplicação (o firewall que derrubou a live em julho deixa de existir).
Depois disso este plano roda sem relógio.

Alternativa: renovar a KingHost mês a mês até a Fase 4 terminar. Custa
mensalidade e mantém o ponto frágil vivo, mas evita a migração de servidor.

---

## O que trava agora

O **inventário** (`scripts/kinghost/01-inventario.ps1` ou as queries no
HeidiSQL). Sem tamanho e engine não dá pra dimensionar a Fase 0 nem planejar
a janela de nada.
