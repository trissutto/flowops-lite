# Campanha Leve 4, Pague 3

## Objetivo

Aumentar o número de peças por pedido e atrair compradores para o ecommerce com uma oferta simples: ao adicionar quatro produtos diferentes ao carrinho, a cliente paga somente os três de maior valor. A peça de menor valor fica grátis.

A campanha será preparada por completo, mas permanecerá desligada até aprovação dos criativos e acionamento manual pela administração.

## Regra comercial

- A promoção vale para todo o catálogo do site.
- O carrinho precisa conter quatro produtos diferentes. Cor ou tamanho diferentes da mesma variação comercial não transformam o item no quarto produto elegível.
- A unidade de menor preço entre os quatro produtos elegíveis fica grátis.
- Produtos que já possuem preço promocional participam usando o preço atual.
- Enquanto a promoção estiver aplicada, o pedido não acumula cupom, desconto adicional de Pix ou outra promoção automática.
- A promoção não possui data final obrigatória.
- Uma chave administrativa única liga ou desliga a campanha.
- Desligar a chave interrompe novos descontos e remove a comunicação promocional.
- Pedidos já concluídos preservam valores e informações da promoção aplicada.

## Estado e controle administrativo

A configuração deve ter, no mínimo:

- `enabled`: chave principal, inicialmente `false`;
- `campaignCode`: identificador estável da campanha;
- `headline`: texto principal exibido no site;
- `startsAt` e `endsAt`: opcionais, sem exigência de preenchimento;
- `updatedAt` e `updatedBy`: auditoria da última alteração.

O painel administrativo deve exibir claramente se a promoção está desligada, ativa ou programada. A alteração da chave deve invalidar o cache público para que a home e o carrinho reflitam o novo estado rapidamente.

## Cálculo e consistência

O backend será a fonte de verdade do desconto. O frontend pode apresentar uma prévia, mas o total definitivo deve ser recalculado no servidor antes da criação e do pagamento do pedido.

Para cada conjunto elegível de quatro produtos diferentes, o backend identifica a unidade de menor preço e aplica um desconto de mesmo valor. Em carrinhos com mais de quatro produtos, a primeira versão aplicará uma gratuidade por pedido; não haverá múltiplos grupos automáticos de quatro.

O pedido deve registrar:

- código da campanha;
- produtos usados para atingir a quantidade mínima;
- item que recebeu a gratuidade;
- preço original considerado;
- valor do desconto;
- estado da configuração no momento da confirmação.

Se preço, estoque ou configuração mudar durante o checkout, o servidor recalcula o pedido e devolve uma mensagem clara antes da cobrança.

## Experiência no site

Quando a chave estiver desligada, nenhum elemento promocional será exibido e o fluxo atual permanecerá inalterado.

Quando estiver ligada:

- a faixa superior e o banner principal comunicam “Leve 4, pague 3”;
- a home oferece acesso direto aos lançamentos e ao catálogo;
- os cards podem receber um selo discreto da campanha;
- o carrinho mostra progresso de zero a quatro produtos diferentes;
- com um produto: “Escolha mais 3 produtos e ganhe a peça de menor valor”;
- com dois produtos: “Faltam 2 produtos para ganhar uma peça”;
- com três produtos: “Escolha mais 1 produto e ganhe a peça de menor valor”;
- com quatro produtos: “Você ganhou a peça de menor valor”;
- o resumo identifica o item grátis e o valor economizado;
- checkout e confirmação repetem a regra aplicada, sem exigir cupom.

Cupons e desconto adicional de Pix devem aparecer como indisponíveis enquanto a campanha estiver aplicada, com explicação curta e sem permitir uma combinação que depois seja recusada pelo servidor.

## Sistema visual

O padrão principal aprovado é editorial elegante:

