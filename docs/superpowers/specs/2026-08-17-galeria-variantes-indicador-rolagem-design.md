# Galeria de produto — indicação de rolagem das variantes

## Objetivo

Deixar evidente que a coluna lateral de cores ou fotos pode ser rolada verticalmente, sem reduzir a largura das miniaturas nem cobrir informações importantes.

## Solução aprovada

- Manter a barra nativa escondida para preservar a largura útil da coluna.
- Quando houver conteúdo abaixo, exibir na base da coluna um degradê e o indicador “Mais cores” com seta para baixo.
- Para uma galeria sem grupos de cores, usar o texto “Mais fotos”.
- Transformar os indicadores em botões clicáveis sem bloquear o gesto de rolagem nem o clique nas miniaturas.
- Ao clicar no indicador inferior, rolar suavemente uma dobra para baixo, preservando uma pequena sobreposição visual com a dobra anterior.
- Ao clicar no indicador superior, rolar suavemente uma dobra para cima com a mesma sobreposição.
- Remover o indicador inferior quando a rolagem chegar ao final.
- Depois que a coluna for rolada para baixo, exibir no topo uma seta discreta para cima enquanto houver conteúdo anterior.
- Manter a próxima miniatura parcialmente visível como pista adicional.
- Atualizar os indicadores ao redimensionar a janela ou trocar o conjunto de variantes.

## Acessibilidade

- A coluna continua identificada como lista de cores ou fotos.
- Os indicadores entram na navegação por teclado como botões.
- Usar os nomes acessíveis “Mostrar próximas cores/fotos” e “Mostrar cores/fotos anteriores”.
- A rolagem e a seleção existentes permanecem disponíveis.

## Critérios de aceitação

- Ao abrir uma peça com variantes ocultas abaixo da dobra, “Mais cores ↓” fica visível.
- Clicar em “Mais cores ↓” move a coluna uma dobra para baixo com animação suave.
- Clicar na seta superior move a coluna uma dobra para cima.
- O indicador inferior desaparece no fim da coluna.
- A seta superior aparece depois que a cliente rola para baixo e desaparece no topo.
- Galerias sem overflow não mostram indicadores.
- A seleção de cor, seleção de foto, zoom e navegação por setas continuam funcionando.
- Testes e build permanecem aprovados.
