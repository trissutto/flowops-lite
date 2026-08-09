# Módulo Produto & Estoque — etapa 1: Produtos

**Status:** aprovado para planejamento

**Data:** 2026-08-08

**Escopo desta especificação:** consolidar as funções de produto na nova área **Produtos**, usando o Produto Master como base. Entradas, etiquetas, realinhamento geral, inteligência e cadastros auxiliares terão especificações próprias.

## 1. Contexto

O sistema possui várias telas relacionadas a produto, criadas em momentos diferentes e para objetivos específicos. As funções mais importantes estão distribuídas entre:

- **Produto Master:** ficha por REF, cores, fotos, publicação e grade editável por loja;
- **Editor de Produtos:** grade geral, estoque direto, preços e dados em bloco;
- **Classificação de Produtos:** classificação BÁSICO ou MODA;
- **Ficha-fila:** prioridade das fichas incompletas conforme vendas;
- telas avançadas de publicação, auditoria e catálogo WooCommerce.

A direção aprovada é criar o módulo **Produto & Estoque**, agrupado por objetivo. Nesta primeira etapa, a nova área **Produtos** deve preservar o fluxo do Produto Master e incorporar funções próximas sem virar uma página monolítica.

## 2. Decisões aprovadas

1. A visão inicial da área Produtos será o **Produto Master**.
2. O fluxo principal continuará sendo **buscar REF → selecionar cor → trabalhar a grade por loja**.
3. A grade editável continuará no centro da experiência.
4. Clicar em uma célula permitirá alterar o estoque.
5. A grade continuará permitindo mover produtos entre lojas.
6. As funções do Editor de Produtos serão oferecidas como modos de trabalho: **Grade geral** e **Edição em massa**.
7. BÁSICO/MODA será um campo da ficha e uma ação em massa, não uma tela independente.
8. A Ficha-fila será a vista **Pendências da ficha**, não uma tela independente.
9. Fotos, dados do site, preços e histórico ficarão organizados em seções do produto.
10. Fluxos grandes, como Realinhamento geral e Publicação avançada, continuarão completos e serão abertos por atalhos com o contexto do produto.

## 3. Limites desta etapa

### Incluído

- estrutura de navegação do módulo Produto & Estoque;
- nova área Produtos;
- Produto Master como visão padrão;
- modos Ficha Master, Grade geral e Edição em massa;
- incorporação de BÁSICO/MODA;
- incorporação da Ficha-fila como vista de pendências;
- preservação de fotos, publicação, preços, histórico, ajuste de estoque e movimento entre lojas;
- decomposição do atual arquivo **produto-master/page.tsx** em componentes menores;
- compatibilidade temporária com as rotas atuais.

### Não incluído

- redesenho de Pedidos de compra;
- redesenho de Reposição;
- redesenho de Etiquetas avulsas;
- redesenho do Realinhamento completo;
- redesenho da Inteligência de estoque;
- união dos cadastros de Ocasiões, Tecidos, Modelagens e Coleções;
- substituição da Publicação avançada do site;
- remoção imediata das rotas antigas;
- alteração das regras de estoque Flow-first, Giga outbox ou WooCommerce.

Esses itens serão tratados como etapas independentes depois da estabilização da área Produtos.

## 4. Arquitetura de navegação

A rota principal do módulo será **/retaguarda/produto-estoque/produtos**.

O cabeçalho do módulo terá cinco áreas:

1. Produtos;
2. Entradas & Etiquetas;
3. Estoque & Movimentações;
4. Inteligência;
5. Cadastros auxiliares.

Somente Produtos será consolidada nesta etapa. Enquanto as outras áreas não forem redesenhadas, seus itens devem direcionar para as rotas atuais correspondentes.

A rota **/retaguarda/produto-master** continuará disponível e não será redirecionada nesta etapa. O redirecionamento será uma tarefa posterior, condicionada à paridade funcional, à validação operacional e a uma decisão explícita de desativação. Nenhuma rota antiga será removida nesta etapa.

## 5. Estrutura da área Produtos

### 5.1 Entrada padrão

Ao entrar em Produtos, o usuário verá:

- busca por REF, descrição, SKU ou EAN;
- botão **Buscar produto**;
- atalho **Pendências da ficha**, com contador;
- nenhum carregamento antecipado do catálogo completo.

Ao selecionar um resultado, a tela abrirá a ficha da REF com as cores e a grade.

### 5.2 Cabeçalho do produto

O cabeçalho mostrará:

- REF;
- descrição principal;
- quantidade de cores e tamanhos;
- classificação BÁSICO ou MODA;
- estado de completude da ficha;
- pendências de foto ou publicação;
- ações de imprimir etiquetas, consultar histórico e editar produto.

