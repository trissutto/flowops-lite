# Pedido de compra — primeira tela do Design System Lurd's

## Objetivo

Aplicar na tela `/loja/pedidos-compra/novo` o visual aprovado em marinho, branco e dourado, reduzindo a poluição visual sem remover nenhuma função operacional já existente.

## Tokens visuais

- Marinho principal: `#071A33`
- Marinho profundo: `#041225`
- Marinho intermediário: `#102A46`
- Dourado principal: `#D2B15B`
- Dourado escuro: `#9A7827`
- Dourado claro: `#FBF6E6`
- Branco: `#FFFFFF`
- Fundo de campo: `#F8FAFC`
- Texto principal: `#10243E`
- Texto secundário: `#64748B`
- Erro: `#BE123C`
- Sucesso financeiro: `#167347`

Os tokens ficam escopados em `.purchase-order-theme`, para não alterar telas antigas. Os padrões reutilizáveis são `po-panel`, `po-label`, `po-input`, `po-select`, `po-action`, `po-icon-action`, `po-price-card` e `po-grade-input`.

## Cabeçalho do pedido

- Fundo marinho, título branco e resumo em dourado suave.
- Botão de salvar dourado com texto marinho.
- Painel branco compacto para fornecedor e dados gerais.
- Primeira faixa: Fornecedor, Marca, Coleção, Data prevista e NF.
- Coleção passa a ser escolhida junto da marca na abertura do pedido e é aplicada às referências pendentes.
- Segunda faixa: Observações e fator padrão.

## Item de produto

- A primeira referência já aparece aberta ao iniciar um novo pedido.
- Cabeçalho compacto com total, Conferir, Etiquetas, Duplicar e Excluir.
- Primeira linha: REF em destaque e controle PLUS SIZE compacto.
- Segunda linha: Grupo, Subgrupo, Tecido, Modelagem e Ocasião.
- CFOP não aparece e continua preenchido com `5102`.
- NCM não aparece e continua preenchido pelo padrão/categoria válido já usado pelo sistema.
- Coleção deixa de aparecer dentro de cada item porque é definida no cabeçalho.
- Não incluir classificação Básico/Moda.

## Precificação

- Custo e Preço de Venda usam o mesmo padrão de destaque.
- Custo ocupa metade da largura visual reservada ao Preço de Venda.
- Desconto, Imposto e Fator ficam compactos.
- Líquido e Sugerido continuam calculados e visíveis.
- Preço de Venda é o campo dominante da faixa.
- Margens e totais permanecem disponíveis em uma linha secundária discreta.

## Grade e cores

- Preservar presets, tamanhos, cores, matriz cor × tamanho, totais e avisos.
- Unificar os presets no padrão marinho/dourado.
- Manter edição direta das quantidades e navegação por Enter.
- Ao confirmar, o item recolhe para a linha da REF já implementada.

## Responsividade e acessibilidade

- Desktop usa largura ampla para evitar campos gigantes e aproveitar a grade.
- Mobile empilha os grupos sem perder nenhuma ação.
- Campos mantêm rótulos visíveis, foco dourado e contraste AA.
- Ações por ícone mantêm `title` e rótulo acessível.

## Validação

- Build completo do frontend.
- Testes do acordeão de referências.
- Verificação das rotas Produto & Estoque.
- Inspeção visual desktop da tela vazia, item aberto e item recolhido.
- Confirmar que payload, estoque, etiquetas, totais e reabertura não mudaram.
