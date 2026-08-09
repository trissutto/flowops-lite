# NCM por IA no pedido de compra

## Objetivo

Substituir o NCM fixo e oculto da tela de pedido de compra por uma classificação fiscal assistida por IA. O campo continua invisível para a operação, mas cada nova referência recebe um código NCM vigente antes de ser gravada.

## Decisão

O backend é a fonte da classificação. Ao adicionar a primeira cor de uma referência, ele monta o contexto com grupo, subgrupo, tecido, modelagem e ocasião e pede à IA que escolha um código dentro de uma lista controlada de NCMs de moda. A resposta só é aceita quando:

1. contém exatamente oito dígitos;
2. pertence à lista de candidatos enviada à IA; e
3. existe na tabela NCM vigente baixada do serviço público do Classif/Siscomex.

A tabela oficial fica em cache por 24 horas. As classificações ficam em cache pela combinação dos atributos para que cores diferentes da mesma referência não gerem chamadas repetidas.

## Fluxo de dados

1. O frontend envia o item sem inventar ou herdar um NCM.
2. `PurchaseOrdersService.addItem` resolve os nomes confiáveis dos atributos pelos IDs.
3. `NcmAiClassifierService` carrega a tabela oficial, filtra os candidatos vigentes e chama a Anthropic.
4. O código retornado é conferido contra a tabela oficial.
5. O NCM validado é gravado em `PurchaseOrderItem` e segue para o cadastro dos SKUs no ERP.

Pedidos reabertos que já possuem NCM preservam o código existente. Novos itens e itens sem NCM passam pela classificação.

## Falhas e segurança operacional

- Se a IA estiver indisponível ou responder fora do contrato, o serviço usa uma regra determinística dentro da mesma lista oficial validada, para não interromper a entrada da mercadoria.
- Se o Siscomex estiver temporariamente indisponível, é usada a última tabela válida em memória; sem cache, apenas a lista controlada embarcada e verificada na implementação pode ser usada.
- A IA nunca pode gravar um código livre.
- A origem da decisão (`ia`, `regra` ou `existente`) é registrada no log do backend.

## Interface

O NCM permanece oculto, como solicitado. Não haverá campo adicional nem confirmação para a usuária. A ação acontece automaticamente tanto no fluxo **Conferir** quanto no fluxo **Salvar pedido**, pois ambos passam por `addItem` no servidor.

## Testes

- aceita uma escolha da IA presente na tabela oficial;
- rejeita uma escolha da IA fora da lista e usa fallback válido;
- funciona sem chave de IA usando fallback válido;
- preserva NCM existente de pedidos reabertos;
- frontend não envia mais o antigo `61062000` como padrão.
