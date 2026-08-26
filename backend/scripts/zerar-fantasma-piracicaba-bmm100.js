/**
 * BMM-100 PRETO 50 (sku 11344742) — zerar o "1" FANTASMA de PIRACICABA (05).
 *
 * O QUE ACONTECEU (26/08/2026)
 *   A última peça física da rede foi bipada em JUNDIAÍ (10) no dia 24/08 pro
 *   ON-000126. Sobrou um "1" em PIRACICABA que só existe no sistema: o
 *   ON-000162 foi roteado pra lá às 11:25 e a PRÓPRIA Piracicaba reportou
 *   "sem estoque físico" às 11:42. O reporte de card não baixava o fantasma
 *   (corrigido no mesmo commit deste script), então o saldo seguiu enganando
 *   a Consulta e o modal "Trocar loja" — o card rodou Piracicaba → Santos →
 *   Suzano → Santos, todas negando.
 *
 * CORREÇÃO: estoque 11344742 @ loja 05 → 0 (giga_estoque + wincred_estoque)
 *   + nota assinada na linha do tempo do ON-000162.
 *
 * Rodar da RAIZ do repo, railway linkado em heroic-mercy > Postgres.
 * Dry-run por padrão. `railway run --service Postgres node backend/scripts/zerar-fantasma-piracicaba-bmm100.js --apply` grava.
 */
const { Client } = require('pg');
const APPLY = process.argv.includes('--apply');

const SKU = '11344742';
const LOJA = '05';
const ORDER_ID_ON162 = '1255f811-bd46-41bb-816e-ed8ae076d20e';

(async () => {
  const db = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  const { rows } = await db.query(
    `SELECT id, estoque FROM giga_estoque
      WHERE regexp_replace(codigo,'^0+','')=$1 AND loja=$2`,
    [SKU, LOJA],
  );
  const row = rows[0];
  if (!row) {
    console.log('Sem linha de estoque — nada a fazer.');
    await db.end();
    return;
  }
  console.log(`giga_estoque ${SKU} loja ${LOJA}: ${row.estoque} → 0`);

  if (!APPLY) {
    console.log('\nDRY-RUN. Rode com --apply pra valer.');
    await db.end();
    return;
  }

  await db.query('BEGIN');
  try {
    await db.query(`UPDATE giga_estoque SET estoque=0, synced_at=now() WHERE id=$1`, [row.id]);
    await db.query(
      `INSERT INTO wincred_estoque (codigo, loja, estoque, synced_at) VALUES ($1,$2,0,now())
       ON CONFLICT (codigo, loja) DO UPDATE SET estoque=0, synced_at=now()`,
      [SKU, LOJA],
    );
    await db.query(
      `INSERT INTO order_history (id, order_id, user_id, from_status, to_status, note, created_at)
       VALUES (gen_random_uuid(), $1, NULL, 'separating', 'separating', $2, now())`,
      [
        ORDER_ID_ON162,
        `Estoque fantasma zerado por script: BMM-100 PRETO 50 (${SKU}) em PIRACICABA (${LOJA}) ` +
          `${row.estoque}→0 — a própria loja reportou "sem estoque físico" às 11:42 e o saldo seguia no sistema.`,
      ],
    );
    await db.query('COMMIT');
    console.log('COMMIT ok — fantasma zerado + nota na linha do tempo do ON-000162.');
  } catch (e) {
    await db.query('ROLLBACK');
    console.error('ROLLBACK:', e.message);
    process.exit(1);
  }
  await db.end();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
