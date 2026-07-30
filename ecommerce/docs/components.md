# Biblioteca de componentes

Toda tela usa **exclusivamente** estes componentes. Página que precisa de algo
novo adiciona à biblioteca (com tipos + entrada aqui), nunca cria local.

Componentes editoriais (Hero, cards, carrossel, blocos de seção) estão em
[editorial-components.md](editorial-components.md).

## Layout

| Componente | Arquivo | Notas |
|---|---|---|
| `Container` | `layout/Container.tsx` | largura + gutter. `narrow/text/page/wide/full` |
| `Section` | `layout/Section.tsx` | ritmo vertical + tom de fundo. Páginas não escrevem `py-*` |
| `Footer` | `layout/Footer.tsx` | 4 colunas + institucional + sociais |

## UI base

| Componente | Arquivo | API essencial |
|---|---|---|
| `Button` | `ui/Button.tsx` | `variant` (primary/secondary/ghost/light/outlineLight/whatsapp), `size`, `block`, `href` → vira `<Link>` |
| `IconButton` | `ui/Button.tsx` | `label` obrigatório (vira `aria-label`) |
| `Input` / `Textarea` / `Select` | `ui/Input.tsx` | label associada, `error` ligado por `aria-describedby`, aceita `ref` (RHF) |
| `Checkbox` / `Radio` / `Switch` | `ui/Choice.tsx` | input `sr-only` + `peer-checked:` na caixa desenhada |
| `ColorSwatch` / `SizePill` | `ui/Choice.tsx` | controles de filtro de cor e tamanho |
| `Badge` / `ProductBadgeTag` / `Chip` | `ui/Badge.tsx` | etiquetas com cor fixa por significado; chip removível |
| `Card` / `Avatar` | `ui/Card.tsx` | casca genérica com hover premium opcional |
| `Overlay` | `ui/Overlay.tsx` | primitivo de Modal/Drawer (ver nota abaixo) |
| `Drawer` | `ui/Drawer.tsx` | painel lateral: header / corpo rolável / rodapé fixo |
| `Modal` | `ui/Modal.tsx` | diálogo central; para conteúdo longo prefira Drawer |
| `Accordion` / `AccordionItem` | `ui/Accordion.tsx` | altura anima com `height: auto` |
| `Tabs` | `ui/Tabs.tsx` | indicador com `layoutId`; setas ←/→ |
| `Tooltip` | `ui/Tooltip.tsx` | abre no hover **e** no foco |
| `Skeleton` e variantes | `ui/Skeleton.tsx` | `ProductCardSkeleton`, `ProductGridSkeleton`, `TextSkeleton` |
| `LuxuryCarousel` | `ui/LuxuryCarousel.tsx` | Embla; `perView` por breakpoint; setas fora do conteúdo |
| `InstagramIcon` / `WhatsAppIcon` | `ui/icons.tsx` | ícones de marca no padrão Lucide |

### Nota de arquitetura: overlays

`Overlay` mantém o painel **sempre montado** depois da primeira abertura e
anima por estado, em vez de montar/desmontar com `AnimatePresence`. Motivo: o
unmount pós-exit depende de `requestAnimationFrame`, que não dispara em aba
sem composição — o painel ficava órfão no DOM. Com `inert` + `pointer-events:
none` o painel fechado sai da ordem de tab e da árvore de acessibilidade, que
é o que de fato importa.

## Navegação

| Componente | Arquivo |
|---|---|
| `Header` | `navigation/Header.tsx` — sticky, encolhe 15% no scroll |
| `AnnouncementBar` | `navigation/AnnouncementBar.tsx` — 36px, mensagens rotativas |
| `Logo` | `navigation/Logo.tsx` — `horizontal`/`compact`, `dark`/`light` |
| `Navigation` | `navigation/Navigation.tsx` — menu desktop + mega menu |
| `MegaMenu` | `navigation/MegaMenu.tsx` — colunas + card editorial + rodapé |
| `CategoryColumn` / `MenuCard` | `navigation/` — peças do mega menu |
| `SearchOverlay` | `navigation/SearchOverlay.tsx` — painel de busca |
| `MobileDrawer` | `navigation/MobileDrawer.tsx` — navegação mobile |
| `HeaderActions` | `navigation/HeaderActions.tsx` — Search/Store/User/Wishlist/Cart |
| `Breadcrumb` | `navigation/Breadcrumb.tsx` — `tone` claro para sobre foto |
| `Pagination` | `navigation/Pagination.tsx` — aceita `hrefFor` para links reais |

## Commerce

| Componente | Arquivo | Papel |
|---|---|---|
| `CategoryListing` | `commerce/CategoryListing.tsx` | orquestra barra + filtros + grid + paginação |
| `SmartBar` | `commerce/SmartBar.tsx` | contagem, busca na categoria, chips, ordenação, visualização |
| `FilterPanel` | `commerce/FilterPanel.tsx` | mesmo conteúdo na sidebar e no drawer |
| `EditorialProductGrid` | `commerce/EditorialProductGrid.tsx` | grade com interrupções editoriais |

## Feedback

| Componente | Arquivo |
|---|---|
| `ToastProvider` / `useToast` | `feedback/ToastProvider.tsx` |
| `EmptyState` | `feedback/EmptyState.tsx` |
| `Spinner` / `LoadingBar` | `feedback/Loading.tsx` |

## Hooks

`hooks/index.ts`: `useLockScroll`, `useEscapeKey`, `useFocusTrap`,
`useMediaQuery`, `useScrolled`, `useDebounced`, `useIntersection`,
`useClickOutside`, `useMounted`.
`hooks/useProductFilters.ts`: estado serializável de filtro/ordenação/busca.

## Stores (Zustand)

`store/ui.ts` (um overlay por vez) · `store/cart.ts` (linha =
produto+tamanho+cor, `persist`) · `store/wishlist.ts` (`persist`).
