# Segurança do checkout — o que existe, o que está preparado, o que falta

Sem teatro: este documento separa o que **protege hoje** do que é **desenho
pronto esperando implementação**. Confundir os dois é como nasce falsa
sensação de segurança.

## O que JÁ existe (implementado e ativo)

### Recálculo server-side — a defesa principal
`POST /api/checkout` **refaz toda a conta**: subtotal a partir dos itens,
cupom via `applyCoupon` (com `CUPONS_JSON` do server tendo precedência),
frete recotado via `findQuote` pelo CEP — o id de frete escolhido no client
precisa existir na cotação do server. Client adulterado pode mandar o total
que quiser: é ignorado.

*Exceção declarada:* o `unitPrice` de cada item ainda não é reconferido
contra o catálogo (falta endpoint de preço em lote — ver comentário no topo
da rota). Mitigação atual: teto de sanidade (> R$ 0, < R$ 10.000/peça),
limite de 50 itens × 20 unidades, e o pedido não move estoque nem dinheiro
antes do pagamento real entrar.

### Rate-limit por IP
- `/api/checkout`: 10 req/min (criar pedido é ação rara);
- `/api/events`: 60 req/min.
Em memória por instância — contém aba em loop e script preguiçoso; **não é
anti-DDoS** (isso é papel da borda/Vercel).

### Webhook com segredo compartilhado
`/api/webhooks/payment`:
- sem `PAYMENT_WEBHOOK_SECRET` → **404** (a rota não existe pra quem não
  deveria saber dela — mesmo padrão do `/api/events/logs`);
- segredo errado → **404 também** (não confirmamos existência pra quem chuta),
  comparação em tempo constante (`timingSafeEqual` sobre hashes);
- payload validado com zod; confirmação idempotente (reenvio de webhook é
  no-op, purchase não duplica — `event_id` derivado do pedido).

### Dados pessoais na resposta
`GET /api/checkout/:id`:
- CPF sai **mascarado** (`***.***.**9-10`) — a tela prova pra cliente que o
  pedido é dela sem reexibir o documento;
- o bloco `tracking` (fbp/fbc/attribution) **não sai** — sinal interno não é
  dado de pedido.
O id do pedido é UUID aleatório funcionando como capability token (modelo
rastreio dos Correios). Sem login no MVP, é essa a barreira — força bruta de
UUID v4 não é vetor realista.

### Cartão nunca persistido
Não há caminho de cartão no server hoje (o método responde "em breve"). O
contrato `CardInput` já avisa: número/cvv vão direto pro gateway tokenizar,
**nunca** pra log, banco ou store. Quando cartão entrar, o dado cru não pode
NEM PASSAR pelo nosso servidor — ver "tokenização" abaixo.

### Logs sem PII
`order_event` (transições de pedido) e `payment_webhook` logam id, número,
status, valor — nunca nome, e-mail, CPF ou endereço. O CPF que vai pra Meta
como `external_id` sai **hasheado (SHA-256)** pela CAPI, junto com e-mail e
telefone (Advanced Matching padrão).

## O que está PREPARADO (desenho pronto, implementação pendente)

- **Tokenização de cartão**: o fluxo correto é o SDK do gateway tokenizar no
  browser e o server só ver o token. O contrato (`CardInput` + comentário) e
  a recusa atual do método já apontam pra isso. **Falta**: escolher gateway
  de cartão, integrar SDK, PCI-DSS SAQ-A.
- **3DS (autenticação da portadora)**: nada implementado — depende do gateway
  escolhido. Entra no `PaymentProvider` como um passo do `createCardCharge`
  que ainda não existe.
- **Antifraude**: nada implementado. O desenho natural: score na criação do
  pedido (device fingerprint + histórico do CPF/CEP) antes de gerar cobrança.
  Os sinais já capturados (fbp, session, attribution) ajudariam, mas **não há
  motor nenhum hoje**.
- **Persistência real de pedidos**: store em memória (declarado em
  `docs/payments.md`). Postgres é pré-requisito pra ir ao ar de verdade —
  pedido pago que some da memória é passivo jurídico, não bug.
- **Assinatura de webhook do gateway real**: o segredo compartilhado atual é
  suficiente pro mock e pra parceiro que suporte header custom; PagBank/
  Pagar.me assinam com esquema próprio (HMAC do corpo) — a validação troca
  quando o provider real entrar.

## Checklist antes de ligar produção com dinheiro real

1. Postgres no `OrderStore` (a interface já isola a troca).
2. `PIX_KEY` real + decisão do token PagBank (ver aviso em `docs/payments.md`).
3. `PAYMENT_WEBHOOK_SECRET` forte configurada no Railway/Vercel E no gateway.
4. `MOCK_PIX_AUTOCONFIRM` **ausente** do ambiente (conferir duas vezes).
5. Validação de preço por item contra o catálogo (fecha a exceção declarada).
6. Revisar retenção de logs: `order_event` fica no stdout da Vercel — ok; se
   um dia logar mais campos, voltar aqui.
