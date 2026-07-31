# Roadmap

Estado real do projeto. Atualizar ao fim de cada sprint.

## Entregue

### Sprint 001 — Fundação ✅
Next 15 + React 19 + TS strict + Tailwind v4. Design tokens completos
(`globals.css @theme`), biblioteca base de UI, biblioteca de animações,
camada de SEO, tipos de domínio, stores Zustand, hooks compartilhados,
estrutura de pastas, `robots.ts`/`sitemap.ts`, 404 e error boundary,
documentação e `LURDS_MASTERPLAN.md`.

### Sprint 002 — Header + navegação ✅
AnnouncementBar rotativa, header sticky que encolhe 15% no scroll, Logo
(horizontal/compacto, claro/escuro), menu principal por intenção, mega menu
com colunas + card editorial, SearchOverlay com intenções e histórico,
UserMenu, Wishlist/Cart/Store com contador, MobileDrawer em acordeão.

### Sprint 003 — Componentes editoriais ✅
Hero configurável (imagem/vídeo, 4 alturas, 3 alinhamentos, parallax),
SectionTitle canônico, ProductCard premium (troca de foto, quick view,
favorito, tamanhos), LookCard com pins, Taxonomy/Category/Occasion/Fit cards,
FabricCard com identidade por tecido, StoreCard, TestimonialCard com dados de
caimento, InstagramCard, NewsletterBlock, VideoBlock, CTABanner, ImageGrid,
EditorialCard, LuxuryCarousel, skeletons e estados vazios.

### Sprint 004 — Home ✅
15 seções: hero fullscreen, manifesto com números, novidades, shop the look,
ocasiões, tecidos, modelagem, best sellers, editorial, vídeo institucional,
depoimentos, Instagram, lojas, CTA final, newsletter. Estática, com
`ItemList` + 14 nós `ClothingStore` no JSON-LD.

### Sprint 005 — Categoria ✅
Hero com breadcrumb, introdução, barra inteligente (contagem, busca na
categoria, chips removíveis, ordenação, visualização), filtros premium
(9 grupos; sidebar no desktop e drawer no mobile, mesmo componente), grid
editorial com interrupções (imagem, look, banner), infinite scroll + botão
"carregar mais" + paginação numerada disponível, guia educativo indexável,
Instagram, newsletter. SSG + ISR 1h para 10 categorias.

## Próximas

| Sprint | Escopo | Depende de |
|---|---|---|
| 006 | **Página de produto** — galeria, seletor de tamanho/cor, dados de caimento, avaliações, disponibilidade por loja, produtos relacionados | 003 |
| 007 | **Sacola** — mini-carrinho em drawer, página de carrinho, frete estimado, cupom | 006 |
| 008 | **Checkout** — endereço, entrega, pagamento (Pix/cartão), retirada em loja | 007 |
| 009 | **Minha conta** — pedidos, rastreio, endereços, dados | 008 |
| 010 | **Favoritos** — página, sincronização com conta | 009 |
| 011 | **Nossas lojas** — mapa, geolocalização, comprar-e-retirar | 003 |
| 012 | **Blog / editorial** — listagem, artigo, SEO de conteúdo | 003 |
| 013 | **Busca inteligente** — API real, facetas, autocomplete com produtos | 005 |
| 014 | **Consultora IA** — recomendação por medidas e ocasião | 006, 013 |
| 015 | **Integração FlowOps** — catálogo, estoque e preço reais via API | 006 |
| 016 | **SEO final** — auditoria, dados estruturados de review, hreflang se aplicável | todas |
| 017 | **Performance** — First Load JS < 200kB, Lighthouse ≥ 95 | todas |
| 018 | **Polimento + go-live** — QA, plano de migração de domínio | todas |

## Dívida técnica registrada

| Item | Onde | Prioridade |
|---|---|---|
| First Load JS 314kB (Framer no bundle comum) | ver [performance.md](performance.md) | Sprint 017 |
| Catálogo é placeholder (`data/content.ts`) | trocar por API em 015 | Sprint 015 |
| Fotos são Unsplash temporárias | substituir pelo banco da marca | quando houver |
| Depoimentos genéricos | trocar por avaliações reais com consentimento | quando houver |
| Vídeo institucional é stock | produzir vídeo próprio | quando houver |
| `(account)` e `(checkout)` vazios | sprints 007–009 | — |
