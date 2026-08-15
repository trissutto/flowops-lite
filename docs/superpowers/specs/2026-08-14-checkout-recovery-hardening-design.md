# Endurecimento da recuperação do checkout

## Objetivo

Completar a captura progressiva do checkout sem criar falsos recuperados, sem quebrar a visualização na retaguarda e sem habilitar mensagens automáticas.

## Decisões

- `ecommerce-contact` representa uma cliente identificada antes do pedido.
- Um pedido criado e ainda não pago continua elegível para recuperação.
- Somente `paidAt`/pagamento confirmado representa recuperação concluída.
- A recuperação por WhatsApp permanece manual.
- PagBank, Pagar.me e seus payloads ficam fora do escopo.

## Fluxo de dados

1. Nome e telefone criam ou atualizam `CheckoutRecovery`, identificada pela sessão.
2. A captura armazena somente contato, itens, subtotal e atribuição comercial.
3. A retaguarda lê capturas e pedidos do e-commerce em uma lista unificada.
4. Ao existir pedido para a mesma sessão, a captura é deduplicada e o pedido passa a representar o checkout.
5. Pedido sem pagamento aparece como “Aguardando pagamento”. Pedido com `paidAt` aparece como “Pago/recuperado”.

## Retaguarda

- Tratar `ecommerce-contact` como origem nativa, usando os itens já embutidos e sem consultar o endpoint legado do WordPress.
- Exibir badges distintos para contato capturado, pedido aguardando pagamento e recuperado.
- Incluir capturas identificadas na fila manual de Marketing Recovery após a janela T1 de uma hora.
- O botão de WhatsApp continua exigindo ação humana.

## Proteção do endpoint público

- Validar e limitar tamanho dos campos e quantidade de itens.
- Sanitizar atribuição para chaves comerciais conhecidas.
- Aplicar limitação de frequência por sessão e telefone em janela curta.
- Responder de forma idempotente e manter comportamento fail-open no navegador.

## Correção de conversão

- Remover a marcação `converted` feita pelo navegador assim que o pedido é criado.
- Usar o estado real do pedido e `paidAt` como fonte da verdade.
- Preservar deduplicação por `trackingInfo.session_id` para não mostrar captura e pedido duplicados.

## Testes

- Unidade: validação, sanitização e limitação do endpoint.
- Unidade: candidato manual vindo de `ecommerce-contact` e janela mínima de uma hora.
- Integração de tipos/build: fontes e estados reconhecidos pela retaguarda.
- Regressão: testes completos de backend e e-commerce, lint e TypeScript.
