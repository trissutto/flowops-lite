# FlowOps Beta — núcleo Shopify

## Objetivo

Construir o próximo FlowOps como um ambiente Beta completo, coerente e navegável, inspirado na organização administrativa do Shopify. O Beta usará dados e funções reais, mas permanecerá isolado do sistema atual até a validação integral.

O projeto não será mais uma coleção de telas beta soltas. A rota `/beta` será a entrada oficial do novo produto e todas as novas áreas compartilharão o mesmo shell.

## Isolamento e convivência

- O sistema atual em `/`, `/clientes-crm`, `/minha-loja`, `/retaguarda` e demais rotas permanece intacto.
- O novo ambiente começa em `/beta`.
- O Beta terá identificação visual persistente em seu cabeçalho.
- Dados são reais e usam as APIs atuais ou endpoints beta próprios.
- Uma função beta nunca redireciona silenciosamente o fluxo atual.
- Links para páginas legadas são permitidos quando uma área ainda não tiver versão beta, mas serão identificados como abertura do sistema atual.
- A substituição do sistema atual não faz parte desta entrega.

## Rotas iniciais

- `/beta` — home do novo FlowOps.
- `/beta/clientes` — lista de clientes no shell Shopify.
- `/beta/clientes/[id]` — ficha única consolidada da pessoa.

A rota existente `/clientes-crm/beta/[id]` permanece funcional por compatibilidade. Ela poderá redirecionar para a rota canônica `/beta/clientes/[id]` somente depois de validado que nenhum link operacional será quebrado.

Rotas futuras seguirão o mesmo padrão:

- `/beta/produtos`
- `/beta/site`
- `/beta/rh`
- `/beta/financeiro`
- `/beta/vendas`
- `/beta/fiscal`
- `/beta/lojas`
- `/beta/configuracoes`

Nesta primeira entrega, as áreas ainda não migradas aparecem no menu com indicação `Em construção` e, quando houver destino seguro, uma ação secundária para abrir a página atual.

## Shell Shopify

O shell é persistente em todas as rotas `/beta` e contém:

- barra superior;
- marca `LURD'S · FlowOps Beta`;
- busca global visual inicialmente limitada às áreas beta disponíveis;
- seleção de contexto entre toda a rede e lojas permitidas ao usuário;
- identificação do usuário;
- menu lateral em cascata;
- conteúdo principal responsivo.

No desktop, o menu permanece lateral. No celular, ele abre como drawer. Somente uma seção principal fica expandida por vez, e o estado acompanha a rota ativa.

## Menu inicial

1. **Início** — home beta.
2. **Clientes**
   - Lista de clientes
   - Nova cliente, inicialmente pelo fluxo atual identificado como legado
   - Revisão de identidade, para administradores
3. **Produtos**
   - Consulta / edição
   - Estoque e movimentações
   - Cadastro
4. **Site**
   - Painel do site
   - Pedidos online
   - Produtos publicados
5. **Recursos Humanos**
   - Colaboradores
   - Ponto e jornada
   - Folha e pagamentos
6. **Financeiro**
   - Contas a pagar
   - Fluxo de caixa
   - Relatórios
7. **Vendas**
   - Faturamento das lojas
   - Indicadores e ranking
   - Metas
8. **Fiscal**
   - Notas fiscais
   - Relatórios fiscais
9. **Lojas**
   - Painel por loja
   - Estoque por loja
   - Transferências
10. **Configurações**
   - Rede e lojas
   - Usuários e permissões
   - Integrações e auditoria

Os nomes descrevem o negócio, não a estrutura técnica do código.

## Home Beta

A home usa dados reais e funciona como painel de orientação, não como catálogo de links.

### Cabeçalho

- saudação ao usuário;
- data e contexto de loja/rede;
- atualização manual;
- selo Beta persistente.

### Indicadores

- faturamento disponível da rede ou loja;
- pedidos que exigem ação;
- clientes ativos ou total de clientes, conforme endpoint disponível;
- alertas operacionais relevantes.

