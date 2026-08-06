# Lançamento do site novo — checklist de necessidades reais

Levantado em 04/08/2026 lendo o código (`ecommerce/`, `backend/src/loja-orders`,
`backend/src/correios`, `backend/src/produto-ficha`). Onde diz **JÁ EXISTE**, é
coisa medida no repositório — não repetir trabalho.

Legenda: 🔴 bloqueia o lançamento · 🟠 bloqueia anúncio pago · 🟡 primeira semana

---

## 1. Pagamento (Pagar.me)

1. 🔴 Revalidar `unitPrice` no servidor contra o catálogo antes de cobrar — hoje o preço que vem do front é o cobrado (o próprio `loja-orders.service.ts` marca isso como pendência conhecida)
2. 🔴 Revalidar subtotal, desconto, frete e total no servidor (idem)
3. 🔴 Parar de enviar e-mail/CPF/telefone inventados ao antifraude (há telefone fixo chumbado no código)
4. 🔴 PIX: expiração de 30 min desfazendo a reserva do pedido
5. 🔴 PIX: webhook confirmando pagamento de forma idempotente (repetição do gateway não pode duplicar pedido)
6. 🔴 Cartão: tratar recusa com mensagem que a cliente entenda (saldo, dados, antifraude)
7. 🔴 Cartão: não criar pedido quando recusado (regra já escrita — validar que se cumpre)
8. 🟠 Parcelamento: definir nº máximo de parcelas, valor mínimo por parcela e quem paga juros
9. 🟠 Exibir as parcelas na PDP e no carrinho, não só no checkout
10. 🟠 3DS / autenticação do emissor no cartão
11. 🟠 Tela de "pagamento em análise" (cartão que não aprova na hora)
12. 🟠 Reprocessar pagamento pendente por cron (não depender só do webhook)
13. 🟡 Segunda tentativa de cartão sem refazer o carrinho
14. 🟡 Conciliação: pedido pago no gateway × pedido pago no Flow (relatório de divergência)
15. 🟡 Estorno/cancelamento pelo painel, com baixa no pedido

## 2. Frete

16. 🔴 Endpoint público de cotação no backend — o cálculo **JÁ EXISTE** (`correios.calcularFrete`, `maisEnvios.calcularFrete`), falta expor
17. 🔴 Trocar a fonte em `ecommerce/src/lib/commerce/frete.ts` (hoje é tabela fixa por faixa de CEP, declarada como estimativa)
18. 🔴 Peso e dimensões reais por produto (hoje o envio usa estimativa de 200g/peça)
19. 🔴 Cotação com o CEP de origem da loja que vai despachar, não um fixo
20. 🔴 Cache da cotação por CEP+peso (não bater nos Correios a cada tecla)
21. 🔴 Fallback quando Correios/Mais Envios não respondem — site não pode travar o checkout
22. 🟠 Config editável de frete grátis: valor mínimo, período, região (hoje `FREE_SHIPPING_FROM` está chumbado no código)
23. 🟠 Config de frete promocional fixo (ex.: R$ 9,90 pra Sudeste até dia X)
24. 🟠 Tela na retaguarda pra essas configs, sem deploy
25. 🟠 Prazo de entrega = prazo do transportador + dias de separação
26. 🟠 Retirada em loja: mostrar só lojas com a peça em estoque
27. 🟠 Retirada em loja: prazo e instruções de retirada
28. 🟡 Frete por região com transportadora própria (rota Itanhaém/Praia Grande/Santos já existe no realinhamento)
29. 🟡 Simulador de frete na PDP, antes do carrinho
30. 🟡 Regra de embalagem (juntar itens numa caixa só muda o preço)

## 3. Produto e catálogo

31. 🔴 Fechar foto por cor de todo produto publicável (a importação e a varredura de bolinha **JÁ EXISTEM**)
32. 🔴 Bolinha de cor preenchida em toda cor publicada
33. 🔴 Título de venda por produto (não a descrição crua do ERP)
34. 🔴 Descrição de venda (composição, caimento, o que veste)
35. 🔴 Definir status de publicação de cada peça (publicado / pronto / sem fotos / não publicar)
36. 🔴 Grade de tamanhos com estoque real por SKU
37. 🔴 Esconder automaticamente cor/tamanho sem estoque
38. 🔴 Preço de venda conferido contra o catálogo (evitar preço zerado ou 100× — já houve incidente)
39. 🟠 Tabela de medidas por modelagem (o dono precisa fornecer as medidas oficiais)
40. 🟠 Categorias e subcategorias ligadas ao CRM (de-para)
41. 🟠 Atributos de filtro: tamanho, cor, tecido, ocasião, modelagem
42. 🟠 Ordem das fotos por cor (capa definida, não aleatória)
43. 🟠 Padronizar proporção das fotos da PDP (hoje varia)
44. 🟠 Peça sem foto nunca aparece na vitrine
45. 🟠 Produtos relacionados / "veja similares"
46. 🟡 Vídeo do produto (campo já existe na ficha)
47. 🟡 Nome de cor amigável (o ERP tem cor técnica)
48. 🟡 Badge de novidade / últimas peças
49. 🟡 Guia de tamanhos por categoria
50. 🟡 Compressão e conversão das fotos (WebP) sem perder qualidade

## 4. Carrinho e checkout

