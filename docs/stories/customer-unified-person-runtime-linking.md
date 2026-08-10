# Story: Vinculação runtime da Cliente Única

Status: Ready for Review

## Objetivo

Resolver `Person` automaticamente nos novos cadastros de loja, WooCommerce, Giga e
live, sem bloquear vendas e sem unir pessoas por identificadores fracos.

## Critérios de aceite

- CPF passa por validação matemática antes de autorizar união.
- ID oficial do Instagram pode criar/vincular pessoa provisória.
- Telefone, nome e username isolados não unem pessoas.
- Operação é transacional, idempotente e auditada.
- Falha de identidade gera warning e não bloqueia o fluxo comercial.
- Build e regressão completa passam.

## Tarefas

- [x] Criar módulo e serviço central de identidade.
- [x] Integrar ecommerce nativo e WooCommerce.
- [x] Integrar Giga sem modificar loja+código.
- [x] Integrar webhook Meta e Live PDV.
- [x] Adicionar testes de regras fortes/fracas.

## Dev Agent Record

### Completion Notes

- `uniqueKey` protege identificadores oficiais contra corrida concorrente.
- Conflito concorrente de Instagram faz retry para a pessoa já existente.
- Todos os chamadores tratam falhas sem interromper venda, ETL ou live.

### File List

- `backend/prisma/schema.prisma`
- `backend/src/person-identity/person-identity.module.ts`
- `backend/src/person-identity/person-identity.service.ts`
- `backend/src/person-identity/person-identity.service.spec.ts`
- `backend/src/live/live.module.ts`
- `backend/src/live/meta-webhook.controller.ts`
- `backend/src/live-pdv/live-pdv.module.ts`
- `backend/src/live-pdv/live-pdv.service.ts`
- `backend/src/loja-orders/loja-orders.module.ts`
- `backend/src/loja-orders/loja-orders.service.ts`
- `backend/src/customers/customers.module.ts`
- `backend/src/customers/customers-etl.service.ts`
- `backend/src/customers/customers-giga-etl.service.ts`

### Change Log

- 2026-08-10: resolvedor central e integrações runtime multicanal.
