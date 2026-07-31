# Mini-cart — o drawer da sacola

> Sprint 009. Peça: `src/components/commerce/MiniCart.tsx`, montado UMA vez no
> layout `(public)` e controlado 100% pelo `uiStore` (`overlay: 'cart'`).
> A linha de peça é a mesma da página — ver `docs/cart.md`.

## Por que abre sozinho ao adicionar

O momento mais frágil do funil é o segundo depois do "Adicionar à sacola": a
cliente precisa VER que funcionou. O toast confirma, mas o mini-cart **mostra**
— a peça, o subtotal, o quanto falta pro frete grátis e o botão de finalizar,
tudo sem tirar a cliente da página (levar pro `/carrinho` a cada adição mata a
compra de duas ou três peças). Por isso o `BuyBox` chama `openOverlay('cart')`
logo após `cartStore.add` + `trackAddToCart`.

O ícone de sacola do header deixou de ser link: abre o mesmo drawer. A página
completa continua existindo — o caminho até ela é o botão "Ver sacola completa"
do próprio drawer.

## Como abre e fecha

- Estado: `useIsCartOpen()` / `openOverlay('cart')` / `closeOverlay()` — um
  overlay por vez (regra do `uiStore`: abrir a busca fecha a sacola, etc).
- Segue o padrão DURO do repo: `Drawer`/`Overlay` sempre montado, animado por
  `open` + `inert` — **nada de AnimatePresence** (docs/animations.md).
- Fecha sozinho quando a rota muda (clique numa peça, "Finalizar compra") — um
  drawer aberto por cima da página nova é bug, não feature.
- Antes da hidratação renderiza vazio dos dois lados (guard `useMounted`) — o
  carrinho vive no localStorage e o HTML do server precisa bater com o do
  primeiro render do client.

## Barra de frete grátis

`freeShippingGap(subtotal)` alimenta a barra no topo do drawer:

- faltando: "Faltam R$ X para o frete grátis" + barra de progresso DOURADA
  (`--color-primary`) animada por width;
- atingiu: celebração DISCRETA — Sparkles + "Você ganhou frete grátis" em
  dourado, com um scale/fade curto. Sem confete, sem verde: verde é reservado
  pro total (dinheiro), e a marca não grita.

É o incentivo mais honesto da sacola: aparece antes de qualquer cupom e empurra
o ticket médio sem pressionar.

## Anatomia

1. **Header** — "Sua sacola (N)", N = soma de quantidades.
2. **Barra de frete grátis** (acima das linhas — é o primeiro empurrão).
3. **Linhas** — `CartLineRow` compacta: foto 3/4, nome, cor/tamanho, stepper,
   preço tabular, remover (`remove_from_cart`).
4. **Cupom compacto** — `applyCoupon` + mensagem elegante inline;
   `coupon_applied`/`coupon_removed`. Aplicado vira um chip com X.
5. **Totais** — subtotal, desconto, frete estimado (só com CEP + cotação já
   salvos pela página/checkout; senão "calculado no checkout"); preço 0 exibe
   "Grátis". **Total em verde** — o único verde do drawer.
6. **Footer** — "Finalizar compra" (primário → `/checkout`), "Ver sacola
   completa" (secundário → `/carrinho`), "Continuar comprando" (fecha).

Vazio: `EmptyState` acolhedor com CTA pra `/novidades` (fecha o drawer e navega).

## Tracking

- `view_cart` dispara quando o drawer ABRE com itens (abrir = ver a sacola,
  mesmo peso da página). Um disparo por abertura — ref interno evita duplicata
  por re-render; reabrir dispara de novo (é outra visita à sacola).
- Eventos de linha (remover, quantidade) moram no `CartLineRow` — iguais nos
  dois contextos por construção.
