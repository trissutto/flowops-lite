# Safe Customer → Person Backfill

Status: aprovado em 11/08/2026.

Vincula somente Customer sem `person_id` a Person por CPF matematicamente válido. Cada aplicação usa lote limitado e identificador único. O lote ocorre em uma transação; o baseline financeiro é coletado antes e depois e qualquer redução protegida causa rollback antes do commit.

O processo não atualiza CPF, vendas, pedidos, parcelas, baixas ou marcados. CPFs inválidos são ignorados; CPF já ligado a Persons diferentes bloqueia a execução. Cada vínculo cria identificador e auditoria com `batch_id`; o rollback existente remove somente vínculos do lote.
