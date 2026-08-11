# Baseline de integridade de clientes

Controle somente leitura: não cria vínculos, corrige CPFs ou altera transações.

No diretório `backend`:

```bash
npm run customer-integrity:collect -- --output=artifacts/customer-before.json
npm run customer-integrity:compare -- --before=artifacts/customer-before.json --after=artifacts/customer-after.json
npm run customer-integrity:test
```

É necessário definir `DATABASE_PUBLIC_URL` ou `DATABASE_URL`. O snapshot existente nunca é sobrescrito. A comparação retorna código 1 se uma métrica protegida diminuir; tolerâncias ficam em `scripts/customer-integrity/config.json` e começam em zero.

Garantias: transação `BEGIN READ ONLY`, consultas validadas como `SELECT`, timeout de 120 segundos, nenhum dado pessoal no JSON, valores separados por status e cobertura de `personId` medida sem criar vínculos. O comando legado `customer-person:baseline` permanece compatível.
