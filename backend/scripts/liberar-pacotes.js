/**
 * LIBERA O ENVIO EM MÚLTIPLOS PACOTES de um pedido (gate dentro de SP).
 * Mesmo efeito do botão "Liberar N fretes" da matriz: carimba
 * `pacotes_liberados_em` e grava a linha no histórico do pedido.
 *
 *   railway run --service Postgres node backend/scripts/liberar-pacotes.js ON-000224 [quem]
 */
const { Client } = require('pg');

async function main() {
  const num = process.argv[2];
  const quem = process.argv[3] || 'dono (via chat)';
  if (!num) {
    console.error('uso: node liberar-pacotes.js <wc_order_number> [quem]');
    process.exit(1);
  }
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const o = (
    await db.query(
      `SELECT id, wc_order_number, status, pacotes_liberados_em FROM orders
        WHERE wc_order_number = $1 OR wc_order_id::text = $1`,
      [num],
    )
  ).rows[0];
  if (!o) { console.error('pedido não encontrado'); process.exit(1); }
  if (o.pacotes_liberados_em) {
    console.log(`#${o.wc_order_number} JÁ estava liberado em ${o.pacotes_liberados_em}`);
    await db.end();
    return;
  }
  await db.query(
    `UPDATE orders SET pacotes_liberados_em = NOW(), pacotes_liberados_por = $2 WHERE id = $1`,
    [o.id, quem],
  );
  await db.query(
    `INSERT INTO order_history (id, order_id, from_status, to_status, note, created_at)
     VALUES (gen_random_uuid()::text, $1, $2, $2,
             'Matriz LIBEROU o envio em múltiplos pacotes (política de frete) — ' || $3, NOW())`,
    [o.id, o.status, quem],
  );
  console.log(`#${o.wc_order_number} LIBERADO em múltiplos pacotes — as lojas já podem enviar.`);
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
