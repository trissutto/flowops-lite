# Animações

Biblioteca: `src/lib/motion.ts`. Única lib de animação do projeto:
**Framer Motion**.

## Princípio

Movimento guia o olho — nunca chama atenção pra si. Sem bounce, sem spring
elástico, sem rotação, sem entrada vindo de longe. Duração generosa +
easing de saída suave = sensação de peso e qualidade.

**Easing assinatura:** `cubic-bezier(0.22, 1, 0.36, 1)` (`EASE_LURDS`).

| Duração | Valor | Uso |
|---|---|---|
| `fast` | 180ms | micro-interação (cor, opacidade de ícone) |
| `base` | 320ms | UI (dropdown, chip, acordeão) |
| `slow` | 560ms | entrada de bloco, hover de card |
| `editorial` | 900ms | imagem (zoom, crossfade) |

## Variants prontos

`fade`, `fadeUp`, `fadeDown`, `slideLeft`, `slideRight`, `scaleIn`,
`zoomOutImage`, `maskUp`, `overlayFade`, `drawerRight`, `drawerLeft`,
`dropdownIn`, `pageTransition`.

## Helpers

```tsx
// revela um bloco quando entra na viewport (once: true)
<motion.div {...reveal()}>…</motion.div>

// container que escalona os filhos
<motion.div {...revealStagger()}>
  <motion.div variants={fadeUp}>…</motion.div>
</motion.div>

// entrada imediata (hero, acima da dobra — não espera scroll)
<motion.h1 {...enter(fadeUp, 0.32)}>…</motion.h1>
```

`once: true` é deliberado: re-animar ao rolar de volta dá sensação de
instabilidade.

## Valores fixos da marca

| Efeito | Valor |
|---|---|
| Zoom de foto no hover | `scale(1.04)` — sempre 1.04, nunca 1.05/1.1 |
| Lift de card no hover | `-6px` (`hover:-translate-y-1.5`) |
| Parallax de hero | 12% de deslocamento, no máximo |
| Zoom-out de entrada do hero | 1.08 → 1.00 em 2,2s |
| Sublinhado de link | 0 → 100% em 320ms |

## Overlays: por que não usamos `AnimatePresence`

Overlays (Drawer, Modal, SearchOverlay) ficam **sempre montados** depois da
primeira abertura e animam por estado.

O unmount pós-`exit` do `AnimatePresence` depende de `requestAnimationFrame`.
Em aba sem composição de frames (background, headless, painel de preview
fechado) o rAF não dispara, o `exit` nunca completa e o elemento fica órfão no
DOM — capturando cliques e foco invisivelmente.

Padrão adotado:

```tsx
<motion.aside
  animate={{ x: open ? '0%' : '100%' }}
  style={{ pointerEvents: open ? 'auto' : 'none' }}
  aria-hidden={!open}
  ref={node => { if (node) node.inert = !open; }}
/>
```

`inert` tira o painel fechado da ordem de tab e da árvore de acessibilidade —
que é o efeito que realmente importa. Bônus: testável por estado, sem depender
de animação ter rodado.

⚠️ Ao animar `x`/`y` entre string e número, use **sempre** o mesmo tipo:
`'0%'` → `'100%'`. Misturar `0` (número) com `'100%'` (string) não interpola.

## Acessibilidade

`prefers-reduced-motion: reduce` zera transições e animações via
`globals.css`. Nenhum componente precisa tratar isso individualmente.
