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

> **Status:** 1–7, 13, 14 e 15 **FEITOS**. O bloco 1–6 saiu junto num commit só
> (mexem todos no mesmo ponto, `criarPedido`, e checkout meio validado é pior
> que nenhum).
>
> Duas decisões do dono nesta rodada: **PIX vale 2 HORAS** (não 30 min) e
> **não existe valor mínimo de pedido**.
>
> 🔴 **ACHADO NO CAMINHO (06/08): o site anunciava 5% off no Pix e cobrava o
> cheio.** Preço Pix no card, na PDP, na busca e a badge "5% off já aplicado"
> no checkout — e nenhum código abatia nada. O dono mandou **aplicar de
> verdade**: agora o desconto é calculado no servidor, aparece como linha no
> resumo e o total cobrado é o mesmo que a tela mostra.
> Desliga com `SITE_PIX_DESCONTO_PCT=0` (backend) + `NEXT_PUBLIC_PIX_DESCONTO_PCT=0` (site).

1. ✅ FEITO — `unitPrice` relido do catálogo peça a peça antes de cobrar (`CarrinhoGuard`). Preço do cliente virou só sugestão
2. ✅ FEITO — Subtotal, desconto, frete e total refeitos do zero no `reprecificar()`. O total do site virou **TETO**: se a nossa conta der mais, o pedido é recusado em vez de cobrar acima do que ela leu
3. ✅ FEITO — Cupom recalculado no backend (`CupomService` → tabela `site_cupons`, env `SITE_CUPONS_JSON` ou os 3 códigos de sempre). Limite de uso só é queimado quando o pagamento confirma
4. ✅ FEITO — Preço travado: catálogo mais caro **recusa** e manda recarregar; mais barato **cobra o menor** (nunca cobra a diferença em silêncio)
5. ✅ FEITO — Estoque conferido no fechamento, por cor+tamanho. ⚠️ Junto: a PDP não mandava a cor pro carrinho (ia colada no nome) — corrigido, senão a conferência somava as cores todas
6. ✅ FEITO — Peça despublicada durante a sessão não fecha pedido (só barra o `publicado = false` explícito: sem linha de curadoria a vitrine deixa vender, e travar aqui derrubaria venda boa)
7. ✅ FEITO (2h) — PIX: expiração de 30 min liberando a reserva
8. ✅ FEITO — Webhook idempotente. O `if (já pago)` já existia e cobria a repetição SEQUENCIAL; faltava a SIMULTÂNEA — `order.paid` e `charge.paid` chegam quase juntos, os dois liam "não pago" e passavam, gerando histórico duplicado e o evento `purchase` disparado 2× (faturamento dobrado no Meta/GA4). Agora a trava é atômica no banco (`updateMany` com `paidAt: null` no WHERE)
9. ✅ CONFERIDO — Cartão recusado apaga o Order recém-criado (`descartarPedido`; itens caem por cascade). O `PagarmePayment` com status `failed` FICA de propósito: é o registro de tentativa que a conciliação precisa enxergar
10. ✅ CONFERIDO — `mensagemRecusa()` traduz o motivo do adquirente em frase acionável (sem limite / vencido / dados errados / operadora fora), sempre oferecendo o PIX como saída. Nunca vaza código de adquirente nem stack
11. ✅ FEITO — `LojaPagamentoReconcileService` (cron de 1 min). ⚠️ O buraco era maior do que parecia: existia reconcile pro link das lojas, mas ele gravava `pagarme_payment = paid` e **não chamava o `confirmarPagamento` do pedido** — o pagamento constava pago no Flow e o pedido seguia aguardando pra sempre. Agora: 1º olha o banco local (de graça), depois pergunta ao gateway com throttle de 3 min por pedido, janela de 72h, teto de 40/ciclo. Kill-switch `LOJA_PAGAMENTO_RECONCILE=0`
12. ✅ FEITO — Conciliação diária às 07h05 (`LOJA_CONCILIACAO=0` desliga) + `GET /admin/loja/conciliacao?de=&ate=` sob demanda. Aponta três divergências: **pago no gateway e não no Flow** (a pior — tem dinheiro na conta e pedido parado), **pago no Flow sem cobrança** e **valor divergente**. Divergência sai como WARN pra aparecer em qualquer filtro de log
13. ✅ FEITO — Validação de e-mail de verdade (hoje é `includes('@')`, "a@b" passa e a confirmação não chega)
14. ✅ FEITO — Remover o fallback de telefone `13 996218277` do checkout (caminho morto hoje, mina amanhã)
15. ✅ SEM VALOR MINIMO (dono) — Valor mínimo de pedido, se houver

