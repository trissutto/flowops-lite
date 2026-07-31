# Fluxo do checkout — carrinho → pedido → pagamento → confirmação

Diagrama textual do caminho feliz (PIX) e das variações. Contratos em
`src/types/checkout.ts`; UI em `app/(checkout)/` + `components/checkout/`.

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
  │     cartão: valida Luhn/validade/CVV NO CLIENT e descarta os dados
  └─ § 4 Revisão ── FINALIZAR
        │
        ▼
POST /api/checkout  (CreateOrderInput: items + cupom + frete + tracking{
  anonymous_id, session_id, fbp/fbc, attribution })
        │
        ├─ ok=false ──► mensagem elegante na revisão (cartão: "estamos
        │               finalizando este meio de pagamento")
        │
        └─ ok=true ───► clearCart()  (o pedido agora vive no server)
              │
              ├─ method=pix ────► PixPanel na própria página:
              │     │              QR (dataURL) + copia-e-cola + countdown
              │     │
              │     │   POLL: GET /api/checkout/:id/status a cada 5s
              │     │         (guard de overlap; erro de rede = tenta na próxima)
              │     │
              │     │   [fora da página] cliente paga no app do banco
              │     │         gateway ──► WEBHOOK do server ──► status=paid
              │     │                                └─► purchase (SERVER-SIDE,
              │     │                                    dedupe por transaction_id)
              │     │
              │     ├─ status=paid ────► router.push /checkout/confirmacao/:id
              │     └─ expirado/cancelado ► estado "código expirou" (nada cobrado)
              │
              └─ method=boleto|card ► router.push /checkout/confirmacao/:id
        │
        ▼
/checkout/confirmacao/:id  (thank you)
  GET /api/checkout/:id ──► { ok, order }
  NENHUM evento de compra no client (guarda de recarga — docs/purchase.md)
```

## Decisões que o diagrama esconde

- **A sacola limpa na criação do pedido**, não no pagamento: o pedido já
  existe no server; manter a sacola viva criaria pedido duplicado no F5.
  Se o PIX expirar, nada foi cobrado e a cliente remonta a sacola.
- **O poll pergunta, o webhook afirma.** O client nunca marca pedido como
  pago — só lê o status que o webhook gravou. É a mesma lição do incidente da
  live de 01/07: confirmação de pagamento é responsabilidade do servidor.
- **5s de intervalo** com guard de overlap (rede lenta não empilha request) e
  parada definitiva em `paid`/`expired`/`cancelled`.
- **Frete do client é estimativa declarada** (`lib/commerce/frete.ts`); o
  server recota pelo `shippingQuoteId` + `cep` e o total dele prevalece.
