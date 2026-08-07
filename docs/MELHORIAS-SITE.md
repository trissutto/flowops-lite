# Site novo — lista de melhorias

Levantada em **06/08/2026**, lendo o código e rodando auditoria, logo depois de
fechar 97 dos 115 itens de `LANCAMENTO-SITE.md`.

**Aquela lista era "o que impede de abrir". Esta é "o que impede de vender" —
e o que constrange se alguém olhar de perto.**

Cada item diz o que foi **MEDIDO** (rodei e contei) e o que é **AVALIAÇÃO**
(julgamento meu, discutível). Não misturo os dois.

🔴 constrange ou perde venda hoje · 🟠 segura conversão · 🟡 melhora margem

---

## A. Links que apontam pro vazio (🔴) — **MEDIDO: 64**

Rodei uma auditoria que extrai todo `href` interno do código e compara com as
rotas que existem de fato. **Existem 21 rotas. O código aponta pra 64 endereços
que não existem.**

Achei três desses por acidente hoje (`/novidades` e os dois links legais do
rodapé) e corrigi. Não são exceção — são amostra.

> **Por que isso é pior do que parece:** 404 não é só uma página feia. É a
> cliente clicando em "Guia de tamanhos" na dúvida se serve nela — a dúvida nº 1
> da cliente plus size — e batendo num muro. O Google também rebaixa domínio que
> serve 404 em link interno de menu.

### A1 — No caminho da compra (corrigir antes de qualquer coisa)

1. 🔴 **`/conta/entrar`** — o botão de LOGIN do cabeçalho. Também usado no
   checkout (`IdentificationStep`) e no rodapé. **O botão de entrar na conta,
   no topo de todas as páginas, dá 404.**
2. 🔴 **`/institucional/termos`** — linkado no `ReviewCard`, ou seja, **ao lado
   do botão "Finalizar compra"**, e no layout do checkout. Corrigi o rodapé
   hoje e passei batido nestes dois.
3. 🔴 **`/institucional/privacidade`** — mesmo caso, no layout do checkout.
4. 🔴 **`/tamanhos/guia`** — o "Guia de tamanhos" da PDP (`BuyBox`). A pergunta
   que mais trava a compra, respondida com 404.

### A2 — O menu inteiro é decorativo

5. 🔴 **Os eixos do menu não têm rota**: `/looks` (+7 subrotas), `/tecidos` (+7),
   `/tamanhos` (+8), `/ocasioes` (+7), `/outlet`, `/categoria`,
   `/novidades/mais-vendidos`, `/novidades/ultimas-pecas`,
   `/novidades/lancamentos`, `/novidades/colecao-atual`, `/novidades/reposicoes`.
   O menu de 7 eixos é a espinha da navegação por INTENÇÃO — e hoje quase todo
   clique nele cai em nada.
6. 🟠 **`/institucional/frete` e `/institucional/pagamento`** — a tarja do topo,
   que gira em todas as páginas.
7. 🟠 **`/lojas/comprar-e-retirar`** — vendido como diferencial em quatro
   lugares, inclusive num banner dentro da grade de categoria.
8. 🟡 `/blog` (+3 posts), `/institucional/sobre`, `/faq`,
   `/trabalhe-conosco`, `/lojas/eventos`, `/colecoes/*`, `/modelagem/*`.

### A3 — A causa, não os sintomas

9. 🔴 **Nada impede um link morto de nascer.** Os 64 passaram por build, por
   type-check e por deploy. Precisa de um teste que rode a auditoria e falhe o
   build — senão a lista volta a crescer na semana que vem.
   *O script já existe; falta virar teste.*

---

## B. Conteúdo falso no ar (🔴)

10. 🔴 **A home mostra produtos que não existem.** `newArrivals` e `bestSellers`
    vêm de `data/content.ts` — catálogo de mentira com fotos de banco de
    imagem. A vitrine principal do site **não está ligada ao estoque**. A
    cliente clica num "mais vendido" e vai pra uma peça que a loja não tem.
11. 🔴 **Depoimentos inventados.** `data/content.ts` tem avaliações assinadas
    por "Cliente Lurds", com **altura, peso e tamanho comprado fictícios**, e
    nota 5 estrelas. Isso não é placeholder de layout: está no ar, com cara de
    prova social real.
    ⚠️ **É risco jurídico, não só ético** — publicidade enganosa pelo CDC, e o
    dado de corpo inventado é exatamente o que faz a cliente plus size confiar.
    **Tirar do ar hoje**, e voltar só com depoimento de cliente de verdade.
12. 🔴 **22 fotos de banco de imagem** (`images.unsplash.com`) em
    `content.ts`, `navigation.ts` e `lojas.json`. Modelo que não é cliente da
    Lurd's, em roupa que a Lurd's não vende.