## B. Frete (🔴/🟠) · **REGRAS DEFINIDAS PELO DONO 04/08**

> **O preço que a cliente vê é TABELA PROMOCIONAL, não a cotação.**
>
> | Destino | Serviço | Preço |
> |---|---|---|
> | SP | SEDEX | **R$ 9,99** |
> | RJ · MG · PR · SC · RS | PAC | **R$ 19,99** |
> | RJ · MG · PR · SC · RS | SEDEX (opcional) | **cotação do nosso contrato** |
> | Demais estados | PAC e SEDEX | **cotação do nosso contrato** (dono, 06/08) |
>
> - Nesses 5 estados a cliente **escolhe**: PAC promocional a R$ 19,99 ou SEDEX
>   pelo preço real do contrato. Em SP o SEDEX já é o promocional.
> - **Retirada em loja liberada perto das lojas** — e **sem exigir** que a peça
>   esteja naquela loja: se não tiver, vem de outra (item 26).
> - **Prazo = prazo do transportador + 2 dias de separação**, configurável.
> - **Origem da cotação é SEMPRE a MATRIZ (11746-692)**, nunca a loja que
>   despacha.
>
> ⚠️ Consequência: o endpoint de cotação (item 16) **continua necessário** —
> ele é a fonte do SEDEX opcional e do simulador. O que muda é que ele deixa de
> ser o preço padrão.

16. ✅ FEITO — Endpoint público de cotação (`POST /api/public/loja/frete`). Deixou de ser proxy da cotação crua e virou a **FONTE ÚNICA** do frete: tabela promocional + cotação do contrato + régua do frete grátis + dias de separação, tudo pronto pro site desenhar
17. ✅ FEITO — A tabela promocional virou **cadastro** (`site_frete_promo`), não código. **DEMAIS ESTADOS = cotação real do contrato** (decisão do dono, 06/08 — o buraco que a lista deixava "a definir"). A tabela do `frete.ts` do site foi rebaixada a paraquedas
18. ✅ FEITO — Peso e caixa do dono: **250 g/peça**, **28 larg × 40 compr**, altura por faixa
19. ✅ FEITO — Origem = **MATRIZ, CEP 11746-692** (decisão do dono; uma origem só mantém a cotação estável). ⚠️ CONFERIR se `CORREIOS_CEP_ORIGEM` no Railway está com esse CEP
20. ✅ FEITO — Correios fora do ar cai na estimativa interna, marcada `estimado`, e o site tem MAIS um paraquedas (tabela local) se o backend também cair. E a promocional — a maior parte dos pedidos — nem depende da cotação pra existir
21. ✅ FEITO — Cache por CEP+peso+altura, 20 min, teto de 500 entradas
22. ✅ FEITO — Config editável (`site_frete_config`): liga/desliga, mínimo, janela de datas e recorte de UF. **Régua nova: R$ 499,90** (dono, 06/08 — era 399,90 chumbado). Grátis zera sempre a econômica mais barata, nunca o expresso
23. ✅ FEITO — Cada linha promocional tem serviço, UFs, preço, prazo opcional e janela de início/fim
24. ✅ FEITO — Tela `/retaguarda/loja-frete` (aba Frete + aba Cupons), no menu da retaguarda. Desligar não apaga: conferência de 6 meses atrás precisa achar a explicação do preço
25. ✅ FEITO — Prazo = transportador + **2 dias de separação**, configurável na tela. O "· frete estimado" da tela agora só aparece quando É estimado — chamar prazo oficial de estimativa treina a cliente a não confiar
26. ✅ FEITO — Retirada NÃO exige a peça na loja: quem resolve a origem é o roteamento da matriz, igual a qualquer pedido dividido
27. ✅ FEITO — Prazo e instruções da retirada vêm da config e aparecem **na hora da escolha**, junto com o endereço da loja — não numa página de ajuda que ninguém abre
28. ✅ FEITO — Simulador na PDP (`SimuladorFrete`). Cota 1 peça de propósito: é o PIOR caso por peça, então a cliente nunca é surpreendida pra cima no checkout. Substituiu o texto fixo "frete grátis acima de R$ 399", que envelheceu junto com a régua
29. ✅ FEITO — Embalagem por FAIXA de altura (regra 1, dono 04/08): **1–2 peças = 3 cm · 3–5 = 6 cm · 6+ = 10 cm**. Roupa comprime, não empilha como tijolo. É chute educado até existir dado — depois de ~30 postagens reais, medir a altura de verdade e ajustar
30. ~~Rota própria Itanhaém/Praia Grande/Santos como opção de entrega~~ — **REMOVIDO (04/08)**. Era a regra do REALINHAMENTO entre lojas (carro da rede levando mercadoria de loja pra loja), não entrega de pedido de cliente. Vazou do contexto do dia pra esta lista. Se um dia virar entrega própria pro cliente naquelas cidades, é item novo e com desenho próprio

