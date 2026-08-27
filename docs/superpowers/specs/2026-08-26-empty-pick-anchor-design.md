# Cards vazios e âncora logística — desenho funcional

## Contexto

Um pedido de entrega por SEDEX tinha duas unidades do mesmo SKU, ambas atribuídas a Vinhedo. Mesmo assim, a tela mantinha um `pick-order` ativo de Piracicaba sem item e tratava o pedido como dividido entre duas lojas. Esse card vazio podia ser escolhido como âncora de juntada, produzindo a rota desnecessária Vinhedo → Piracicaba → cliente.

O defeito vem de duas ambiguidades hoje misturadas no mesmo conceito:

- card órfão: card ativo sem peça e sem função logística;
- card receptor: loja sem peça própria que precisa receber transferências porque é o destino escolhido para retirada ou motoboy.

O sistema deve remover o primeiro e preservar o segundo.

## Objetivo

Garantir que pedidos de envio comum saiam diretamente da única loja que possui todas as peças, sem criar uma etapa intermediária vazia, preservando o fluxo legítimo de transferência para a loja escolhida em retiradas e entregas por motoboy.

## Fonte da verdade do destino

O projeto já grava a loja escolhida para retirada ou motoboy em `Order.pickupStoreCode`. Não será criado outro campo nem outra seleção.

Para este desenho, `pickupStoreCode` significa **destino logístico obrigatório** quando a forma de entrega for:

- retirada em loja;
- motoboy com loja escolhida.

Em SEDEX, PAC e transportadora, `pickupStoreCode` não cria destino intermediário.

A modalidade deve ser determinada pela classificação de `Order.shippingMethod` já usada pelo sistema, em conjunto com `Order.isPickup` e `pickupStoreCode`. A existência isolada de `pickupStoreCode` não transforma um envio comum em retirada ou motoboy.

## Regras de negócio

### 1. Envio comum: SEDEX, PAC ou transportadora

Se uma única loja cobre 100% das quantidades do pedido:

- criar ou manter somente o card dessa loja;
- enviar diretamente dessa loja para a cliente;
- remover cards ativos sem itens;
- não oferecer juntada;
- não permitir escolher card vazio como âncora.

Se duas ou mais lojas possuem peças, a juntada continua disponível, mas a âncora deve ser uma loja que possua ao menos uma peça atribuída no momento da operação.

### 2. Retirada em loja

A loja de `pickupStoreCode` é o destino final, mesmo que não possua peças próprias.

- Se ela cobre todo o pedido, separa e entrega diretamente.
- Se cobre parte, separa sua parte e recebe as demais.
- Se não cobre nenhuma peça, pode manter um card receptor com zero itens.
- As lojas fornecedoras transferem as peças para ela.
- A cliente só pode receber o pedido completo após a conferência definida no fluxo de retirada.

### 3. Motoboy com loja escolhida

A loja de `pickupStoreCode` é o hub obrigatório da entrega por motoboy, mesmo sem estoque próprio.

- As lojas com estoque transferem as peças para o hub.
- O hub confere o pedido completo.
- Somente o hub libera a entrega por motoboy.
- Alterar esse destino exige alteração explícita da forma/loja de entrega já existente.

### 4. Classificação de card vazio

Um card ativo com zero itens é legítimo somente quando todas as condições forem verdadeiras:

1. a forma de entrega é retirada ou motoboy;
2. existe `pickupStoreCode` válido;
3. o card pertence à loja indicada por `pickupStoreCode`;
4. existe ao menos um card fornecedor ativo com itens e `transferToStoreCode` apontando para essa loja.

Fora desse caso, o card é órfão e deve ser removido.

## Comportamento do backend

### Saneamento de cards órfãos

Criar uma operação interna idempotente que, dentro do fluxo de alteração de rota, identifique cards ativos sem `OrderItem.assignedStoreId` correspondente.

- Preservar apenas o receptor logístico legítimo.
- Estornar bipes ativos antes de remover qualquer card, reutilizando o fluxo de estorno existente.
- Remover o card órfão.
- Emitir `pick-order:removed` para a loja afetada.
- Registrar `OrderHistory` com card, loja, motivo e autor.

O saneamento deve rodar após operações que podem mudar atribuições:

- confirmação ou recálculo da rota;
- troca de loja do card;
- movimentação manual de item;
- troca/cancelamento de peça;
- mudança da forma ou loja de entrega;
- criação ou alteração de juntada.

### Validação da juntada

