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

⚠️ **Sprint 011: em produção quem gera o payload é o BACKEND FlowOps** — o
`pix-emv.ts` daqui virou ferramenta de desenvolvimento/conferência (ver
`docs/payments.md`). O que descrevemos acima continua valendo como referência
do formato: é o mesmo padrão EMV dos dois lados.

`POST /api/checkout` recebe do backend `payment.pix` e monta a resposta:
- `copyPaste` — o texto que a cliente cola, sempre vindo do backend;
- `qrCode` — data URI. Se o backend mandar o dele, usamos; se mandar só o
  copia-e-cola, o BFF renderiza aqui com a lib `qrcode`. Os dois caminhos
  funcionam, e nos dois o QR nasce do MESMO payload do copia-e-cola.

## Fluxo de confirmação: poll + webhook

```
cliente paga no app do banco
        │
        ▼
Pagar.me ──webhook──► BACKEND FLOWOPS
                        │ marca paid no Postgres
                        │
                        ├──POST──► /api/webhooks/payment (x-webhook-secret)
                        │            └─► purchase (GA4 + Meta CAPI)
                        │
PixPanel ──poll 5s──► GET /api/checkout/:id/status
                        └─► GET /public/loja/pedido/:id/status ◄┘
```

- O **backend** é o único que confirma pagamento. O ecommerce não tem estado
  de pedido pra transicionar — e é assim que se garante que "pago" significa
  a mesma coisa pro site, pro CRM e pra separação.
- O **poll** é só como a tela descobre. Erro de rede ou 502 no poll é tratado
  como silêncio: tenta de novo no ciclo seguinte.
- PIX expira em 30min sem pagamento → o backend marca `expired` e o poll
  reflete. Pagamento que chega DEPOIS do expiry ainda confirma — dinheiro que
  entrou não se recusa.

## Mock de desenvolvimento

`MockProvider` (`src/lib/payments/mock.ts`) gera um PIX de mentira **sem
backend rodando**, útil pra mexer na UI do `PixPanel`. Ele não é chamado por
rota nenhuma no fluxo real.

A auto-confirmação do mock foi **removida** na sprint 011: ela marcava o pedido
como pago num store local que não existe mais. Um "pago" inventado pelo
ecommerce seria uma mentira que nem o backend nem o CRM conheceriam — e pedido
"pago" sem dinheiro entrar é o pior bug possível num e-commerce.
