# Módulo Produto & Estoque — plano de implementação da etapa Produtos

**Data:** 2026-08-08

**Especificação de origem:** docs/superpowers/specs/2026-08-08-produto-estoque-produtos-design.md

## Objetivo

Criar a área **Produto & Estoque → Produtos**, usando o Produto Master como visão inicial e preservando a grade editável, os movimentos entre lojas, a ficha, as fotos e o conteúdo do site. Incorporar como modos ou vistas as funções do Editor de Produtos, da classificação BÁSICO/MODA e da Ficha-fila, sem remover as rotas antigas nesta etapa.

## Regras inegociáveis

1. Não alterar as regras Flow-first, outbox do Giga ou integração WooCommerce.
2. Não mudar os endpoints operacionais antes de existir teste de paridade.
3. Não ampliar permissões: cada ação mantém as restrições atuais do endpoint.
4. Não remover nem redirecionar as rotas antigas nesta etapa.
5. SKU permanece imutável.
6. Ajuste de estoque não usa atualização otimista.
7. Movimento entre lojas sempre passa pela validação do backend e pelo Realinhamento.
8. Toda edição em massa exige seleção, prévia e confirmação.
9. Cada tarefa deve terminar com testes e um commit pequeno.
10. O trabalho avança por fases; uma fase só começa depois que a anterior está verde.
11. A nova área consolidada será restrita a admin nesta etapa, porque os endpoints centrais de products-editor exigem admin estrito. As rotas antigas continuarão preservando os acessos atuais de operator.

## Arquitetura alvo

### Rotas

- **/retaguarda/produto-estoque**: redireciona para a área Produtos.
- **/retaguarda/produto-estoque/produtos**: Produto Master e seus modos.
- **/retaguarda/produto-estoque/produtos/pendencias**: fila integrada de fichas incompletas.
- **/retaguarda/produto-master**: continua renderizando a experiência atual por um componente compartilhado.
- **/retaguarda/editor-produtos**: continua disponível como fallback.
- **/retaguarda/ficha-fila**: continua disponível como fallback.
- **/cadastros/classificacao-produtos**: continua disponível como fallback.

### Fronteira de código

Criar a feature **frontend/src/features/produto-estoque** com:

- tipos de domínio;
- adaptadores dos dados atuais;
- clientes de API;
- hooks de orquestração;
- shell do módulo;
- componentes da ficha, grade, movimento, pendências e edição em massa.

Os arquivos de rota devem apenas compor componentes da feature. Regras de estoque, classificação e publicação não devem ser duplicadas nas páginas.

### Estratégia de dados

- busca e ficha carregam primeiro;
- grade, fotos, histórico, pendências e classificação carregam sob demanda;
- cada painel trata seu erro sem derrubar a ficha inteira;
- depois de uma escrita crítica, o valor exibido vem de uma nova resposta do servidor;
- operações parciais exibem sucesso ou falha por SKU.

## Fase 0 — proteção do trabalho

### Tarefa 1 — registrar a linha de base

**Arquivos:** nenhum.

**Passos:**

1. Confirmar que o working tree está limpo.
2. Registrar o commit inicial da implementação.
3. Executar o build e os testes existentes antes de qualquer alteração.
4. Salvar no primeiro comentário da implementação qualquer falha que já exista na linha de base.

**Comandos de verificação:**

- na raiz: **git status --short**
- em frontend: **npm run lint**
- em frontend: **npm run build**
- em backend: **npm test -- --runInBand**
- em backend: **npm run build**

**Critério de saída:** linha de base conhecida e nenhuma alteração local inesperada.

### Tarefa 2 — adicionar testes de frontend

**Arquivos a modificar:**

- frontend/package.json
- frontend/package-lock.json

**Arquivos a criar:**

- frontend/vitest.config.ts
- frontend/src/test/setup.ts
- frontend/playwright.config.ts
- frontend/e2e/auth.setup.ts

**Passos:**

