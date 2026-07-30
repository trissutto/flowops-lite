# Filtros

`components/commerce/FilterPanel.tsx` + `hooks/useProductFilters.ts` +
`services/products.ts`.

## Um componente, dois containers

O **mesmo** `FilterPanel` renderiza:

- **Desktop:** sidebar de 264px, sticky abaixo da barra inteligente.
- **Mobile:** dentro de um `Drawer` com rodapé fixo ("Limpar" / "Ver N peças").

Isso garante que as duas experiências nunca divirjam. Quem decide o container
é a página, não o componente.

## Grupos

Ordem = do mais usado ao mais específico.

| Grupo | Controle | Aberto por padrão |
|---|---|---|
| Tamanho | pílulas (`SizePill`) | ✅ |
| Preço | faixa (dois sliders nativos) | ✅ |
| Cor | swatches circulares | ✅ |
| Tecido | checkbox | — |
| Ocasião | checkbox | — |
| Modelagem | checkbox | — |
| Coleção | checkbox | — |
| Destaques | switch (novidades, promoção, mais vendidos, exclusivos) | — |
| Disponibilidade | switch (na minha loja, comprar e retirar) | — |

**Cada tipo tem controle próprio de propósito.** Checkbox pra tudo empobrece
a leitura: tamanho pede pílula tabular, cor pede o círculo da cor.

Cada grupo é um `AccordionItem` e mostra um contador dourado quando tem
filtro ativo.

## Faixa de preço

Dois `<input type="range">` nativos sobrepostos. Nativo de propósito:
acessível por teclado de fábrica e zero JS de arraste. Os limites vêm de
`priceRange(category)` — a faixa real do recorte, não valores fixos.

## Estado

`useProductFilters()` devolve um `FilterState` **serializável**:

```ts
{
  tamanho: ['50', '52'],        // string[]  → múltipla escolha
  preco: [180, 420],            // [n, n]    → faixa
  promocao: true,               // boolean   → flag
}
```

API: `toggleValue`, `setRange`, `toggleFlag`, `isChecked`, `isFlagOn`,
`getRange`, `clearGroup`, `clearAll`, `removeChip`, mais `activeCount` e
`activeChips` (derivados) para a barra.

Ser serializável é o que vai permitir levar/trazer da URL na Sprint 016 sem
reescrever nada.

## Aplicação

Acontece no **service**, nunca no componente:

```
CategoryListing → useInfiniteQuery(['products', categoria, filtros, sort, busca])
                → fetchProducts({ ... })
                → predicado por grupo + sort + slice
```

Trocar por filtro no servidor = mudar o corpo de `fetchProducts`. Nenhuma tela
muda.

Filtro novo = uma entrada em `filterGroups()` (a UI) + uma em `PREDICATES`
(a regra). Nada de `if` espalhado.

## Reset de página

Mudança de filtro, ordenação ou busca volta pra página 1 (`useEffect` em
`CategoryListing`) — senão a cliente aplica um filtro e cai numa página 4 que
não existe mais.

## Acessibilidade

- Cada controle tem label associada; inputs `sr-only` mantêm o foco
- Contador de filtros ativos também aparece como texto no chip (não só cor)
- Chip removível tem botão com `aria-label="Remover filtro"`
- Sliders com `aria-label` "Preço mínimo"/"Preço máximo"
- Acordeão com `aria-expanded` + `aria-controls`
