# Site novo — 100 itens pra ir ao ar

Refeito em 04/08/2026, **só o site novo** (`ecommerce/` + `backend/src/loja-orders`,
`correios`, `produto-ficha`, `pick-orders`). Levantado lendo o código.

- **JÁ EXISTE** = medido no repositório. Não refazer.
- 🔴 impede ir ao ar · 🟠 impede anunciar/escalar · 🟡 primeira semana

> Corrigido nesta versão: "dado inventado no antifraude" **não se aplica ao site
> novo** — o checkout exige CPF, e-mail e telefone da cliente antes de cobrar
> (`loja-orders.service.ts › validar()`). Aquilo era do link de pagamento das
> lojas, e já foi resolvido em 01/08.

---

## A. Dinheiro — não pode errar (🔴) · **APROVADO PELO DONO 04/08**

> **Status:** 7, 13, 14 e 15 **FEITOS** (commits `0408caa`). Itens **1–6 são o
> próximo bloco** — vão juntos num commit só, porque mexem no mesmo ponto
> (`criarPedido`) e checkout meio validado é pior que nenhum.
>
> Duas decisões do dono nesta rodada: **PIX vale 2 HORAS** (não 30 min) e
> **não existe valor mínimo de pedido**.

1. ⬜ APROVADO — Revalidar `unitPrice` de cada item contra o catálogo antes de cobrar — hoje o preço vem do front (o código marca como pendência conhecida)
2. ⬜ APROVADO — Revalidar subtotal, desconto, frete e total no servidor
3. ⬜ APROVADO — Recalcular o cupom no servidor (não aceitar valor do cliente)
4. ⬜ APROVADO — Travar preço entre "ver carrinho" e "pagar" (não mudar no meio)
5. ⬜ APROVADO — Validar estoque no fechamento, não só ao adicionar
6. ⬜ APROVADO — Não fechar pedido com peça despublicada durante a sessão
7. ✅ FEITO (2h) — PIX: expiração de 30 min liberando a reserva
8. PIX: webhook idempotente (repetição do gateway não duplica pedido)
9. Cartão recusado não cria pedido (regra existe — validar que se cumpre)
10. Cartão: mensagem de recusa que a cliente entenda
11. Cron reprocessando pagamento pendente (não depender só do webhook)
12. Conciliação diária: pago no gateway × pago no Flow
13. ✅ FEITO — Validação de e-mail de verdade (hoje é `includes('@')`, "a@b" passa e a confirmação não chega)
14. ✅ FEITO — Remover o fallback de telefone `13 996218277` do checkout (caminho morto hoje, mina amanhã)
15. ✅ SEM VALOR MINIMO (dono) — Valor mínimo de pedido, se houver

## B. Frete (🔴/🟠)

16. ✅ FEITO — Endpoint público de cotação (`POST /api/public/loja/frete`, commit b6d7b1c) — **o cálculo COM CONTRATO JÁ EXISTE**. Verificado 04/08: `CORREIOS_CONTRATO`, `CORREIOS_CARTAO_POSTAGEM`, `CORREIOS_DR` e `CORREIOS_CEP_ORIGEM` estão configurados, e o `calcularFrete` passa `nuContrato`+`nuDR` no preço e consulta o prazo oficial — é o preço NEGOCIADO, não tabela de balcão. Falta **só expor num endpoint público** (hoje a rota exige login) e trocar a fonte no site. Item pequeno, retorno grande
17. ⬜ PRÓXIMO — Trocar a fonte em `ecommerce/src/lib/commerce/frete.ts` (hoje tabela fixa por faixa de CEP)
18. ✅ FEITO — Peso e caixa do dono: **250 g/peça**, **28 larg × 40 compr × 3 cm alt por peça** (só a altura acompanha a quantidade)
19. ✅ FEITO — Origem = **MATRIZ, CEP 11746-692** (decisão do dono; uma origem só mantém a cotação estável). ⚠️ CONFERIR se `CORREIOS_CEP_ORIGEM` no Railway está com esse CEP
20. 🔴 Fallback quando o transportador não responde (não travar o checkout)
21. 🔴 Cache de cotação por CEP+peso
22. 🟠 Config editável de frete grátis: mínimo, período, região (hoje `FREE_SHIPPING_FROM` chumbado)
23. 🟠 Config de frete promocional fixo com data de início e fim
24. 🟠 Tela na retaguarda pra essas configs, sem deploy
25. 🟠 Prazo = prazo do transportador + dias de separação
26. 🟠 Retirada em loja só onde a peça existe
27. 🟠 Retirada: prazo, endereço e instruções
28. 🟡 Simulador de frete na página do produto
29. 🟡 Regra de embalagem (vários itens numa caixa)
30. ~~Rota própria Itanhaém/Praia Grande/Santos como opção de entrega~~ — **REMOVIDO (04/08)**. Era a regra do REALINHAMENTO entre lojas (carro da rede levando mercadoria de loja pra loja), não entrega de pedido de cliente. Vazou do contexto do dia pra esta lista. Se um dia virar entrega própria pro cliente naquelas cidades, é item novo e com desenho próprio

## C. Produto e vitrine (🔴 — o gargalo real)