1. Adicionar Vitest, jsdom, Testing Library, jest-dom e user-event como dependências de desenvolvimento.
2. Adicionar Playwright como dependência de desenvolvimento.
3. Criar os scripts **test:unit**, **test:unit:watch** e **test:e2e**.
4. Configurar o alias **@** para **frontend/src** no Vitest.
5. Carregar jest-dom no setup.
6. Configurar o Playwright para usar **E2E_BASE_URL**.
7. Criar setup de autenticação por **E2E_ADMIN_EMAIL** e **E2E_ADMIN_PASSWORD**, sem gravar credenciais.
8. Criar um teste unitário mínimo para confirmar que o ambiente funciona.
9. Criar um teste E2E mínimo que abre a rota existente **/retaguarda/produto-master** somente quando as variáveis de autenticação estiverem presentes.

**Verificação:**

- **npm run test:unit**
- **npm run test:e2e**, quando as variáveis E2E estiverem configuradas
- **npm run build**

**Commit sugerido:** **test: adiciona base de testes do modulo produto**

## Fase 1 — domínio e infraestrutura da feature

### Tarefa 3 — extrair tipos e funções puras

**Arquivos a criar:**

- frontend/src/features/produto-estoque/types.ts
- frontend/src/features/produto-estoque/domain/product-groups.ts
- frontend/src/features/produto-estoque/domain/stock-movements.ts
- frontend/src/features/produto-estoque/domain/product-groups.test.ts
- frontend/src/features/produto-estoque/domain/stock-movements.test.ts

**Origem a consultar:**

- frontend/src/app/retaguarda/produto-master/page.tsx
- frontend/src/app/retaguarda/editor-produtos/page.tsx

**Passos:**

1. Escrever testes para agrupar linhas por REF, marca e cor.
2. Cobrir a regra de que REF sozinha não identifica a ficha; a chave é REF + marca.
3. Cobrir ordenação de cores e tamanhos.
4. Cobrir normalização da matriz de estoque por loja.
5. Escrever testes para quantidade disponível depois dos movimentos do rascunho.
6. Cobrir origem igual ao destino, quantidade zero, saldo insuficiente e movimentos repetidos.
7. Mover os tipos SkuRow, Ficha, FichaCor, Produto, Pendencia e Movimento para **types.ts**.
8. Implementar apenas as funções necessárias para fazer os testes passarem.
9. Substituir gradualmente as definições locais do Produto Master pelos tipos compartilhados.

**Verificação:**

- **npm run test:unit -- product-groups.test.ts stock-movements.test.ts**
- **npm run lint**
- **npm run build**

**Commit sugerido:** **refactor: extrai dominio do produto master**

### Tarefa 4 — criar clientes de API focados

**Arquivos a criar:**

- frontend/src/features/produto-estoque/api/product-search-api.ts
- frontend/src/features/produto-estoque/api/product-ficha-api.ts
- frontend/src/features/produto-estoque/api/product-stock-api.ts
- frontend/src/features/produto-estoque/api/product-editor-api.ts
- frontend/src/features/produto-estoque/api/product-classification-api.ts
- frontend/src/features/produto-estoque/api/product-pending-api.ts
- frontend/src/features/produto-estoque/api/product-api.test.ts

**Passos:**

1. Encapsular **GET /products-editor/search** e manter o formato atual.
2. Encapsular leitura e escrita de **/produto-ficha**.
3. Encapsular ajuste em **POST /products-editor/movimentar**.
4. Encapsular pendências e confirmação em **/realignment**.
5. Encapsular edição, prévia, histórico e exclusão do Editor.
6. Encapsular leitura exata por REF usando **/product-classification/list** e filtrar a REF exata no cliente.
7. Encapsular **set** e **bulk** de classificação.
8. Encapsular **GET /produto-ficha/fila**.
9. Mockar **@/lib/api** e testar URL, método e corpo de cada operação crítica.
10. Não criar endpoint agregador e não alterar o backend nesta tarefa.

**Verificação:**

- **npm run test:unit -- product-api.test.ts**
- **npm run lint**
- **npm run build**

**Commit sugerido:** **refactor: centraliza api de produto e estoque**

### Tarefa 5 — criar hooks de orquestração

**Arquivos a criar:**

- frontend/src/features/produto-estoque/hooks/use-product-search.ts
- frontend/src/features/produto-estoque/hooks/use-product-ficha.ts
- frontend/src/features/produto-estoque/hooks/use-stock-adjustment.ts
- frontend/src/features/produto-estoque/hooks/use-transfer-draft.ts
- frontend/src/features/produto-estoque/hooks/use-product-permissions.ts
- frontend/src/features/produto-estoque/hooks/use-product-search.test.tsx
- frontend/src/features/produto-estoque/hooks/use-transfer-draft.test.tsx

