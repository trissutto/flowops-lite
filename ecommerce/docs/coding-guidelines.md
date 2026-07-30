# Padrões de código

## TypeScript

- `strict` ligado. **Nada de `any`** — na dúvida, `unknown` + narrowing.
- Props numa `interface` declarada no topo do arquivo do componente.
- Tipos de domínio moram em `types/index.ts` e são a única fonte de verdade.
  Componente não redefine shape que já existe.
- Uniões discriminadas em vez de flags booleanas soltas
  (`ButtonProps | AnchorProps`, não `isLink`).

## Componentes

- Um componente por arquivo, PascalCase, export **nomeado** (não default,
  exceto páginas/layouts que o Next exige).
- Ordem interna: imports → tipos → constantes → componente → subcomponentes.
- `'use client'` só quando necessário. Se o componente não tem estado, efeito
  nem handler, é Server Component.
- Todo componente que aceita `className` usa `cn()` no `class` final — senão a
  prop do consumidor não sobrescreve (conflito de Tailwind).
- Responsabilidade única. `Header` não sabe filtrar produto; `ProductCard` não
  sabe buscar dados.

## Estilo

- **Nunca** cor, tamanho, raio ou duração hardcoded. Use token
  (`bg-surface-alt`, `py-section`, `duration-[320ms]` com o easing da marca).
- Composição de seção vem do `SectionTitle` — não recriar eyebrow + fio + título.
- Classes longas: agrupar por eixo (layout → espaçamento → cor → estado).

## Nomes

| Coisa | Padrão | Exemplo |
|---|---|---|
| Componente | PascalCase | `ProductCard.tsx` |
| Hook | `use` + camelCase | `useProductFilters.ts` |
| Service | substantivo plural | `services/products.ts` |
| Dados | substantivo | `data/navigation.ts` |
| Tipo | PascalCase, sem prefixo `I` | `Product`, `FilterGroup` |
| Booleano | `is`/`has`/`can` | `isFavorite`, `hasMore` |
| Handler (prop) | `on` + evento | `onQuickView` |

## Imports

Sempre `@/` (nunca `../../..`). Ordem: React → Next → libs externas →
`@/` internos → tipos.

## Comentários

Comentário explica **por que**, nunca **o que**. O código já diz o que faz.

```ts
// ✅ explica uma decisão que o código não revela
// 120ms de atraso na saída: sem isso o menu fecha quando o mouse
// atravessa o vão entre o item e o painel.

// ❌ narra o óbvio
// seta o índice aberto
setOpenIndex(index);
```

Cabeçalho de arquivo em componente não-trivial: o que é, decisão de design
relevante e o que NÃO fazer com ele.

## Formulários

React Hook Form + Zod. Um schema por formulário, tipo derivado com
`z.infer`. Erro sempre visível e ligado ao campo por `aria-describedby`.

## Estado

- Local primeiro (`useState`).
- Compartilhado entre componentes irmãos → hook dedicado (`useProductFilters`).
- Global de verdade (carrinho, favoritos, overlay) → Zustand.
- Dado remoto → TanStack Query. Nunca `useEffect` + `fetch` na mão.

## Antes de abrir PR

```bash
npx tsc --noEmit      # zero erro
npm run build         # zero warning
```

Mais o checklist da seção 16 do [LURDS_MASTERPLAN.md](../LURDS_MASTERPLAN.md).