## C. Produto e vitrine (🔴 — o gargalo real) · **REVISADO PELO DONO 04/08**

> ✅ **31 e 32 REVISADOS 06/08.** Achei os dois pela leitura do código — e eles
> compartilham a mesma raiz: **REF reciclada entre fornecedores** (a mesma REF
> com DUAS marcas). Quem GRAVA a bolinha escolhia a marca de um jeito, quem LÊ
> escolhia de outro, e **nenhum dos dois era determinístico**.
>
> ⚠️ Sem acesso ao log de produção não dá pra jurar que era a ÚNICA causa. Por
> isso a rodada também **quebrou o silêncio**: todo caminho que antes falhava
> calado agora diz o motivo — na tela e no log. Se sobrar algum caso, ele vai
> se identificar em vez de virar adivinhação.

31. ✅ REVISADO — **Três defeitos no importador**, todos silenciosos:
    - **`WC_URL` era pré-requisito pra tudo.** Existem DUAS fontes; só a REST precisa dessa env — o MySQL do WordPress (a que funciona, e a que o PDV usa há meses) não. Sem a env, o botão recusava a REF inteira mesmo com a fonte boa disponível, e a mensagem apontava pro lugar errado
    - **O filtro de REF não era aplicado no caminho do MySQL.** O casamento é `SKU LIKE 'REF%'` (peneira grossa de propósito): pedindo `VMS-223` vinha `VMS-2231` junto, e o casamento de cor depois ainda achava uma cor válida — **foto de outra peça, na cor certa, sem erro nenhum**
    - **Produto sem imagem não dizia nada.** Se a opção `siteurl` do WordPress estiver vazia, TODA foto vira URL nula e a tela só mostrava "nenhuma cor com foto". Agora avisa onde olhar
