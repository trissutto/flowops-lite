# Acessibilidade

Alvo: **WCAG 2.1 nível AA**. Não é item de checklist no fim — é condição de
aceite de cada componente.

## Contraste

Pares aprovados sobre `background` (#FCFAF7):

| Texto | Contraste | Uso |
|---|---|---|
| `ink` #1A1614 | ~15:1 | corpo, títulos |
| `ink-soft` #5C534B | ~7:1 | texto secundário |
| `ink-muted` #8A7F76 | ~4,6:1 | **só ≥ 13px** (caption, metadados) |
| `primary-strong` #8C7325 | ~4,6:1 | texto dourado sobre claro |

⚠️ `primary` (#B8912B) **não** passa AA como texto pequeno sobre claro — use
só em fio, borda e ícone. Sobre fundo escuro, use `primary-soft`.

## Foco

`:focus-visible` global em `globals.css`: contorno dourado de 2px com offset
de 3px. **Nunca** remover outline sem repor equivalente visível.

Todo controle é alcançável e operável por teclado. Os inputs de
Checkbox/Radio/Switch ficam `sr-only` (não `display: none`, que mataria o
foco) e a caixa desenhada reage com `peer-focus-visible:`.

## Overlays (Drawer, Modal, SearchOverlay)

- `role="dialog"` + `aria-modal="true"` + `aria-label`
- Foco move pro painel ao abrir e **volta ao gatilho** ao fechar
  (`useFocusTrap`)
- Tab circula dentro do painel
- **Esc** fecha (`useEscapeKey`)
- Scroll do body travado enquanto aberto (`useLockScroll`)
- Painel fechado recebe `inert` → sai da ordem de tab e da árvore de
  acessibilidade

## Navegação

- **Skip link** é o primeiro tabbable da página → `#conteudo`
- `<nav>` com `aria-label` distinto por região
- Mega menu abre no hover **e** no foco; `aria-expanded` no gatilho
- Breadcrumb com `aria-current="page"` no último item
- Item ativo do menu marcado por `data-active`, não só por cor

## Semântica

- Um `<h1>` por página; sem pular nível
- Seção com `aria-labelledby` apontando pro seu `<h2>`
- Listas reais (`<ul>/<li>`) em coleções
- `<figure>/<figcaption>` em imagem com legenda
- `<blockquote>` + `<figcaption>` em depoimento
- `<dl>` nos dados de caimento (altura/peso/tamanho)
- Card clicável tem `role="button"` + `tabIndex={0}` + Enter/Espaço, e um
  `aria-label` que descreve o destino

## Imagens

- `alt` descritivo em toda imagem informativa
- `alt=""` + `aria-hidden` nas puramente decorativas (segunda foto do card,
  poster de vídeo por baixo)
- Ícone só-decorativo: `aria-hidden`. Ícone que É o botão: `aria-label` no
  botão

## Movimento e mídia

- `prefers-reduced-motion: reduce` zera animação e transição globalmente
- Vídeo com autoplay é **mudo, em loop** e tem controle de pausa e de som
  visíveis (WCAG 2.2.2 exige poder pausar)
- Carrossel não tem autoplay
- Anúncio rotativo não usa `aria-live` (interromperia o leitor de tela sem
  necessidade)

## Feedback

- Toast em região `aria-live="polite"` — anuncia sem roubar foco
- Erro de formulário com `role="alert"` e ligado por `aria-describedby`
- Estado de carregamento com `role="status"` + `aria-label`

## Toque

Alvos ≥ 44×44px no mobile. Itens do drawer têm `min-h-14`; CTAs ocupam a
largura total.

## Como testar

1. Guardar o mouse: percorrer a página só com Tab/Shift+Tab/Enter/Esc.
2. Zoom de 200% — nada deve cortar ou sobrepor.
3. DevTools → Rendering → emular `prefers-reduced-motion`.
4. Lighthouse (aba Accessibility) em build de produção.
5. Leitor de tela: NVDA (Windows) ou VoiceOver (Mac) nos fluxos de compra.
