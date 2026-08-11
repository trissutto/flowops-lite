-- Rollback somente dos vínculos criados por um lote operacional.
-- Uso no psql: \set batch_id 'operational-2026-...'
-- Não remove nem altera vendas, parcelas, baixas, marcados ou seus valores.
BEGIN;

UPDATE giga_clientes t SET person_id = NULL
FROM person_link_audits a
WHERE a.batch_id = :'batch_id' AND a.entity_type = 'giga_cliente'
  AND t.loja = split_part(a.entity_id, '|', 1)
  AND t.codigo = split_part(a.entity_id, '|', 2)
  AND t.person_id = a.person_id;

UPDATE crediario_parcelas t SET person_id = NULL FROM person_link_audits a
WHERE a.batch_id = :'batch_id' AND a.entity_type = 'crediario_parcela'
  AND t.registro::text = a.entity_id AND t.person_id = a.person_id;

UPDATE crediario_baixas t SET person_id = NULL FROM person_link_audits a
WHERE a.batch_id = :'batch_id' AND a.entity_type = 'crediario_baixa'
  AND t.id::text = a.entity_id AND t.person_id = a.person_id;

UPDATE marcados t SET person_id = NULL FROM person_link_audits a
WHERE a.batch_id = :'batch_id' AND a.entity_type = 'marcado'
  AND t.id::text = a.entity_id AND t.person_id = a.person_id;

UPDATE orders t SET person_id = NULL FROM person_link_audits a
WHERE a.batch_id = :'batch_id' AND a.entity_type = 'order'
  AND t.id::text = a.entity_id AND t.person_id = a.person_id;

UPDATE pdv_sales t SET person_id = NULL FROM person_link_audits a
WHERE a.batch_id = :'batch_id' AND a.entity_type = 'pdv_sale'
  AND t.id::text = a.entity_id AND t.person_id = a.person_id;

UPDATE live_pdv_carts t SET person_id = NULL FROM person_link_audits a
WHERE a.batch_id = :'batch_id' AND a.entity_type = 'live_pdv_cart'
  AND t.id::text = a.entity_id AND t.person_id = a.person_id;

UPDATE customer_accounts t SET person_id = NULL FROM person_link_audits a
WHERE a.batch_id = :'batch_id' AND a.entity_type = 'customer_account'
  AND t.id::text = a.entity_id AND t.person_id = a.person_id;

DELETE FROM person_link_audits
WHERE batch_id = :'batch_id'
  AND entity_type IN ('giga_cliente','crediario_parcela','crediario_baixa','marcado',
                      'order','pdv_sale','live_pdv_cart','customer_account');

COMMIT;
