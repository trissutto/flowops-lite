/*
 * Idempotent customer -> person backfill. Dry-run is the default.
 * Apply requires BOTH --apply and CUSTOMER_PERSON_BACKFILL_ENABLED=1.
 * It never changes CPF, Giga keys, financial rows, sales, orders or marcados.
 */
const { Client } = require('pg');
const { randomUUID } = require('crypto');

function normalizeCpf(value) {
  const cpf = String(value || '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return null;
  const digit = (length) => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += Number(cpf[i]) * (length + 1 - i);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]) ? cpf : null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (apply && process.env.CUSTOMER_PERSON_BACKFILL_ENABLED !== '1') {
    throw new Error('Aplicação bloqueada: defina CUSTOMER_PERSON_BACKFILL_ENABLED=1');
  }
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL ausente');
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const stats = { mode: apply ? 'apply' : 'dry-run', scanned: 0, valid: 0, invalid: 0, linked: 0, alreadyLinked: 0 };
  try {
    const { rows: customers } = await client.query(`
      SELECT id, cpf, name, email, phone, person_id, created_at
      FROM customers
      WHERE cpf IS NOT NULL AND btrim(cpf) <> ''
      ORDER BY created_at, id
    `);
    for (const customer of customers) {
      stats.scanned += 1;
      const cpf = normalizeCpf(customer.cpf);
      if (!cpf) { stats.invalid += 1; continue; }
      stats.valid += 1;
      if (customer.person_id) { stats.alreadyLinked += 1; continue; }
      if (!apply) { stats.linked += 1; continue; }

      await client.query('BEGIN');
      try {
        const personId = randomUUID();
        const { rows } = await client.query(`
          INSERT INTO persons (
            id, cpf_normalized, identity_status, name, email, phone,
            primary_customer_id, first_registration_at,
            first_registration_source, created_at, updated_at
          ) VALUES ($1, $2, 'confirmed', $3, $4, $5, $6, $7, 'flow', now(), now())
          ON CONFLICT (cpf_normalized) DO UPDATE SET updated_at = persons.updated_at
          RETURNING id
        `, [personId, cpf, customer.name, customer.email, customer.phone, customer.id, customer.created_at]);
        const resolvedPersonId = rows[0].id;
        const updated = await client.query(
          'UPDATE customers SET person_id = $1 WHERE id = $2 AND person_id IS NULL',
          [resolvedPersonId, customer.id],
        );
        if (updated.rowCount === 1) {
          await client.query(`
            INSERT INTO person_identifiers (
              id, person_id, type, normalized_value, verified, source,
              source_customer_id, verified_at, created_at, updated_at
            ) VALUES ($1, $2, 'cpf', $3, true, 'customer_backfill', $4, now(), now(), now())
            ON CONFLICT (person_id, type, normalized_value) DO NOTHING
          `, [randomUUID(), resolvedPersonId, cpf, customer.id]);
          await client.query(`
            INSERT INTO person_link_audits (
              id, person_id, entity_type, entity_id, rule, confidence,
              automatic, batch_id, created_at
            ) VALUES ($1, $2, 'customer', $3, 'valid_cpf_exact', 100, true, $4, now())
            ON CONFLICT (person_id, entity_type, entity_id, rule) DO NOTHING
          `, [randomUUID(), resolvedPersonId, customer.id, process.env.CUSTOMER_PERSON_BATCH_ID || 'manual']);
          stats.linked += 1;
        } else {
          stats.alreadyLinked += 1;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    console.log(JSON.stringify(stats, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
