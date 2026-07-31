# Carrinho — store, página e regras compartilhadas

> Sprint 009. Peças: `src/store/cart.ts` (estado), `src/components/commerce/CartLineRow.tsx`
> (linha compartilhada), `src/app/(public)/carrinho/page.tsx` (página completa) e
> `src/components/commerce/MiniCart.tsx` (drawer — ver `docs/mini-cart.md`).

## O store estendido (`src/store/cart.ts`)

A API original (`lines`, `add`, `remove`, `setQuantity`, `clear`, `useCartCount`,
`useCartSubtotal`) **não mudou** — nenhuma tela existente foi reescrita. A sprint
acrescentou por cima:

| Campo | O que guarda | O que NUNCA guarda |
|---|---|---|
| `couponCode` | o código aplicado (`setCoupon`) | o valor do desconto |
| `cep` | o CEP da última cotação (`setCep`) | preço/prazo de frete |
| `shippingQuoteId` | o id da `ShippingQuote` escolhida (`setShippingQuote`) | o preço da cotação |
| `savedForLater` | peças guardadas pra depois (`saveForLater`/`moveToCart`/`removeSaved`) | — |

### Princípio: persistir a ESCOLHA, recalcular o VALOR

Desconto e frete são derivados a cada render:

- cupom → `applyCoupon(couponCode, subtotal)` de `lib/commerce/cupom`;
- frete → `findQuote(cep, subtotal, shippingQuoteId)` / `quoteShipping` de `lib/commerce/frete`.

Persistir o preço em localStorage seria cobrar o frete de ontem com a regra de
hoje. Efeito colateral desejado: se o subtotal cair abaixo do mínimo do cupom, o
desconto **some sozinho** (a UI mostra a mensagem do `applyCoupon` explicando).

### `savedForLater` fica fora de `lines` de propósito

Não entra no subtotal, não vai pro checkout e **sobrevive ao `clear()`** — que
agora zera o *pedido* (linhas, cupom, cotação) mas preserva o que é da *cliente*
(CEP e guardados). Mover de/para a sacola funde quantidade quando a mesma linha
(produto+tamanho+cor) já existe do outro lado.

### Migração de estado antigo

Tudo persiste no mesmo `lurds-cart`. Carrinho gravado antes da sprint (só
`{ lines }`) migra sozinho: o merge do `persist` preenche as chaves novas com os
defaults.

## Regras compartilhadas com o checkout

O carrinho **não tem regra própria** — só orquestra:

- **Cupom**: `applyCoupon` valida, calcula e devolve a mensagem pronta pra UI.
  Cupom `kind: 'shipping'` zera o ENVIO, não o subtotal. A validação que VALE é
  a do server no `POST /api/checkout` (mesma função rodando lá) — client-side é
  cortesia de UX.
- **Frete**: `quoteShipping(cep, subtotal)` devolve PAC + SEDEX + retiradas
  elegíveis; PAC zera acima de `FREE_SHIPPING_FROM`. Preço `0` exibe **"Grátis"**,
  nunca "R$ 0,00" (contrato de `ShippingQuote`).
- **Barra de frete grátis**: `freeShippingGap(subtotal)` → `{ reached, missing, progress }`.
- **Pix e parcelamento**: total −5% no Pix e 12x sem juros — as mesmas
  convenções do `precoPix`/`parcelamento` do catálogo. Números exibidos aqui são
  estimativa; o total que vale é recalculado no server.

## A linha compartilhada (`CartLineRow`)

Mini-cart e página renderizam a MESMA linha — stepper, remover e tracking se
comportam igual porque são o mesmo código. A linha fala direto com o cart store
(os dois consumidores usam o mesmo) e dispara os eventos **depois** da mutação:

- remover (ou "−" no 1) → `remove_from_cart`;
- "Salvar para depois" → sai do funil → `remove_from_cart` (guardar não é wishlist);
- "Mover para favoritos" → `add_to_wishlist` **+** `remove_from_cart` (a peça sai do subtotal);
- linha `saved` remove sem evento — nunca esteve no funil.

Props: `line` (obrigatória), `saved` (lista de guardados — troca o stepper por
"Mover para a sacola"), `full` (layout da página: foto maior + ações
secundárias), `notice` (aviso de estoque vindo da revalidação).

## A página `/carrinho`

Client page. Desktop em duas colunas (linhas | resumo sticky `top-28`), mobile
empilhado. Antes da hidratação renderiza skeleton com a mesma silhueta (o
carrinho vive no localStorage — server e client precisam concordar no primeiro
paint).

- `view_cart` no mount (uma vez, se há itens).
- **CEP com máscara** `00000-000`; ao fechar 8 dígitos, cota na hora e persiste
  o CEP. CEP incompleto invalida a opção escolhida (sem cotação fantasma).
- **Rádio de entrega** inclui retirada na loja quando o CEP cai na área
  (`pickupStoresFor`), com "pronta em ~3h".
- **Verde `--color-success` SÓ no total** — convenção de dinheiro da marca.
- **Revalidação de estoque** ao montar: best-effort via
  `/api/loja/produtos?busca=<sku>` (não existe consulta por REF exata ainda).
  Miss na busca NÃO marca esgotado — só avisamos quando a resposta AFIRMA
  indisponibilidade. Falha de rede é silenciosa: o aviso é cortesia, quem trava
  a venda é o checkout.
- **Cross-sell "Complete seu look"**: fetch direto de
  `/api/loja/relacionados?slug=<primeira linha>&limite=4` (por URL, sem importar
  módulos de recommendations — construídos em paralelo; o contrato é o BFF).
  Falhou ou veio vazio → a seção não renderiza.