32. ✅ REVISADO — **A bolinha era pintada numa ficha que o site nunca abre.** `marcaDaFamilia` pegava `[0]` de um `SELECT` **sem `ORDER BY`**; o catálogo escolhia a marca por outro caminho, também sem ordem. Quando davam marcas diferentes, a varredura pintava numa ficha e a página lia outra. E pior: a varredura **não olha marca**, então dava a peça como pintada e **parava de tentar** — "rodou, o log diz que pintou, e a bolinha não aparece". Agora a marca é determinística (a com mais cadastros; empate alfabético) e o catálogo, em vez de devolver `undefined` quando nenhuma ficha casa (**peça sem bolinha, sem título e sem vídeo, em silêncio**), usa a ficha mais preenchida e registra que houve desempate — porque o conserto de verdade é limpar o cadastro
> 🔴 **A LISTAGEM NUNCA RECEBIA A FICHA** (achado e corrigido 06/08). O
> `complementos()` sempre carregou as fichas, mas o `listar()` as **descartava**
> — só a PDP passava a ficha adiante. Resultado na vitrine: **card sem bolinha
> de cor, sem título comercial e sem os atributos que os filtros do menu usam**.
> A ficha do CRM é a fonte do conteúdo desde 03/08 e metade do site não estava
> lendo. Este era o elo CRM→vitrine que faltava, e destrava 33, 34, 44 e 46 de
> uma vez.

33. ✅ FEITO — Título vem da ficha (`nomeCurto`) → cadastro do site → descrição crua do ERP, nessa ordem. A crua é último recurso: é texto de etiqueta ("BLUSA FEM MC VISCOSE"), não título de vitrine
34. ✅ FEITO — Descrição de venda da ficha (`descricao`), com tecido, coleção, ocasiões, modelagens e elasticidade expostos separados
35. ⬜ APROVADO — Status de publicação decidido peça a peça (`statusPublicacao` existe por cor; falta virar o gate de publicação)
36. ⬜ APROVADO — Estoque por SKU somando **TODAS as lojas ATIVAS** (criar config de quais lojas entram)
37. ✅ FEITO — Esgotado **aparece riscado**, com "Esgotado por enquanto". O padrão do backend era `soDisponivel ?? true` — ou seja, **esconder por omissão**. Agora só some com `?disponivel=1`, e a ordenação joga o esgotado pro fim em QUALQUER ordem (senão "menor preço" encheria a primeira tela de peça que não vende)
38. ✅ FEITO no bloco A — o `CarrinhoGuard` relê o preço do catálogo antes de cobrar
39. ✅ FEITO — Peça sem NENHUMA foto sai da vitrine (e o log diz quais). A PDP continua abrindo por link direto: é o que permite conferir antes de publicar
40. ✅ JÁ EXISTIA — `product_photos.ordem` define a capa; a leitura já ordena por `cor, ordem, createdAt`
41. ⬜ APROVADO — Proporção padronizada das fotos da PDP
42. ✅ FEITO (leitura) — a grade de medidas chega ao site: template da modelagem + **ajuste da peça sobrepondo LINHA A LINHA** (trocar o objeto inteiro obrigaria a redigitar a grade toda pra mudar um busto). O cadastro já existia; faltava o `include` — a peça chegava sem medida nenhuma
43. ⬜ APROVADO — Categorias e subcategorias ligadas ao CRM
44. ✅ FEITO — Filtros de **tecido, ocasião e coleção** (da ficha) somados a tamanho, cor, marca, modelagem e preço
45. ⬜ APROVADO — Produtos relacionados / "veja similares" (**JÁ EXISTE** o bloco, falta a fonte)
46. ✅ FEITO — Cor amigável: "VD MUSGO ESC" → "Verde Musgo Escuro". Tradução **conservadora** (só as abreviações que a casa usa; palavra desconhecida passa intacta — inventar nome de cor é pior que mostrar a técnica). Título da ficha ganha da tradução: escolha humana vence heurística
47. ✅ JÁ EXISTIA — `youtubeUrl` por cor já sai no payload da peça
48. ✅ JÁ EXISTIA — badges de novidade, promoção e "últimas peças" (≤3 no estoque)
49. ✅ FEITO junto com 42 — a mesma grade alimenta o guia de tamanhos
50. ⬜ APROVADO — WebP e compressão sem perder qualidade

## D. Carrinho e checkout (🔴/🟠) · **APROVADO PELO DONO 04/08**

