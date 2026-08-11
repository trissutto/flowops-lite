# Implantação da base única de clientes

## Garantias

- `Person` consolida a identidade; os cadastros operacionais (`Customer` e Giga) são preservados.
- Crediário, baixas e marcados são ligados somente por `loja + codCliente`.
- Nenhuma parcela, baixa, venda, marcado, valor ou identificador legado é regravado.
- Os scripts são `dry-run` por padrão, idempotentes e auditados por lote.
- A implantação deve parar se o portão financeiro divergir.

## Ordem obrigatória

1. Criar snapshot restaurável do PostgreSQL e registrar horário/checksum.
2. Implantar o schema e a aplicação sem habilitar qualquer backfill.
3. Executar `npm run customer-person:baseline` e guardar o JSON.
4. Executar `npm run customer-person:backfill` sem `--apply`.
5. Aplicar a fundação com um `CUSTOMER_PERSON_BATCH_ID` único, `--apply` e a trava `CUSTOMER_PERSON_BACKFILL_ENABLED=1`.
6. Executar `npm run customer-person:operational` sem `--apply`; revisar `unlinked`, `candidates` e `unresolved` por entidade.
7. Aplicar o lote operacional com `--apply` e `CUSTOMER_PERSON_OPERATIONAL_ENABLED=1`.
8. Repetir baseline, conciliar amostras de todas as lojas e confirmar diferença financeira igual a zero.

## Critérios de parada

- Qualquer diferença em quantidade ou valor de crediário, baixas, marcados ou vendas.
- Um CPF válido resolvido para mais de uma pessoa.
- Vínculo de crediário/marcado sem correspondência exata de loja e código do cliente.
- Crescimento inesperado de `unresolved` entre diagnóstico e aplicação.

## Rollback

O arquivo `backend/scripts/customer-person/rollback-operational.sql` desfaz somente os `person_id` do lote informado e apaga as auditorias correspondentes. Ele não exclui dados operacionais. A fundação de Customers tem rollback separado em `rollback-links.sql`.

Após rollback, executar novamente o baseline e comparar com o snapshot registrado antes da implantação.
