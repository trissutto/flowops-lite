# Purchase — a regra da compra

O evento mais importante e o mais fácil de errar. Errar aqui não é bug de relatório: é decisão de investimento em mídia tomada em cima de número falso.

## A regra

`purchase` dispara **só** quando:

- PIX confirmado, **ou**
- cartão aprovado, **ou**
- boleto compensado.

**Nunca** na criação do pedido. **Nunca** no início do checkout. **Nunca** ao abrir a página de obrigado.

## Como isso é garantido

Não por disciplina de quem integra — por construção, em três camadas:

1. **`purchase` não existe no cliente.** Está em `SERVER_ONLY_EVENTS`. Chamar `track('purchase')` no navegador é descartado com aviso no console, e o tipo do TypeScript já reclama antes.
2. **`/api/events` recusa.** Mesmo que alguém forje a requisição, a rota filtra eventos server-only e registra a tentativa no log.
3. **`trackPurchase()` confere o pagamento.** Recusa qualquer entrada cujo `payment.status` não seja `'paid'`. A checagem é no ponto de emissão, não em quem chama.

Há teste automatizado para as camadas 1 e 3 (`tracking.test.ts`).

## Onde chamar

No **webhook do gateway**, não na página de confirmação. A página a cliente pode recarregar dez vezes, abrir num link salvo ou nem chegar (fecha o app depois de pagar no banco). O webhook é o único ponto que corresponde ao dinheiro ter entrado.

```ts
import { trackPurchase } from '@/lib/tracking/server/track-server';

await trackPurchase({
  transaction_id: pedido.id,
  value: pedido.total,
  items: pedido.itens.map(toTrackedItem),
  cupom: pedido.cupom,
  context: {
    anonymous_id: pedido.tracking.anonymous_id,   // guardado no checkout
    session_id:   pedido.tracking.session_id,
    attribution:  pedido.tracking.attribution,
    loja:         pedido.lojaAtribuida,
  },
  user: { email: cliente.email, phone: cliente.telefone, external_id: cliente.id },
  meta: { fbp: pedido.tracking.fbp, fbc: pedido.tracking.fbc },
  payment: { status: 'paid', method: 'pix', confirmed_at: pagamento.confirmadoEm },
});
```

## O que guardar no checkout

Sem isto, a venda é atribuída a "direto" e a campanha que pagou por ela não recebe crédito nenhum. Persista junto do pedido:

| Campo | Por quê |
|---|---|
| `anonymous_id` | costura a sessão com os eventos anteriores |
| `session_id` | mantém a sessão íntegra no GA4 |
| `attribution` | a campanha que trouxe a cliente |
| `fbp`, `fbc` | o que mais aumenta o casamento na CAPI |

## Idempotência

`event_id = purchase-${transaction_id}`. Derivado, não aleatório. Webhook repetido → mesmo id → a Meta conta uma venda só.

Além disso, um guard em memória por `orderId` em `/api/webhooks/payment` barra a rajada de retry. Ver a ressalva em [limitacoes.md](./limitacoes.md).

**Sprint 011 — quem chama:** o `purchase` é emitido no `POST /api/webhooks/payment`, e quem bate nessa porta é o **backend FlowOps** (não a Pagar.me), depois de confirmar o pagamento no Postgres. O corpo traz os dados da compra prontos, porque o ecommerce não guarda mais o pedido. A montagem do evento mora num lugar só: `emitirPurchaseConfirmado()` em `src/lib/orders/confirm.ts`.

## Estorno

`trackRefund()` existe e funciona, mas ainda não está ligado no ERP. Troca e devolução já são um fluxo maduro no FlowOps (portal de trocas); a ligação entra quando o checkout existir.

Estorno parcial muda o valor, não o pedido — por isso o `event_id` do parcial inclui o valor, senão o segundo estorno do mesmo pedido seria deduplicado contra o primeiro.

## Add to cart, pela mesma lógica

Dispara **depois** que a peça entrou no carrinho de verdade. Se a API recusar — sem estoque, tamanho esgotado — não dispara. Medir intenção como se fosse ação estraga a análise de funil inteira.

```tsx
const ok = await carrinho.add(produto, tamanho);
if (!ok) return;
trackAddToCart(produto, { tamanho });
```

Idem `remove_from_cart`: só após a remoção acontecer.
