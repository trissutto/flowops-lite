# Último Enter da grade cria a próxima REF

## Objetivo

Corrigir o fluxo de digitação da matriz de grade no pedido de compra. O Enter
continua avançando entre quantidades e, no último campo, deve concluir a REF
atual e preparar imediatamente a próxima.

## Comportamento

1. Nos campos intermediários, Enter move o foco para a quantidade seguinte.
2. No último campo, Enter aguarda a mesma conferência usada pelo botão
   `Conferir`, incluindo cadastro, estoque e etiquetas.
3. Com a conferência concluída, a REF atual recolhe, uma nova REF vazia é
   adicionada e o foco vai para o campo Referência dela.
4. Se validação, cadastro ou recebimento falhar, nenhuma nova REF é criada e o
   erro permanece visível para correção.
5. Uma trava síncrona impede dois Enters rápidos de conferirem a mesma REF duas
   vezes.

## Preservação de fluxo

- O botão `Conferir` mantém seu comportamento atual.
- Os demais atalhos da grade não mudam.
- A nova REF herda somente os campos já previstos pelo pedido; REF, NCM, custo,
  preço, cores e quantidades continuam específicos da nova peça.

## Validação

- Testar avanço entre campos intermediários.
- Testar a ordem: conferir, criar e focar.
- Testar que falha na conferência não cria REF.
- Executar build e checagem de tipos do frontend.
