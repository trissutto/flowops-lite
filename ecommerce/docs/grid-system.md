# Sistema de grade

## Container

Largura via `Container` (nunca padding lateral na mão):

| width | Máx | Uso |
|---|---|---|
| `narrow` | 640px | formulário, newsletter |
| `text` | 896px | manifesto, guia, texto longo |
| `page` | 1152px | padrão de conteúdo |
| `wide` | 1344px | grades editoriais, header, footer |
| `full` | — | seções que sangram na borda |

Gutter: `1.5rem` no mobile, `2.5rem` a partir de `lg`.

## Ritmo vertical

Via `Section` (`space`): `sm` 4.5rem · `md` 7rem (padrão) · `lg` 10rem.
Páginas **não** escrevem `py-*`.

Alternância de `tone` (`default` → `alt` → `champagne` → `dark`) cria a
separação entre seções sem precisar de borda.

## Grades de produto

| Contexto | Colunas | Gap |
|---|---|---|
| Grid editorial | 2 → 3 (lg) → 4 (xl) | `gap-x-4 gap-y-10` / `lg:gap-x-6 gap-y-14` |
| Grid compacto (`view="grid"`) | 2 → 4 (lg) → 5 (xl) | idem |
| Carrossel de produto | 1.35 → 2 (sm) → 3 (lg) → 4 (xl) | `gap-4 lg:gap-6` |

**Duas colunas no mobile** é deliberado: uma coluna faz a cliente rolar
demais e perde a comparação lado a lado, que é como se escolhe roupa.

O `perView` fracionário (1.35) no carrossel deixa o próximo item cortado —
afordância de que há mais conteúdo, sem precisar de seta no mobile.

## Grades de eixo

| Seção | Colunas |
|---|---|
| Ocasiões | 2 → 4 (lg) |
| Tecidos | 2 → 3 (lg) → 6 (xl) |
| Modelagem | 1 → 2 (sm) → 3 (lg) |
| Instagram | 2 → 3 (sm) → 6 (lg) |
| Lojas | 1 → 3 (lg) |

## Proporções de imagem

| Proporção | Onde |
|---|---|
| `3/4` | ProductCard (padrão editorial), LookCard, OccasionCard |
| `4/5` | CategoryCard, FabricCard |
| `1/1` | Instagram |
| `4/3` | MenuCard, EditorialCard |
| `16/9` | EditorialCard grande, VideoBlock |
| `21/9` | vídeo institucional, faixa de fechamento |

## Interrupções editoriais

`EditorialProductGrid` insere blocos de **2 colunas** em posições definidas.
Regra: escolher posições múltiplas do número de colunas do maior breakpoint
(6, 14, 22 com 4 colunas) pra a interrupção cair depois de uma fileira
completa — no meio da fileira, o layout "engasga".

## Layouts do ImageGrid

- `feature` — uma foto grande (metade) + duas menores empilhadas. Abertura de
  seção editorial.
- `mosaic` — três colunas com alturas alternadas; um item ocupa duas linhas.
- `even` — quatro colunas iguais. Uso raro (só quando as fotos são
  equivalentes em importância).

Itens de tamanhos diferentes é o que tira a cara de "galeria de estoque".

## Breakpoints

`xs` 420 · `sm` 640 · `md` 768 · `lg` 1024 · `xl` 1280 · `2xl` 1536.

Mobile-first: a classe sem prefixo é o mobile; prefixo adiciona a partir
daquele ponto.
