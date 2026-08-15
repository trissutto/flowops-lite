# Classificação segura das recusas do checkout

## Problema

O relatório de funil registra toda resposta `ok: false` do checkout como
`api_rejected` e apresenta esse código como "Pedido recusado pelo servidor".
Esse grupo mistura cartão não aprovado, mudança de estoque ou preço, cupom ou
frete inválido e indisponibilidade técnica. Além disso, a coluna de eventos
conta cada nova tentativa da mesma sessão. No período investigado, nove eventos
vieram de três sessões, e uma dessas sessões concluiu a compra depois.

## Objetivo

Mostrar no painel a causa operacional de cada tentativa não concluída, sem
armazenar mensagem livre, dados pessoais ou dados do cartão. Manter separadas
as contagens de pessoas e tentativas para que retries não pareçam clientes
perdidos.

## Contrato de erro

O backend devolverá, nas recusas conhecidas de `POST /public/loja/pedido`, um
campo `code` pertencente a uma lista fechada:

- `card_declined`: a operadora não aprovou o pagamento;
- `catalog_unavailable`: produto despublicado, sem estoque ou com preço
  indisponível/alterado;
- `coupon_invalid`: cupom inexistente, vencido ou incompatível;
- `shipping_invalid`: frete ou retirada não pôde ser confirmado;
- `validation_error`: payload incompleto ou inválido;
- `payment_unavailable`: gateway ou tokenização indisponível;
- `internal_error`: falha inesperada ao criar ou cobrar o pedido.

O texto amigável existente continua sendo exibido à cliente. O código é
apenas diagnóstico e não conterá detalhe dinâmico.

## Fluxo de dados

1. O backend classifica a recusa na origem e responde com `ok: false`, `error`
   e `code`.
2. O BFF `/api/checkout` preserva o código conhecido. Falhas próprias do BFF
   recebem um código da mesma lista.
3. A página registra `checkout_error` com `method` e `reason=code`.
4. A lista fechada de campos do tracking continua descartando qualquer outro
   dado antes da gravação em `site_eventos`.
5. O painel traduz os códigos para rótulos de negócio e mostra `Pessoas` e
   `Tentativas` (nome mais claro para a coluna hoje chamada `Eventos`).

Eventos antigos com `api_rejected` continuam legíveis e passam a aparecer como
"Motivo não detalhado (dado antigo)", sem reescrever o histórico.

## Limites e segurança

- Nenhuma mensagem do gateway, nome, telefone, CPF, e-mail, token ou endereço
  entra no evento analítico.
- Não será bloqueada nem limitada uma nova tentativa da cliente.
- A regra de cobrança, criação do pedido e persistência de `payment_failed`
  não muda.
- A correção não altera pagamentos existentes nem faz deploy automático.

## Testes

- Testes unitários do backend para cada classe de recusa e fallback interno.
- Testes do BFF garantindo propagação apenas de códigos conhecidos.
- Testes do tracking confirmando que somente `method` e `reason` persistem.
- Teste do relatório para rótulos novos e compatibilidade com
  `api_rejected` antigo.
- Typecheck e suites afetadas de `backend`, `ecommerce` e `frontend`.

## Critério de sucesso

Uma recusa de cartão aparece como "Cartão não aprovado", uma falha genuína
como "Erro interno", e as duas não são mais somadas sob "Pedido recusado pelo
servidor". Múltiplas tentativas da mesma sessão aumentam `Tentativas`, mas não
`Pessoas`.
