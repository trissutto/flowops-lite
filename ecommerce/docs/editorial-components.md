# Componentes editoriais

Os blocos que dão à vitrine a cara de revista. Toda página monta a partir
daqui — nenhuma cria seção própria.

## Hero — `sections/Hero.tsx`

O componente mais importante da linguagem visual.

| Prop | Valores | Padrão |
|---|---|---|
| `image` / `video` | `Media` / `VideoMedia` | arte champagne se ambos ausentes |
| `height` | `small` `medium` `large` `fullscreen` | `large` |
| `align` | `left` `center` `right` | `center` |
| `overlay` | `none` `soft` `medium` `strong` | `medium` |
| `parallax` | boolean | `true` (12% de deslocamento) |
| `priority` | boolean | `false` — ligar só no hero da primeira dobra |
| `above` | ReactNode | slot pro breadcrumb |
| `showScrollHint` | boolean | seta de "role pra baixo" |

De fábrica: zoom-out de 1.08→1.00 em 2,2s na entrada, parallax leve no
scroll, gradiente ancorando o texto, entrada escalonada de
eyebrow → título → subtítulo → CTAs.

**Regra:** pouquíssimo texto. Título curto, uma linha de apoio, até dois botões.

## SectionTitle — `sections/SectionTitle.tsx`

Cabeçalho canônico de toda seção. Composição fixa (não recriar na mão):
eyebrow → título → fio dourado → descrição → CTA.
Aceita `align`, `tone` (para fundo escuro), `hideRule`, `as` (h1/h2/h3) e `id`
(para ligar com `aria-labelledby` da seção).

## Manifesto — `sections/Manifesto.tsx`

Seção institucional: título grande, parágrafos em `body-lg font-light` e
números em destaque (`stats`). Não vende — posiciona.

## Cards

| Componente | Arquivo | Particularidade |
|---|---|---|
| `ProductCard` | `cards/ProductCard.tsx` | troca de foto no hover, zoom 1.04, quick view, favorito, tamanhos disponíveis, preço + Pix + parcelamento, desconto **calculado** |
| `LookCard` | `cards/LookCard.tsx` | pins nas peças, lista de itens com preço, "levar o look" e compra individual, salvar e compartilhar |
| `CategoryCard` / `OccasionCard` | `cards/TaxonomyCard.tsx` | variante `editorial`: foto com nome sobreposto |
| `FitCard` | `cards/TaxonomyCard.tsx` | variante `text`: sem foto, tipografia grande (conteúdo educativo) |
| `FabricCard` | `cards/FabricCard.tsx` | identidade própria por tecido (gradiente + brilho diagonal no hover); texto escura em tecidos claros pra manter AA |
| `StoreCard` | `cards/StoreCard.tsx` | **cidade é a protagonista** em caixa-alta; sem foto de modelo (decisão validada) |
| `TestimonialCard` | `cards/TestimonialCard.tsx` | bloco de caimento: altura, peso, numeração comprada |
| `InstagramCard` | `cards/InstagramCard.tsx` | feito à mão (widget de terceiro mata o Lighthouse); mostra produtos marcados |

Hover padrão de card: sobe 6px, sombra mais funda, foto em `scale(1.04)`,
duração 560–900ms com o easing da marca. No mobile nada disso dispara.

## Blocos de seção

| Componente | Uso |
|---|---|
| `ProductCarousel` | vitrine de produtos (novidades, best sellers, relacionados) |
| `LookShowcase` | carrossel de looks; "levar o look" adiciona tudo na sacola |
| `TestimonialCarousel` | avaliações, 1 no mobile / 3 no desktop, com bullets |
| `VideoBlock` | vídeo institucional; autoplay mudo + loop + controles de pausa/som |
| `CTABanner` | chamada larga com parallax; usado na home e intercalado na listagem |
| `ImageGrid` | grade editorial (`feature`, `mosaic`, `even`) — itens de tamanhos diferentes é o que tira a cara de galeria |
| `EditorialCard` | artigo (foto, eyebrow, título, resumo, tempo de leitura) |
| `NewsletterBlock` | bloco de seção com **um** campo. Nunca popup |

## LuxuryCarousel — `ui/LuxuryCarousel.tsx`

Embla. `perView` por breakpoint, `gap`, `arrows`, `dots`, `align`, `loop`.
Setas ficam **fora** do conteúdo (nunca sobre a foto) e desaparecem quando não
há para onde ir. Sem autoplay: conteúdo de moda que se move sozinho tira a
atenção da peça e é problema de acessibilidade.

## Grid editorial — `commerce/EditorialProductGrid.tsx`

A grade **não** é uniforme. `interruptions` insere, em posições definidas,
blocos que ocupam 2 colunas:

```ts
{ at: 6,  kind: 'image',  image, caption, href }
{ at: 14, kind: 'look',   look }
{ at: 22, kind: 'banner', eyebrow, title, description, href, cta }
```

Sem `interruptions`, degrada pra grade limpa (serve busca e outlet).
`view="grid"` desliga as interrupções e adensa as colunas.
