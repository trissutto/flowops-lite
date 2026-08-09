# Decision log — Produto & Estoque

Data: 2026-08-08

## Decisão

Criar um módulo unificado em `/retaguarda/produto-estoque`, mantendo todas as
rotas antigas operacionais e reutilizando seus componentes de página. A ficha
Produto Master é a base da área Produtos; Editor de Produtos, Fila da Ficha e
Classificação BÁSICO/MODA aparecem como modos complementares do mesmo módulo.

Os fluxos de nascimento, reposição, etiquetas, realinhamento e auditoria
continuam em suas próprias rotas e são acessados por hubs organizados por
objetivo. Nenhuma tela antiga será removida ou redirecionada.

## Motivo

- preserva todas as funções já validadas em produção;
- reduz o risco de duplicar regras de estoque, preço e movimentação;
- cria uma entrada única sem impedir os fluxos especializados;
- permite evolução incremental da interface sem migração destrutiva.

## Rotas novas

- `/retaguarda/produto-estoque/produtos`
- `/retaguarda/produto-estoque/produtos/grade-geral`
- `/retaguarda/produto-estoque/produtos/pendencias`
- `/retaguarda/produto-estoque/produtos/classificacao`
- `/retaguarda/produto-estoque/entradas`
- `/retaguarda/produto-estoque/estoque`
- `/retaguarda/produto-estoque/inteligencia`
- `/retaguarda/produto-estoque/cadastros`

## Compatibilidade e rollback

O ponto de retorno anterior à implementação é o commit `1e6814e`. As telas
anteriores permanecem acessíveis pelos mesmos URLs e também continuam listadas
nos hubs existentes. O novo módulo é aditivo.

## Baseline técnico

- frontend e backend compilavam antes da mudança;
- o lint do frontend não tinha configuração e iniciava um prompt interativo;
- o Jest do backend tentava executar artefatos compilados de `dist` e não
  transformava corretamente os testes TypeScript.

O Jest é corrigido junto da implementação. Como o frontend legado ainda não
possui ESLint configurado e ativá-lo revela uma quantidade grande de pendências
fora deste escopo, esta entrega usa `tsc --noEmit`, o build de produção e um
teste de integridade específico do módulo como gates repetíveis.