**Passos:**

1. Mover o estado de busca e o agrupamento para **use-product-search**.
2. Manter a busca automática por **?busca=REF**.
3. Adicionar suporte a **marca**, **cor**, **secao** e **modo** na URL.
4. Mover cache de ficha por REF + marca para **use-product-ficha**.
5. Mover ajuste de célula, estado ocupado e recarga para **use-stock-adjustment**.
6. Mover rascunho, desfazer, disponibilidade e autorização para **use-transfer-draft**.
7. Ler **/auth/me** uma vez e expor as permissões por ação.
8. Testar busca inicial por query string, troca de produto e preservação do contexto.
9. Testar rascunho, remoção de um movimento, autorização e erro parcial.

**Verificação:**

- **npm run test:unit -- use-product-search.test.tsx use-transfer-draft.test.tsx**
- **npm run lint**
- **npm run build**

**Commit sugerido:** **refactor: extrai estado do workspace de produtos**

## Fase 2 — shell do módulo e paridade do Produto Master

### Tarefa 6 — criar o shell Produto & Estoque

**Arquivos a criar:**

- frontend/src/features/produto-estoque/components/ProdutoEstoqueShell.tsx
- frontend/src/features/produto-estoque/components/ProdutoEstoqueShell.test.tsx
- frontend/src/app/retaguarda/produto-estoque/layout.tsx
- frontend/src/app/retaguarda/produto-estoque/page.tsx
- frontend/src/app/retaguarda/produto-estoque/produtos/page.tsx

**Passos:**

1. Criar o shell com as cinco áreas aprovadas.
2. Marcar Produtos como área ativa.
3. Fazer a rota raiz do módulo redirecionar para Produtos.
4. Fazer Entradas apontar para **/loja/pedidos-compra**.
5. Fazer Estoque & Movimentações apontar para **/retaguarda/realinhamento**.
6. Fazer Inteligência apontar para **/retaguarda/inteligencia-estoque**.
7. Fazer Cadastros auxiliares apontar para **/cadastros/classificacao-peca**.
8. Restringir a nova área consolidada a admin sem mudar os guardas do backend.
9. Usar a identidade visual já adotada por AdminShell e pelos hubs.
10. Garantir navegação por teclado e estado ativo via pathname.
11. Renderizar um placeholder temporário do ProductWorkspace na nova rota.

**Verificação:**

- teste do item ativo e dos links;
- **npm run test:unit -- ProdutoEstoqueShell.test.tsx**
- **npm run lint**
- **npm run build**

**Commit sugerido:** **feat: cria shell do modulo produto e estoque**

### Tarefa 7 — dividir o Produto Master sem alterar comportamento

**Arquivos a criar:**

- frontend/src/features/produto-estoque/components/ProductWorkspace.tsx
- frontend/src/features/produto-estoque/components/ProductSearch.tsx
- frontend/src/features/produto-estoque/components/ProductHeader.tsx
- frontend/src/features/produto-estoque/components/ProductColorRail.tsx
- frontend/src/features/produto-estoque/components/ProductCommonData.tsx
- frontend/src/features/produto-estoque/components/ProductColorPanel.tsx
- frontend/src/features/produto-estoque/components/ProductPhotosPanel.tsx
- frontend/src/features/produto-estoque/components/ProductWorkspace.test.tsx

**Arquivos a modificar:**

- frontend/src/app/retaguarda/produto-master/page.tsx
- frontend/src/app/retaguarda/produto-estoque/produtos/page.tsx

**Passos:**

1. Escrever testes de caracterização para busca, abertura da REF e troca de cor.
2. Mover a busca e a composição principal para **ProductWorkspace**.
3. Extrair o cabeçalho e os indicadores.
4. Extrair a lista de cores.
5. Mover a atual FichaComum para **ProductCommonData**.
6. Mover a atual FichaDaCor para **ProductColorPanel**.
7. Reutilizar **FotosDaCor** dentro de **ProductPhotosPanel**.
8. Fazer a rota nova renderizar **ProductWorkspace** dentro do shell.
9. Fazer a rota antiga renderizar o mesmo **ProductWorkspace** sem redirecionar.
10. Comparar as duas rotas com a mesma REF e confirmar paridade visual e funcional.

