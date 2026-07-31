# Busca — motor de 3 camadas

`src/lib/search/` (motor puro, zero UI) + `src/lib/merchandising/` (boosts).
A UI importa **só do barrel** `@/lib/search` — nunca dos arquivos internos.

## Por que 3 camadas

Cada camada é substituível sem tocar nas outras. É o desenho inteiro:

| Camada | Arquivo | Hoje | Amanhã |
|---|---|---|---|
| 1. Índice | `engine.ts` → `createSearchIndex` | produto achatado em memória | índice servido pela API quando o catálogo não couber no client |
| 2. Motor | `engine.ts` → `rankSearch` | ranking síncrono no client | chamada a `/api/search` — a UI não muda |
| 3. Intenção | `intent.ts` → `heuristicInterpreter` | dicionário + heurística | LLM via `/api/search/intent` (ver docs/ai-search.md) |

O contrato entre elas está em `src/lib/search/types.ts` (`SearchDoc`,
`SearchQuery`, `SearchOutcome`, `IntentInterpreter`). Vocabulário em
`synonyms.ts` — **dados, não código**: sinônimo novo = uma linha no array.

## O fluxo de uma busca

```
"Vestido pra casamento até 200"
        │ heuristicInterpreter.interpret()
        ▼
Intent { facets: { category: 'vestidos', occasion: 'casamento', priceMax: 200 },
         residual: '', label: 'vestidos para casamento até R$ 200', confidence: 'alta' }
        │ rankSearch(docs, { term })
        ▼
1. facetas filtram/pontuam (estrito: TODA faceta precisa casar)
2. residual pontua texto: exato > SKU > começa-com > contém > fuzzy (bigramas)
3. applyBoosts: merchandising (regras) + personalização (≤ 1.3)
4. vazio? relaxa em camadas e marca relaxed: true
        ▼
SearchOutcome { results, intent, relaxed, suggestions }
```

### Escada de score do texto

| Match | Score |
|---|---|
| nome exato | 100 |
| SKU exato | 95 |
| nome começa com o termo | 60 |
| palavra do nome começa com o termo | 55 |
| nome contém | 40 |
| multi-palavra parcial (proporcional) | até 30 |
| doc contém | 25 |
| fuzzy (Dice de bigramas ≥ 0.4, termo ≥ 4 letras) | até 20 |

Facetas somam por fora: categoria +30, ocasião +20, tecido/cor +15,
modelagem +12, atributos +8 cada (teto 3), preço +10.

O fuzzy é o que salva o typo: "vestdio" → bigramas em comum com "vestido"
→ acha os vestidos sem nenhuma configuração.

## Zero results NUNCA

Quando o passo estrito devolve vazio, `rankSearch` relaxa **em camadas**,
soltando a faceta menos confiável primeiro:

```
atributos → modelagem → cor → tecido → ocasião → preço → categoria → só texto
```

No limite (nem texto acha nada), ranqueia o catálogo inteiro por
aproximação fuzzy + boosts. Qualquer degrau acima do primeiro marca
`relaxed: true` e preenche `suggestions` (termos do vocabulário próximos
do que foi digitado). A UI usa isso pra dizer "não achamos exatamente X,
veja parecidos" — nunca uma página morta.

Busca vazia (sem termo, sem faceta) devolve o catálogo ranqueado só por
merchandising — vitrine, não caixa vazia.

## Como a UI consome

```ts
import { createSearchIndex, rankSearch } from '@/lib/search';

// 1× por load do catálogo (memo/useMemo):
const docs = createSearchIndex(products);

// A cada tecla (já é síncrono e barato — sem debounce de rede):
const outcome = rankSearch(docs, {
  term,
  limit: 12,
  personalization: { topCategories, topFabrics },  // opcional
});

outcome.intent?.label   // "vestidos para casamento" → mostrar "Buscando por…"
outcome.relaxed         // true → mostrar "veja parecidos" + outcome.suggestions
outcome.results[n].reasons  // por que subiu — painel de debug/merchandising
```

Tracking: a UI que chama `rankSearch` dispara `trackSearch` de
`@/lib/tracking` (o motor não trackeia — é lib pura).

## Personalização

`PersonalizationContext` (`topCategories`, `topFabrics`, `nearStore`) são
sinais **locais** da visitante, sem PII e sem login. O fator combinado é
travado em **≤ 1.3** dentro de `applyBoosts`: personalização desempata
entre resultados equivalentes, mas nunca vence um match de texto melhor.
`nearStore` só passa a pontuar quando `availability.stores` vier populado
do BFF (hoje chega vazio).

## Testes

`src/lib/search/search.test.ts` — 26 testes: todas as frases naturais da
spec, typo, escada de relaxamento, boosts e teto de personalização.

```
npx vitest run src/lib/search/search.test.ts
```

## Documentos irmãos

- `docs/ai-search.md` — o slot da IA (camada 3)
- `docs/boost-rules.md` — cada regra de boost e como criar novas
- `docs/merchandising.md` — visão de negócio do ranking
