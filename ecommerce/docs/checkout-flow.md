# Fluxo do checkout — carrinho → pedido → pagamento → confirmação

Diagrama textual do caminho feliz (PIX) e das variações. Contratos do navegador
em `src/types/checkout.ts`; contrato com o backend em `src/lib/orders/store.ts`;
UI em `app/(checkout)/` + `components/checkout/`.

**Desde a sprint 011 o pedido nasce no backend FlowOps (Postgres).** O
ecommerce é UI + primeira barreira de validação + disparo do `purchase`. Quem
cobra e quem confirma pagamento é o backend — ver `docs/payments.md`.

```
SACOLA (zustand persist, localStorage)
  │  /checkout
  ▼
CHECKOUT ONE-PAGE (client, estado local)
  │
  ├─ mount ──────────────► begin_checkout (com os itens)
  │
  ├─ § 1 Identificação ──► CustomerIdentity (cpf/phone só dígitos)
  ├─ § 2 Entrega
  │     CEP completo ────► GET viacep.com.br/ws/{cep}/json/  (erro = silêncio)
  │     quoteShipping() ─► rádios (PAC/SEDEX/retirada)       (client, estimativa)
  │     confirmar ───────► add_shipping_info
  ├─ § 3 Pagamento ──────► add_payment_info (na escolha da aba)
  │     cartão: valida Luhn/validade/CVV e TOKENIZA no navegador
  │             POST api.pagar.me/core/v5/tokens?appId=<pk_>
  │             → só o card_token segue adiante (PAN nunca vai a servidor)
  └─ § 4 Revisão ── FINALIZAR
        │
        ▼
POST /api/checkout   ← BFF: zod + rate-limit (10/min por IP)
        │              recálculo de cupom/frete/total (1ª barreira)
        │
        └─► POST {FLOWOPS_API_URL}/public/loja/pedido   (x-loja-token)
              │   backend: cria Order no Postgres, cobra na Pagar.me,
              │            reconfere o total (o dele vence)
              │
              ├─ ok=false ──► mensagem elegante do BACKEND na revisão
              │
              └─ 201 { id, number, status, total, payment{ pix? } }
                    │
                    │  QR: usa `pix.qrCode` do backend; se vier só o
                    │      copia-e-cola, o BFF gera o dataURL aqui
                    ▼
              200 { ok:true, order }  (costura: dados do backend + itens,
                                       cliente e frete que o BFF já tinha)
        │
        └─► clearCart()  (o pedido agora vive no Postgres do Flow)
              │
              ├─ method=pix ────► PixPanel na própria página:
              │     │              QR + copia-e-cola + countdown
              │     │
              │     │   POLL: GET /api/checkout/:id/status a cada 5s
              │     │         └─► GET /public/loja/pedido/:id/status
              │     │         (guard de overlap; erro de rede = tenta na próxima)
              │     │
              │     │   [fora da página] cliente paga no app do banco
              │     │         Pagar.me ──► webhook do BACKEND ──► paid no Postgres
              │     │                        └─► POST /api/webhooks/payment
              │     │                            (x-webhook-secret) ──► purchase
              │     │
              │     ├─ status=paid ────► router.push /checkout/confirmacao/:id
              │     └─ expirado/cancelado ► estado "código expirou" (nada cobrado)
              │
              └─ method=card ──► aprovado na hora ► /checkout/confirmacao/:id
        │
        ▼
/checkout/confirmacao/:id  (thank you — `id` é o UUID do Order no Flow)
  GET /api/checkout/:id ──► GET /public/loja/pedido/:id ──► { ok, order }
  CPF mascarado no BFF (defesa em profundidade, mesmo com o backend sanitizando)
  NENHUM evento de compra no client (guarda de recarga — docs/purchase.md)
```

## Decisões que o diagrama esconde

- **A sacola limpa na criação do pedido**, não no pagamento: o pedido já
  existe no Postgres; manter a sacola viva criaria pedido duplicado no F5.
  Se o PIX expirar, nada foi cobrado e a cliente remonta a sacola.
- **O poll pergunta, o backend afirma.** O client nunca marca pedido como
  pago — nem o BFF. É a mesma lição do incidente da live de 01/07:
  confirmação de pagamento é responsabilidade do servidor que tem o dinheiro
  na frente.
- **Recálculo duplo é de propósito.** O BFF refaz cupom e frete com as mesmas
  funções da vitrine (garante que a conta mostrada é a conta pedida) e o
  backend reconfere contra o catálogo. Divergência não derruba a venda — o
  total do backend vence e sai um `console.warn` pra alguém olhar a tabela
  fora de sincronia.
- **5s de intervalo** no poll, com guard de overlap (rede lenta não empilha
  request) e parada definitiva em `paid`/`expired`/`cancelled`. Erro de rede
  ou 502 no poll é tratado como silêncio: a tela tenta de novo no ciclo
  seguinte, nunca desiste de um PIX que a cliente vai pagar.
- **Frete do client é estimativa declarada** (`lib/commerce/frete.ts`); o
  BFF recota pelo `shippingQuoteId` + `cep` antes de mandar pro backend.
- **Boleto ainda não existe** no contrato do backend: o BFF recusa com
  `ok:false` e a mensagem elegante de "estamos finalizando este meio".
- **Backend fora do ar ≠ pedido inexistente.** `GET /api/checkout/:id` devolve
  502 (não 404) quando a chamada falha — mandar a cliente pro "não encontramos
  esse pedido" logo depois de ela pagar seria cruel e mentiroso.
