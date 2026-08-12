const { Client } = require('pg');

async function financialBaseline(client) {
  const { rows } = await client.query(`SELECT json_build_object(
    'parcelasCount',(SELECT count(*)::text FROM crediario_parcelas),
    'parcelasAmount',(SELECT round(coalesce(sum(valor_parcela),0)::numeric,2)::text FROM crediario_parcelas WHERE NOT cancelado),
    'baixasCount',(SELECT count(*)::text FROM crediario_baixas),
    'baixasAmount',(SELECT round(coalesce(sum(total_pago),0)::numeric,2)::text FROM crediario_baixas WHERE status='paid'),
    'marcadosCount',(SELECT count(*)::text FROM marcados),
    'marcadosAmount',(SELECT round(coalesce(sum(valor_total),0)::numeric,2)::text FROM marcados),
    'salesCount',(SELECT count(*)::text FROM pdv_sales),
    'salesAmount',(SELECT round(coalesce(sum(total),0)::numeric,2)::text FROM pdv_sales WHERE status='finalized' AND NOT is_training)
  ) AS value`);
  return rows[0].value;
}

async function conflicts(client, entityType) {
  const { rows } = await client.query(`SELECT count(*)::int AS count FROM (
    SELECT entity_id FROM person_link_audits WHERE entity_type=$1
    GROUP BY entity_id HAVING count(DISTINCT person_id)>1
  ) c`, [entityType]);
  return rows[0].count;
}

async function main() {
  if (process.env.PERSON_LINK_RECOVERY_ENABLED !== '1') throw new Error('Restauração bloqueada: defina PERSON_LINK_RECOVERY_ENABLED=1');
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_PUBLIC_URL ou DATABASE_URL ausente');
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query("SET LOCAL statement_timeout='180s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('customer-person-recovery'))");
    const before = await financialBaseline(client);

    const [gigaConflicts, parcelaConflicts] = await Promise.all([
      conflicts(client, 'giga_cliente'), conflicts(client, 'crediario_parcela'),
    ]);
    if (gigaConflicts || parcelaConflicts) throw new Error(`Conflitos bloqueantes: giga=${gigaConflicts}, parcelas=${parcelaConflicts}`);

    const giga = await client.query(`UPDATE giga_clientes t SET person_id=a.person_id
      FROM (SELECT entity_id,min(person_id) person_id FROM person_link_audits
             WHERE entity_type='giga_cliente' GROUP BY entity_id HAVING count(DISTINCT person_id)=1) a
      WHERE concat_ws('|',t.loja,t.codigo)=a.entity_id AND t.person_id IS NULL`);
    const parcelas = await client.query(`UPDATE crediario_parcelas t SET person_id=a.person_id
      FROM (SELECT entity_id,min(person_id) person_id FROM person_link_audits
             WHERE entity_type='crediario_parcela' GROUP BY entity_id HAVING count(DISTINCT person_id)=1) a
      WHERE t.registro::text=a.entity_id AND t.person_id IS NULL`);

    const after = await financialBaseline(client);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`PORTÃO FINANCEIRO FALHOU: ${JSON.stringify({ before, after })}`);
    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, restored: { giga: giga.rowCount, parcelas: parcelas.rowCount }, financialGate: 'PASS', baseline: after }, null, 2));
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { await client.end(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
