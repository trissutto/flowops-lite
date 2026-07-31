# Página de confirmação (thank you)

Rota `/checkout/confirmacao/[id]` · `app/(checkout)/checkout/confirmacao/[id]/page.tsx`.

## O que ela mostra

Busca `GET /api/checkout/:id` → `{ ok, order }` (que por baixo lê o pedido no
backend FlowOps — o `:id` é o UUID do Order no Postgres) e exibe:

1. **Chip de status** — "Pagamento confirmado" (pago) ou "Aguardando
   pagamento" (PIX pendente/boleto), com o tom certo em cada um.
2. **Número do pedido** em destaque (display serif) — é o dado que a cliente
   anota/manda no WhatsApp. Quem gera é o backend (sprint 011); a tela só
   exibe o que veio.
3. **Próximos passos** — 3 passos com estado (✓ verde / relógio), texto
   adaptado ao método (PIX pago, PIX pendente, boleto) e ao modo de entrega.
4. **Entrega** — endereço completo OU, na retirada, a loja com endereço,
   horário e o lembrete do documento com foto.
5. **Resumo** — itens compactos, frete ("Grátis" quando 0), desconto/cupom,
   total (verde — a convenção de dinheiro) e o CPF mascarado do pedido.
6. **Botão WhatsApp** (verde, `wa.me`) com mensagem pré-pronta
   "Oi! Acabei de fazer o pedido LP-XXXX".
7. **Rail de recomendados** — `GET /api/loja/produtos?ordenar=relevancia&perPage=4`
   direto por URL (`mapPeca` + `ProductCard`). Se falhar, o rail some — 
   recomendação nunca quebra a thank you.

Pedido inexistente/link errado → `EmptyState` elegante com saída pra loja e
pro WhatsApp. Carregando → skeleton com as mesmas larguras (zero salto).

## O que é PLACEHOLDER honesto (v1)

| Bloco | Hoje | Quando muda |
|-------|------|-------------|
| Acompanhe seu pedido | "você recebe o código por e-mail e WhatsApp" | integração de rastreio (LinkeTrack/Correios) |
| Nota fiscal | "enviada por e-mail após o faturamento" | integração NF-e do FlowOps |
| WhatsApp | número da unidade Anália Franco (`WHATSAPP_ATENDIMENTO`) | canal dedicado do e-commerce |

Nada de link morto nem recurso fingido: o texto diz exatamente o que acontece.

## Guarda de recarga — por que NENHUM purchase aqui

A thank you **não dispara evento de compra nenhum**. O `purchase` é exclusivo
do servidor: o backend confirma o pagamento e avisa o `/api/webhooks/payment`,
que dispara com dedupe por `transaction_id` (docs/purchase.md). Thank you que dispara purchase
no client conta a mesma venda a cada F5, infla ROAS e desafina o acerto — o
bug mais clássico de e-commerce. Aqui é só leitura e exibição; recarregar a
página 50 vezes não muda um número em lugar nenhum.