> **Status 06/08:** 52–59, 61 e 62 fechados (a maioria já vinha do bloco A).
> **51 e 60 seguem abertos** — os dois dependem da sessão da cliente, que é o
> bloco E; fazer aqui seria construir a mesma plumbing duas vezes.

51. ⬜ ABERTO — Carrinho persistente por cliente, não só no navegador (**depende do bloco E**: sem sessão não há a quem amarrar o carrinho)
52. ✅ CONFERIDO — ViaCEP preenche rua/bairro/cidade/UF e o foco pula pro NÚMERO (o único campo que só a cliente sabe); complemento em campo próprio dos dois lados. Erro do ViaCEP é silencioso de propósito: o serviço é cortesia e os campos continuam editáveis
53. ✅ CONFERIDO — Máscara + validação REAL de CPF (dígito verificador, não só 11 números) e de celular com DDD
54. ✅ FEITO no bloco A — o guard responde com a frase pronta: "Sobrou só 1 unidade de X no tamanho 46. Ajuste a quantidade pra continuar"
55. ✅ FEITO nos blocos A e B — tabela `site_cupons` + tela `/retaguarda/loja-frete` (aba Cupons): validade, mínimo, primeira compra (checada por CPF), categoria e limite de usos
56. ✅ FEITO — cupom `tipo='shipping'` zera o frete **econômico** e não mexe no subtotal; quem escolheu expresso paga expresso
57. ✅ FEITO — a barra lê a config via `GET /api/loja/config` (novo, sem exigir CEP). Antes lia a constante do código: o dia em que o mínimo mudasse na retaguarda, ela seguiria **prometendo frete grátis que o checkout não daria**. Frete grátis desligado agora esconde a barra em vez de travar em "faltam R$ 499,90"
58. ✅ FEITO no bloco A — resumo com subtotal, frete, cupom e **desconto do Pix como linha própria**, batendo com o total que o servidor cobra
59. ✅ CONFERIDO — o checkout pede só nome, e-mail, CPF e telefone; não existe login obrigatório
60. ⬜ ABERTO — Salvar endereço pra próxima compra (**depende do bloco E**: `/conta/enderecos` já existe no backend, falta a sessão no checkout pra oferecer "salvar")
61. ✅ CONFERIDO — "Restam 2 nesta cor" sai do estoque REAL da grade daquela cor, e o carrinho avisa "Restam só N neste tamanho". Nada inventado
62. ✅ CONFERIDO — Quick add na listagem, com escolha de cor e tamanho no próprio card

## E. Conta da cliente (🟠) · **APROVADO PELO DONO 04/08**

> **Padrão do bloco (06/08):** quase tudo já existia no backend `customers/app`
> — login, endereços, pedidos, cashback, senha. **O que faltava era a tela.**
> Recurso que a cliente não vê não muda comportamento nenhum.

63. ✅ CONFERIDO — Login por CPF no `/customers/app`, cruzando com o CRM. Quem já comprou na loja física entra com o mesmo CPF e vê o histórico junto
64. ✅ FEITO — Status **traduzido pra cliente** (pago / preparando / a caminho / entregue) + rastreio. Antes a tela recebia o estado CRU da operação: `awaiting_payment`, `routing` e `separating` chegavam assim na tela, porque o único mapa de tradução cobria só o vocabulário do WooCommerce
65. ✅ FEITO — Segunda via do PIX em "Meus pedidos". Sem isso, a cliente que fechou o pedido e perdeu a aba **não tinha como pagar**: o caminho era o WhatsApp, em horário comercial, se alguém respondesse — enquanto o código vencia sozinho. Só aparece enquanto o código VALE (copia-e-cola vencido é pior que nenhum: o banco recusa e ela acha que a loja errou)
66. ✅ CONFERIDO — `/conta/enderecos` com o CRUD do backend
67. ✅ FEITO — `/conta/dados`: o que a loja tem (CPF **mascarado até pra dona**, porque a tela fica aberta em ônibus e em loja) + os canais que ela autoriza. Cada clique vira **linha nova** em `customer_consents`, com data e IP — sobrescrever apagaria a prova de quando ela autorizou. Grava em TODOS os cadastros do CPF: registrar num só faria a outra loja continuar mandando WhatsApp depois do "não"
68. ✅ FEITO — `/conta/cashback` com saldo, extrato e **a expiração em destaque**. O saldo já era creditado a cada compra e nunca teve tela: cashback que a cliente não vê é custo sem retorno, e descobrir que venceu depois transforma benefício em reclamação
69. ✅ FEITO — `/conta/favoritos`. O coração já existia no card e o store já guardava; não havia onde VER. O store guarda só a REF de propósito — a peça é relida com o preço e o estoque de HOJE, e REF que sumiu do catálogo sai da lista em vez de virar card quebrado
70. ✅ CONFERIDO — "Esqueci minha senha" com código pelo WhatsApp, na mesma tela do login