- feed em proporção real 4:5, com saída final de 1080 × 1350 pixels;
- fundo marfim, texto preto e detalhes em dourado champanhe;
- fotografia de moda plus size com produtos reais do site;
- modelo e produto em destaque, sem aparência de encarte de supermercado;
- “LEVE 4, PAGUE 3” como mensagem dominante;
- “A PEÇA DE MENOR VALOR É GRÁTIS” em faixa dourada;
- “EM TODO O SITE” imediatamente visível;
- chamada principal “COMPRAR AGORA”.

O texto deve ficar em uma camada de design controlada. Fotos geradas servem como conceito; os criativos finais devem usar imagens oficiais dos lançamentos do site para não anunciar peças inexistentes.

## Lote de 30 criativos

### 18 editoriais de lançamento

Uma modelo e um lançamento real por peça. Variar categoria, cor, enquadramento e posição da composição, mantendo a identidade aprovada.

### 6 combinações de produtos

Quatro produtos reais formando uma seleção visual. A quarta peça recebe sinalização de gratuidade sem sugerir que uma referência específica será sempre grátis, pois o benefício depende do menor preço no carrinho.

### 6 criativos de recuperação

Peças voltadas a remarketing e recuperação de carrinho. Exemplos de mensagem:

- “Escolha mais uma peça e ganhe a de menor valor”;
- “Seu quarto look pode sair grátis”;
- “Complete quatro produtos e pague somente três”.

Cada criativo terá nome, objetivo, público, categoria principal, texto da arte, legenda sugerida, chamada e URL com UTM.

## Destinos e mensuração

Anúncios editoriais direcionam para o produto ou categoria correspondente. Criativos gerais direcionam para uma landing page da campanha com lançamentos e navegação por categoria.

Eventos necessários:

- impressão e clique do banner;
- visualização da landing page;
- progresso da promoção no carrinho;
- gratuidade aplicada;
- gratuidade removida após alteração do carrinho;
- início do checkout;
- compra com a campanha;
- receita, desconto, itens por pedido e margem estimada.

UTMs devem identificar campanha, conjunto, criativo e posicionamento.

## Desempenho

- A home carrega somente o banner visível inicialmente.
- Imagens adicionais usam carregamento tardio.
- Arquivos de site devem ser WebP ou AVIF responsivos e otimizados.
- O texto e a chamada do banner da home devem ser HTML sempre que possível; a imagem serve como fundo editorial.
- A chave desligada não deve adicionar JavaScript ou requisições promocionais desnecessárias ao caminho crítico.

## Proteções e falhas

- A configuração começa desligada.
- Falha na leitura pública da configuração equivale a promoção desligada.
- Falha de cálculo impede a cobrança com valor promocional incorreto e apresenta opção de tentar novamente.
- A ativação administrativa exige confirmação explícita.
- Logs registram ativação, desativação e alterações.
- O backend rejeita tentativas de aplicar cupom ou desconto Pix adicional quando a promoção estiver ativa no pedido.

## Validação

- Testes unitários para zero a quatro produtos, produtos repetidos, preços iguais e produto já promocional.
- Teste de carrinho com mais de quatro produtos garantindo apenas uma gratuidade por pedido.
- Testes de concorrência para mudança da chave durante o checkout.
- Testes de persistência do desconto em pedidos concluídos.
- Testes de bloqueio de cupom, Pix e promoções automáticas concorrentes.
- Testes visuais da home e do carrinho com a chave ligada e desligada.
- Conferência manual dos 30 criativos em 1080 × 1350, incluindo texto, referência, URL e UTM.

## Critérios de aceite

- A campanha pode ser preparada e implantada desligada.
- Uma única chave controla comunicação e elegibilidade do desconto.
- Quatro produtos diferentes concedem exatamente uma gratuidade correspondente ao menor preço.
- Nenhum desconto adicional é acumulado.
- O site explica o progresso e o benefício antes do checkout.
- Os 30 criativos usam lançamentos reais e seguem o padrão editorial aprovado.
- A ativação e a desativação não exigem novo deploy.