**Verificação:**

- **npm run test:unit -- ProductWorkspace.test.tsx**
- **npm run lint**
- **npm run build**
- teste manual: buscar a mesma REF nas duas rotas

**Commit sugerido:** **refactor: compartilha produto master entre rotas**

### Tarefa 8 — extrair grade, ajuste e movimento

**Arquivos a criar:**

- frontend/src/features/produto-estoque/components/StoreStockGrid.tsx
- frontend/src/features/produto-estoque/components/StockCellInspector.tsx
- frontend/src/features/produto-estoque/components/TransferDraftPanel.tsx
- frontend/src/features/produto-estoque/components/StoreStockGrid.test.tsx
- frontend/src/features/produto-estoque/components/TransferDraftPanel.test.tsx

**Arquivos a modificar:**

- frontend/src/features/produto-estoque/components/ProductWorkspace.tsx
- frontend/src/features/produto-estoque/components/ProductColorPanel.tsx

**Passos:**

1. Escrever teste para renderizar tamanhos por linha e lojas por coluna.
2. Cobrir estoque zero, total por tamanho e movimento pendente.
3. Extrair a atual GradeEstoque.
4. Criar os modos **Ajustar estoque** e **Mover entre lojas**.
5. Fazer uma célula selecionada alimentar o inspetor.
6. No ajuste, exigir nova quantidade, motivo e confirmação.
7. Depois da gravação, recarregar o saldo confirmado.
8. No movimento, permitir adicionar unidades ao rascunho.
9. Preservar desfazer de uma unidade e autorização do conjunto.
10. Exibir resultado por movimento quando a resposta for parcial.
11. Não permitir destino igual à origem nem quantidade acima da disponibilidade.

**Verificação:**

- **npm run test:unit -- StoreStockGrid.test.tsx TransferDraftPanel.test.tsx**
- **npm run lint**
- **npm run build**
- teste manual em produto conhecido: ajustar uma célula em ambiente autorizado
- teste manual em produto conhecido: montar rascunho sem autorizar

**Commit sugerido:** **refactor: extrai grade e movimento entre lojas**

### Tarefa 9 — criar os modos e seções da ficha

**Arquivos a criar:**

- frontend/src/features/produto-estoque/components/ProductModeTabs.tsx
- frontend/src/features/produto-estoque/components/ProductSectionTabs.tsx
- frontend/src/features/produto-estoque/components/ProductModeTabs.test.tsx

**Arquivos a modificar:**

- frontend/src/features/produto-estoque/components/ProductWorkspace.tsx

**Passos:**

1. Adicionar Ficha Master, Grade geral e Edição em massa.
2. Fazer Ficha Master ser o modo padrão.
3. Adicionar Ficha & classificação, Grade por loja, Fotos & site, Preços e Histórico.
4. Fazer Grade por loja ser a seção padrão depois da busca.
5. Sincronizar modo e seção com a URL.
6. Carregar somente o painel ativo.
7. Preservar REF e cor ao trocar de modo.
8. Exibir erro local do painel sem limpar a ficha.

**Verificação:**

- **npm run test:unit -- ProductModeTabs.test.tsx ProductWorkspace.test.tsx**
- **npm run lint**
- **npm run build**

**Commit sugerido:** **feat: adiciona modos e secoes ao produto master**

## Fase 3 — incorporar telas pequenas

### Tarefa 10 — incorporar BÁSICO/MODA

**Arquivos a criar:**

- frontend/src/features/produto-estoque/components/ProductClassificationField.tsx
- frontend/src/features/produto-estoque/components/ProductClassificationField.test.tsx

**Arquivos a modificar:**

- frontend/src/features/produto-estoque/components/ProductHeader.tsx
- frontend/src/features/produto-estoque/components/ProductCommonData.tsx
- frontend/src/features/produto-estoque/api/product-classification-api.ts

**Passos:**

