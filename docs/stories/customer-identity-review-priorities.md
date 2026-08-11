# Story: prioridades e histórico da revisão de identidade

Status: Ready for Review

## Objetivo

Adicionar filtros explicáveis e histórico reversível à fila manual já publicada, preservando a regra de que nenhuma identidade é confirmada automaticamente.

## Critérios de aceite

- Backend calcula prioridade e sinais sem persistir score.
- Fila filtra por prioridade, tipo, canal, estado do vínculo e nome.
- Ordenação padrão apresenta conflitos e casos de maior evidência primeiro.
- Histórico mostra decisão, ator, motivo, participantes, destino e rollback.
- Dados pessoais permanecem mascarados e acesso continua restrito à matriz.
- Nenhum novo caminho escreve em tabelas financeiras ou transacionais.

## Tarefas

- [x] Criar classificação, filtros e testes do backend.
- [x] Criar endpoint paginado do histórico.
- [x] Adicionar filtros, contadores e abas à interface.
- [x] Validar builds e regressão completa.

## Dev Agent Record

### File List

- `backend/src/customers/customer-identity-review.service.ts`
- `backend/src/customers/customer-identity-review.service.spec.ts`
- `backend/src/customers/customers-crm.controller.ts`
- `frontend/src/app/retaguarda/revisao-identidade/page.tsx`
- `docs/superpowers/specs/2026-08-10-customer-identity-review-priorities-design.md`
- `docs/superpowers/plans/2026-08-10-customer-identity-review-priorities-plan.md`

### Completion Notes

- Prioridade calculada no backend e nunca usada para decisão automática.
- Histórico protegido, mascarado e com rollback seguro.
- 45 testes, build backend e build frontend aprovados.

### Change Log

- 2026-08-11: implementação inicial concluída.
