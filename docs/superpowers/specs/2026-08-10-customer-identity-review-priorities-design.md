# Filtros de prioridade e histórico da revisão de identidade

Data: 2026-08-10
Status: aprovado para planejamento

## Objetivo

Tornar a revisão manual mais rápida e rastreável sem transformar telefone ou Instagram em chaves automáticas de identidade. A operação continuará exclusivamente humana, motivada, auditada e reversível.

## Alternativas consideradas

1. Persistir uma pontuação em cada sugestão. Facilita consultas, mas cria sincronização e dados obsoletos quando clientes mudam.
2. Calcular tudo no navegador. É simples, porém limita paginação, duplica regras e exige enviar mais dados.
3. Calcular prioridade no backend e persistir somente decisões. É a opção escolhida: uma regra única, dados sempre atuais e nenhuma nova fonte de verdade.

## Classificação

Cada grupo pendente receberá `priority`, `score` e `signals`. A pontuação serve apenas para ordenação e explicação; nunca confirma um vínculo.

- `high`: nome normalizado igual e pelo menos um reforço seguro visível no conjunto, como e-mail normalizado igual, relação Site/Live ou histórico coincidente.
- `review`: telefone ou Instagram coincide, mas faltam reforços suficientes.
- `conflict`: mais de uma `Person` já vinculada, nomes claramente divergentes ou dados fiscais incompatíveis.
- `partial`: exatamente uma `Person` já existe e ainda há `Customer` sem vínculo; aparece como sinal adicional, não como decisão.

Sinais retornados: nomes iguais, e-mails iguais, Site/Live, histórico presente, vínculo parcial, conflito de Person e divergência de CPF. Dados pessoais continuam mascarados.

## Filtros da fila

O endpoint aceitará `priority`, `type`, `channel`, `linkState`, `search`, `page` e `limit`. A ordenação padrão será conflito, alta confiança e revisão, com maior score primeiro. A tela exibirá contadores por classe, chips de filtro e busca por nome mascarado/visível conforme a permissão já existente.

Filtros previstos:

- Alta confiança, precisa conferir e conflito.
- Telefone ou Instagram.
- Site + Live.
- Sem pessoa ou parcialmente vinculada.
- Busca por nome.

## Histórico de decisões

Novo endpoint paginado de leitura sobre `PersonReviewDecision`:

- decisão, data, ator e motivo;
- tipo e identificador mascarado;
- participantes preservados no snapshot;
- pessoa de destino;
- estado de rollback e quantidade restaurável.

A tela terá abas `Pendentes` e `Histórico`. Confirmações ainda válidas poderão ser desfeitas pelo endpoint existente, com confirmação explícita. Rejeições e rollbacks serão somente leitura. O histórico não exibirá identificadores completos.

## Concorrência e erros

- A fila é recalculada no backend antes de cada decisão.
- Mudança no conjunto bloqueia a decisão e pede atualização.
- Decisão feita em outra sessão desaparece na próxima atualização.
- Rollback não sobrescreve vínculos alterados depois da decisão.
- Filtros não mantêm cache autoritativo.

## Testes

- Pontuação e classes para nomes/e-mails iguais, Site/Live, vínculo parcial e conflitos.
- Filtros, ordenação e paginação.
- Histórico mascarado e protegido por matriz.
- Rollback disponível somente para confirmação ativa.
- Invariância: nenhum caminho novo escreve em pedidos, vendas, parcelas, baixas ou marcados.

## Fora de escopo

- Confirmação automática ou em massa.
- Transferência, exclusão ou fusão de `Customer`.
- Alteração de compras, crediário, baixas, marcados ou valores.
- Propagação de `personId` para transações operacionais; isso será uma fase separada.
