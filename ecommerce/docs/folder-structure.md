# Estrutura de pastas

```
ecommerce/
├─ LURDS_MASTERPLAN.md        ← a constituição do projeto
├─ docs/                      ← esta documentação
├─ public/                    ← estáticos (fotos da marca, og, ícones)
└─ src/
   ├─ app/
   │  ├─ layout.tsx           raiz: fontes, JSON-LD global, providers, skip link
   │  ├─ providers.tsx        TanStack Query + ToastProvider
   │  ├─ globals.css          DESIGN TOKENS (@theme) — fonte única do sistema
   │  ├─ error.tsx            boundary de erro com identidade da marca
   │  ├─ not-found.tsx        404 editorial
   │  ├─ robots.ts            robots.txt gerado
   │  ├─ sitemap.ts           sitemap gerado da árvore de navegação
   │  ├─ (public)/            VITRINE — header + footer compartilhados
   │  │  ├─ layout.tsx
   │  │  ├─ page.tsx          Home (15 seções)
   │  │  └─ categoria/[slug]/ Página de categoria
   │  ├─ (account)/           conta, pedidos, favoritos, endereços  (a fazer)
   │  └─ (checkout)/          carrinho, checkout                    (a fazer)
   │
   ├─ components/
   │  ├─ ui/                  primitivos: Button, Input, Choice, Badge, Card,
   │  │                       Overlay, Drawer, Modal, Accordion, Tabs, Tooltip,
   │  │                       Skeleton, LuxuryCarousel, icons
   │  ├─ layout/              Container, Section, Footer
   │  ├─ navigation/          Header, AnnouncementBar, Logo, Navigation,
   │  │                       MegaMenu, CategoryColumn, MenuCard,
   │  │                       SearchOverlay, MobileDrawer, HeaderActions,
   │  │                       Breadcrumb, Pagination
   │  ├─ sections/            blocos de página: Hero, SectionTitle, Manifesto,
   │  │                       ProductCarousel, LookShowcase,
   │  │                       TestimonialCarousel, VideoBlock, CTABanner,
   │  │                       ImageGrid (+ EditorialCard), NewsletterBlock
   │  ├─ cards/               ProductCard, LookCard, TaxonomyCard
   │  │                       (Category/Occasion/Fit), FabricCard, StoreCard,
   │  │                       TestimonialCard, InstagramCard
   │  ├─ commerce/            CategoryListing, SmartBar, FilterPanel,
   │  │                       EditorialProductGrid
   │  └─ feedback/            ToastProvider, EmptyState, Loading
   │
   ├─ hooks/
   │  ├─ index.ts             lock scroll, esc, focus trap, media query,
   │  │                       scrolled, debounce, intersection, click outside
   │  └─ useProductFilters.ts estado de filtro/ordenação/busca
   │
   ├─ services/
   │  ├─ products.ts          catálogo: fetch, filtros, ordenação, meta
   │  └─ search.ts            busca + intenções + histórico
   │
   ├─ data/
   │  ├─ navigation.ts        menu, mega menu, announcements, buscas populares
   │  ├─ stores.ts            14 lojas físicas (dados REAIS)
   │  └─ content.ts           vitrine (PLACEHOLDER) + taxonomias (reais)
   │
   ├─ lib/
   │  ├─ utils.ts             cn, formatPrice, slugify, blur placeholder
   │  ├─ motion.ts            biblioteca de animações
   │  └─ seo.ts               buildMetadata + JSON-LD
   │
   ├─ store/                  ui.ts, cart.ts, wishlist.ts (Zustand)
   └─ types/index.ts          contrato de domínio
```

## Onde colocar o quê

| Vou criar… | Vai em |
|---|---|
| primitivo sem domínio (botão, input) | `components/ui/` |
| bloco que ocupa uma faixa da página | `components/sections/` |
| card de uma entidade do negócio | `components/cards/` |
| algo específico de listagem/compra | `components/commerce/` |
| comportamento usado por 2+ componentes | `hooks/` |
| acesso a dado (mesmo mock) | `services/` |
| texto/foto que humano vai editar | `data/` |
| função pura sem React | `lib/` |