A classificação BÁSICO/MODA será editável na ficha e ficará disponível na Edição em massa. A função histórica de promoção de julho não faz parte da nova área Produtos. Ela permanecerá apenas na rota antiga durante a janela de compatibilidade e não será requisito para a paridade desta etapa.

### 5.3 Modos de trabalho

#### Ficha Master

Modo padrão para trabalhar uma REF por vez. Contém:

- lista de cores;
- dados comuns da REF;
- ficha e classificações;
- grade por loja;
- fotos e dados do site;
- preços;
- histórico.

#### Grade geral

Modo amplo derivado do Editor de Produtos. Mostra todas as cores e tamanhos da REF nas lojas, permitindo:

- comparar estoques entre lojas;
- selecionar uma célula para ajuste;
- consultar preço por variação;
- identificar rupturas;
- abrir um movimento para o Realinhamento.

#### Edição em massa

Modo para selecionar SKUs ou variações e aplicar:

- alteração de preço fixo;
- aumento ou redução percentual;
- substituição de descrição;
- alteração de marca;
- renomeação de REF para os SKUs selecionados, preservando as validações e a prévia existentes;
- classificação BÁSICO/MODA;
- exclusão de itens pela ação avançada existente.

O SKU continuará imutável. Toda alteração em massa terá seleção explícita, prévia do antes/depois e confirmação final. Exclusões ficarão em **Mais ações**, exigirão confirmação reforçada e manterão a auditoria existente.

## 6. Ficha Master

### 6.1 Hierarquia

A hierarquia continuará sendo:

**REF → cor → tamanho/SKU → estoque por loja**

Dados como descrição de venda, tecido, coleção, ocasião, modelagem, grade de medidas e elasticidade pertencem ao nível da REF.

Título do site, vídeo, estado de publicação, fotos e amostra de cor pertencem ao nível da cor.

Estoque e histórico operacional pertencem ao nível do SKU e da loja.

### 6.2 Lista de cores

A lateral de cores mostrará:

- nome e amostra da cor;
- estoque total da cor;
- indicador de pendências;
- cor selecionada.

Trocar a cor atualizará os dados específicos, as fotos e a grade sem perder a REF aberta.

### 6.3 Dados comuns da REF

Os dados comuns aparecerão em um resumo recolhível acima da grade. A edição abrirá o formulário completo já existente, sem duplicar esses campos em cada cor.

### 6.4 Seções locais

A Ficha Master terá:

1. Ficha & classificação;
2. Grade por loja;
3. Fotos & site;
4. Preços;
5. Histórico.

A seção padrão depois da busca será **Grade por loja**, porque é a operação mais frequente e a principal razão para manter o Produto Master como base.

## 7. Grade por loja

### 7.1 Matriz

As linhas representam tamanho/SKU. As colunas representam lojas. Cada célula mostra o estoque atual daquela combinação.

A grade deve preservar:

- leitura simultânea das lojas;
- célula clicável;
- destaque da célula selecionada;
- total por tamanho;
- identificação de estoque zero;
- indicação de movimento pendente.

### 7.2 Ajustar estoque

No modo **Ajustar estoque**:

1. o usuário seleciona uma célula;
2. a lateral mostra loja, cor, tamanho e quantidade atual;
3. o usuário informa a nova quantidade;
4. a interface mostra a diferença;
5. o usuário confirma;
6. o sistema grava, audita e recarrega o valor confirmado pelo servidor.

Não haverá atualização otimista para estoque. A célula ficará ocupada durante a gravação e exibirá o valor retornado pelo backend.

O endpoint atual a preservar é **POST /products-editor/movimentar**.

### 7.3 Mover entre lojas

No modo **Mover entre lojas**:

1. a célula selecionada define SKU e loja de origem;
2. o usuário escolhe loja de destino e quantidade;
3. o movimento é adicionado ao rascunho;
4. vários movimentos podem ser reunidos;
5. o usuário revisa e autoriza o rascunho;
6. a confirmação usa o fluxo atual de Realinhamento.

O endpoint atual a preservar é **POST /realignment/confirm**.

Validações obrigatórias:

- origem e destino não podem ser iguais;
- quantidade deve ser positiva;
- quantidade não pode superar o saldo disponível confirmado pelo servidor;
- movimentos pendentes para o mesmo SKU devem ser exibidos antes da confirmação;
- falha em um movimento não deve ocultar o resultado dos demais.

O Realinhamento geral continuará em sua própria tela. A grade apenas inicia o fluxo com produto, cor, tamanho e origem já selecionados.

## 8. Pendências da ficha

A atual Ficha-fila será incorporada como uma vista acessada pelo botão **Pendências da ficha**.

Sua função ficará explícita: priorizar produtos vendidos cuja ficha está incompleta e que, por isso, prejudicam a apresentação no site.