## F. Pedido → loja → entrega (🔴) · **APROVADO PELO DONO 04/08**

> **73 e 74 NÃO são pra construir do zero.** O dono confirmou: o aviso por
> WhatsApp já existe no WooCommerce — são os workflows do n8n `Pedido Pago` e
> `Código de rastreio`, no n8n em `auto.lurds.com.br`. O trabalho é **reapontar
> o gatilho** pro pedido do site (`Order` com `source='ecommerce'`) em vez do
> webhook do WooCommerce — não reescrever. Vale o e-mail junto.
>
> **Status 06/08:** 75, 76 e a metade visível do 77 feitos. **71, 72, 78 e 79
> não foram tocados de propósito** — a lista diz "JÁ EXISTE" e mexer no
> roteamento/etiqueta/NF-e sem pedido real passando é risco sem retorno. O que
> falta neles é o **teste ponta a ponta** do item 112, com pedido de verdade.
> **73 e 74 são configuração no n8n**, não código nosso.

71. ⬜ APROVADO — Pedido do site cair na fila da loja certa — roteamento **JÁ EXISTE**
72. ⬜ APROVADO — Etiqueta e NF-e do pedido do site — **JÁ EXISTE** em pick-orders
73. ⬜ APROVADO — E-mail de confirmação **+ WhatsApp** — o WhatsApp já roda no WooCommerce (workflow n8n **"Pedido Pago"**); reapontar o gatilho pro pedido do site
74. ⬜ APROVADO — Aviso de "pedido enviado" com rastreio, **e-mail + WhatsApp** — já roda no WooCommerce (workflow n8n **"Código de rastreio"**); reapontar
75. ✅ FEITO — Cron de hora em hora + `GET /admin/loja/parados?horas=4`. É o alerta mais difícil de perceber sem ele: o pedido pagou, virou `processing` e ficou na fila — **status válido, log limpo, nenhum erro em lugar nenhum** — e a cliente esperando. Não conserta de propósito (roteamento é decisão da matriz, e cron escolhendo loja sozinho é pior que pedido parado); ele GRITA, que é o que faltava pro responsável do item 111 ter o que olhar. Janela de 7 dias pra não repetir backlog eternamente e virar alarme que ninguém lê. `LOJA_ALERTA_PARADO=0` desliga
76. ✅ FEITO — `/pedido/<id>` é a URL pública e compartilhável. A tela já existia, mas só em `/checkout/confirmacao/<id>` — uma URL que diz "checkout" e "confirmação" pra quem só quer saber onde está a peça, e que ninguém guarda. Redireciona em vez de duplicar a tela: uma cópia envelheceria em semanas e as duas passariam a mostrar coisas diferentes do mesmo pedido
77. 🔶 PARCIAL — O código de rastreio agora **sai no GET público do pedido**, com link direto pros Correios (colar o código no site deles é o passo em que a cliente desiste e liga). Falta o `LINKETRACK_TOKEN` pra atualização automática do status de entrega
78. ⬜ APROVADO — Split entre lojas **JÁ EXISTE na retaguarda** — falta só testar ponta a ponta com pedido do site novo
79. ⬜ APROVADO — Corrigir endereço do pedido antes de postar — **JÁ EXISTE** (04/08)
80. ⬜ APROVADO — Aviso de entrega concluída

