# Plano de implementação

1. Extrair normalização e classificação determinística no serviço de revisão.
2. Aplicar filtros e ordenação antes da paginação, retornando contadores globais.
3. Criar leitura paginada e mascarada de `PersonReviewDecision`.
4. Expor a rota específica antes das rotas parametrizadas.
5. Evoluir a página com abas, chips, busca, filtros e rollback.
6. Cobrir classificação e mascaramento com testes unitários.
7. Executar Prisma validate, Jest completo e builds backend/frontend.
