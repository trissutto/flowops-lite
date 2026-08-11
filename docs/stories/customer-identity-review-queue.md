# Story: fila de revisão de identidade

Status: Ready for Review

## Objetivo

Permitir que a matriz confirme ou rejeite sugestões de mesma pessoa por telefone ou Instagram, sem mover, apagar ou reatribuir compras, parcelas, baixas ou marcados.

## Critérios de aceite

- Somente admin/operator acessa a fila e decide.
- Telefone e Instagram nunca geram vínculo automático.
- Confirmação altera exclusivamente `customers.person_id` e cria auditoria.
- Grupo conflitante, alterado ou já decidido é bloqueado.
- Motivo é obrigatório; rejeição some enquanto o conjunto não mudar.
- Confirmação pode ser desfeita sem sobrescrever vínculos posteriores.
- Há testes de normalização, agrupamento e invariância financeira por construção.

## Tarefas

- [x] Persistir decisões reversíveis.
- [x] Implementar serviço e endpoints protegidos.
- [x] Implementar tela de revisão na retaguarda.
- [x] Cobrir regras críticas com testes.
- [x] Validar Prisma, backend e frontend.
