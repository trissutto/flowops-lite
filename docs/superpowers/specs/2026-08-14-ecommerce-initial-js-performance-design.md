# Ecommerce — redução do JavaScript inicial

## Objetivo

Reduzir o JavaScript carregado antes da primeira interação nas páginas públicas do ecommerce, preservando a identidade visual, a jornada de compra, o rastreamento e a acessibilidade.

A linha de base observada no Lighthouse Treemap da produção é de aproximadamente 331,7 KiB transferidos em scripts. Os dois maiores chunks somam 101,5 KiB e os quatro maiores somam 145,4 KiB. O código atual usa Framer Motion em 40 arquivos e mantém componentes globais interativos — minissacola, consultora virtual, cupom, notificações e rastreamento — no layout público.

## Estratégia aprovada

Aplicar uma otimização cirúrgica. Funcionalidades secundárias deixam de participar do carregamento inicial e animações simples passam a usar CSS. Framer Motion permanece onde o movimento editorial ou a interação complexa justificarem seu custo.

Não será realizada uma remoção indiscriminada de bibliotecas nem uma reestruturação ampla das páginas.

## Escopo

### Carregamento sob demanda

- Carregar a consultora virtual apenas depois de intenção do usuário ou em período ocioso, sem bloquear o conteúdo principal.
- Carregar o cupom de boas-vindas após o carregamento essencial e somente quando suas regras indicarem que ele pode aparecer.
- Carregar o assistente de tamanho somente quando a cliente solicitar ajuda.
- Avaliar busca, minissacola, quick-add e overlays para que a interface inicial não importe implementações pesadas antes da interação.
- Preservar feedback imediato no primeiro clique por meio de estados leves e acessíveis.

### Animações

- Substituir animações simples de opacidade, deslocamento e expansão em componentes globais por CSS.
- Manter Framer Motion em movimentos editoriais ou coordenados cujo comportamento não seja reproduzido com clareza por CSS.
- Respeitar `prefers-reduced-motion` em todas as animações mantidas ou substituídas.
- Evitar que componentes globais importem Framer Motion apenas para transições decorativas.

### Fronteiras client/server

- Revisar componentes marcados com `use client` que participam das rotas inicial, categoria, produto, sacola e checkout.
- Manter no servidor conteúdo estático, textos, estrutura e dados que não dependam do navegador.
- Isolar estado e eventos em componentes-client pequenos, próximos do controle que realmente precisa deles.
- Não transformar páginas inteiras em componentes-client para facilitar uma otimização local.

### Dependências e ícones

- Não remover `lucide-react` apenas pela quantidade de imports; validar o resultado do tree-shaking no build.
- Não adicionar dependências de animação, carregamento ou análise sem necessidade comprovada.
- Tratar React, React DOM e runtime obrigatório do Next.js como custo de base, separando-os do código opcional da loja.

## Componentes prioritários

1. Layout público e providers globais.
2. `AssistenteWidget`.
3. `CupomBoasVindas`.
4. `FitAssistant`.
5. `MiniCart` e seus overlays.
6. Busca e menu mobile.
7. `QuickAddSheet`.
8. Animações globais de toast, barra promocional e progresso de frete.

## Comportamento e dados

- A sacola persistida deve continuar disponível no primeiro acesso e após recarregar a página.
- Adiar a interface da minissacola não pode adiar ou perder a restauração dos itens.
- O rastreamento de visualização de página e consentimento não será condicionado ao carregamento dos widgets comerciais.
- Eventos de abertura, interação e conversão dos componentes adiados devem continuar sendo enviados uma única vez.
- O cupom e a consultora não podem reaparecer incorretamente por causa do carregamento tardio.

## Estados e tratamento de erro

- Falha ao carregar consultora, cupom ou assistente de tamanho não pode afetar navegação, produto, sacola ou checkout.
- Componentes carregados sob demanda devem falhar de forma silenciosa quando forem opcionais ou mostrar uma alternativa curta quando a ação tiver sido solicitada pelo usuário.
- A primeira interação não pode produzir tela vazia, clique perdido ou interface travada.
- Importações dinâmicas devem ter fallback visual proporcional, sem deslocamento relevante de layout.

## Acessibilidade

- Preservar nomes acessíveis, foco, navegação por teclado e encerramento dos diálogos.
- Ao abrir um componente sob demanda, transferir foco somente quando isso já fizer parte do comportamento esperado.
- Controles disparadores devem continuar presentes e compreensíveis antes do carregamento do conteúdo pesado.
- Transições em CSS e Framer Motion devem respeitar redução de movimento.

## Medição e critérios de sucesso

Executar medições em build de produção para:

- home;
- categoria;
- produto;
- sacola;
- checkout.

Registrar, quando as ferramentas disponíveis permitirem:

- JavaScript inicial transferido;
- chunks compartilhados;
- quantidade de JavaScript não utilizado;
- tempo de bloqueio da thread principal;
- LCP, INP/TBT e CLS;
- presença dos componentes adiados antes e depois da interação.

A meta orientadora é reduzir os aproximadamente 331,7 KiB para menos de 250–270 KiB nas páginas públicas mais pesadas. Essa faixa não é um critério absoluto: a entrega será aceita quando houver redução mensurável, ausência de regressão e justificativa verificável para o JavaScript restante.

## Verificação

- Executar auditoria de links, lint, testes, typecheck e build dentro de `ecommerce`.
- Adicionar ou ajustar testes para regras de carregamento tardio e fallbacks.
- Validar desktop e mobile nas cinco rotas prioritárias.
- Verificar teclado, foco e `prefers-reduced-motion` nos componentes alterados.
- Confirmar persistência da sacola e ausência de duplicidade nos eventos relevantes.
- Comparar o treemap ou relatório de bundle antes e depois.
- Revisar o diff e preservar alterações não relacionadas existentes no repositório.

## Fora de escopo

- Alterações no gateway, PIX, cartão, webhooks ou confirmação de pedidos.
- Mudanças de catálogo, preço, estoque ou banco de dados.
- Reestruturação visual ampla das páginas.
- Deploy em Vercel, Railway ou alteração direta da branch `main`.
- Remoção total de Framer Motion sem evidência de benefício e testes de regressão.

## Entrega

A implementação será dividida em mudanças pequenas e verificáveis, mantendo o build utilizável a cada etapa. O relatório final apresentará arquivos alterados, medições antes/depois, testes executados, riscos restantes e instruções seguras para revisão e deploy.