Antes de aceitar a âncora:

- carregar os cards ativos e a contagem de itens atribuídos por loja;
- em envio comum, recusar âncora com zero itens;
- em retirada/motoboy, a âncora não é livre: deve ser `pickupStoreCode`;
- se apenas uma loja possui todas as peças em envio comum, responder que a juntada é desnecessária e manter envio direto;
- nunca transformar em feeder um card sem itens.

A validação deve acontecer no backend mesmo que a interface esconda a opção.

### Quantidade duplicada do mesmo SKU

As decisões devem usar soma de `OrderItem.quantity`, não quantidade de linhas. Um registro com `quantity = 2` representa duas peças e precisa ser tratado como duas unidades em cobertura, exibição e testes.

## Comportamento da interface

### Contagem de lojas responsáveis

Contar:

- lojas com ao menos uma peça atribuída; mais
- o destino receptor legítimo, quando retirada/motoboy e ele não tiver peça própria.

Não contar cards órfãos.

### Card receptor

Não apresentar como se a loja tivesse estoque. Usar texto explícito:

> Piracicaba — destino da retirada/motoboy · 0 peças próprias · 2 peças vindo de Vinhedo

O card deve mostrar origem, quantidade aguardada e etapa da transferência.

### Modal de juntada

Em envio comum:

- listar apenas lojas com quantidade atribuída maior que zero;
- mostrar a quantidade real em cada candidata;
- esconder o botão quando apenas uma loja possui todas as peças;
- explicar “Vinhedo possui as 2 peças e enviará diretamente”.

Em retirada/motoboy:

- não pedir escolha de âncora;
- mostrar que a loja escolhida no pedido é o destino obrigatório;
- permitir trocar o destino somente pelo fluxo existente de troca de entrega.

## Concorrência e segurança

- A validação e a mutação devem ocorrer em transação sempre que card e atribuições forem alterados juntos.
- Repetir o saneamento não pode remover um receptor legítimo nem gerar segundo estorno.
- Card com bipes não pode ser apagado antes do estorno correspondente.
- Card separado, pronto ou enviado segue as travas logísticas atuais; este desenho não autoriza apagar movimentação física já realizada.
- Nenhuma mudança toca Giga diretamente fora dos serviços assíncronos/estornos já existentes.

## Auditoria

Registrar no histórico:

- card órfão removido automaticamente;
- motivo da preservação de card receptor;
- juntada recusada por âncora vazia;
- envio direto determinado porque uma loja cobre 100%;
- usuário responsável quando a ação nasceu de operação manual.

## Cenários de aceite

1. **SEDEX, duas unidades iguais em Vinhedo:** somente Vinhedo permanece; envio direto; juntada indisponível.
2. **SEDEX, card vazio em Piracicaba e duas peças em Vinhedo:** Piracicaba é removida; contador mostra uma loja.
3. **SEDEX dividido entre duas lojas:** ambas permanecem; juntada pode escolher apenas loja com peça.
4. **Retirada em Piracicaba, todas as peças em Vinhedo:** Piracicaba permanece como receptora; Vinhedo transfere duas peças.
5. **Motoboy por Piracicaba, todas as peças em Vinhedo:** Piracicaba permanece como hub; Vinhedo transfere duas peças; Piracicaba entrega por motoboy.
6. **Retirada/motoboy com parte do pedido no destino:** destino mostra peças próprias e peças chegando.
7. **Card vazio fora do destino logístico:** removido automaticamente e auditado.
8. **Card vazio com bipe órfão:** estoque é estornado antes da remoção.
9. **Uma linha de item com `quantity = 2`:** cobertura e texto exibem duas peças.
10. **Tentativa direta na API de usar âncora vazia em SEDEX:** resposta 400, sem alterar cards.
11. **Tentativa de escolher outra âncora em retirada/motoboy:** recusada; orientar troca da loja de entrega.
12. **Reexecução do saneamento:** nenhuma baixa, estorno ou remoção duplicada.

## Fora de escopo

- redesenhar toda a torre de controle;
- alterar cálculo de frete;
- criar nova seleção de loja para motoboy;
- mudar a regra financeira de acerto entre lojas;
- alterar o fluxo físico depois que uma caixa já foi despachada.

## Arquivos provavelmente afetados na implementação

- `backend/src/pick-orders/juntada.service.ts`
- `backend/src/routing/routing.service.ts`
- `frontend/src/app/pedidos/wc/[id]/page.tsx`
- testes de routing, juntada e tela de pedido
