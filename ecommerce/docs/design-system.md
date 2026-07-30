# Design System

Fonte única de verdade: **`src/app/globals.css`**, bloco `@theme`.
O Tailwind v4 gera as utilities a partir das variáveis — declarar
`--color-ink` cria `bg-ink`, `text-ink`, `border-ink`.

> Cor, tamanho ou duração hardcoded dentro de componente é bug.
> Se falta um valor, o token entra no `@theme` primeiro.

## Cores

| Token | Hex | Uso |
|---|---|---|
| `ink` | `#1A1614` | texto principal, botão primário, seções escuras |
| `ink-soft` | `#5C534B` | texto secundário (AA sobre `background`) |
| `ink-muted` | `#8A7F76` | caption, placeholder (usar ≥ 13px) |
| `background` | `#FCFAF7` | fundo base da página |
| `surface` | `#FFFFFF` | cards, inputs |
| `surface-alt` | `#F5F0E8` | seções alternadas (creme) |
| `champagne` | `#EDE3D3` | superfícies quentes, gradientes |
| `border` | `#E8DFD0` | hairline padrão |
| `border-strong` | `#D6C9B3` | hairline de ênfase |
| `primary` | `#B8912B` | dourado: fio, borda, acento |
| `primary-strong` | `#8C7325` | dourado legível como texto sobre claro |
| `primary-soft` | `#D4AF37` | dourado sobre fundo escuro |
| `primary-wash` | `#FBF6E6` | hover de superfície dourada |
| `secondary` | `#7A3B46` | vinho da marca (etiqueta promoção) |
| `accent` | `#4F7355` | sálvia, uso raro |
| `success` | `#2E7D46` | **só** WhatsApp / dinheiro / Pix |
| `warning` / `danger` / `info` | — | estados de sistema |

**Regras.** Dourado é acento, nunca área grande. Verde é reservado —
usar em outro contexto quebra a leitura de "isto é dinheiro". Texto pequeno
sobre `background` usa `ink-soft` ou `primary-strong` (nunca `primary`).

## Tipografia

- **Playfair Display** (`font-display`) — títulos. A palavra de ênfase vai em
  `italic text-primary-strong` (ou `text-primary-soft` sobre escuro).
- **Inter** (`font-sans`) — UI e corpo. `font-light` (300) é o peso do texto.

| Token | Tamanho | Onde |
|---|---|---|
| `text-display` | clamp 2.75→5.5rem | título do hero |
| `text-h1` | clamp 2.25→3.5rem | título de página |
| `text-h2` | clamp 1.75→2.5rem | título de seção |
| `text-h3` | clamp 1.375→1.75rem | título de card grande |
| `text-h4` | 1.125rem | título de card pequeno |
| `text-body-lg` | 1.0625rem | parágrafo editorial |
| `text-body` | 0.9375rem | corpo padrão |
| `text-small` | 0.8125rem | apoio, metadados |
| `text-caption` | 0.6875rem | micro-label (via `.eyebrow`) |
| `text-button` | 0.8125rem | botões |

## Composição canônica de seção

Nunca mude a ordem — é o que faz páginas diferentes parecerem o mesmo site:

```
eyebrow dourado (caixa-alta, tracking 0.32em)
título serif (text-h2)
fio dourado (.hairline-gold, w-24)
descrição (text-body-lg font-light text-ink-soft, max-w-2xl)
CTA opcional (caixa-alta + seta que desliza no hover)
```

Implementado em `components/sections/SectionTitle.tsx` — use o componente,
não recrie a composição.

## Espaçamento

Escala base 4px do Tailwind, mais aliases semânticos:

| Token | Valor | Uso |
|---|---|---|
| `section` | 7rem | respiro padrão entre seções (`py-section`) |
| `section-sm` | 4.5rem | seções densas |
| `section-lg` | 10rem | manifesto, CTA final |
| `gutter` | 1.5rem | padding lateral mobile |
| `gutter-lg` | 2.5rem | padding lateral desktop |

Largura de conteúdo via `Container`: `narrow` 640 · `text` 896 ·
`page` 1152 (padrão) · `wide` 1344 · `full`.

## Raio, sombra, movimento

- **Raio** — `pill` em botões e chips; `md` (12px) em fotos e inputs;
  `lg` (20px) em cards; `xl` em drawer de baixo.
- **Sombra** — `xs → xl` quentes e difusas + `gold` (hover de card premium).
- **Movimento** — easing `--ease-lurds` = `cubic-bezier(0.22,1,0.36,1)`.
  Durações: `fast` 180ms (micro), `base` 320ms (UI), `slow` 560ms (entrada),
  `editorial` 900ms (imagem). Zoom de foto no hover: **exatamente 1.04**.

## Z-index

Escala nomeada em `:root` — `--z-sticky` 20, `--z-header` 30,
`--z-dropdown` 40, `--z-overlay` 50, `--z-drawer` 60, `--z-modal` 70,
`--z-toast` 80, `--z-tooltip` 90. Nunca inventar número solto.

## Utilities de marca

| Classe | Efeito |
|---|---|
| `.eyebrow` | micro-label caixa-alta com tracking largo |
| `.hairline-gold` | fio divisor com gradiente dourado |
| `.link-underline` | sublinhado que cresce no hover / `[data-active]` |
| `.tabular` | números tabulares (preços alinhados) |
| `.grain` | textura de papel sobre gradientes |
| `.shimmer` | animação dos skeletons |
| `.no-scrollbar` | esconde a barra mantendo o scroll |

## Breakpoints

`xs` 420 (large mobile) · `sm` 640 · `md` 768 (tablet) · `lg` 1024 (notebook) ·
`xl` 1280 (desktop) · `2xl` 1536.
