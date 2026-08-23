# Header

`components/navigation/Header.tsx` — presente em toda página do grupo
`(public)`.

## Anatomia

```
┌──────────────────────────────────────────────┐
│ AnnouncementBar (36px, ink, rotativa)        │  ← rola junto, não é sticky
├──────────────────────────────────────────────┤
│ [☰]  LURD'S      menu principal    🔍 📍 👤 ♡ 🛍 │  ← sticky
└──────────────────────────────────────────────┘
        └─ mega menu abre aqui (full-width) ─┘
```

## Comportamento sticky

Ao passar de **24px** de scroll:

| Propriedade | Topo | Rolado |
|---|---|---|
| Altura | 64px / 96px (lg) | 56px / 76px (lg) — ~15% menor |
| Fundo | `background` sólido | `background/92` + `backdrop-blur-md` |
| Borda | transparente | `border` |
| Sombra | nenhuma | `shadow-xs` |
| Logo | escala 1 | escala 0.92 (lg) |

Transição de 320ms com o easing da marca — perceptível, nunca abrupta.

**Por que a AnnouncementBar não é sticky:** a barra promocional não deve
competir com a navegação depois que a cliente começou a explorar. Ela
cumpre o papel na primeira dobra e sai.

## Announcement Bar

`data/navigation.ts → announcements`. Troca a cada 5s com fade. Campanha nova
= acrescentar item no array; nenhuma mudança estrutural.

Não usa `aria-live`: mensagem promocional interrompendo o leitor de tela é
ruído, não informação.

## Logo

`variant`: `horizontal` (lettering "LURD'S" + eyebrow "PLUS SIZE") ou
`compact` (monograma L, para header reduzido em telas estreitas).
`tone`: `dark` (sobre claro) / `light` (sobre foto).
`asHeading`: renderiza dentro de `<h1>` — usar **só** onde o logo é o
título da página.

Feito em tipografia enquanto o SVG oficial não chega: nítido em qualquer
densidade e zero requisição.

## Ações

| Botão | Comportamento |
|---|---|
| Buscar | abre o SearchOverlay (`store/ui.ts`) |
| Lojas | link direto pra `/lojas` (oculto no mobile — está no drawer) |
| Conta | dropdown com atalhos + CTA "Entrar" |
| Favoritos | contador do `wishlist` store |
| Sacola | contador somando quantidades do `cart` store |

Os contadores só aparecem **após a hidratação** (`useMounted`) — os stores
persistem em `localStorage` e renderizar antes causaria mismatch.

## Estado dos overlays

Um só overlay aberto por vez, coordenado por `store/ui.ts`
(`search` | `menu` | `cart`). Abrir um fecha o outro — sem isso o scroll-lock
e o foco começam a brigar.

## Acessibilidade

- Skip link é o primeiro tabbable da página (no layout raiz)
- `<nav aria-label="Navegação principal">`
- Gatilho do mega menu com `aria-expanded`
- Botão de menu mobile com `aria-label` + `aria-expanded`
- Item ativo por `data-active` (não só cor)
- Esc fecha o mega menu, o drawer e a busca