A vista manterá:

- período de vendas usado para ordenar a fila;
- limites de 20, 50, 100 ou 200 itens;
- quantidade vendida;
- lista atual das informações ausentes;
- acesso direto à REF e à seção que precisa ser completada.

O endpoint atual a preservar é **GET /produto-ficha/fila**.

Ao abrir um item, a vista navegará para o Produto Master com a REF e a seção pendente já selecionadas. Ao salvar, o contador e a fila serão atualizados.

## 9. Fotos e site

A seção Fotos & site preservará:

- galeria por REF e cor;
- upload;
- reordenação;
- exclusão;
- importação de fotos do WooCommerce;
- importação em lote;
- estado de publicação;
- publicação de itens com foto;
- geração ou pintura da amostra de cor.

As operações em lote continuarão em segundo plano e mostrarão estado, progresso e resultado. A importação geral manterá a opção de cancelamento existente.

A Publicação avançada continuará fora desta etapa. A seção terá um atalho **Abrir publicação avançada** quando forem necessários IA, categorias, tags, descrições longas, peso, dimensões ou edição em lote do WooCommerce.

## 10. Preços e histórico

### Preços

- exibir preço atual por variação;
- permitir edição unitária;
- direcionar alterações de múltiplos SKUs para a Edição em massa;
- mostrar prévia antes de alterações percentuais ou em bloco.

### Histórico

- vendas;
- devoluções;
- trocas;
- ajustes de estoque;
- movimentos entre lojas;
- alterações de preço e dados;
- autor, data e valores antes/depois nas alterações auditadas de estoque, preço e dados.

O histórico comercial continuará usando **GET /products-editor/historico**. A trilha de alterações continuará usando os mecanismos de auditoria já existentes.

## 11. Componentes e responsabilidades

O atual arquivo **frontend/src/app/retaguarda/produto-master/page.tsx** concentra muitas responsabilidades. A implementação deve extrair unidades com limites claros:

- **ProductWorkspace:** coordena busca, REF ativa e modo atual;
- **ProductSearch:** busca e seleção de resultado;
- **ProductHeader:** identidade, status e ações rápidas;
- **ProductModeTabs:** Ficha Master, Grade geral e Edição em massa;
- **ProductColorRail:** seleção e estado das cores;
- **ProductCommonData:** dados compartilhados da REF;
- **ProductSectionTabs:** seções locais;
- **StoreStockGrid:** matriz de tamanho/SKU por loja;
- **StockCellInspector:** ajuste pontual;
- **TransferDraftPanel:** rascunho e autorização de movimentos;
- **ProductBulkEditor:** seleção, prévia e aplicação em massa;
- **ProductPendingQueue:** fila de fichas incompletas;
- **ProductPhotosPanel:** fotos, amostra de cor e publicação;
- **ProductHistoryPanel:** histórico comercial e operacional.

Esses componentes devem consumir serviços e hooks específicos, sem duplicar regras de estoque ou publicação no frontend.

## 12. Fluxo de dados e integrações existentes

### Busca e ficha

- **GET /products-editor/search**;
- **GET /produto-ficha/:ref**;
- **PATCH /produto-ficha/:ref**;
- **PATCH /produto-ficha/:ref/cor/:cor**;
- **GET /produto-ficha/grades**.

### Estoque e movimento

- **POST /products-editor/movimentar**;
- **POST /realignment/pendencias**;
- **POST /realignment/confirm**.

### Edição em massa e histórico

- **POST /products-editor/apply**;
- **POST /products-editor/apply-marca-todos**;
- **POST /products-editor/excluir**;
- **GET /products-editor/ref-info**;
- **GET /products-editor/historico**.

### Classificação

- **POST /product-classification/set**;
- **POST /product-classification/bulk**.

### Pendências

- **GET /produto-ficha/fila**.

### Fotos

- endpoints existentes de **/product-photos**, incluindo busca, upload, reordenação, importação, publicação, amostra de cor e exclusão.

Não será criado um endpoint agregador gigante nesta etapa. O frontend fará carregamento progressivo: primeiro busca e ficha; depois, apenas os dados da seção aberta.

## 13. Estados, erros e concorrência

- Busca vazia: orientar a pesquisa por REF, descrição, SKU ou EAN.
- Produto não encontrado: manter o termo e oferecer nova busca.
- Erro de seção secundária: manter as demais seções utilizáveis e permitir tentar novamente.
- Ajuste de estoque: bloquear apenas a célula em gravação.
- Conflito de saldo: mostrar o saldo atual retornado pelo servidor e exigir nova confirmação.
- Movimento inválido: manter o rascunho, destacar o item com erro e permitir correção.
- Edição em massa parcial: mostrar resultado por SKU, com sucessos e falhas separados.
- Operação em lote de fotos: mostrar progresso e resultado sem bloquear a ficha.
- Saída com alterações não salvas: solicitar confirmação.

