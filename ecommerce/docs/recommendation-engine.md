# Motor de Recomendação

Sprint 008 — Parte 3. Como o site escolhe "outras peças" pra mostrar, o que é
heurística honesta e o que muda quando existir dado de pedidos/CRM.

## Arquitetura em uma frase

A página declara **o que** quer (`RecommendationRail kind="..." seed={peça}`),
o motor (`src/lib/recommendations/engine.ts`) decide **como** — trocar a
heurística por dado real não toca em nenhuma página.

```
RecommendationRail (UI)          ← título editorial, skeleton, tracking
  └── getRecommendations(req)    ← contrato: RecommendationRequest → Product[]
        ├── /api/loja/relacionados   (BFF → backend FlowOps)
        ├── /api/loja/produtos       (BFF → catálogo com filtros)
        ├── recently-viewed.ts       (localStorage)
        ├── personalization.ts       (localStorage)
        └── store/wishlist           (zustand persistido)
```

Regras universais, valem pra todo `kind`:

- o(s) **seed(s) nunca aparecem** no resultado;
- **dedup por id** dentro do rail;
- **falha de rede/parse → `[]`** — o rail some inteiro (nem título renderiza),
  a página nunca quebra;
- limite padrão de 8 peças.

## Os kinds, um a um

### `voce-tambem-pode-gostar`

**Hoje:** repassa pro backend — `GET /public/loja/produto/:slug/relacionados`
via BFF `/api/loja/relacionados?slug=X&limite=8`. A inteligência (mesma
categoria, popularidade, estoque) mora no servidor, que enxerga o catálogo
inteiro.

**Quando houver pedidos/CRM:** o backend evolui o endpoint (similaridade por
compra conjunta, por perfil de cliente); o site não muda nada.

### `complete-seu-look`

**Hoje:** categorias **complementares** à do seed, definidas num mapa de dados
comentado no topo do `engine.ts` (peça de baixo pede peça de cima; peça única —
vestido, macacão, conjunto — pede terceira peça). Busca cada categoria
complementar em `/api/loja/produtos?categoria=X` e **intercala** os resultados
(round-robin) pro rail não virar blocos monotemáticos. Com vários seeds
(carrinho), une os complementos de todos e não recomenda categoria que a
cliente já tem na mão. Categoria sem complemento mapeado → rail some
(preferimos sumir a recomendar bobagem).

A personalização entra aqui: complemento que está no `topCategories` da
visitante vem primeiro.

**Quando houver pedidos:** o mapa manual vira estatística de "comprado junto"
por categoria — ou por peça. O mapa continua existindo como fallback de
catálogo frio.

### `quem-viu-tambem-comprou`

**Hoje: heurística honesta, e o nome do código diz isso.** Não existe dado de
pedidos ligado ao catálogo do site ainda, então aproximamos por: **mesma
categoria + faixa de preço ±30% do seed**, excluindo o próprio seed. A lógica
da faixa: quem olha vestido de R$ 200 não está decidindo entre ele e um de
R$ 600.

**Quando houver pedidos:** o checkout alimenta uma matriz de co-ocorrência no
backend (peça A e peça B no mesmo pedido) e este kind troca a query — a
assinatura e a UI ficam intactas.

### `ultimos-vistos`

Memória local (`recently-viewed.ts`): máx. 12 peças, dedup por id, mais
recente primeiro, guardando só o mínimo do card (id, slug, nome, 1ª foto,
preço). O rail renderiza direto do snapshot — sem rajada de requests — e o
clique leva pra página do produto, onde preço/estoque são sempre frescos.
Peça sem foto não entra (não há card sem foto).

Na página de produto o seed é a própria peça — ela não aparece no rail de
"vistos" dela mesma.

### `favoritos`

Ids do wishlist store (zustand + localStorage) resolvidos no **catálogo
vivo** via `/api/loja/produtos` — favorito precisa mostrar preço e
disponibilidade atuais. Ordem de exibição = ordem em que a cliente favoritou.

**Limitação conhecida:** o BFF ainda não filtra por ids; varremos a primeira
página (100 itens) e filtramos no client. Quando o backend ganhar `?refs=`,
vira uma query exata sem mudar assinatura.

## PersonalizationContext — privacidade por desenho

Contrato em `src/lib/search/types.ts`:

```ts
interface PersonalizationContext {
  topCategories: string[]; // top 3, da mais pra menos vista
  topFabrics: string[];    // top 3
  nearStore?: string;      // loja já atribuída pelo tracking (por CEP)
}
```

Como é construído (`personalization.ts`):

- a cada página de produto vista, `registerView(categoria, tecido)` incrementa
  contadores **no localStorage do aparelho** (normalizados, cauda podada em 20
  chaves);
- `getPersonalizationContext()` devolve o top 3 de cada eixo, mais a loja
  próxima que o tracking já conhecia.

**Privacidade: só sinais locais, zero PII.** Nenhum nome, telefone, e-mail ou
id de pessoa passa por aqui — nem sai do aparelho. O contexto é um agregado
anônimo ("olha mais vestidos e viscolycra") consumido pelo motor de busca e de
recomendação no próprio navegador.

**Quando houver login:** o módulo sincroniza os contadores com o CRM do
FlowOps (merge por soma, servidor manda) e o contexto passa a seguir a cliente
entre aparelhos. **A interface não muda** — `registerView` e
`getPersonalizationContext` continuam sendo os únicos pontos de contato.

## Onde os sinais são registrados

A página de produto é Server Component (ISR), então os registros client-side
vivem no `ProductPageSignals` (componente invisível, `useEffect` por id da
peça): `pushRecentlyViewed(product)` + `registerView(categoria, tecido)`.

## UI: RecommendationRail

`src/components/commerce/RecommendationRail.tsx` (client):

- **buscando** → `SectionTitle` + skeletons na silhueta do card (sem CLS);
- **vazio** → não renderiza NADA (nem título) — páginas empilham rails sem
  medo de seção fantasma;
- **com peças** → `LuxuryCarousel` de `ProductCard` (o card único do site).

Tracking: `view_item_list` uma única vez quando os produtos chegam
(`list_name` = kind) e `select_item` no clique que navega pro produto —
clique no coração de favoritar não conta.

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/lib/recommendations/engine.ts` | motor — estratégias por kind |
| `src/lib/recommendations/recently-viewed.ts` | últimos vistos (localStorage) |
| `src/lib/recommendations/personalization.ts` | sinais locais → PersonalizationContext |
| `src/components/commerce/RecommendationRail.tsx` | rail visual + tracking |
| `src/components/commerce/ProductPageSignals.tsx` | registro dos sinais na página de produto |
| `src/app/api/loja/relacionados/route.ts` | BFF fino → `/public/loja/produto/:slug/relacionados` |
