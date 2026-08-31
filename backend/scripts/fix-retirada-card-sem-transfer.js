/**
 * FIX — RETIRADA COM CARD SEM MARCAÇÃO DE TRANSFERÊNCIA (caso LP-000290,
 * 31/08): pedido de retirada na loja X com card em OUTRA loja marcado
 * `is_transfer=false`. A tela da loja fonte mostra "🏬 Cliente retirou" —
 * mas a cliente retira na X. O certo é o card ser transferência → X
 * ("📦 Enviei pra loja X" + caixa com romaneio).
 *
 * Corrige TODO pedido de retirada ativo nesse estado (card ativo em loja
 * diferente da retirada, sem is_transfer). Grava o customer_snapshot no
 * mesmo formato do confirmRoute.
 *
 *   railway run --service Postgres node backend/scripts/fix-retirada-card-sem-transfer.js [--aplicar]
 *   (sem --aplicar: só lista o que faria)
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const aplicar = process.argv.includes('--aplicar');

  const tortos = (
    await db.query(`
      SELECT p.id AS pick_id, s.code AS loja_card, o.id AS order_id,
             o.wc_order_number, o.wc_order_id, o.pickup_store_code,
             o.customer_name, o.customer_cpf, o.customer_email, o.customer_phone,
             o.shipping_method, p.status
        FROM pick_orders p
        JOIN stores s ON s.id = p.store_id
        JOIN orders o ON o.id = p.order_id
       WHERE o.is_pickup = true
         AND o.pickup_store_code IS NOT NULL
         AND p.status IN ('new', 'separating', 'separated', 'ready')
         AND p.is_transfer = false
         AND s.code <> o.pickup_store_code`)
  ).rows;

  console.log(`cards de retirada SEM transferência (loja ≠ retirada): ${tortos.length}`);
  for (const t of tortos) {
    console.log(`  #${t.wc_order_number} card na ${t.loja_card} (${t.status}) → retirada na ${t.pickup_store_code}`);
    if (!aplicar) continue;
    const snap = JSON.stringify({
      name: t.customer_name, cpf: t.customer_cpf, email: t.customer_email,
      phone: t.customer_phone, pickupStoreCode: t.pickup_store_code,
      shippingMethod: t.shipping_method, wcOrderId: t.wc_order_id,
      wcOrderNumber: t.wc_order_number,
    });
    await db.query(
      `UPDATE pick_orders SET is_transfer = true, transfer_to_store_code = $2, customer_snapshot = $3
        WHERE id = $1`,
      [t.pick_id, t.pickup_store_code, snap],
    );
    console.log('    → corrigido: is_transfer=true, destino', t.pickup_store_code);
  }
  if (!aplicar && tortos.length) console.log('\n(rode com --aplicar pra corrigir)');
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