## G. Trocas (🟠) · **APROVADO PELO DONO 04/08**

81. ⬜ APROVADO — Política de trocas publicada
82. ⬜ APROVADO — Portal de trocas ligado ao pedido do site (**JÁ EXISTE** pro site antigo)
83. ⬜ APROVADO — Prazo de arrependimento de 7 dias
84. ⬜ APROVADO — Etiqueta de devolução
85. ⬜ APROVADO — Vale-troca / crédito na conta

## H. Conteudo (🟠) · APROVADO PELO DONO 04/08

86. ⬜ APROVADO — Banners editáveis sem deploy — desenhado, não construído
87. ⬜ APROVADO — Tela de rascunho com preview ao lado — desenhada, não construída
88. ⬜ APROVADO — Vitrines curadas na home
89. ⬜ APROVADO — Menu dos 7 eixos populado (estrutura **JÁ EXISTE**)
90. ⬜ APROVADO — Nossas Lojas (**JÁ EXISTE**) e Troca Fácil (**JÁ EXISTE**)
91. ⬜ APROVADO — Landing de campanha = PAGINA TEMATICA com URL propria (ex.: /natal, /dia-das-maes, /black-friday): banner, texto e uma selecao de pecas, ligada e desligada sem mexer no site. E pra onde o anuncio aponta.

## I. SEO e velocidade (🟠) · APROVADO PELO DONO 04/08

92. ⬜ APROVADO — Título e meta description por produto e categoria
93. ⬜ APROVADO — Slug estável (URL que não muda)
94. ⬜ APROVADO — Sitemap.xml e robots.txt
95. ⬜ APROVADO — Dados estruturados de produto
96. ⬜ APROVADO — Open Graph pra WhatsApp e Instagram — EXPLICADO: Open Graph = o CARTAO que aparece quando alguem cola o link do produto no WhatsApp ou no Instagram: foto, nome e preco em vez de URL crua. Sem isso, link compartilhado vira texto sem graca e perde clique.
97. ⬜ APROVADO — Redirect 301 das URLs do site antigo
98. ⬜ APROVADO — Core Web Vitals na PDP e na listagem
99. ⬜ APROVADO — Canonical em filtro e paginação

## J. Rastreamento (🔴/🟠) · APROVADO PELO DONO 04/08

> ⚠️ REGRA DO DONO: SEM PESAR O SITE. Tag so carrega depois do conteudo,
> nunca bloqueando a pagina; Meta pela API de Conversoes (servidor) em vez de
> mais script no navegador; e medir o Core Web Vitals ANTES e DEPOIS de cada
> tag entrar. Se pesar, sai.

100. ⬜ APROVADO — GTM em todas as páginas
101. ⬜ APROVADO — Evento de compra com valor e itens (sem isso não há ROI de anúncio)
102. ⬜ APROVADO — Meta Pixel + API de Conversões (server-side)
103. ⬜ APROVADO — GA4 com e-commerce
104. ⬜ APROVADO — Eventos de ver produto, adicionar ao carrinho, iniciar checkout
105. ⬜ APROVADO — Consentimento de cookies antes da tag

## K. Seguranca e LGPD (🔴/🟠) · APROVADO PELO DONO 04/08