31. 🔴 Foto por cor em todo produto publicável (importador e varredura **JÁ EXISTEM**)
32. 🔴 Bolinha de cor preenchida em toda cor publicada (varredura automática **JÁ EXISTE**)
33. 🔴 Título de venda por produto (não a descrição crua do ERP)
34. 🔴 Descrição de venda: composição, caimento, o que veste
35. 🔴 Status de publicação decidido peça a peça
36. 🔴 Estoque real por SKU aparecendo na grade
37. 🔴 Esconder cor/tamanho sem estoque
38. 🔴 Conferir preço contra o catálogo (já houve incidente de preço 100×)
39. 🔴 Peça sem foto nunca chega à vitrine
40. 🟠 Ordem das fotos por cor (capa definida)
41. 🟠 Proporção padronizada das fotos da PDP
42. 🟠 Tabela de medidas por modelagem (o dono precisa fornecer as oficiais)
43. 🟠 Categorias e subcategorias ligadas ao CRM
44. 🟠 Filtros: tamanho, cor, tecido, ocasião, modelagem
45. 🟠 Produtos relacionados / "veja similares" (**JÁ EXISTE** o bloco, falta a fonte)
46. 🟠 Nome de cor amigável (o ERP tem cor técnica)
47. 🟡 Vídeo do produto (campo já existe na ficha)
48. 🟡 Badge de novidade e de últimas peças
49. 🟡 Guia de tamanhos por categoria
50. 🟡 WebP e compressão sem perder qualidade

## D. Carrinho e checkout (🔴/🟠)

51. 🔴 Carrinho persistente por cliente, não só no navegador
52. 🔴 CEP com ViaCEP e complemento em campo próprio (backend **JÁ CORRIGIDO**)
53. 🔴 Máscara e validação de CPF e telefone
54. 🔴 Mensagem clara quando falta estoque no fechamento
55. 🟠 Cupom: validade, mínimo, primeira compra, por categoria
56. 🟠 Cupom de frete grátis separado do de desconto
57. 🟠 Barra de progresso de frete grátis lendo a config (**JÁ EXISTE** a barra)
58. 🟠 Resumo discriminado antes de pagar
59. 🟠 Checkout sem cadastro obrigatório antes
60. 🟡 Salvar endereço pra próxima compra
61. 🟡 Escassez honesta ("últimas 2") — **JÁ EXISTE**, ligar na fonte real
62. 🟡 Quick add na listagem — **JÁ EXISTE**

## E. Conta da cliente (🟠)

63. Cadastro e login ligados ao CRM por CPF — **JÁ EXISTE** a base
64. Meus pedidos com status e rastreio
65. Segunda via do PIX em aberto
66. Meus endereços
67. Meus dados com consentimento LGPD
68. 🟡 Cashback: saldo e extrato (existe no CRM)
69. 🟡 Lista de desejos
70. 🟡 Recuperação de senha

## F. Pedido → loja → entrega (🔴)

71. 🔴 Pedido do site cair na fila da loja certa — roteamento **JÁ EXISTE**
72. 🔴 Etiqueta e NF-e do pedido do site — **JÁ EXISTE** em pick-orders
73. 🔴 E-mail de confirmação do pedido
74. 🔴 Aviso de "pedido enviado" com rastreio
75. 🔴 Alerta quando o pagamento confirma e o pedido não anda
76. 🟠 Página pública de acompanhamento
77. 🟠 Rastreio automático (`LINKETRACK_TOKEN` não configurado hoje)
78. 🟠 Pedido com peças de lojas diferentes (split) testado ponta a ponta
79. 🟠 Corrigir endereço do pedido antes de postar — **JÁ EXISTE** (04/08)
80. 🟡 Aviso de entrega concluída

## G. Trocas (🟠)

81. Política de trocas publicada
82. Portal de trocas ligado ao pedido do site (**JÁ EXISTE** pro site antigo)
83. Prazo de arrependimento de 7 dias
84. Etiqueta de devolução
85. 🟡 Vale-troca / crédito na conta

## H. Conteúdo (🟠)

86. Banners editáveis sem deploy — desenhado, não construído
87. Tela de rascunho com preview ao lado — desenhada, não construída
88. Vitrines curadas na home
89. Menu dos 7 eixos populado (estrutura **JÁ EXISTE**)
90. Nossas Lojas (**JÁ EXISTE**) e Troca Fácil (**JÁ EXISTE**)
91. 🟡 Landing de campanha

## I. SEO e velocidade (🟠)

92. Título e meta description por produto e categoria
93. Slug estável (URL que não muda)
94. Sitemap.xml e robots.txt
95. Dados estruturados de produto
96. Open Graph pra WhatsApp e Instagram
97. Redirect 301 das URLs do site antigo
98. Core Web Vitals na PDP e na listagem
99. 🟡 Canonical em filtro e paginação

## J. Rastreamento (🔴/🟠)

100. 🔴 GTM em todas as páginas
101. 🔴 Evento de compra com valor e itens (sem isso não há ROI de anúncio)
102. 🟠 Meta Pixel + API de Conversões (server-side)
103. 🟠 GA4 com e-commerce
104. 🟠 Eventos de ver produto, adicionar ao carrinho, iniciar checkout
105. 🟠 Consentimento de cookies antes da tag

## K. Segurança e LGPD (🔴/🟠)

106. 🔴 Rate-limit no checkout e no login
107. 🔴 Cookie de sessão httpOnly (**JÁ EXISTE** no padrão adotado)
108. 🟠 Política de privacidade e termos publicados
109. 🟠 Consentimento LGPD gravado no CRM
110. 🟠 Exclusão de conta e exportação de dados

## L. Operação (🔴/🟠)

111. 🔴 Responsável diário por pedido travado
112. 🔴 Pedido de teste ponta a ponta antes de abrir
113. 🟠 Treinamento das lojas no fluxo do site
114. 🟠 Canal de atendimento com resposta definida
115. 🟡 Runbook: o que fazer quando o gateway cai

---

## Por onde eu começaria

**Semana 1 (código, rápido):** 1–6, 16–21, 100–101.
**Em paralelo, desde já (gente):** 31–39 — é o que consome tempo humano.
**Semana 2:** 22–24 (config de frete), 71–75 (pedido→loja), 51–54.
**Antes de anunciar:** 92–99 e 102–105.
