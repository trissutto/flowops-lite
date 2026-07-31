# Pagamentos — arquitetura do provider

Como o pedido cobra sem saber quem cobra — e o que falta pra ligar o gateway
de verdade.

## A fronteira

```
POST /api/checkout ──► getPaymentProvider() ──► createPixCharge(order)
                                                  │
GET  .../status    ──► checkStatus?(order) ───────┤   (mock: auto-confirm)
POST /api/webhooks/payment ───────────────────────┴──► confirmPayment(orderId)
```

O checkout conhece **uma interface** (`src/lib/payments/provider.ts`):

```ts
interface PaymentProvider {
  id: string;
  createPixCharge(order: Order): Promise<{ copyPaste; txid; expiresAt }>;
  checkStatus?(order: Order): Promise<OrderStatus>; // opcional
}
```

Trocar de gateway é implementar isso e mudar **uma env**. Nenhuma rota, tela
ou store muda.

A confirmação de pagamento tem **um caminho só**: `confirmPayment()`
(`src/lib/orders/confirm.ts`). Webhook, auto-confirm do mock e qualquer
conciliação futura passam por ele — é onde mora a idempotência e o único
lugar do sistema que emite o evento `purchase` (ver `docs/purchase.md`).

## Envs

| Env | Default | Efeito |
|---|---|---|
| `PAYMENT_PROVIDER` | `mock` | `mock` \| `pagbank` (esqueleto — lança erro) |
| `PIX_KEY` | chave de sandbox | Chave PIX do payload EMV. Sem a real, o QR abre no banco mas não acha destinatário |
| `PIX_MERCHANT_NAME` | `LURDS PLUS SIZE` | Nome exibido no app do banco (máx 25 chars) |
| `PIX_MERCHANT_CITY` | `ITANHAEM` | Cidade do recebedor (máx 15 chars) |
| `PAYMENT_WEBHOOK_SECRET` | — | **Sem ela o webhook responde 404** (a rota não existe) |
| `MOCK_PIX_CONFIRM_SECONDS` | `25` | Idade a partir da qual o mock confirma o pedido |
| `MOCK_PIX_AUTOCONFIRM` | off | `1` liga a auto-confirmação do mock **em produção** (em dev é sempre ligada) |
| `CUPONS_JSON` | tabela padrão | Substitui a tabela de cupons no server (ver `cupom.ts`) |

## Mock (o default)

Gera o payload EMV **real** com a chave de sandbox e auto-confirma pedidos
`awaiting_payment` com mais de 25s — pelo mesmo `confirmPayment` do webhook,
então o fluxo demonstrado é o fluxo de produção, incluindo o `purchase`.
Detalhes em `docs/pix.md`.

## ⚠️ PagBank — LEIA ANTES DE LIGAR

O esqueleto `PagBankProvider` lança erro de propósito. Motivo, documentado na
memória do projeto ("PagBank: token único por conta"):

> A conta PagBank da casa tem **token único de API, compartilhado com outro
> sistema** (Reservas Ita divide a mesma conta). Gerar um token novo pra este
> ecommerce **revoga o anterior e quebra o outro sistema em silêncio**.

Ligar exige, nesta ordem:

1. Decisão do dono: qual conta/token este ecommerce usa (conta separada? o
   token atual compartilhado com cuidado?).
2. Inventário de quem usa o token vigente (FlowOps live-pdv usa PagBank PIX).
3. Implementar `createPixCharge` com a API de cobranças PIX do PagBank e
   apontar o webhook deles pra `/api/webhooks/payment` (adaptando a validação
   de assinatura pro esquema deles — hoje é segredo compartilhado simples).
4. `PAYMENT_PROVIDER=pagbank` + envs do token.

Enquanto isso não acontece, qualquer tentativa de usar o provider falha com
erro claro — melhor que fingir que funciona.

## Pedidos: storage honesto

`src/lib/orders/store.ts` guarda pedidos **em memória por instância
serverless** (mesmo padrão declarado do log de tracking). Serve pra
desenvolver e demonstrar; **não** é storage de produção pra dinheiro. A
interface `OrderStore` existe pra trocar por Postgres implementando 5 métodos
— e cada transição de status já sai como `console.log` estruturado
(tag `order_event`, sem PII) pra trilha durável no stdout da Vercel.

O número do pedido (`LP-000123-K4`) também é sequencial em memória com sufixo
aleatório de desempate — vira sequence do Postgres na mesma migração.
