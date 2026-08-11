# Plano de implementação — fila de revisão de identidade

## 1. Persistência e contratos

- Adicionar `PersonReviewDecision` ao Prisma com decisão, hash da sugestão, participantes, estado anterior, operador e rollback.
- Criar índices para status, tipo, hash e data.
- Validar schema e regenerar Prisma Client.

## 2. Serviço de candidatos

- Implementar normalização e hash estável de telefone e Instagram.
- Consultar somente grupos com dois ou mais Customers e pelo menos um sem `personId`.
- Excluir rejeições cujo conjunto de participantes ainda seja idêntico.
- Retornar dados mascarados, origem, loja e resumo comercial.

## 3. Decisões transacionais

- Confirmar grupo após recalculá-lo e validar concorrência.
- Reusar Person existente, criar provisória ou bloquear conflito entre Persons.
- Atualizar somente `customers.personId` e criar `PersonLinkAudit`.
- Rejeitar com justificativa e impedir reapresentação do mesmo conjunto.
- Implementar rollback dos vínculos criados pela decisão.

## 4. API e autorização

- Expor listagem, detalhe, confirmação, rejeição e rollback em `/customers-crm/identity-review`.
- Aplicar autenticação e `AdminOnly` em todas as rotas.
- Colocar rotas específicas antes de `/:id` para evitar colisões no NestJS.

## 5. Interface

- Criar página de revisão na retaguarda.
- Mostrar filtros, contadores, comparação lado a lado, evidências e alertas financeiros.
- Exigir justificativa para confirmar/rejeitar e atualizar a fila sem recarregar a página.
- Exibir estados de carregamento, conflito, vazio e erro.

## 6. Verificação

- Testar normalização, agrupamento, autorização, confirmação, rejeição, conflito, concorrência e rollback.
- Validar que tabelas financeiras não são alteradas.
- Rodar Prisma validate/generate, testes e builds de backend/frontend.
- Revisar diff, commit, push e abrir PR sem executar decisões automáticas em produção.
