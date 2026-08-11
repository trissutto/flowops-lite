/*
 * Backfill histórico de person_id. Dry-run por padrão.
 * Aplicação exige --apply e CUSTOMER_PERSON_OPERATIONAL_ENABLED=1.
 * Crediário/marcados usam exclusivamente loja+codCliente via giga_clientes.
 */
const { Client } = require('pg');

const BATCH_SIZE = Math.max(100, Math.min(5000, Number(process.env.CUSTOMER_PERSON_BATCH_SIZE || 1000)));
const BATCH_ID = process.env.CUSTOMER_PERSON_BATCH_ID || null;

const targets = [
  {
    name: 'giga_cliente', table: 'giga_clientes', key: ['loja', 'codigo'], rule: 'store_customer_code_exact',
    select: `SELECT g.loja, g.codigo, c.person_id
      FROM giga_clientes g
      JOIN customer_giga_links l
        ON l.giga_loja = lpad(btrim(g.loja), 2, '0')
       AND l.giga_codigo::text = coalesce(nullif(ltrim(btrim(g.codigo), '0'), ''), '0')
      JOIN customers c ON c.id = l.customer_id
      WHERE g.person_id IS NULL AND c.person_id IS NOT NULL`,
  },
  {
    name: 'crediario_parcela', table: 'crediario_parcelas', key: ['registro'], rule: 'store_customer_code_exact',
    select: `SELECT p.registro, coalesce(g.person_id, c.person_id) AS person_id
      FROM crediario_parcelas p
      JOIN giga_clientes g
        ON lpad(btrim(p.loja), 2, '0') = lpad(btrim(g.loja), 2, '0')
       AND coalesce(nullif(ltrim(btrim(p.cod_cliente), '0'), ''), '0')
         = coalesce(nullif(ltrim(btrim(g.codigo), '0'), ''), '0')
      LEFT JOIN customer_giga_links l
        ON l.giga_loja = lpad(btrim(g.loja), 2, '0')
       AND l.giga_codigo::text = coalesce(nullif(ltrim(btrim(g.codigo), '0'), ''), '0')
      LEFT JOIN customers c ON c.id = l.customer_id
      WHERE p.person_id IS NULL AND coalesce(g.person_id, c.person_id) IS NOT NULL`,
  },
  {
    name: 'crediario_baixa', table: 'crediario_baixas', key: ['id'], rule: 'store_customer_code_exact',
    select: `SELECT b.id, coalesce(g.person_id, c.person_id) AS person_id
      FROM crediario_baixas b
      JOIN giga_clientes g
        ON lpad(btrim(b.loja_code), 2, '0') = lpad(btrim(g.loja), 2, '0')
       AND coalesce(nullif(ltrim(btrim(b.cod_cliente), '0'), ''), '0')
         = coalesce(nullif(ltrim(btrim(g.codigo), '0'), ''), '0')
      LEFT JOIN customer_giga_links l
        ON l.giga_loja = lpad(btrim(g.loja), 2, '0')
       AND l.giga_codigo::text = coalesce(nullif(ltrim(btrim(g.codigo), '0'), ''), '0')
      LEFT JOIN customers c ON c.id = l.customer_id
      WHERE b.person_id IS NULL AND coalesce(g.person_id, c.person_id) IS NOT NULL`,
  },
  {
    name: 'marcado', table: 'marcados', key: ['id'], rule: 'store_customer_code_exact',
    select: `SELECT m.id, coalesce(g.person_id, c.person_id) AS person_id
      FROM marcados m
      JOIN giga_clientes g
        ON lpad(btrim(m.store_code), 2, '0') = lpad(btrim(g.loja), 2, '0')
       AND coalesce(nullif(ltrim(btrim(m.cod_cliente), '0'), ''), '0')
         = coalesce(nullif(ltrim(btrim(g.codigo), '0'), ''), '0')
      LEFT JOIN customer_giga_links l
        ON l.giga_loja = lpad(btrim(g.loja), 2, '0')
       AND l.giga_codigo::text = coalesce(nullif(ltrim(btrim(g.codigo), '0'), ''), '0')
      LEFT JOIN customers c ON c.id = l.customer_id
      WHERE m.person_id IS NULL AND coalesce(g.person_id, c.person_id) IS NOT NULL`,
  },
  {
    name: 'order', table: 'orders', key: ['id'], rule: 'valid_cpf_exact',
    select: `SELECT o.id, p.id AS person_id
      FROM orders o JOIN persons p
        ON p.cpf_normalized = regexp_replace(coalesce(o.customer_cpf, ''), '\\D', '', 'g')
      WHERE o.person_id IS NULL`,
  },
  {
    name: 'pdv_sale', table: 'pdv_sales', key: ['id'], rule: 'valid_cpf_exact',
    select: `SELECT s.id, p.id AS person_id
      FROM pdv_sales s JOIN persons p
        ON p.cpf_normalized = regexp_replace(coalesce(s.customer_cpf, ''), '\\D', '', 'g')
      WHERE s.person_id IS NULL`,
  },
  {
    name: 'live_pdv_cart', table: 'live_pdv_carts', key: ['id'], rule: 'customer_person_link',
    select: `SELECT l.id, c.person_id
      FROM live_pdv_carts l JOIN customers c ON c.id = l.customer_id
      WHERE l.person_id IS NULL AND c.person_id IS NOT NULL`,
  },
  {
    name: 'customer_account', table: 'customer_accounts', key: ['id'], rule: 'valid_cpf_exact',
    select: `SELECT a.id, p.id AS person_id
      FROM customer_accounts a JOIN persons p
        ON p.cpf_normalized = regexp_replace(coalesce(a.cpf, ''), '\\D', '', 'g')
      WHERE a.person_id IS NULL`,
  },
];

function assertIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Identificador SQL inválido: ${value}`);
  return `"${value}"`;
}

async function financialBaseline(client) {
  const { rows } = await client.query(`SELECT json_build_object(
    'parcelas', (SELECT count(*) FROM crediario_parcelas),
    'parcelasValor', (SELECT round(coalesce(sum(valor_parcela),0)::numeric,2)::text FROM crediario_parcelas WHERE NOT cancelado),
    'baixas', (SELECT count(*) FROM crediario_baixas),
    'baixasValor', (SELECT round(coalesce(sum(total_pago),0)::numeric,2)::text FROM crediario_baixas WHERE status='paid'),
    'marcados', (SELECT count(*) FROM marcados),
    'marcadosValor', (SELECT round(coalesce(sum(valor_total),0)::numeric,2)::text FROM marcados),
    'vendas', (SELECT count(*) FROM pdv_sales),
    'vendasValor', (SELECT round(coalesce(sum(total),0)::numeric,2)::text FROM pdv_sales WHERE status='finalized' AND NOT is_training)
  ) AS value`);
  return rows[0].value;
}

async function countCandidates(client, target) {
  const { rows } = await client.query(`SELECT
    (SELECT count(*)::int FROM ${assertIdentifier(target.table)} WHERE person_id IS NULL) AS unlinked,
    (SELECT count(*)::int FROM (${target.select}) candidate) AS candidates`);
  return { unlinked: rows[0].unlinked, candidates: rows[0].candidates,
    unresolved: rows[0].unlinked - rows[0].candidates };
}

async function countAmbiguous(client, target) {
  const keys = target.key.map(assertIdentifier).join(',');
  const { rows } = await client.query(`SELECT count(*)::int ambiguous FROM (
    SELECT ${keys} FROM (${target.select}) candidate
    GROUP BY ${keys} HAVING count(DISTINCT person_id) > 1
  ) conflicts`);
  return rows[0].ambiguous;
}

async function applyTarget(client, target) {
  let updated = 0;
  const table = assertIdentifier(target.table);
  const keys = target.key.map(assertIdentifier);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    const before = await financialBaseline(client);
    while (true) {
    const order = target.key.map((_, index) => index + 1).join(',');
    const { rows } = await client.query(`${target.select} ORDER BY ${order} LIMIT $1`, [BATCH_SIZE]);
    if (!rows.length) break;
      const width = target.key.length + 1;
      const params = [];
      const valueSql = rows.map((row, rowIndex) => {
        params.push(row.person_id, ...target.key.map((key) => row[key]));
        return `(${Array.from({ length: width }, (_, col) => `$${rowIndex * width + col + 1}`).join(',')})`;
      }).join(',');
      params.push(target.name, target.rule, BATCH_ID);
      const personParam = width * rows.length + 1;
      const ruleParam = personParam + 1;
      const batchParam = ruleParam + 1;
      const batchColumns = ['person_id', ...target.key].map(assertIdentifier).join(',');
      const join = keys.map((key) => `t.${key}=b.${key}`).join(' AND ');
      const entity = target.key.map((key) => `b.${assertIdentifier(key)}::text`).join(", '|' ,");
      const result = await client.query(`WITH batch(${batchColumns}) AS (VALUES ${valueSql}),
        changed AS (
          UPDATE ${table} t SET person_id=b.person_id FROM batch b
          WHERE ${join} AND t.person_id IS NULL
          RETURNING t.person_id, ${target.key.map((key) => `t.${assertIdentifier(key)}`).join(',')}
        )
        INSERT INTO person_link_audits
          (id, person_id, entity_type, entity_id, rule, confidence, automatic, batch_id, created_at)
        SELECT gen_random_uuid(), b.person_id, $${personParam}, concat_ws('|', ${entity}),
          $${ruleParam}, 100, true, $${batchParam}, now()
        FROM batch b JOIN changed c ON ${keys.map((key) => `c.${key}=b.${key}`).join(' AND ')}
        ON CONFLICT (person_id, entity_type, entity_id, rule) DO NOTHING
        RETURNING entity_id`, params);
      updated += result.rowCount;
    }
    const after = await financialBaseline(client);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`PORTAO FINANCEIRO FALHOU em ${target.name}`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return updated;
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (apply && process.env.CUSTOMER_PERSON_OPERATIONAL_ENABLED !== '1') {
    throw new Error('Aplicação bloqueada: defina CUSTOMER_PERSON_OPERATIONAL_ENABLED=1');
  }
  if (apply && (!BATCH_ID || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,79}$/.test(BATCH_ID))) {
    throw new Error('Aplicacao exige CUSTOMER_PERSON_BATCH_ID unico');
  }
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL ausente');
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("SET statement_timeout = '120s'");
    if (apply) {
      const reused = await client.query('SELECT 1 FROM person_link_audits WHERE batch_id=$1 LIMIT 1', [BATCH_ID]);
      if (reused.rowCount) throw new Error(`batch-id ja utilizado: ${BATCH_ID}`);
    }
    const before = await financialBaseline(client);
    const report = { mode: apply ? 'apply' : 'dry-run', batchId: BATCH_ID, batchSize: BATCH_SIZE, targets: {} };
    let totalAmbiguous = 0;
    for (const target of targets) {
      const counts = await countCandidates(client, target);
      const ambiguous = await countAmbiguous(client, target);
      totalAmbiguous += ambiguous;
      report.targets[target.name] = { ...counts, ambiguous, updated: 0 };
    }
    if (totalAmbiguous) throw new Error(`Aplicacao bloqueada: ${totalAmbiguous} chave(s) ambigua(s)`);
    if (apply) for (const target of targets) report.targets[target.name].updated = await applyTarget(client, target);
    const after = await financialBaseline(client);
    // Em apply, cada dominio ja foi conciliado dentro de sua propria transacao.
    if (apply) Object.assign(before, after);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('PORTÃO FINANCEIRO FALHOU: baseline divergiu');
    report.financialGate = apply ? 'PASS_PER_TARGET' : 'PASS';
    report.baseline = after;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
