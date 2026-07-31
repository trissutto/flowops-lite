# Pagamentos — quem cria, quem cobra, quem confirma

Desde a **sprint 011** o ecommerce **não é dono do pedido nem da cobrança**.
Quem cria, cobra e confirma é o **backend FlowOps** (NestJS + Postgres). O
ecommerce faz a UI do checkout, tokeniza o cartão no navegador e dispara o
evento de compra.

## Quem faz o quê

| Papel | Onde mora |
|---|---|
| Pedido (nasce, vive, muda de status) | Backend FlowOps — Postgres |
| Cobrança na Pagar.me (PIX e cartão) | Backend FlowOps (`PagarmeService`) |
| Webhook do gateway | Backend FlowOps |
| Confirmação do pagamento | Backend FlowOps |
| Recálculo de cupom/frete/total (1ª barreira) | Ecommerce — `POST /api/checkout` |
| Tokenização do cartão | **Navegador** (chave pública Pagar.me) |
| Evento `purchase` (GA4 + Meta CAPI) | Ecommerce — `POST /api/webhooks/payment` |

**Por que o backend e não aqui:** o pedido precisa estar no Postgres pro resto
da casa funcionar — CRM, roteamento pra loja, separação, NF-e. Pedido que só o
ecommerce enxerga é pedido que ninguém despacha. E o backend já tem a conta
Pagar.me configurada: dois sistemas cobrando na mesma conta seria pedir
confusão (a casa já tem essa cicatriz com o token único do PagBank).

## O caminho, ponta a ponta

```
NAVEGADOR                    ECOMMERCE (BFF)                BACKEND FLOWOPS
─────────                    ───────────────                ───────────────
cartão ─┐
        └─► api.pagar.me/tokens  (número NUNCA passa por servidor nenhum)
             └─► card_token ─┐
                             ▼
  FINALIZAR ───────► POST /api/checkout
                       zod + rate-limit
                       recálculo cupom/frete/total
                       └────────────────────► POST /public/loja/pedido
                                               x-loja-token
                                               │ cria Order no Postgres
                                               │ cobra na Pagar.me
                                               ◄─ 201 { id, number, status,
                                                        total, payment{pix?} }
                       QR: usa o do backend ou gera do copia-e-cola
                     ◄─ 201 { ok, order }
  PixPanel
   poll 5s ────────► GET /api/checkout/:id/status
                       └────────────────────► GET /public/loja/pedido/:id/status

                                    [fora da tela] cliente paga no banco
                                               │
                                    Pagar.me ──► webhook do BACKEND
                                               │ marca paid no Postgres
                                               ▼
                     POST /api/webhooks/payment ◄─── backend chama o ecommerce
                       x-webhook-secret                (com os dados da compra)
                       └─► trackPurchase()  → GA4 + Meta CAPI
```

## Contrato com o backend

Cliente em `src/lib/orders/store.ts` (`BackendOrderStore`). Todos os endpoints
levam o header `x-loja-token: ${LOJA_ORDER_TOKEN}`.

| Endpoint | Uso |
|---|---|
| `POST /public/loja/pedido` | cria o pedido + a cobrança. `201 {ok:true, order}` ou `200 {ok:false, error}` (mensagem já elegante, vai direto pra tela) |
| `GET /public/loja/pedido/:id` | pedido completo pra thank you page |
| `GET /public/loja/pedido/:id/status` | `{ ok, status, paidAt? }` — o que o poll do PIX pergunta |

O `201` devolve só o que o backend acabou de decidir (id, número, status, total
conferido, cobrança). Cliente, itens e endereço o BFF já tem em mãos e costura
na resposta pra tela — não faz sentido o backend repetir o que a requisição
acabou de mandar.

**Sem `FLOWOPS_API_URL` ou `LOJA_ORDER_TOKEN` o checkout fica fora do ar**, com
erro gritado no log e mensagem elegante na tela. Não existe fallback pra
memória, de propósito: era exatamente o bug que a sprint 011 matou (pedido que
sumia quando a instância serverless reciclava).

## Envs