13. 🟠 **Estrela de avaliação na PDP.** O componente existe e o catálogo real
    nunca preenche — então some. Melhor assim do que inventar; mas ou se
    constrói avaliação de verdade (a base de pedidos já permite pedir), ou se
    remove o componente.

---

## C. Conversão (🟠)

14. 🟠 **A busca não sabe o que a loja tem.** O `IntentInterpreter` traduz
    intenção ("esconder barriga" → modelagem), mas a modelagem só existe se a
    ficha do CRM estiver preenchida. Sem cadastro, a busca inteligente devolve
    vazio — e vazio na busca é a saída mais rápida do site.
15. 🟠 **Não existe "avise-me quando voltar".** Agora que a peça esgotada
    aparece riscada (item 37), a cliente vê que existe e acabou — e não tem o
    que fazer com isso. É a lista de espera mais barata que existe, e o único
    momento em que ela dá o contato de bom grado.
16. 🟠 **Frete só depois do CEP, e o CEP só no checkout.** O simulador na PDP
    já existe (item 28), mas o CEP não é lembrado entre as telas. Ela digita de
    novo na sacola e outra vez no checkout.
17. 🟠 **Carrinho abandonado não tem nenhum resgate.** O pedido PIX não pago já
    é rastreável (`awaiting_payment` com validade de 2h) e o WhatsApp da casa já
    funciona pela Evolution. Falta ligar os dois — é a recuperação de receita
    com melhor retorno que existe num e-commerce.
18. 🟠 **A PDP não diz em qual loja tem.** O estoque é somado de todas as lojas;
    a cliente que quer provar antes de levar não sabe onde ir. O dado existe por
    loja em `wincred_estoque`.
19. 🟡 **"Compre o look" existe como bloco e não como dado.** `LookShowcase`
    monta a partir de conteúdo estático; ligar em peças reais transforma em
    ticket médio.
20. 🟡 **Nenhum e-mail transacional é da marca.** Confirmação e rastreio saem
    (ou sairão) pelo n8n; nenhum deles vende a próxima compra.

---

## D. Velocidade (🟠)

21. 🟠 **First Load JS — MEDIDO em 06/08** (rodei o build; a suspeita da
    primeira versão desta lista virou número):

    | Rota | First Load JS |
    |---|---|
    | `/` (home) | **256 kB** |
    | `/produto/[slug]` | **256 kB** |
    | `/novidades` | 253 kB |
    | `/lojas` | 245 kB |
    | resto | ~230 kB |
    | **compartilhado por todas** | **200 kB** |

    Melhor que os >300 kB registrados em julho, ainda acima do alvo de 200 kB.
    **O gargalo é o compartilhado**: 200 dos 256 kB da home entram em TODA
    página, então otimizar página a página quase não move o ponteiro.
    `framer-motion` está em 37 componentes e é o suspeito — mas isso ainda é
    *AVALIAÇÃO*: falta abrir o bundle pra confirmar quanto é dele.
22. 🟠 **Medir antes de otimizar.** Não existe número de Core Web Vitals do site
    hoje. A regra do bloco J ("medir antes e depois de cada tag") não tem linha
    de base pra comparar.
23. 🟡 **Fotos sem WebP** (item 50 da lista antiga, ainda aberto). O acervo vem
    do WooCommerce como JPEG grande; é o maior byte da PDP.

---

## E. Dados e operação (🟠)

24. 🔴 **A ficha do CRM é o gargalo de tudo.** Título, descrição, tecido,
    ocasião, modelagem, medidas e bolinha — o site inteiro depende dela, e o
    catálogo tem milhares de REFs. Sem uma **fila de trabalho** ("as 50 peças
    mais vendidas ainda sem ficha"), o preenchimento nunca converge.
25. 🟠 **Não há tela de saúde do catálogo.** Quantas REFs publicadas estão sem
    foto? Sem bolinha? Com preço divergente entre cores? Os três já são
    calculáveis — falta a tela.
26. 🟠 **REF com duas marcas continua sendo bomba-relógio.** Corrigi hoje pra
    não quebrar mais (a escolha virou determinística), mas o cadastro
    duplicado segue lá. O log já aponta quais; falta a tela pra limpar.
27. 🟡 **A altura da caixa é chute.** 1–2 peças = 3 cm, 3–5 = 6, 6+ = 10. Depois
    de ~30 postagens reais, medir e ajustar — cada centímetro errado é margem.

---

## Por onde eu começaria

**Hoje, antes de qualquer anúncio:** itens 10, 11 e 12 — tirar do ar o conteúdo
inventado. É o único grupo com risco jurídico, e é o mais rápido de resolver.

**Esta semana:** A1 inteiro (itens 1–4). São quatro rotas; duas delas ficam ao
lado do botão de pagar.

**Depois:** o item 9 (teste que quebra o build) — senão os outros 60 links
voltam sozinhos.

**Em paralelo, e é o que demora:** item 24. Enquanto a ficha não estiver
preenchida, metade desta lista não tem o que exibir.
