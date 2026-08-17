# Home mobile orientada à compra

## Objetivo

Reorganizar a Home da Lurd's Plus Size para que a cliente entenda imediatamente
o que comprar e qual é o próximo passo. A primeira tela deve reproduzir a
hierarquia, as proporções e as funções do mockup aprovado, preservando a
identidade visual da marca, os dados reais do CRM e o desempenho atual.

## Resultado esperado

No celular, a jornada inicial será:

1. benefício comercial e cabeçalho compacto;
2. campanha principal com um CTA dominante para Novidades;
3. cinco atalhos editoriais de categoria;
4. vitrine de novidades reais;
5. benefícios de compra;
6. convite para encontrar uma loja física.

A cliente poderá seguir para a compra online ou encontrar uma loja sem precisar
interpretar a estrutura da página.

## Primeira tela

A composição aprovada será mantida como referência obrigatória:

- barra superior compacta com benefício comercial;
- cabeçalho com menu, marca, busca, conta e sacola;
- hero editorial em proporção mobile, sem ocupar uma tela inteira;
- uma mensagem principal curta e um único CTA visualmente dominante;
- CTA do hero direcionado para `/novidades` e preservando UTMs existentes;
- indicadores do carrossel quando houver mais de uma campanha;
- seção `Compre por categoria` imediatamente após o hero;
- cinco atalhos: Vestidos, Blusas, Conjuntos, Calças e Outlet;
- seção `Novidades da semana` com produtos reais do CRM;
- faixa compacta de benefícios;
- bloco `Prefere provar? Encontre uma loja perto de você` com CTA `Ver lojas`
  apontando para `/lojas` e preservando UTMs.

No desktop, a mesma ordem será mantida com largura ampliada, sem transformar o
hero em tela cheia.

## Conteúdo e origem dos dados

### Hero

O hero continuará vindo da retaguarda por `getHeroDaHome`. A aplicação não
inventará preço, campanha ou destino. Quando o conteúdo administrativo não
trouxer texto visível, haverá texto acessível para SEO, sem sobrepor texto à
arte pronta.

### Categorias editoriais

Serão produzidas cinco imagens novas e coordenadas, com a mesma modelo e direção
de arte aprovada. Elas representam categorias, não produtos específicos, e
serão armazenadas como WebP responsivo no projeto. Cada card terá nome, texto
alternativo e destino real:

- Vestidos → `/categoria/vestidos`;
- Blusas → `/categoria/blusas`;
- Conjuntos → `/categoria/conjuntos`;
- Calças → `/categoria/calcas`;
- Outlet → `/outlet`.

### Novidades

A vitrine será carregada pelo CRM com ordenação por novidades e filtro de
lançamento. Nenhum produto fictício ou foto editorial entrará nessa seção. Se a
consulta falhar ou retornar vazia, a Home continuará funcional e não exibirá
cards vazios.

### Lojas

O bloco de lojas será visível ainda na jornada inicial e levará para `/lojas`.
A seção detalhada de lojas poderá continuar mais abaixo, mas o primeiro CTA
garante acesso imediato à função aprovada.

## Componentes

As responsabilidades serão separadas em unidades pequenas:

- `HomeHero`: apresenta a campanha real e seu CTA;
- `HomeCategoryNav`: renderiza os cinco atalhos editoriais;
- `HomeNovidades`: apresenta produtos recebidos do CRM;
- `HomeBenefits`: mostra Pix, parcelamento, troca e entrega;
- `HomeStoreCallout`: encaminha para a busca de lojas;
- `HomePage`: busca os dados em paralelo e define somente a ordem das seções.

Componentes existentes serão reutilizados quando entregarem a composição sem
carregar comportamento ou estilos desnecessários. A Home não duplicará regras
de produto, preço, promoção ou disponibilidade.

## Simplificação do restante da Home

Depois do bloco inicial, a página manterá apenas conteúdo real e útil. Vitrines
repetitivas serão reduzidas para evitar que a cliente percorra várias listas com
os mesmos produtos. Instagram e lojas detalhadas continuarão condicionados a
dados reais. Nenhum placeholder, produto inventado ou link sem destino será
publicado.

## Responsividade e acessibilidade

- alvo principal: 390 px de largura;
- dois produtos por linha no celular, com imagem, nome curto, preço, parcelas e
  tamanhos disponíveis;
- áreas clicáveis com pelo menos 44 × 44 px;
- um único `h1` e hierarquia semântica de títulos;
- contraste AA, foco visível e textos alternativos úteis;
- navegação completa por teclado;
- respeito a `prefers-reduced-motion`.

## Desempenho

- somente a imagem LCP terá prioridade;
- hero com preload no `head`, tamanhos responsivos e dimensões explícitas;
- categorias em WebP com dimensões adequadas ao maior uso real;
- categorias, produtos e seções inferiores usarão carregamento tardio;
- nenhuma biblioteca nova de carrossel será adicionada;
- a implementação não poderá regredir CLS nem aumentar o JavaScript inicial de
  forma material.

Meta de validação: manter o Lighthouse mobile tipicamente acima de 90 e buscar
LCP de até 2,5 s, reconhecendo a variação natural do teste sintético.

## Métricas

Serão registrados, pelo mecanismo de analytics já existente:

- clique no CTA do hero;
- clique em cada categoria;
- clique em produto da vitrine de novidades;
- clique no CTA `Ver lojas`;
- posição e UTMs disponíveis no momento do clique.

Os parâmetros de campanha serão preservados nos links internos conforme o
mecanismo já adotado pelo site.

## Falhas e estados vazios

- falha no hero: usar o fallback oficial existente;
- novidades vazias: ocultar a grade sem quebrar a sequência;
- imagem de categoria indisponível: manter nome e link com fallback visual;
- falha de analytics: nunca bloquear navegação;
- links de categoria e lojas serão cobertos por teste.

## Validação

- testes unitários para destinos e estados vazios;
- teste da origem real dos produtos da vitrine;
- teste de preservação de UTMs nos CTAs;
- build de produção e suíte existente;
- inspeção visual em celular e desktop;
- verificação de teclado, contraste e textos alternativos;
- PageSpeed após o deploy, comparando mediana de pelo menos três execuções.

## Fora do escopo

- alterar cadastro, preço ou estoque do CRM;
- substituir fotos dos produtos reais;
- criar produtos ou depoimentos fictícios;
- redesenhar checkout, páginas de categoria ou página de lojas;
- adicionar geolocalização automática nesta entrega.
