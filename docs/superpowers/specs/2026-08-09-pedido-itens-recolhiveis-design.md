# Pedido de compra — itens recolhíveis por referência

## Objetivo

Reduzir a poluição visual no lançamento de pedidos com várias referências. Depois que uma referência for conferida com sucesso, todo o seu formulário deve ser recolhido e permanecer visível apenas como uma linha compacta com a própria REF.

## Decisão de interface

Usar um acordeão dentro da tela existente `/loja/pedidos-compra/novo`, sem criar outra tela e sem remover os fluxos antigos.

Foram considerados três caminhos:

1. esconder definitivamente o formulário após a conferência, que é simples, mas impede a consulta dos dados;
2. abrir a referência conferida em modal, que separa bem os contextos, mas acrescenta uma camada desnecessária;
3. transformar o próprio card em linha recolhível, preservando os dados no mesmo lugar e mantendo o fluxo atual.

A terceira opção foi escolhida por ser a mais direta para pedidos longos.

## Comportamento aprovado

- Uma referência pendente continua aberta e editável.
- O botão **Conferir + etiquetas** mantém toda a validação e gravação atuais.
- No último campo da grade, pressionar `Enter` executa a mesma conferência da referência, em vez de criar outra REF antes de salvar a atual.
- Se houver erro de validação ou gravação, o item permanece aberto e o erro atual continua visível.
- Depois que a API confirmar o recebimento da referência, o item é recolhido automaticamente.
- A linha recolhida mostra somente `REF <número>` e um indicador discreto para reabrir.
- A linha inteira é clicável e também pode ser aberta pelo teclado.
- Ao reabrir uma referência conferida, o formulário completo aparece no estado travado já usado pelo sistema; reabrir não desfaz a conferência e não permite alterar estoque lançado.
- Clicar novamente no cabeçalho recolhe o item.
- Referências já recebidas ao reabrir um pedido começam recolhidas.
- Referências pendentes carregadas de um pedido continuam abertas para edição.
- O botão **Adicionar nova REF** permanece disponível abaixo dos itens.
- Dados, totais, grade, etiquetas, duplicação, exclusão e payloads da API não mudam.

## Estado e componentes

O estado visual de aberto/recolhido fica apenas no frontend e é identificado por `tempId`. Ele não é persistido no banco e não altera `ItemForm` nem o contrato do backend.

O componente da página controla quais referências conferidas estão abertas. O `ItemEditor` recebe o estado e um callback de alternância:

- pendente: formulário completo;
- conferido e recolhido: botão/linha compacta;
- conferido e reaberto: formulário completo, travado.

O recolhimento só acontece após `conferirAgora` concluir e atualizar o item como `conferido`.

## Acessibilidade e interação

- A linha compacta deve ser um `button` real, não uma `div` clicável.
- Deve expor `aria-expanded` e um rótulo que informe a ação de reabrir.
- O foco permanece previsível: uma falha não recolhe o formulário; após sucesso, o foco pode seguir para **Adicionar nova REF**.
- A seta gira para indicar aberto ou fechado, sem depender apenas de cor.

## Validação

- Confirmar uma REF válida pelo botão e verificar o recolhimento após a resposta da API.
- Confirmar pelo `Enter` no último campo da grade e verificar o mesmo resultado.
- Forçar erro de validação e confirmar que o formulário permanece aberto.
- Reabrir a linha e confirmar que todos os dados continuam presentes e travados.
- Recolher novamente pelo cabeçalho e pelo teclado.
- Reabrir um pedido existente e confirmar que recebidos começam recolhidos e pendentes continuam editáveis.
- Confirmar que etiquetas ainda abrem e que os totais do pedido não mudam.
- Executar o build do frontend e a verificação existente do módulo Produto & Estoque.

## Fora do escopo

- alterar backend, banco ou contratos de API;
- permitir edição de referência já conferida;
- redesenhar os demais campos do pedido nesta entrega;
- remover ou substituir telas antigas.