1. Carregar a classificação da REF depois da ficha.
2. Exibir BÁSICO, MODA ou Não revisado no cabeçalho.
3. Permitir alteração pela seção Ficha & classificação.
4. Usar **POST /product-classification/set**.
5. Atualizar o cabeçalho somente depois da resposta do servidor.
6. Manter a promoção de julho fora da nova interface.
7. Tratar REF reciclada explicitamente: a classificação continua pertencendo à REF, conforme a regra atual.
8. Testar leitura, alteração, erro e ausência de classificação.

**Verificação:**

- **npm run test:unit -- ProductClassificationField.test.tsx**
- **npm run lint**
- **npm run build**

**Commit sugerido:** **feat: integra classificacao basico e moda**

### Tarefa 11 — incorporar Pendências da ficha

**Arquivos a criar:**

- frontend/src/features/produto-estoque/components/ProductPendingQueue.tsx
- frontend/src/features/produto-estoque/components/ProductPendingQueue.test.tsx
- frontend/src/app/retaguarda/produto-estoque/produtos/pendencias/page.tsx

**Arquivos a modificar:**

- frontend/src/features/produto-estoque/components/ProductSearch.tsx
- frontend/src/app/retaguarda/ficha-fila/page.tsx

**Passos:**

1. Extrair a tabela e filtros atuais da Ficha-fila para o componente compartilhado.
2. Preservar período, atalhos, limite, progresso, completas, sem marca e não mostradas.
3. Exibir contador de pendências junto à busca.
4. Fazer cada item abrir a nova rota com **busca**, **marca** e **secao**.
5. Depois de salvar a ficha, invalidar e recarregar a fila.
6. Fazer a rota antiga continuar renderizando o mesmo componente.
7. Testar ordenação recebida, filtros, vazio, erro e deep link.

**Verificação:**

- **npm run test:unit -- ProductPendingQueue.test.tsx**
- **npm run lint**
- **npm run build**
- teste manual: Pendências → Preencher → salvar → atualizar fila

**Commit sugerido:** **feat: integra pendencias da ficha ao modulo**

## Fase 4 — incorporar o Editor de Produtos

### Tarefa 12 — criar a Grade geral

**Arquivos a criar:**

- frontend/src/features/produto-estoque/components/ProductGeneralGrid.tsx
- frontend/src/features/produto-estoque/components/ProductGeneralGrid.test.tsx

**Arquivos a modificar:**

- frontend/src/features/produto-estoque/components/ProductWorkspace.tsx
- frontend/src/features/produto-estoque/api/product-editor-api.ts

**Passos:**

1. Escrever teste com duas cores, vários tamanhos e várias lojas.
2. Montar uma matriz única a partir das linhas da busca.
3. Exibir REF, SKU, descrição, marca, cor, tamanho, preço e lojas.
4. Manter SKU bloqueado.
5. Permitir ajuste de estoque clicando na célula pelo mesmo inspetor.
6. Permitir selecionar linhas para a Edição em massa.
7. Mostrar alertas atuais de legenda de live e classificação.
8. Manter cabeçalho e primeira coluna legíveis em matriz larga.
9. Garantir rolagem horizontal contida em telas pequenas.

**Verificação:**

- **npm run test:unit -- ProductGeneralGrid.test.tsx**
- **npm run lint**
- **npm run build**
- comparação manual com /retaguarda/editor-produtos

**Commit sugerido:** **feat: adiciona grade geral de produtos**

### Tarefa 13 — criar a Edição em massa

**Arquivos a criar:**

- frontend/src/features/produto-estoque/components/ProductBulkEditor.tsx
- frontend/src/features/produto-estoque/components/ProductBulkPreview.tsx
- frontend/src/features/produto-estoque/components/ProductBulkEditor.test.tsx

**Arquivos a modificar:**

- frontend/src/features/produto-estoque/components/ProductWorkspace.tsx
- frontend/src/features/produto-estoque/api/product-editor-api.ts
- frontend/src/app/retaguarda/editor-produtos/page.tsx

**Passos:**