51. 🔴 Carrinho persistente por cliente (não só no navegador)
52. 🔴 Validar estoque no fechamento, não só ao adicionar
53. 🔴 Bloquear compra de peça despublicada durante a sessão
54. 🔴 Endereço: CEP com ViaCEP e complemento em campo próprio (o backend **JÁ FOI CORRIGIDO** pra separar complemento de bairro)
55. 🔴 Validação de CPF e telefone com máscara e verificação
56. 🟠 Cupom: validade, valor mínimo, primeira compra, por categoria
57. 🟠 Cupom de frete grátis distinto do cupom de desconto
58. 🟠 Barra de progresso de frete grátis (**JÁ EXISTE**, revisar valor vindo da config)
59. 🟠 Resumo do pedido com tudo discriminado antes de pagar
60. 🟠 Checkout em uma página, sem cadastro obrigatório antes
61. 🟡 Salvar endereço pra próxima compra
62. 🟡 Recuperação de carrinho abandonado (integra com o n8n depois)

## 5. Conta da cliente

63. 🟠 Cadastro/login ligado ao CRM por CPF
64. 🟠 Meus pedidos com status e rastreio
65. 🟠 Segunda via do PIX de pedido em aberto
66. 🟠 Meus endereços (adicionar, editar, padrão)
67. 🟠 Meus dados (com consentimento LGPD)
68. 🟡 Cashback: saldo e extrato (existe no CRM)
69. 🟡 Lista de desejos
70. 🟡 Recuperação de senha por e-mail ou WhatsApp

## 6. Pós-venda e logística

71. 🔴 Pedido do site cair na fila de separação da loja certa (roteamento **JÁ EXISTE**)
72. 🔴 Etiqueta e NF-e do pedido do site (**JÁ EXISTE** no fluxo de pick-orders)
73. 🔴 E-mail de confirmação de pedido
74. 🔴 E-mail/WhatsApp de "pedido enviado" com rastreio
75. 🟠 Página pública de acompanhamento do pedido
76. 🟠 Rastreio automático (`LINKETRACK_TOKEN` não está configurado hoje)
77. 🟠 Aviso de pedido atrasado pra operação
78. 🟠 Regra de split: pedido com peças de lojas diferentes
79. 🟡 Aviso de entrega concluída
80. 🟡 Pesquisa de satisfação pós-entrega

## 7. Trocas e devoluções

81. 🟠 Política de trocas publicada no site
82. 🟠 Portal de trocas ligado ao pedido do site (**JÁ EXISTE** pro site antigo)
83. 🟠 Prazo de arrependimento (7 dias) tratado
84. 🟠 Etiqueta de devolução
85. 🟡 Vale-troca / crédito na conta
86. 🟡 Status da troca visível pra cliente

## 8. Conteúdo e vitrine

87. 🟠 Banners editáveis sem deploy (desenhado, não construído)
88. 🟠 Tela de rascunho com preview do site ao lado (desenhado, não construído)
89. 🟠 Vitrines curadas na home (o que aparece primeiro)
90. 🟠 Menu com os 7 eixos populado de verdade (**JÁ EXISTE** a estrutura)
91. 🟠 Página Nossas Lojas (**JÁ EXISTE**)
92. 🟠 Página Troca Fácil (**JÁ EXISTE**)
93. 🟡 Landing de campanha (50% OFF, datas comemorativas)
94. 🟡 Blog / conteúdo pra SEO
95. 🟡 Depoimentos e prova social

## 9. SEO e performance

96. 🟠 Título e meta description por produto e categoria
97. 🟠 URL amigável e estável (slug que não muda)
98. 🟠 Sitemap.xml e robots.txt
99. 🟠 Dados estruturados de produto (preço, estoque, avaliação)
100. 🟠 Open Graph pra WhatsApp e Instagram
101. 🟠 Redirect 301 das URLs do site antigo (não perder o que já ranqueia)
102. 🟠 Core Web Vitals na PDP e na listagem
103. 🟠 Imagens com `priority` e tamanho correto (já houve pegadinha de poster de vídeo baixando o original cru)
104. 🟡 Canonical em filtro e paginação
105. 🟡 Página 404 útil

## 10. Rastreamento e dados

106. 🔴 GTM instalado em todas as páginas
107. 🔴 Evento de compra com valor e itens (sem isso não há ROI de anúncio)
108. 🟠 Meta Pixel + API de Conversões (server-side)
109. 🟠 Google Analytics 4 com e-commerce
110. 🟠 Eventos: ver produto, adicionar ao carrinho, iniciar checkout
111. 🟠 Consentimento de cookies antes de disparar tag
112. 🟡 Google Merchant Center / catálogo do Meta
113. 🟡 Relatório de funil (visita → carrinho → pagamento)

## 11. Segurança e LGPD

114. 🔴 Rate-limit no checkout e no login
115. 🔴 Não confiar em nada que vem do cliente (validação server-side)
116. 🔴 Cookie de sessão httpOnly
117. 🟠 Política de privacidade e termos de uso publicados
118. 🟠 Consentimento LGPD registrado no CRM
119. 🟠 Exclusão de conta e exportação de dados
120. 🟠 Log de acesso a dado de cliente
121. 🟡 Teste de carga antes de campanha

## 12. Operação

122. 🔴 Alguém responsável por pedido travado, todo dia
123. 🔴 Alerta quando pagamento confirma e o pedido não avança
124. 🟠 Treinamento das lojas pro fluxo do site
125. 🟠 Canal de atendimento na loja (WhatsApp/chat) com resposta definida
126. 🟠 Ambiente de teste com pedido de mentira
127. 🟡 Runbook: o que fazer quando o gateway cai
