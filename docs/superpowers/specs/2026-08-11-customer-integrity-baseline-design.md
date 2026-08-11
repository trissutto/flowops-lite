# Customer Integrity Baseline Design

Status: aprovado em 11/08/2026.

## Decisão

Adotar coletor manual/CI externo ao runtime NestJS. Ele abre transação PostgreSQL read-only, coleta somente agregados e compara snapshots por configuração versionada. Não cria endpoint, cron, tabela ou migration.

Fluxo: `Postgres -> SELECT agregado -> snapshot JSON -> comparação -> gate`.

O banco rejeita escrita; a aplicação rejeita SQL que não seja SELECT; snapshots não contêm PII nem são sobrescritos. Contagens e valores financeiros essenciais não podem diminuir. Cobertura de vínculos é observada sem bloquear seu crescimento.

Rollback: remover scripts e comandos. Não existe rollback de dados porque não há escrita no sistema.