1. Extrair do Editor as transformações de REF, preço, descrição e marca.
2. Adicionar BÁSICO/MODA entre as ações.
3. Escrever teste para cada transformação antes de montar a interface.
4. Exigir seleção explícita de SKUs.
5. Criar prévia antes/depois.
6. Validar colisão da REF com **GET /products-editor/ref-info**.
7. Aplicar dados com **POST /products-editor/apply**.
8. Manter **apply-marca-todos** para pesquisas maiores que o limite da tela.
9. Colocar exclusão em Mais ações, com confirmação reforçada e suporte a **forcar**.
10. Mostrar resultado por SKU e manter falhas selecionadas para correção.
11. Atualizar no Editor antigo o texto incorreto de gravação direta no Giga para linguagem Flow-first.
12. Não remover nem redirecionar o Editor antigo.

**Verificação:**

- **npm run test:unit -- ProductBulkEditor.test.tsx**
- **npm run lint**
- **npm run build**
- testar prévia sem gravar
- testar operação em shadow mode quando disponível

**Commit sugerido:** **feat: integra edicao em massa de produtos**

### Tarefa 14 — integrar Preços e Histórico

**Arquivos a criar:**

- frontend/src/features/produto-estoque/components/ProductPricesPanel.tsx
- frontend/src/features/produto-estoque/components/ProductHistoryPanel.tsx
- frontend/src/features/produto-estoque/components/ProductHistoryPanel.test.tsx

**Arquivos a modificar:**

- frontend/src/features/produto-estoque/components/ProductWorkspace.tsx

**Passos:**

1. Exibir preços por cor, tamanho e SKU.
2. Direcionar alteração unitária para o mesmo mecanismo de prévia.
3. Direcionar múltiplos SKUs para Edição em massa.
4. Carregar histórico somente ao abrir a seção.
5. Usar **GET /products-editor/historico** por SKU.
6. Separar vendas, devoluções, trocas, ajustes e movimentos.
7. Exibir estado vazio e falha sem fechar a ficha.
8. Testar carregamento tardio, troca de SKU e erro.

**Verificação:**

- **npm run test:unit -- ProductHistoryPanel.test.tsx**
- **npm run lint**
- **npm run build**

**Commit sugerido:** **feat: integra precos e historico do produto**

### Tarefa 15 — consolidar Fotos & site

**Arquivos a modificar:**

- frontend/src/features/produto-estoque/components/ProductPhotosPanel.tsx
- frontend/src/features/produto-estoque/components/ProductColorPanel.tsx
- frontend/src/components/FotosDaCor.tsx, somente se a extração exigir props mais claras
- frontend/src/app/retaguarda/publicar-site/page.tsx

**Arquivos a criar:**

- frontend/src/features/produto-estoque/components/ProductPhotosPanel.test.tsx

**Passos:**

1. Preservar galeria, upload, reordenação e exclusão.
2. Preservar importação WooCommerce por cor.
3. Preservar importação geral, status e cancelamento.
4. Preservar publicação de pendentes.
5. Preservar pintura das amostras de cor.
6. Exibir o estado da cor no cabeçalho.
7. Adicionar à Publicação avançada suporte de entrada por **?ref=...&cor=...**.
8. Adicionar na ficha o atalho para a Publicação avançada com REF e cor preenchidas.
9. Testar ações por cor, deep link e estado de operação em lote.

**Verificação:**

- **npm run test:unit -- ProductPhotosPanel.test.tsx**
- **npm run lint**
- **npm run build**
- teste manual com uma cor que já tenha fotos

**Commit sugerido:** **refactor: consolida fotos e site na ficha master**

## Fase 5 — navegação, compatibilidade e qualidade

### Tarefa 16 — atualizar os hubs e o mapa de rotas

**Arquivos a modificar:**

- frontend/src/app/loja/page.tsx
- frontend/src/app/retaguarda/page.tsx
- frontend/src/app/retaguarda/mapa-urls/routes.generated.json, somente pelo gerador

**Passos:**

1. Adicionar o card **Produto & Estoque** nos hubs Loja e Gestão.
2. Fazer o card abrir a nova área Produtos.
3. Manter os cards antigos durante o piloto, agrupados ou identificados como versão anterior.
4. Depois da validação do piloto, retirar os cards antigos do destaque, sem apagar as rotas.
5. Executar **node scripts/gen-routes-map.mjs** dentro de frontend.
6. Conferir se as novas rotas aparecem no mapa.

**Verificação:**

- **npm run lint**
- **npm run build**
- navegar pelos dois hubs e pelo mapa de URLs

