# Home

`src/app/(public)/page.tsx` — Server Component.

## A jornada em 15 movimentos

A ordem não é decorativa: cada seção prepara a próxima.

| # | Seção | Papel na jornada | Componente |
|---|---|---|---|
| 01 | Hero editorial | desejo — "elegância não tem tamanho" | `Hero` fullscreen |
| 02 | Manifesto | quem somos, desde 1979 + números | `Manifesto` |
| 03 | Novidades | o que chegou (recência) | `ProductCarousel` |
| 04 | Shop the Look | resolve a composição inteira | `LookShowcase` |
| 05 | Compre por ocasião | como ela realmente pensa | `OccasionCard` × 8 |
| 06 | Moda por tecido | educação de caimento | `FabricCard` × 6 |
| 07 | Moda por modelagem | consultoria de estilo | `FitCard` × 6 |
| 08 | Best sellers | prova social por volume | `ProductCarousel` |
| 09 | Editorial da semana | inspiração, cara de revista | `ImageGrid` + `EditorialCard` |
| 10 | Vídeo institucional | o provador por dentro | `VideoBlock` 21:9 |
| 11 | Depoimentos | prova social com dados de caimento | `TestimonialCarousel` |
| 12 | Instagram | vida real, produtos marcados | `InstagramCard` × 6 |
| 13 | Nossas lojas | a ponte pro físico | `StoreCard` × 3 |
| 14 | CTA final + newsletter | convite e relacionamento | `CTABanner` + `NewsletterBlock` |
| 15 | Footer | navegação e institucional | layout do grupo `(public)` |

## Decisões

**Por que ocasião antes de categoria.** A cliente chega com um problema
("casamento sábado"), não com uma taxonomia. Ocasião → tecido → modelagem é
uma escada de consultoria: onde vou, com que material, valorizando o quê.

**Por que a loja física fecha a página.** É onde a conversão da Lurds
acontece de verdade. A home inteira é vitrine; o último movimento é um
convite pro provador, com "Como chegar" e WhatsApp lado a lado.

**Por que os depoimentos mostram altura, peso e numeração.** É a informação
que resolve a dúvida real de quem já comprou algo que não vestiu. Nenhum
concorrente dá.

**Alternância de tom.** `default → alt → default → champagne → dark` cria
ritmo sem precisar de borda entre seções.

## Técnico

- **Estática.** Nada de dado por request; conteúdo muda por deploy.
- **JSON-LD:** `ItemList` dos destaques + os 14 nós `ClothingStore` (SEO local).
- **LCP:** a imagem do hero é a única com `priority`. Todo o resto é lazy.
- **Client islands:** só os carrosséis e cards com hover. Manifesto, títulos,
  ocasiões, tecidos e modelagem são server-rendered.
- **Um `<h1>`** (hero). Cada seção tem `<h2>` ligado por `aria-labelledby`.

## Conteúdo

Vem de `data/content.ts`. **Produtos, looks, depoimentos, Instagram e vídeo
são placeholder** — estrutura pra dar forma às seções.

O que já é **real**: taxonomias (ocasiões, tecidos, modelagens), a numeração
46–60, o texto do manifesto e as 14 lojas (`data/stores.ts`).

Trocar conteúdo = editar `data/content.ts`. Nenhum componente muda.