Mensagens não devem afirmar que a gravação ocorre diretamente no Giga. A interface deve usar linguagem neutra, coerente com o modelo Flow-first e com a sincronização por outbox.

## 14. Permissões e segurança operacional

- preservar os guardas e perfis atuais de cada operação;
- não ampliar permissões porque as funções passaram a compartilhar o mesmo módulo;
- esconder ou desabilitar ações sem permissão;
- exigir confirmação explícita para exclusão e alterações em massa;
- registrar auditoria das mudanças críticas;
- nunca confiar apenas no saldo exibido no navegador para validar uma movimentação.

## 15. Responsividade e acessibilidade

A experiência é desktop-first, pois a grade por loja precisa de espaço.

- em telas médias, o inspetor da célula desce para baixo da grade;
- em telas pequenas, a lista de cores vira faixa horizontal e a grade usa rolagem horizontal contida;
- células e ações devem ser acessíveis por teclado;
- seleção não pode depender apenas de cor;
- estados de carregamento e erro devem ser anunciados;
- campos devem ter rótulos explícitos.

## 16. Estratégia de migração

### Fase 1 — estrutura e paridade do Produto Master

- criar o shell do módulo;
- extrair componentes do Produto Master;
- manter todos os recursos atuais;
- disponibilizar a nova rota sem retirar a antiga.

### Fase 2 — funções pequenas incorporadas

- incluir BÁSICO/MODA na ficha e em massa;
- incluir Pendências da ficha;
- criar links contextuais entre pendência e seção incompleta.

### Fase 3 — modos do Editor de Produtos

- adicionar Grade geral;
- adicionar Edição em massa;
- preservar prévia, auditoria e histórico;
- manter temporariamente o Editor antigo como fallback.

### Fase 4 — estabilização

- executar validação operacional com usuários;
- comparar resultados de estoque e movimentos com as telas antigas;
- corrigir lacunas de paridade;
- somente depois redirecionar as rotas antigas.

## 17. Critérios de aceitação

1. O usuário encontra uma REF e abre sua ficha sem navegar para outra área.
2. A REF exibe cores e grade por loja.
3. Uma célula pode ser clicada e ajustada com confirmação e auditoria.
4. O usuário cria e autoriza movimentos entre lojas sem perder o contexto da REF.
5. Todos os movimentos respeitam saldo e pendências validados no backend.
6. BÁSICO/MODA pode ser alterado na ficha e em massa.
7. Pendências da ficha são ordenadas por vendas e abrem diretamente o ponto incompleto.
8. Fotos e dados de site continuam disponíveis por cor.
9. Grade geral mostra cores, tamanhos e lojas em uma visão ampla.
10. Edição em massa oferece seleção, prévia e resultado por SKU.
11. SKU não pode ser editado.
12. Rotas antigas permanecem disponíveis até a validação de paridade.
13. Nenhuma mensagem nova afirma gravação direta no Giga.
14. Fluxos operacionais de Pedidos, Reposição, Etiquetas, Inteligência e Realinhamento completo continuam funcionando separadamente.

## 18. Testes necessários

### Unidade

- transformação REF → cores → SKUs → lojas;
- cálculo da diferença de estoque;
- validação do rascunho de movimento;
- montagem da prévia em massa;
- identificação das pendências da ficha.

### Componentes

- busca e seleção de REF;
- troca de cor;
- seleção de célula;
- alternância Ajustar/Mover;
- atualização do inspetor;
- seleção de itens em massa;
- estados de carregamento, vazio, erro e sucesso.

### Integração

- ajuste de estoque e recarga do saldo;
- criação e confirmação de Realinhamento;
- edição de ficha comum e por cor;
- alteração BÁSICO/MODA;
- fila de pendências e deep link;
- upload, importação e reordenação de fotos;
- aplicação em massa com falhas parciais.

### Ponta a ponta

- buscar REF → selecionar cor → alterar estoque;
- buscar REF → mover entre lojas → autorizar;
- abrir Pendências → completar ficha → retirar item da fila;
- selecionar SKUs → visualizar alterações → aplicar;
- abrir foto por cor → importar → ordenar → publicar;
- confirmar que rotas antigas continuam acessíveis durante a migração.

## 19. Resultado esperado

Produtos passa a ser o ponto único para consultar e manter uma peça, sem retirar a autonomia dos fluxos operacionais. O Produto Master continua reconhecível, a grade permanece central e as funções hoje espalhadas entram como modos ou seções coerentes, com migração progressiva e possibilidade de retorno às telas antigas até a paridade ser comprovada.
