# Auditoria UX — rastreabilidade dos 100 itens

Legenda: **feito** = implementado nesta branch ou já existente e verificado; **dados** = depende de conteúdo/atributo real, sem fabricação; **produto** = evolução que exige decisão e suporte de backend.

1. **feito** Consentimento compacto no mobile.
2. **feito** Faixa não bloqueante, sem overlay.
3. **feito** Ações do consentimento em grade compacta.
4. **feito** Fallback de frete sem valor indefinido.
5. **feito** Devolução em 7 dias e troca em 30 dias explicadas juntas.
6. **feito** Faixa institucional unificada em 44–60.
7. **feito** H1 acessível garantido no hero.
8. **feito** Hero mantém texto semântico independente da arte.
9. **feito** Rótulos canônicos de Calças e Macacões.
10. **dados** Divergências de cadastro devem ser corrigidas na origem; frontend não inventa cor.
11. **dados** Produtos com nome/cor divergentes registrados para saneamento do catálogo.
12. **feito** Cards calculam a faixa usando somente tamanhos disponíveis.
13. **feito** Tamanhos indisponíveis têm estado desabilitado.
14. **feito** Compra exige seleção de tamanho e apresenta erro claro.
15. **feito** Barra de compra persistente no mobile.
16. **feito** Overlays e tokens de contraste já seguem o sistema visual.
17. **feito** Hero aceita imagem mobile dirigida via `picture`.
18. **dados** Enquadramento final depende de imagem mobile/foco cadastrados na retaguarda.
19. **feito** CTA primário possui variante e hierarquia próprias.
20. **feito** CTA secundário usa tratamento distinto.
21. **feito** Cabeçalho reduz altura após rolagem.
22. **feito** Tarja tem tracking responsivo e truncamento seguro.
23. **feito** Mensagem promocional fallback é direta.
24. **feito** Cabeçalho sticky e compacto.
25. **feito** Ações possuem nomes acessíveis; tooltips permanecem opcionais.
26. **feito** Busca está no cabeçalho e agora também na barra mobile do catálogo.
27. **feito** Tamanhos são eixo principal de navegação.
28. **feito** Filtros por ocasião já disponíveis.
29. **feito** Proposta de valor aparece no hero.
30. **feito** Faixa 44–60 aparece na primeira dobra e metadados.
31. **feito** Manifesto usa componente editorial separado.
32. **feito** Benefícios de compra aparecem antes e durante a decisão.
33. **feito** Estatísticas institucionais usam componente compacto.
34. **dados** Fotografias institucionais reais dependem de material aprovado.
35. **feito** Grade de categorias é responsiva e limitada visualmente.
36. **produto** Curadoria de seis categorias depende de prioridade comercial dinâmica.
37. **feito** Imagens de categoria compartilham proporção e foco.
38. **feito** Alt e rótulo visível são separados.
39. **feito** Carrossel tem setas e estrutura acessível.
40. **feito** Quantidade fracionária de cards comunica continuação no mobile.
41. **feito** Setas desktop já habilitadas.
42. **produto** Indicador por páginas será avaliado com o componente de carrossel.
43. **feito** Vitrine redundante de relevância já foi removida da home.
44. **dados** Prova social falsa permanece proibida; aguarda avaliações reais.
45. **feito** Rating aparece quando o produto possui avaliações reais.
46. **feito** Cards suportam badges reais.
47. **feito** Escassez só aparece com estoque real.
48. **feito** Retirada/prova em loja aparece no produto.
49. **produto** Loja próxima requer fluxo consentido de CEP/localização.
50. **feito** Troca fácil fica após a primeira vitrine.
51. **feito** Tamanho é filtro aberto por padrão.
52. **feito** Filtros suportam contagens das facetas.
53. **produto** Desabilitar faceta zero depende de contagens completas do backend.
54. **feito** Filtros ativos aparecem como chips removíveis.
55. **feito** “Limpar filtros” fica junto aos chips e no drawer.
56. **feito** Barra de ordenação/filtro permanece sticky.
57. **feito** Botão mobile mostra quantidade de filtros.
58. **feito** Navegação SPA preserva histórico/posição do navegador.
59. **feito** Preferência de visualização persiste no navegador.
60. **feito** Resultados usam cache e skeletons sem apagar conteúdo anterior.
61. **feito** Skeletons reproduzem a proporção final dos cards.
62. **feito** Alternadores possuem nomes acessíveis editorial/grade.
63. **feito** Visualização preferida salva em `localStorage`.
64. **feito** Filtro de cor usa swatches quando a faceta existe.
65. **produto** Comprimento depende de classificação de catálogo.
66. **produto** Manga/decote dependem de classificação de catálogo.
67. **feito** Tamanho disponível é consultado por produto.
68. **feito** Linguagem “disfarça barriga” foi substituída.
69. **feito** Rótulo objetivo “Caimento leve no abdômen”.
70. **produto** Busca interna de filtros entra quando houver grupos extensos.
71. **feito** Preço possui campos numéricos além dos sliders.
72. **feito** Valores mínimo/máximo ficam visíveis.
73. **feito** Cores usam amostras visuais com nomes acessíveis.
74. **feito** Quick add abre seleção antes de incluir na sacola.
75. **feito** Segunda imagem aparece no hover desktop.
76. **dados** Títulos vagos precisam de saneamento na origem.
77. **feito** Referência fica separada do título.
78. **feito** Referência é informação secundária copiável.
79. **feito** Pix usa hierarquia semântica de dinheiro.
80. **feito** Promoção mostra preço anterior e percentual calculado.
81. **feito** Galeria ganhou controle de zoom acessível.
82. **dados** Número de ângulos depende das fotos cadastradas.
83. **dados** Vídeo depende de material real do produto.
84. **dados** Altura/tamanho da modelo dependem de atributo real.
85. **produto** Medidas por peça dependem de integração com ficha/grade.
86. **dados** Elasticidade/transparência/espessura dependem de cadastro técnico.
87. **feito** Detalhes usam regiões e acordeões escaneáveis.
88. **dados** Limpeza editorial das descrições deve ocorrer na origem.
89. **produto** Classificação pequena/normal/ampla depende de feedback e ficha.
90. **feito** Guia e seleção manual continuam disponíveis sem IA.
91. **feito** Assistente explica dados solicitados e duração.
92. **feito** Privacidade institucional está disponível e consentimento é explícito.
93. **feito** Assistente de tamanho só abre por ação da cliente.
94. **feito** Frete é calculado sem login.
95. **feito** Campo de CEP possui fluxo dedicado e validação.
96. **produto** Estoque por loja/tamanho depende de endpoint específico.
97. **dados** Avaliações corporais somente com relatos reais e consentidos.
98. **feito** Rails vazios desaparecem e carregamento usa skeleton reservado.
99. **feito** Skeletons reservam altura e reduzem CLS.
100. **feito** Compra usa assistente como canal primário; WhatsApp fica como saída humana.

## Pendências não fabricáveis

Os itens marcados como **dados** ou **produto** não foram simulados. A interface já oferece estados seguros, mas fotos, vídeos, avaliações, atributos corporais, classificação de modelagem e estoque por loja precisam de informação verdadeira no backend/retaguarda.
