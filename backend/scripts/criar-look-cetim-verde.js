/**
 * PRIMEIRO LOOK — "Cetim Verde": Regata Alcinha 403048 + Calça Aladdin 406027
 * (dono, 13/08: mesma foto, têm que se vender juntas).
 *
 * Idempotente: se já existe um look contendo as duas REFs, não cria de novo.
 * Rodar DEPOIS do deploy que aplica o schema (prisma db push roda no start).
 *
 *   railway run --service Postgres node backend/scripts/criar-look-cetim-verde.js
 */
const { Client } = require('pg');
const crypto = require('crypto');

const NOME = 'Cetim Verde';
const REFS = ['403048', '406027'];

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const jaExiste = await db.query(
    `SELECT look_id FROM site_look_peca WHERE ref = ANY($1)
      GROUP BY look_id HAVING COUNT(DISTINCT ref) = $2`,
    [REFS, REFS.length],
  );
  if (jaExiste.rows.length) {
    console.log(`Look já existe (${jaExiste.rows[0].look_id}) — nada a fazer.`);
    await db.end();
    return;
  }

  const lookId = crypto.randomUUID();
  await db.query('BEGIN');
  try {
    await db.query(
      `INSERT INTO site_look (id, nome, criado_por, criado_em) VALUES ($1, $2, 'seed-13-08', NOW())`,
      [lookId, NOME],
    );
    for (const ref of REFS) {
      await db.query(
        `INSERT INTO site_look_peca (id, look_id, ref) VALUES ($1, $2, $3)`,
        [crypto.randomUUID(), lookId, ref],
      );
    }
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
  console.log(`Look "${NOME}" criado (${lookId}) com ${REFS.join(' + ')}.`);
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
