-- Reverte SOMENTE vínculos de um lote; não toca movimentos ou chaves históricas.
-- Execute dentro de transação e substitua :batch_id pelo identificador auditado.
BEGIN;

CREATE TEMP TABLE rollback_person_links AS
SELECT person_id, entity_id
FROM person_link_audits
WHERE batch_id = :'batch_id' AND entity_type = 'customer';

UPDATE customers c
SET person_id = NULL
FROM rollback_person_links r
WHERE c.id = r.entity_id AND c.person_id = r.person_id;

DELETE FROM person_identifiers i
USING rollback_person_links r
WHERE i.person_id = r.person_id
  AND i.source_customer_id = r.entity_id
  AND i.source = 'customer_backfill';

DELETE FROM person_link_audits WHERE batch_id = :'batch_id';

-- Pessoas sem qualquer vínculo podem ser removidas; Restrict impede perda acidental.
DELETE FROM persons p
WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.person_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM person_identifiers i WHERE i.person_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM person_link_audits a WHERE a.person_id = p.id);

COMMIT;
