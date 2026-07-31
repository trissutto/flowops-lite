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

- **Tokenização de cartão**: ✅ FEITO na sprint 011. `CardForm.tsx` chama a API
  de tokens da Pagar.me **do navegador** com a chave pública
  (`NEXT_PUBLIC_PAGARME_PUBLIC_KEY`); só o `card_token` viaja pro BFF e dele
  pro backend, que cobra. O PAN não toca servidor nenhum. **Falta**: formalizar
  o PCI-DSS SAQ-A.
- **3DS (autenticação da portadora)**: nada implementado. Agora é decisão do
  BACKEND, que é quem cria a transação na Pagar.me.
- **Antifraude**: nada implementado. O desenho natural: score na criação do
  pedido (device fingerprint + histórico do CPF/CEP) antes de gerar cobrança.
  Os sinais já capturados (fbp, session, attribution) ajudariam, mas **não há
  motor nenhum hoje**.
- **Persistência real de pedidos**: ✅ FEITO na sprint 011. O pedido nasce no
  Postgres do backend FlowOps (`POST /public/loja/pedido`); o ecommerce não
  guarda pedido nenhum e **não tem fallback pra memória** — sem as envs do
  backend o checkout sai do ar com aviso, em vez de fingir que funciona.
- **Assinatura de webhook do gateway**: o webhook da Pagar.me chega no
  **backend** agora, e é lá que a assinatura deles é conferida. O
  `/api/webhooks/payment` daqui é chamada interna backend→ecommerce,
  autenticada pelo segredo compartilhado `PAYMENT_WEBHOOK_SECRET`.

## Checklist antes de ligar produção com dinheiro real

1. `FLOWOPS_API_URL` + `LOJA_ORDER_TOKEN` configuradas na Vercel (sem elas não
   há checkout — de propósito).
2. `PAYMENT_WEBHOOK_SECRET` forte, com o **mesmo valor** no Railway (backend) e
   na Vercel (ecommerce).
3. `NEXT_PUBLIC_PAGARME_PUBLIC_KEY` da conta certa — a chave pública é do
   ambiente (test/live) e trocar de ambiente sem trocar a chave gera token que
   o backend não consegue usar.
4. Validação de preço por item contra o catálogo (fecha a exceção declarada) —
   agora é responsabilidade do backend, que tem o catálogo na mão.
5. Revisar retenção de logs: `order_event` e `payment_webhook` ficam no stdout
   da Vercel, sem PII — ok; se um dia logar mais campos, voltar aqui.