**Commit sugerido:** **feat: adiciona produto e estoque aos hubs**

### Tarefa 17 — acessibilidade, responsividade e desempenho

**Arquivos a revisar:**

- todos os componentes de frontend/src/features/produto-estoque/components

**Passos:**

1. Garantir rótulos de campos e nomes acessíveis nas células.
2. Permitir seleção e confirmação pelo teclado.
3. Não depender apenas de cor para seleção, zero, pendência ou erro.
4. Em tela média, mover o inspetor para baixo da grade.
5. Em tela pequena, transformar as cores em faixa horizontal.
6. Conter a rolagem da grade sem criar rolagem na página inteira.
7. Garantir alvos de toque adequados.
8. Fazer carregamento tardio de fotos, histórico, pendências e modos não ativos.
9. Evitar busca duplicada ao alternar seções.
10. Cancelar ou ignorar respostas de uma REF anterior quando o usuário trocar de produto rapidamente.
11. Verificar larguras de 360, 768, 1024 e 1440 pixels.

**Verificação:**

- testes de teclado com Testing Library
- auditoria manual com navegador
- **npm run test:unit**
- **npm run lint**
- **npm run build**

**Commit sugerido:** **fix: melhora acessibilidade e responsividade de produtos**

### Tarefa 18 — regressão e piloto controlado

**Arquivos a criar:**

- frontend/e2e/produto-estoque-produtos.spec.ts
- docs/qa/produto-estoque-produtos-checklist.md

**Passos:**

1. Automatizar busca → selecionar cor → abrir grade.
2. Automatizar abertura de Pendências e deep link.
3. Automatizar prévia de edição em massa sem confirmar escrita.
4. Executar em ambiente controlado o ajuste real de uma célula.
5. Executar movimento real entre duas lojas de teste ou com produto autorizado.
6. Comparar os saldos com Produto Master e Editor antigos.
7. Testar upload, ordenação e publicação em produto de teste.
8. Validar admin com acesso completo à nova área.
9. Validar que operator não ganha acesso aos modos baseados em products-editor e continua usando as rotas antigas permitidas.
10. Confirmar que as rotas antigas continuam funcionando.
11. Registrar diferenças e bloquear o avanço se houver divergência de estoque.
12. Executar escritas reais de estoque somente com REF, origem e destino autorizados explicitamente pelo responsável; sem essa autorização, limitar a validação à prévia.
13. Conduzir piloto com pelo menos um usuário operacional.
14. Só retirar os cards antigos do destaque depois da aprovação do piloto.

**Verificação final:**

- **npm run test:unit**
- **npm run test:e2e**
- **npm run lint**
- **npm run build**
- em backend: **npm test -- --runInBand**
- em backend: **npm run build**
- **git diff --check**
- checklist operacional assinado

**Commit sugerido:** **test: valida modulo produto e estoque**

## Ordem de entrega

1. Shell e Produto Master compartilhado.
2. Grade, ajuste e movimento com paridade.
3. BÁSICO/MODA e Pendências.
4. Grade geral.
5. Edição em massa.
6. Preços, histórico e fotos.
7. Hubs, qualidade e piloto.

Cada bloco deve poder ser disponibilizado com as telas antigas ainda acessíveis. A primeira liberação não deve depender da conclusão de todas as fases.

## Critérios para encerrar a implementação

1. Os 14 critérios da especificação foram testados.
2. Nenhuma divergência de estoque foi encontrada no piloto.
3. Ajuste e movimento usam os mesmos endpoints e regras atuais.
4. Busca, ficha, fotos e grade têm paridade com o Produto Master.
5. Grade geral e edição em massa têm paridade com o Editor.
6. BÁSICO/MODA e Pendências funcionam dentro do módulo.
7. Build, lint, testes unitários, backend e E2E estão verdes.
8. Rotas antigas continuam acessíveis.
9. O usuário operacional aprovou a nova área antes de retirar os atalhos antigos.

## O que vem depois

Depois da estabilização da área Produtos, criar especificações e planos separados para:

1. Entradas & Etiquetas;
2. Estoque & Movimentações e Realinhamento;
3. Inteligência;
4. Cadastros auxiliares;
5. desativação final das telas antigas.
