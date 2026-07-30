# Lurds Digital Guidelines

Guia de identidade digital da Lurd's Plus Size para páginas **públicas/voltadas à cliente**
(Home, Categoria, Produto, Checkout, Minha Conta, Nossas Lojas…).
Referência viva: toda tela nova deve nascer seguindo este guia.
Primeira implementação de referência: `/nossaslojas`.

> Este guia NÃO se aplica às telas internas de operação (PDV, retaguarda) — elas têm
> convenções próprias no CLAUDE.md.

## 1. Filosofia

A cliente não entra numa "página": entra numa boutique. Cada tela deve parecer uma
revista de moda — não um e-commerce comum. Inspiração: Apple, Aritzia, COS, Sézane,
Toteme, Zara editorial.

Critério de decisão (nesta ordem):
1. *"Isso parece um e-commerce comum?"* → refaça.
2. *"Isso poderia estar no site da Apple ou da Aritzia?"* → implemente.

Tom de voz: acolhedor, direto, feminino, sem juridiquês e sem gerúndio corporativo.
"A gente te recebe com um sorriso" em vez de "oferecemos atendimento diferenciado".

## 2. Cores (tokens CSS)

Definidos em `frontend/src/app/nossaslojas/lojas.css` (`.lojas-root`) — copiar para
novas rotas públicas ou promover a um CSS compartilhado quando houver 2+ telas.

| Token | Hex | Uso |
|---|---|---|
| `--lj-ivory` | `#FDFBF7` | Fundo base de página |
| `--lj-cream` | `#F6F1E8` | Fundo de seções alternadas |
| `--lj-champagne` | `#EFE6D6` | Gradientes, superfícies quentes |
| `--lj-ink` | `#211C18` | Texto principal, botões primários, seções escuras |
| `--lj-ink-soft` | `#5C534B` | Texto secundário (AA sobre ivory) |
| `--lj-gold` | `#B8912B` | Bordas de acento, fios |
| `--lj-gold-strong` | `#8C7325` | Texto dourado (AA sobre ivory), hovers |
| `--lj-gold-soft` | `#D4AF37` | Dourado sobre fundos escuros |
| `--lj-line` | `#E8DFD0` | Hairlines, bordas de card |
| Verde dinheiro | `#2E7D46` | **SÓ** WhatsApp/dinheiro/ação de conversão direta |

Regras: dourado é acento, nunca fundo de área grande. Verde só em WhatsApp/pagamento.
Nada de cores fora da paleta sem decisão explícita.

## 3. Tipografia

- **Títulos**: Playfair Display (`.lojas-serif`), peso 400–600, itálico para a palavra
  de ênfase (`<span class="italic text-[var(--lj-gold-strong)]">`).
- **Texto/UI**: Inter, pesos 300–600 (`font-light` para corpo, `font-medium` para UI).
- **Micro-labels**: 10–11px, `uppercase`, `tracking-[0.3em]+`, dourado ou ink-soft.
  É o elemento que mais "assina" a marca — usar acima de todo título de seção.

Hierarquia padrão de seção:
```
micro-label dourado (10-11px caps tracking largo)
título serif 3xl–5xl
fio dourado central (.lojas-rule, w-24)
parágrafo font-light leading-loose ink-soft (max-w-2xl)
```

## 4. Espaçamento e layout

- Seções: `py-24 sm:py-32` (respiro generoso é parte da identidade).
- Containers: `max-w-3xl` (texto), `max-w-4xl` (manifesto), `max-w-6xl/7xl` (grids).
- Cards: `rounded-3xl`, borda `--lj-line`, sombra suave `0_10px_40px_-30px`.
- Botões: **pill** (`rounded-full`), caps com tracking; primário = ink (hover dourado),
  secundário = outline dourado (hover `#FBF6E6`), WhatsApp = verde.
- Divisor editorial: `.lojas-rule` (fio com gradiente dourado).

## 5. Imagens

- Sempre `next/image` com `fill` + `sizes` corretos, `placeholder="blur"`
  (`BLUR_DATA_URL` champagne em `lib.ts`), lazy por padrão, `priority` só no hero.
- Fotos editoriais: pessoas reais, luz natural, tons quentes. Sobre foto, texto branco
  com gradiente escuro leve (`from-black/45 via-black/25`).
- Hover padrão de imagem em card: `scale-[1.04]`, `duration-700 ease-out`.
- Fotos temporárias: Unsplash (host liberado no `next.config.js`); trocar por fotos
  reais da marca assim que existirem (basta editar o JSON da tela).

## 6. Movimento (Framer Motion)

- Entrada de seção: `initial={{opacity:0, y:24}}` → `whileInView` com
  `viewport={{once:true, margin:'-80px'}}`, `duration` 0.6–0.9.
- Stagger discreto: `delay: i * 0.1`.
- Hover de card: lift `-translate-y-1.5` + sombra mais funda + zoom da foto. Nada gira,
  nada pisca, nada quica (exceto a seta do hero).
- Drawer: `x: '100%' → 0`, `ease: [0.22, 1, 0.36, 1]`, backdrop com blur.
- Easing assinatura: `cubic-bezier(0.22, 1, 0.36, 1)`.
- Respeitar `prefers-reduced-motion` (scroll-behavior já cai pra `auto`).

## 7. Componentes canônicos (referência em /nossaslojas)

| Padrão | Arquivo |
|---|---|
| Hero fotográfico com gradiente | `components/Hero.tsx` |
| Seção manifesto + stats | `components/Manifesto.tsx` |
| Card boutique (foto, badges, CTAs) | `components/StoreCard.tsx` |
| Drawer lateral premium (40vw / fullscreen mobile) | `components/StoreDrawer.tsx` |
| Autocomplete + geolocalização | `components/SearchLocate.tsx` |
| Mapa integrado com selo da marca | `components/MapPanel.tsx` |
| Carrossel de depoimentos | `components/Testimonials.tsx` |
| Badges de diferenciais | pills caps 10px, borda dourada/30 |

## 8. Ícones

Somente **Lucide**, `strokeWidth 1.5–1.75`, tamanhos 14–24px, cor dourada
(`--lj-gold-strong`) sobre claro ou branca sobre escuro. Sem emoji na UI pública.

## 9. Acessibilidade (mínimo obrigatório)

- Contraste AA: usar `--lj-ink-soft`/`--lj-gold-strong` (nunca `--lj-gold` como texto
  pequeno sobre ivory).
- `:focus-visible` dourado global (já no CSS da rota) — nunca remover outline sem repor.
- Drawer/modal: `role="dialog"` + `aria-modal`, foco no fechar, Esc fecha, scroll lock.
- `alt` descritivo em toda imagem; `aria-label` em botões só-ícone; navegação completa
  por teclado (cards com `role="button"` + Enter/Espaço).

## 10. Dados e SEO

- Conteúdo editável vive em JSON (`src/data/*.json`) — texto/foto novos NÃO devem exigir
  mexer em componente.
- Toda tela pública: `metadata` completo (title, description, canonical
  `www.lurdsplussize.com.br`, OG com imagem 1200×630) + JSON-LD quando aplicável
  (LocalBusiness/ClothingStore, Product, BreadcrumbList).
- Páginas públicas devem sair **estáticas** no build sempre que possível.
