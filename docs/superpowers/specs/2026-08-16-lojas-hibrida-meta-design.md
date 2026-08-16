# Página `/lojas` híbrida para campanhas da Meta

## Objetivo

Transformar `/lojas` em uma página de dupla conversão: continuar atendendo quem procura endereço, telefone, Instagram ou rota para uma unidade física e, ao mesmo tempo, conduzir visitantes com intenção de compra ao catálogo online.

A solução deve preservar a promessa dos anúncios direcionados às lojas. A compra online aparece como alternativa natural, sem substituir nem esconder as informações das unidades.

## Público e origem

- A página continua disponível para tráfego orgânico e navegação interna.
- O tráfego pago é reconhecido por `utm_source=meta`.
- A URL final dos anúncios permanece `/lojas`; os parâmetros são adicionados pelo Gerenciador de Anúncios.
- Parâmetros esperados: `utm_source`, `utm_medium`, `utm_campaign`, `utm_id`, `utm_term`, `utm_content` e `utm_adset`.

## Experiência proposta

### Hero

O hero mantém fotografia, mensagem e prioridade visual para lojas físicas. Os CTAs passam a ser:

1. **Encontrar minha loja**: rola até a busca/localização das unidades.
2. **Comprar online**: abre `/novidades` preservando os parâmetros de campanha.

O botão de geolocalização continua disponível na área de busca. Ele não precisa competir com os dois caminhos principais no hero.

### Seção de compra online

A seção é renderizada logo depois da área de busca e da lista de lojas, independentemente de a visitante ter selecionado uma unidade. Assim, ela aparece no fluxo natural após as informações procuradas no anúncio:

> **Prefere receber em casa?**
>
> Os mesmos lançamentos das lojas também estão disponíveis online, com entrega para todo o Brasil.

A seção exibe de quatro a seis produtos atuais de `/novidades`. Cada item contém:

- foto otimizada;
- nome curto e referência;
- preço;
- cores disponíveis, quando houver;
- link **Ver peça**.

Ao final, o CTA **Ver todas as novidades** leva para `/novidades`. A seção deve usar a fonte de catálogo já adotada pelo ecommerce e possuir fallback para um CTA simples caso os produtos não possam ser carregados.

### Faixa móvel para campanhas

Quando `utm_source=meta`, uma faixa fixa aparece somente no celular.

Estado inicial:

- texto: **Compre também pelo site**;
- ação: **Ver novidades**.

Depois de a visitante escolher uma unidade:

- texto: **Lurds [unidade] selecionada**;
- ações: **Como chegar** e **Comprar online**.

A faixa não pode cobrir consentimento de cookies, atendimento por WhatsApp ou controles essenciais. Ela desaparece ao sair de `/lojas` e não é exibida para tráfego sem a UTM da Meta.

### Tráfego orgânico

Visitantes sem `utm_source=meta` veem os dois CTAs no hero e a seção de novidades. A faixa fixa não aparece, mantendo a experiência mais discreta.

## Preservação de campanha

Os links internos de compra originados na página devem carregar os parâmetros UTM válidos para `/novidades` e páginas de produto. Não serão propagados parâmetros desconhecidos ou dados pessoais.

Uma função isolada deve:

1. ler apenas a lista autorizada de parâmetros;
2. montar a URL interna de destino;
3. impedir protocolos ou domínios externos;
4. evitar parâmetros duplicados.

O rastreamento de sessão já existente continua sendo a fonte principal de atribuição. A propagação explícita funciona como proteção para ferramentas que dependam da URL.

## Eventos e atribuição

Adicionar eventos sem substituir os eventos comerciais já existentes:

- `stores_online_cta_click`: clique em Comprar online ou Ver novidades;
- `stores_product_click`: clique em produto exibido na seção;
- `store_locator`: seleção, localização ou rota para uma unidade, já existente quando aplicável.

Propriedades mínimas:

- `source_position`: `hero`, `campaign_bar`, `products_section` ou `selected_store_bar`;
- `store_unit`: unidade selecionada, quando existir;
- `product_ref`: referência, apenas em clique de produto;
- parâmetros de atribuição disponíveis na sessão.

Os eventos comerciais `view_item`, `add_to_cart`, `begin_checkout` e `purchase` permanecem como estão. A análise deve permitir relacioná-los à sessão iniciada em `/lojas` e às UTMs da campanha.

## Componentes e responsabilidades

- `Hero`: apresenta os dois caminhos principais e emite a intenção escolhida.
- `OnlineShoppingSection`: carrega/renderiza produtos e aplica o fallback.
- `CampaignMobileBar`: controla os dois estados da faixa móvel.
- utilitário de atribuição: valida e propaga parâmetros permitidos.
- camada de tracking: registra os novos eventos com nomes e propriedades consistentes.

Os componentes não devem conhecer detalhes internos uns dos outros. A unidade selecionada continua sendo controlada por `NossasLojasClient` e passada à faixa por propriedades.

## Desempenho e acessibilidade

- Não aumentar o peso do carregamento inicial com imagens fora da dobra; usar carregamento tardio e tamanhos responsivos.
- Evitar nova chamada de catálogo quando a página já puder receber os produtos no servidor.
- Reservar espaço das imagens para impedir mudança de layout.
- CTAs acessíveis por teclado, com foco visível e nomes claros.
- A faixa deve respeitar `safe-area-inset-bottom` em celulares.
- Animações devem respeitar `prefers-reduced-motion`.

## Falhas e estados vazios

- Sem catálogo: mostrar texto e botão para `/novidades`.
- Sem JavaScript: hero e links essenciais continuam navegáveis.
- Geolocalização negada: a busca manual por cidade/unidade permanece disponível.
- UTM ausente ou inválida: tratar como tráfego normal e não mostrar a faixa.
- Produto sem preço ou imagem válida: não renderizar o card incompleto.

## Testes e critérios de aceite

### Funcionais

- Hero oferece Encontrar minha loja e Comprar online.
- Comprar online leva a `/novidades` com UTMs autorizadas preservadas.
- A seção mostra entre quatro e seis produtos válidos ou o fallback.
- A faixa aparece no celular com `utm_source=meta` e não aparece sem esse parâmetro.
- Após selecionar uma unidade, a faixa exibe seu nome e as duas ações esperadas.
- Todos os CTAs emitem o evento e a posição corretos.

### Qualidade

- Testes unitários para leitura e propagação de UTMs.
- Testes de componente para estados da faixa e fallback do catálogo.
- Teste de integração da seleção de loja com a faixa.
- Verificação manual em Facebook/Instagram, celular e desktop.
- Build do ecommerce sem novos erros.
- Nenhuma regressão em busca, geolocalização, drawer, telefone, Instagram, WhatsApp ou rotas das lojas.

## Fora de escopo

- Criar uma landing separada como `/lojas/meta`.
- Alterar campanhas ou anúncios dentro da Meta.
- Personalizar produtos por cidade ou unidade nesta primeira versão.
- Redirecionar automaticamente a visitante para o ecommerce.
- Mudar o checkout ou a política comercial.

## Resultado esperado

A campanha continua gerando visitas e contatos para as lojas físicas, mas deixa de perder potenciais compradoras online. O relatório de campanha passa a distinguir intenção de loja, entrada no catálogo e receita online atribuída às sessões que começaram em `/lojas`.
