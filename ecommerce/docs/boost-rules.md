# Regras de boost — referência técnica

`src/lib/merchandising/rules.ts` (as regras) + `boost.ts` (o aplicador).
Shape: `BoostRule` em `src/lib/search/types.ts`. Visão de negócio em
`docs/merchandising.md`.

## Como funciona

Boost é um **multiplicador sobre o score de relevância**. A relevância
(texto + facetas) decide quem aparece; o boost decide quem aparece
primeiro **entre resultados comparáveis**. Um boost de 1.25 não faz uma
calça aparecer na busca por "vestido" — só reordena dentro do que já era
relevante.

`applyBoosts(score, product, rules, personalization?)` devolve
`{ score, reasons }`. As `reasons` ("boost Novidade ×1.25") viajam até o
`ScoredResult` — é o que torna o ranking auditável no painel de debug.

Condições dentro de `when` são **E** (todas precisam valer). Regras entre
si são independentes e os fatores **multiplicam** (produto novo E em
promoção acumula 1.25 × 1.15).

## As regras de hoje (todas `enabled`)

| id | Fator | Condição (`when`) | Por quê |
|---|---|---|---|
| `novidade` | 1.25 | `isNew: true` (badge `novo`) | estoque novo é o que gira; quem vê lançamento navega o resto |
| `best-seller` | 1.2 | `badge: 'best-seller'` | prova social converte — mas abaixo de novidade pra vitrine não congelar |
| `promocao` | 1.15 | `onSale: true` (badge `promocao` ou `compareAtPrice > price`) | atrai clique, margem menor → empurrão moderado |
| `ultimas-pecas` | 1.1 | `badge: 'ultimas-pecas'` | urgência real, mas grade quebrada não pode dominar a primeira dobra |

## Condições disponíveis no `when`

| Campo | Casa quando |
|---|---|
| `badge` | `product.badges` contém o badge |
| `isNew` | presença do badge `novo` é igual ao valor |
| `onSale` | badge `promocao` OU `compareAtPrice > price` |
| `category` | categoria igual (normalizada) |
| `collection` | coleção igual (normalizada) |
| `fabric` | tecido do produto contém o valor |
| `maxStock` | **proxy**: badge `ultimas-pecas` (o front não recebe contagem de estoque; o `mapPeca` liga esse badge quando `estoqueTotal ≤ 3`). Quando o BFF expor o número, a checagem vira comparação real sem mudar o shape. |

## Criando uma regra nova

1. Adicione o objeto em `DEFAULT_BOOST_RULES` (`rules.ts`) com comentário
   do PORQUÊ do fator — regra sem justificativa vira superstição:

```ts
{
  // Coleção de festa em novembro/dezembro: pico de formatura + confra.
  id: 'festa-fim-de-ano',
  label: 'Festa em alta',
  factor: 1.15,
  enabled: true,
  when: { collection: 'festa e cerimonia' },
},
```

2. Calibre o fator: 1.05–1.1 sutil · 1.15–1.25 visível · > 1.3 só com
   motivo forte (começa a atropelar a relevância).
3. Teste em `search.test.ts` se a regra tiver lógica de condição nova.
4. Pra desligar, `enabled: false` — não delete (histórico documenta o que
   já foi tentado).

## Caminho pra virar painel

`loadBoostRules()` é o único ponto de troca (documentado no próprio
arquivo): backend ganha `GET /api/loja/boost-rules` (Postgres + tela de
retaguarda), a função busca com cache curto e **cai pras DEFAULT em
erro** — merchandising fora do ar nunca quebra a busca. O motor já recebe
regras por parâmetro (`rankSearch(docs, query, rules?)`), que é também
como o painel fará preview de uma regra antes de publicar.
