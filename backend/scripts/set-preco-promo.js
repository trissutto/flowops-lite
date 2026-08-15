/**
 * Seta o preço promocional DE SITE de uma peça (dono, 14/08). Só o site usa —
 * o PDV das lojas continua no preço do ERP. A trava antifraude lê o mesmo
 * campo, então o checkout cobra o promo sem recusar.
 *   railway run --service Postgres node backend/scripts/set-preco-promo.js REF 139.90 239.90
 *   railway run --service Postgres node backend/scripts/set-preco-promo.js REF off   (remove a promo)
 */
const { Client } = require('pg');

async function main() {
  const ref = String(process.argv[2] || '').toUpperCase().trim();
  const promoArg = process.argv[3];
  const deArg = process.argv[4];
  if (!ref) { console.error('Uso: node set-preco-promo.js REF <preco|off> [precoDe]'); process.exit(2); }

  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  if (String(promoArg).toLowerCase() === 'off') {
    const r = await db.query(`UPDATE site_produto SET preco_promo=NULL, preco_de=NULL WHERE ref=$1 RETURNING ref`, [ref]);
    console.log(r.rowCount ? `Promo REMOVIDA de ${ref}` : `REF ${ref} não existe em site_produto`);
    await db.end();
    return;
  }

  const promo = Number(promoArg);
  const de = deArg != null ? Number(deArg) : null;
  if (!Number.isFinite(promo) || promo <= 0) { console.error('preço promo inválido'); process.exit(2); }

  const r = await db.query(
    `UPDATE site_produto SET preco_promo=$2, preco_de=$3 WHERE ref=$1
       RETURNING ref, nome, preco_promo, preco_de`,
    [ref, promo, de],
  );
  if (!r.rowCount) { console.error(`REF ${ref} não existe em site_produto — publique a peça primeiro`); process.exit(1); }
  const p = r.rows[0];
  console.log(`✓ ${p.ref} (${p.nome}): de R$ ${p.preco_de ?? '—'} por R$ ${p.preco_promo}`);
  console.log('  (o catálogo tem cache de 60s — a vitrine reflete em até 1 min)');
  await db.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