106. ⬜ APROVADO — Rate-limit no checkout e no login — EXPLICADO: Rate-limit = teto de tentativas por minuto. No login impede alguem testar mil senhas; no checkout impede um robo (ou um retry em loop) abrir centenas de pedidos e cobrancas. O endpoint de pedido JA TEM; falta o login e o de frete.
107. ⬜ APROVADO — Cookie de sessão httpOnly (**JÁ EXISTE** no padrão adotado)
108. ⬜ APROVADO — Política de privacidade e termos publicados
109. ⬜ APROVADO — Consentimento LGPD gravado no CRM
110. ⬜ APROVADO — Exclusão de conta e exportação de dados — EXPLICADO: Exigencia da LGPD: a cliente pode pedir pra APAGAR a conta dela e pode pedir uma COPIA dos dados que temos. Precisa existir o caminho — nem que seja um botao que abre chamado pra alguem executar.

## L. Operacao (🔴/🟠) · APROVADO PELO DONO 04/08

111. ⬜ APROVADO — Responsável diário por pedido travado — EXPLICADO: Nao e software, e GENTE: uma pessoa nomeada pra olhar todo dia se algum pedido pago nao andou. Sistema avisa (item 75), mas alguem tem que ler o aviso — senao o pedido dorme e a cliente cobra.
112. ⬜ APROVADO — Pedido de teste ponta a ponta antes de abrir
113. ⬜ APROVADO — Treinamento das lojas no fluxo do site
114. ⬜ APROVADO — Canal de atendimento com resposta definida
115. ⬜ APROVADO — Runbook: o que fazer quando o gateway cai

---

## Por onde eu começaria

**Semana 1 (código, rápido):** 1–6, 16–21, 100–101.
**Em paralelo, desde já (gente):** 31–39 — é o que consome tempo humano.
**Semana 2:** 22–24 (config de frete), 71–75 (pedido→loja), 51–54.
**Antes de anunciar:** 92–99 e 102–105.

---

## COMO TRABALHAR NESTA LISTA (instrucao do dono, 04/08)

> **Nao parar.** Se um item precisar de decisao do dono, MARCAR como pendente,
> registrar a pergunta aqui embaixo e PASSAR PRO PROXIMO. As pendentes sao
> resolvidas em bloco quando ele voltar.

### Ordem de execucao sem depender de ninguem

1. **Bloco A, itens 1-6** — revalidacao no servidor. Vao JUNTOS num commit:
   mexem no mesmo ponto (criarPedido) e checkout meio validado e pior que
   nenhum. Nao precisa de decisao.
2. **Itens 31 e 32** — os BUGS de foto e bolinha. Medir antes de mexer: pegar
   uma REF que deveria ter foto, seguir WordPress -> R2 -> ficha -> bolinha e
   achar onde para. NAO chutar.
3. **Item 17** — tabela promocional de frete no site (SP SEDEX 9,99 / RJ MG PR
   SC RS PAC 19,99 / SEDEX opcional pela cotacao). Regras ja definidas.
4. **Itens 20, 21** — fallback e cache da cotacao.
5. **Itens 92-99** — SEO. Nenhum precisa de decisao.
6. **Itens 100-105** — rastreamento, respeitando SEM PESAR O SITE.
7. **Item 106** — rate-limit no login e no frete.

### Regras que valem sempre

-  no backend (nest build),  no frontend, antes de
  cada commit.
- Commit por item ou bloco fechado, com o PORQUE no corpo.
- Branch + push + PR. Deploy e passo manual do dono.
- Quando o conserto depender de dado que so existe em producao, DIZER ANTES e
  entregar junto o jeito de ver (endpoint de diagnostico, log, contador).

### Pendentes de decisao do dono

| # | Pergunta |
|---|---|
| B | Frete pros estados FORA de SP/RJ/MG/PR/SC/RS — qual regra? Hoje sem definicao |
| 36 | Quais lojas entram na config de estoque do site (todas as ativas = quais?) |
| 42 | As medidas oficiais por modelagem (o dono precisa fornecer) |
| 29 | Revisar a faixa de altura depois de ~30 postagens reais |

### Fora do meu alcance (so o dono faz)

- Merge dos PRs e deploy.
- Conferir  = 11746692 no Railway (o valor fica mascarado
  pra mim).