Quando um indicador não puder ser calculado de maneira confiável sem atingir o Giga ao vivo, ele será omitido ou exibirá `Dados indisponíveis`; nunca será inventado.

### Precisa da sua atenção

Reúne pendências já disponíveis nas APIs, como:

- pedidos do site pendentes;
- produtos não encontrados;
- materiais pendentes;
- remessas em trânsito ou paradas;
- integrações com falha.

Cada item leva ao destino operacional real.

### Acesso rápido

Mostra somente áreas úteis e autorizadas para o usuário. Clientes será uma área beta nativa; módulos ainda não migrados são identificados como sistema atual.

## Clientes no Beta

A lista existente será apresentada sob `/beta/clientes` dentro do novo shell. A prioridade é reusar os contratos de busca, filtros, paginação e escopo já validados.

- O clique principal abre `/beta/clientes/[id]`.
- A ficha antiga continua disponível como ação secundária.
- Busca, filtros e página são preservados ao voltar.
- O escopo continua sendo `originStoreId` ou `targetStoreId`.
- A ficha usa a visão única por `Person` já criada.
- A origem principal da pessoa privilegia seu primeiro cadastro físico válido, sem depender do registro usado para abrir a URL.

## Autorização

- O Beta usa a mesma autenticação JWT do sistema atual.
- Usuários de loja veem somente os dados autorizados por seu escopo.
- Administradores e operadores respeitam as regras existentes de rede.
- Crédito permanece editável somente por `admin`, com bloqueio no backend e auditoria.
- Menus e atalhos respeitam a função do usuário; esconder uma opção não substitui validação de backend.

## Estados e falhas

- Se o usuário não estiver autenticado, `/beta` direciona ao login atual com retorno para o Beta.
- Falha em um indicador não derruba a home inteira.
- Áreas em construção têm estado explícito e não simulam funcionalidade.
- Erros de rede oferecem nova tentativa.
- A home não consulta o Giga ao vivo.
- Loading preserva a estrutura para evitar saltos visuais.

## Arquitetura de frontend

- `frontend/src/app/beta/layout.tsx` — aplica o shell a todas as rotas Beta.
- `frontend/src/app/beta/page.tsx` — home Beta.
- `frontend/src/app/beta/clientes/page.tsx` — lista no novo ambiente.
- `frontend/src/app/beta/clientes/[id]/page.tsx` — ficha única.
- `frontend/src/components/beta/BetaShell.tsx` — barra superior, sidebar e drawer móvel.
- `frontend/src/components/beta/beta-navigation.ts` — configuração tipada do menu e destinos.
- componentes beta menores para cards, empty states e indicadores, evitando uma página monolítica.

O shell não será inserido no `RootLayout`; isso garante que nenhuma rota atual seja afetada.

## Entrega incremental

Esta primeira etapa entrega:

1. shell Shopify completo em `/beta`;
2. home Beta com dados reais disponíveis;
3. navegação real para Clientes;
4. lista e ficha única sob rotas canônicas `/beta/clientes`;
5. atalhos identificados para módulos atuais ainda não migrados;
6. responsividade e autorização por papel.

As demais áreas serão migradas uma a uma para dentro do mesmo núcleo, sem criar novas homes ou shells paralelos.

## Validação

- `/beta` funciona sem alterar `/`.
- Menu lateral e drawer móvel navegam corretamente.
- Apenas uma seção do menu fica expandida.
- Links ativos e contexto de loja são visíveis.
- Home tolera falha parcial dos endpoints.
- `/beta/clientes` preserva busca, filtros e paginação.
- `/beta/clientes/[id]` abre a ficha consolidada.
- Ficha antiga continua acessível.
- Usuário de loja não acessa cliente fora de `originStoreId` ou `targetStoreId`.
- Crédito continua restrito a administrador.
- TypeScript, build de frontend e testes focados passam.

## Fora do escopo

- Substituir a home atual.
- Alterar o PDV ou a Live Commerce.
- Aplicar o shell Beta às páginas atuais.
- Migrar todos os módulos nesta primeira etapa.
- Fazer leituras síncronas no Giga.
- Criar indicadores fictícios.
