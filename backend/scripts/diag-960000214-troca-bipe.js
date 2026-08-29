/**
 * DIAGNÓSTICO — pedido 960000214: CAJ224 PRETO 52 foi TROCADA (era 48) e a
 * atendente de Suzano não consegue bipar.
 *
 * Somente leitura. Mostra, na ordem, tudo que o `registerScan` checa antes de
 * aceitar um bipe — a linha que estiver fora do lugar é a causa.
 *
 *   railway run --service Postgres node backend/scripts/diag-960000214-troca-bipe.js
 */
const { Client } = require('pg');

const WC = '960000214';

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const o = await db.query(
    `SELECT id, wc_order_number, wc_order_id, status, created_at
       FROM orders
      WHERE wc_order_number = $1 OR wc_order_id::text = $1`,
    [WC],
  );
  console.log('════════ PEDIDO ════════');
  console.table(o.rows);
  if (!o.rows.length) {
    console.log('pedido não encontrado');
    await db.end();
    return;
  }
  const orderId = o.rows[0].id;

  // A trava nº 1 do bipe: o item só entra na conta do card se o
  // `assigned_store_id` for o da loja que está bipando. A troca zera esse campo
  // e conta com o re-roteamento pra preencher de novo.
  console.log('\n════════ ITENS · assigned_store_id ════════');
  const it = await db.query(
    `SELECT oi.sku, oi.product_name, oi.tamanho, oi.quantity,
            oi.assigned_store_id, s.code AS loja, s.name AS loja_nome,
            oi.cancelled_at
       FROM order_items oi
       LEFT JOIN stores s ON s.id = oi.assigned_store_id
      WHERE oi.order_id = $1
      ORDER BY oi.sku`,
    [orderId],
  );
  console.table(it.rows);
  const semLoja = it.rows.filter((r) => !r.assigned_store_id);
  if (semLoja.length) {
    console.log(`  ⚠️  ${semLoja.length} item(ns) SEM loja: ${semLoja.map((r) => r.sku).join(', ')}`);
    console.log('     → o bipe responde "SKU ... não está na lista deste pedido".');
  }

  console.log('\n════════ PICK ORDERS (cards) ════════');
  const po = await db.query(
    `SELECT po.id, po.status, s.code AS loja, s.name AS loja_nome,
            po.debit_approved_at, po.issue_reason, po.created_at
       FROM pick_orders po
       LEFT JOIN stores s ON s.id = po.store_id
      WHERE po.order_id = $1
      ORDER BY po.created_at`,
    [orderId],
  );
  console.table(po.rows);

  console.log('\n════════ BIPES REGISTRADOS ════════');
  const sc = await db.query(
    `SELECT pick_order_id, sku, ean, scanned_at, reverted_at,
            stock_decreased_at, stock_increased_at, debit_skipped_reason
       FROM pick_order_scans
      WHERE order_id = $1
      ORDER BY scanned_at`,
    [orderId],
  );
  console.table(sc.rows);

  console.log('\n════════ TROCAS DE PEÇA ════════');
  const sw = await db.query(
    `SELECT old_sku, new_sku, new_name, tipo, status, diff_cents, motivo, created_at
       FROM order_item_swaps
      WHERE order_id = $1
      ORDER BY created_at`,
    [orderId],
  );
  console.table(sw.rows);

  console.log('\n════════ PEÇAS REPORTADAS ("não achei") ════════');
  const rp = await db.query(
    `SELECT sku, reason, note, reported_at, resolved_at
       FROM pick_order_item_reports
      WHERE order_id = $1`,
    [orderId],
  );
  console.table(rp.rows);

  // A trava nº 2: a tela casa o código do leitor pelo EAN do espelho, com o
  // próprio CODIGO como variante. SKU sem EAN e com etiqueta EAN13 real não bipa.
  const skus = it.rows.map((r) => String(r.sku));
  console.log('\n════════ ESPELHO WINCRED · EAN dos SKUs ════════');
  const wp = await db.query(
    `SELECT codigo, ref, cor, tamanho, ean
       FROM wincred_produtos
      WHERE codigo = ANY($1::text[])
      ORDER BY codigo`,
    [skus],
  );
  console.table(wp.rows);
  const faltando = skus.filter((s) => !wp.rows.some((r) => String(r.codigo).trim() === s));
  if (faltando.length) console.log(`  ⚠️  SKU sem linha no espelho: ${faltando.join(', ')}`);
  const semEan = wp.rows.filter((r) => !r.ean || String(r.ean).trim().length < 8);
  if (semEan.length) {
    console.log(`  ⚠️  SKU sem EAN no espelho: ${semEan.map((r) => r.codigo).join(', ')}`);
    console.log('     → só bipa se a etiqueta imprimir o CODIGO como barcode.');
  }

  console.log('\n════════ ESTOQUE WINCRED dos SKUs ════════');
  const est = await db.query(
    `SELECT codigo, loja, estoque
       FROM wincred_estoque
      WHERE codigo = ANY($1::text[]) AND estoque <> 0
      ORDER BY codigo, loja`,
    [skus],
  );
  console.table(est.rows);

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
