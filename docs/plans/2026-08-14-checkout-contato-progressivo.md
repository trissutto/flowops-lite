# Checkout com contato progressivo

## Objetivo

Reduzir o abandono na primeira etapa do checkout e identificar a cliente cedo o suficiente para permitir recuperação manual do carrinho.

## Fluxo aprovado

1. Identificação solicita somente nome e WhatsApp.
2. Ao continuar, o checkout salva contato, sessão, atribuição, itens e subtotal sem bloquear a navegação.
3. A cliente escolhe entrega e pagamento normalmente.
4. Na revisão, informa nome completo, e-mail e CPF antes de finalizar.
5. Depois que o pedido nasce, a captura é marcada como convertida.

## Segurança e operação

- CPF, e-mail e dados de cartão nunca entram na captura de recuperação.
- Falha na captura não interrompe a compra.
- Nenhuma mensagem é enviada automaticamente.
- PagBank e Pagar.me, inclusive seus payloads, permanecem inalterados.
- Os contatos aparecem junto dos carrinhos do e-commerce na retaguarda.
