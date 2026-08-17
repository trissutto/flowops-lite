# Home — categorias roláveis e CTA de lojas antecipado

## Objetivo

Fazer o acesso às lojas físicas aparecer mais cedo na jornada móvel sem remover produtos, preços ou benefícios da Home.

## Solução aprovada

- No celular, transformar a lista de categorias em uma faixa horizontal rolável.
- Manter o tamanho atual dos círculos e os nomes atuais.
- Exibir a barra de rolagem horizontal para tornar a interação evidente.
- Manter a grade atual de cinco categorias no desktop.
- No celular, posicionar o cartão “Prefere provar? — Ver lojas” imediatamente depois das categorias e antes de “Novidades”.
- No desktop, preservar a posição atual do cartão junto aos benefícios.
- Manter o destino `/lojas` e o rastreamento atual do clique.

## Ordem móvel

1. Capa
2. Categorias roláveis
3. Cartão “Ver lojas”
4. Novidades
5. Benefícios

## Critérios de aceitação

- A faixa de categorias aceita rolagem horizontal por toque no celular.
- A barra de rolagem permanece visível.
- Os círculos não aumentam em relação ao desenho atual.
- O cartão “Ver lojas” aparece antes da vitrine de novidades no celular.
- O cartão não fica duplicado na mesma visualização.
- O desktop mantém categorias e bloco de benefícios no desenho atual.
- O link, rastreamento, testes e build continuam funcionando.