| Env | Default | Efeito |
|---|---|---|
| `FLOWOPS_API_URL` | — | URL do backend com `/api`. **Sem ela não há checkout** |
| `LOJA_ORDER_TOKEN` | — | Segredo do header `x-loja-token`. **Sem ele não há checkout** |
| `PAYMENT_WEBHOOK_SECRET` | — | Segredo COMPARTILHADO com o backend. Sem ela o webhook responde 404 (a rota não existe) |
| `NEXT_PUBLIC_PAGARME_PUBLIC_KEY` | — | Chave `pk_` da Pagar.me pra tokenizar cartão no navegador. Sem ela o cartão é recusado com mensagem elegante; PIX segue normal |
| `CUPONS_JSON` | tabela padrão | Substitui a tabela de cupons na 1ª barreira (ver `cupom.ts`) |

Envs de PIX local (`PIX_KEY`, `PIX_MERCHANT_NAME`, `PIX_MERCHANT_CITY`) valem
só pro mock de desenvolvimento — ver abaixo.

## Cartão: o número não passa por servidor nenhum

`CardForm.tsx` faz `POST api.pagar.me/core/v5/tokens?appId=<pk_>` **do
navegador**, com a chave pública. Só o `card_token` viaja: pro BFF, e dele pro
backend, que cobra. Nem o servidor do site nem o backend jamais veem o PAN —
PCI-DSS não é opcional.

Se `NEXT_PUBLIC_PAGARME_PUBLIC_KEY` não estiver configurada, o form continua
validando (Luhn, bandeira, validade, CVV) mas não gera token; o BFF então
recusa cartão sem token com a frase elegante de "não conseguimos validar seu
cartão agora". Melhor isso que uma tela que finge cobrar.

## O webhook mudou de remetente

`POST /api/webhooks/payment` **não é mais chamado pela Pagar.me** — é chamado
pelo **backend**, depois que ele confirmou o pagamento. Consequências:

- a **validação HMAC da Pagar.me saiu**: o corpo não é mais deles, então não há
  assinatura pra conferir. A autenticação é o segredo compartilhado
  `PAYMENT_WEBHOOK_SECRET`, a mesma env dos dois lados;
- o corpo traz os **dados da compra** (itens, cliente, tracking): o ecommerce
  não tem mais o pedido em memória, e ir buscar no backend só pra montar o
  evento seria um round-trip a mais no caminho do dinheiro;
- a rota **não marca nada como pago** — não há mais o que marcar. Ela só emite
  o `purchase` (ver `docs/purchase.md`).

Idempotência em duas camadas: `event_id` derivado do `transaction_id` (a Meta
conta uma venda só, mesmo com retry entre instâncias) + um guard em memória por
`orderId` que corta a rajada de retry antes de gastar rede.

## `src/lib/payments/` — ferramenta de desenvolvimento

`provider.ts`, `mock.ts` e `pix-emv.ts` **saíram do caminho de produção** e
ficaram no repositório de propósito:

- `pix-emv.ts` gera payload EMV BR Code correto (com teste) — serve pra
  conferir um copia-e-cola de produção ou depurar valor/CRC;
- `MockProvider` gera um PIX de mentira **sem backend rodando**, o que é ouro
  pra mexer na UI do `PixPanel`.

A auto-confirmação do mock foi **removida**: ela dependia de marcar o pedido
como pago num store local que não existe mais, e um "pago" inventado pelo
ecommerce seria uma mentira que nem o backend nem o CRM conheceriam.

**Regra:** nada em `src/app/api/**` importa de `lib/payments/`. Se importar, o
pedido voltou a ter dois donos.

## O que o ecommerce deixou de fazer

| Sumiu | Onde foi parar |
|---|---|
| `InMemoryOrderStore` | Postgres do FlowOps |
| `nextOrderNumber()` (sequencial em memória) | o backend gera o número |
| `confirmPayment(orderId)` | o backend confirma; aqui sobrou o helper que monta o `purchase` |
| `provider.checkStatus()` no poll | `GET /public/loja/pedido/:id/status` |
| Validação HMAC da Pagar.me | o webhook do gateway agora chega no backend |
