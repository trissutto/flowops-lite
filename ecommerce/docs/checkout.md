# Checkout one-page

Sprint 010 · rota `/checkout` · grupo `(checkout)` com chrome próprio.

## Por que one-page

Cada troca de rota no checkout é um ponto de fuga: botão voltar, refresh que
perde estado, latência entre etapas. No one-page o estado inteiro mora num
componente só (`app/(checkout)/checkout/page.tsx`) e as etapas são um
**accordion controlado** — a página é a dona da sequência, os componentes de
seção só recebem `defaults` e devolvem `onDone`. Concluiu a seção, ela colapsa
num resumo de 1 linha com "editar"; a próxima abre sozinha.

O chrome do grupo `(checkout)` é mínimo de propósito (logo + "Compra segura" +
rodapé legal): cada link a mais é uma porta de saída no momento mais caro do
funil. Sem menu, sem busca, sem banner.

## As 4 seções

| # | Seção | Componente | Confirma quando |
|---|-------|-----------|-----------------|
| 1 | Identificação | `IdentificationStep` | nome + e-mail + CPF + celular válidos |
| 2 | Entrega | `ShippingStep` | CEP válido + opção de frete escolhida (+ endereço, se não for retirada) |
| 3 | Pagamento | `PaymentStep` (+ `CardForm`) | método escolhido (cartão: dados válidos + parcelas) |
| 4 | Revisão | `ReviewCard` | botão **Finalizar** (o único verde da página — verde = dinheiro) |

Coluna direita (desktop): `OrderSummary` sticky com itens, cupom e totais.
Mobile: o mesmo componente vira uma barra colapsável no topo (só o total
sempre visível — o formulário é o trabalho a fazer).

## Validações (client = cortesia, server = verdade)

- **CPF**: máscara progressiva + dígito verificador REAL (algoritmo da
  Receita, `masks.ts`). Sequências repetidas são barradas.
- **Celular**: máscara `(DD) 90000-0000`, aceita fixo (10) e celular (11).
- **CEP**: máscara `00000-000`; com 8 dígitos dispara ViaCEP
  (`https://viacep.com.br/ws/{cep}/json/`) preenchendo rua/bairro/cidade/UF e
  focando o **número**. Erro do ViaCEP é silencioso: os campos continuam
  editáveis na mão.
- **Cartão**: Luhn + comprimento por bandeira; detecção de bandeira por
  prefixo (Elo testada ANTES da Visa — vários BINs Elo começam com 4);
  validade MM/AA ≥ mês atual; CVV 3–4 dígitos. **Nenhum dado de cartão sai do
  navegador no MVP** — `CreateOrderInput` nem tem o campo; quando o gateway
  entrar, o form tokeniza via SDK e só o token viaja.
- **Cupom**: `applyCoupon` de `lib/commerce/cupom.ts` (mesma função que roda
  no server). A UI exibe o `message`, nunca calcula desconto por conta.

Formulários com `react-hook-form` + `zod` (`zodResolver`), `mode: 'onTouched'`.
Todo erro do server vira mensagem elegante (mapa na página) — status HTTP e
stack nunca chegam na cliente.

## Totais

O client soma subtotal − desconto + frete **só pra exibição**. O total que
vale é recalculado pelo server no `POST /api/checkout` (cupom, `pixPrice`,
frete). O desconto de 5% do PIX aparece como badge informativa na aba; o valor
real vem no `order.total` — e é ele que o `PixPanel` mostra.

## Tracking do funil

| Evento | Quando |
|--------|--------|
| `begin_checkout` | mount da página, uma vez, com os itens do carrinho |
| `add_shipping_info` | ao CONFIRMAR a entrega (não a cada clique no rádio) |
| `add_payment_info` | ao escolher a aba de pagamento (1× por método) |
| `coupon_applied` / `coupon_removed` | no resumo |
| `purchase` | **NUNCA no client** — servidor via webhook (docs/purchase.md) |

O `CreateOrderInput.tracking` leva `anonymous_id`, `session_id`, `fbp`/`fbc`
(`getMetaBrowserIds`) e `attribution` (`captureAttribution`) — é o que costura
a compra confirmada de volta ao funil e à CAPI.

## Estados e acessibilidade

- Skeleton de página inteira antes do mount (carrinho vem do localStorage —
  evita flash de "sacola vazia" e mismatch de hidratação).
- Sacola vazia → `EmptyState` com saída pra loja.
- Seções sempre no mesmo lugar do DOM; miniaturas e QR com dimensão fixa;
  `autocomplete` correto em todos os campos (`name`, `email`, `postal-code`,
  `cc-number`…) — zero layout shift, autofill do navegador funciona.
- Abas de pagamento com `role=tablist` + setas; rádios de frete com input
  nativo `sr-only` (foco de teclado preservado).
