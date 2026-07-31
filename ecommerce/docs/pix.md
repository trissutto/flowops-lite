# PIX — payload EMV, CRC16 e o fluxo de confirmação

Como o copia-e-cola nasce, por que o app do banco aceita, e como o pedido
descobre que foi pago.

## O payload EMV (BR Code)

O "PIX copia e cola" é um payload **EMVCo QRCPS-MPM**: campos TLV
(Tag + Length + Value) em texto, fechados por um CRC16. Montamos em
`src/lib/payments/pix-emv.ts`, sem dependência externa — TLV e CRC são ~30
linhas e o teste cobre o formato byte a byte.

```
00 02 01                      ← payload format indicator
26 XX                         ← merchant account info
   00 14 br.gov.bcb.pix       ←   GUI oficial do arranjo PIX
   01 XX <chave>              ←   a chave (env PIX_KEY)
52 04 0000                    ← MCC não informado
53 03 986                     ← moeda BRL
54 06 289.90                  ← valor — PONTO decimal, sempre 2 casas
58 02 BR
59 XX LURDS PLUS SIZE         ← nome (máx 25, sem acento)
60 XX ITANHAEM                ← cidade (máx 15, sem acento)
62 XX                         ← additional data
   05 XX <txid>               ←   txid (máx 25 alfanum, derivado do pedido)
63 04 ABCD                    ← CRC16 do payload inteiro (incluindo "6304")
```

Regras que derrubam QR em silêncio (por isso o teste é rígido):

- valor com **vírgula** → inválido. `toFixed(2)` sempre;
- nome/cidade com acento → normalizados (NFD + descarte de combining marks);
- txid além de 25 chars ou com símbolo → saneado;
- CRC errado → o app do banco recusa sem dizer por quê.

## CRC16-CCITT-FALSE

Polinômio `0x1021`, valor inicial `0xFFFF`, sem reflexão, sem XOR final —
exatamente o do padrão EMV. Vetor de verificação clássico coberto no teste:
`"123456789" → 0x29B1`. O CRC cobre **todo** o payload, incluindo o `6304`
que o anuncia.

Teste: `npx vitest run src/lib/payments/pix-emv.test.ts` (9 casos).

## QR e copia-e-cola são o MESMO payload

`POST /api/checkout` gera o payload uma vez e:
- devolve em `order.payment.pix.copyPaste` (o texto que a cliente cola);
- renderiza em `order.payment.pix.qrCode` via `qrcode` → data URI (o que a
  câmera lê). Um payload, duas formas.

## Fluxo de confirmação: poll + webhook

```
cliente paga no app do banco
        │
        ▼
[produção] gateway ──POST──► /api/webhooks/payment ──► confirmPayment()
                                                          │ marca paid
                                                          │ emite purchase
[sempre]  PixPanel ──poll──► GET /api/checkout/:id/status │
                              └─► provider.checkStatus() ◄┘
                                  (devolve o status já refletido)
```

- O **webhook** é o caminho canônico: o gateway avisa, `confirmPayment` marca
  pago e emite o `purchase` (uma vez só — idempotente).
- O **poll** é como a tela descobre: `GET /:id/status` a cada poucos
  segundos. Ele também roda o `checkStatus` do provider — que no gateway real
  pode ser uma consulta de cobrança (rede de segurança pra webhook perdido) e
  no mock é a auto-confirmação.
- PIX expira em 30min sem pagamento → pedido `expired` (no mock, o próprio
  `checkStatus` expira; com gateway real, o webhook de expiração deles).
  Pagamento que chega DEPOIS do expiry local ainda confirma — dinheiro que
  entrou não se recusa (ver comentário em `confirm.ts`).

## Auto-confirmação do mock

| Ambiente | Comportamento |
|---|---|
| dev | pedido `awaiting_payment` com mais de `MOCK_PIX_CONFIRM_SECONDS` (25s) é confirmado no próximo poll |
| produção | **nunca**, a menos que `MOCK_PIX_AUTOCONFIRM=1` (demo consciente) |

A confirmação do mock chama o **mesmo** `confirmPayment` do webhook — o fluxo
demonstrado em dev é, linha por linha, o de produção: transição de status,
log `order_event`, emissão do `purchase` com dedup por `event_id`.
