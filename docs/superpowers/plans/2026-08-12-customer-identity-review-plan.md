# Plano de implementação — revisão conservadora de identidade

## Resultado esperado

Completar a fila de revisão já existente para considerar e-mail exato, excluir contas internas e provar por testes que nenhuma sugestão produz vínculo automático ou alteração financeira.

## Etapa 1 — normalização e classificação

- Adicionar `email` ao tipo de sugestão.
- Implementar normalização conservadora de e-mail.
- Centralizar a identificação de contas internas.
- Testar telefones, e-mails, Instagram, conflitos de CPF e contas internas.

Arquivos:

- `backend/src/customers/customer-identity-review.service.ts`
- `backend/src/customers/customer-identity-review.service.spec.ts`

## Etapa 2 — geração segura da fila

- Incluir e-mail nos campos consultados e nos buckets de correspondência.
- Excluir contas internas antes da formação dos grupos.
- Manter como requisito pelo menos dois participantes e um participante sem `personId`.
- Não mudar o fluxo de confirmação: somente `Customer.personId` e auditoria.

## Etapa 3 — interface administrativa

- Adicionar e-mail ao filtro e ao badge de tipo.
- Exibir o valor correspondente de forma mascarada.
- Manter conflitos bloqueados e motivo obrigatório.

Arquivo:

- `frontend/src/app/retaguarda/revisao-identidade/page.tsx`

## Etapa 4 — validação

- Executar testes unitários do serviço.
- Executar build do backend.
- Executar verificação TypeScript/build do frontend na medida suportada pelo projeto.
- Rodar auditoria de integridade somente leitura e confirmar totais financeiros inalterados.
- Fazer dry-run dos vínculos operacionais e confirmar zero aplicação implícita.

## Etapa 5 — entrega

- Revisar diff e preservar arquivos não relacionados.
- Commitar apenas especificação, plano, código e testes deste escopo.
- Fazer push da branch.
- Entregar link de PR para revisão e deploy manual.

