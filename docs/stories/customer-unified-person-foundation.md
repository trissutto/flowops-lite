# Story: Fundação da Cliente Única Multicanal

Status: Ready for Review

## Objetivo

Criar a fundação aditiva e reversível da identidade `Person`, preservando integralmente
cadastros, crediário, marcados, vendas e chaves do Giga.

## Critérios de aceite

- Novas tabelas de pessoa, identificadores e auditoria existem no Prisma.
- `personId` é opcional, indexado e restritivo nos domínios críticos.
- Não há delete, renumeração ou atualização financeira na migração.
- Baseline e rollback são read-only/aditivos e idempotentes.
- Testes cobrem normalização, integridade e não regressão.
- Nenhuma alteração é aplicada em produção sem snapshot e portões aprovados.

## Tarefas

- [x] Modelar schema aditivo.
- [x] Criar baseline financeiro e script de backfill sombra.
- [x] Criar rollback de vínculos.
- [x] Adicionar testes e executar validações.
- [x] Documentar operação e riscos restantes.

## Dev Agent Record

### Completion Notes

- Schema Prisma válido com relações restritivas e campos opcionais.
- Backfill opera em dry-run por padrão e exige dupla habilitação para escrever.
- Baseline de produção executado em transação read-only; nenhum dado alterado.
- Backfill financeiro por loja+código permanece para a próxima onda, após snapshot.
- CodeRabbit indisponível no host WSL (`bash` ausente); revisão manual e `git diff --check` concluídos.

### File List

- `backend/prisma/schema.prisma`
- `backend/src/person-identity/identity-normalization.ts`
- `backend/src/person-identity/identity-normalization.spec.ts`
- `backend/scripts/customer-person/baseline.js`
- `backend/scripts/customer-person/backfill-shadow.js`
- `backend/scripts/customer-person/rollback-links.sql`
- `backend/package.json`
- `docs/superpowers/plans/2026-08-10-unified-customer-person-implementation.md`

### Change Log

- 2026-08-10: fundação aditiva, baseline, backfill sombra, rollback e testes.
