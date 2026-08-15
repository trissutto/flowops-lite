# Tabela de medidas em modal — design

## Objetivo

Substituir o assistente “Descubra seu tamanho ideal” da página de produto por um único acesso direto chamado “Tabela de medidas”, usando a arte fornecida pela Lurd's.

## Escopo

- Remover da `BuyBox` o botão do assistente de tamanho, seu estado local, o carregamento dinâmico e a renderização do `FitAssistant`.
- Preservar a seleção obrigatória de tamanho e seu tratamento de erro.
- Adicionar o link/botão textual “Tabela de medidas” junto ao seletor de tamanhos.
- Copiar a imagem fornecida para os arquivos públicos do e-commerce, com nome estável e apropriado para publicação.
- Abrir a imagem em um modal na própria página, sem navegar para outra rota.

## Experiência da cliente

1. A cliente abre uma página de produto.
2. Abaixo das opções de tamanho, encontra somente “Tabela de medidas”.
3. Ao acionar o link, abre-se uma sobreposição com a arte completa da tabela.
4. O modal fecha pelo botão visível, pela tecla `Esc` ou por clique/toque fora do conteúdo.
5. Ao fechar, o foco retorna ao link “Tabela de medidas”.

## Layout responsivo

- Em telas pequenas, o modal usa quase toda a largura disponível e permite rolagem vertical quando a imagem for mais alta que a tela.
- Em telas grandes, a imagem fica centralizada, limitada pela altura e largura da janela, sem distorção.
- A arte será exibida preservando sua proporção original.

## Acessibilidade

- O acionador será um botão com aparência de link, pois abre um modal e não navega.
- O modal terá nome acessível “Tabela de medidas”.
- O botão de fechar terá rótulo explícito.
- A imagem terá texto alternativo descrevendo as medidas apresentadas.
- O foco será controlado ao abrir e fechar, seguindo o padrão de modal existente no projeto, quando disponível.

## Implementação

- Preferir o componente de modal/dialog já existente no e-commerce. Se não existir um componente compatível, criar um componente pequeno e isolado para a tabela.
- A imagem ficará em `ecommerce/public/images/guia-tamanhos/`.
- Não modificar a página geral `/tamanhos/guia`, o cálculo de estoque, o carrinho nem o checkout.
- Não manter código morto do Fit AI dentro da `BuyBox`.

## Verificação

- Typecheck e testes relacionados ao e-commerce.
- Conferência visual em desktop e viewport móvel.
- Testar abertura, fechamento por botão, `Esc`, clique no fundo e retorno de foco.
- Confirmar que a seleção de tamanho e “Adicionar à sacola” permanecem funcionando.

## Critérios de aceite

- “Descubra seu tamanho ideal” não aparece mais na página de produto.
- “Tabela de medidas” abre a imagem fornecida sem sair da página.
- O modal funciona em celular e desktop e pode ser operado por teclado.
- Nenhuma outra etapa de compra é alterada.
