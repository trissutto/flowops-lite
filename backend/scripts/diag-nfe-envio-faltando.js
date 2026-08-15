/**
 * DIAGNÓSTICO — por que o envio saiu SEM NF-e?
 *
 * Passa o rastreio (ou o número do pedido) e ele mostra: o pick, o pedido,
 * o destinatário (CPF/endereço), os itens e TODA tentativa de NF-e gravada
 * (status/cStat/xMotivo/erro). No fim, o retrato dos últimos 14 dias.
 *
 *   railway run --service Postgres -- node backend/scripts/diag-nfe-envio-faltando.js AP356584751BR
 */
const { Client } = require('pg');

const ALVO = (process.argv[2] || 'AP356584751BR').trim();

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log(`════════ ALVO: ${ALVO} ════════`);
  const p = await db.query(
    `SELECT po.id, po.status, po.store_id, po.tracking_code, po.carrier,
            po.correios_prepostagem_id, po.correios_generated_at,
            (po.etiqueta_pdf IS NOT NULL) AS tem_etiqueta_gravada,
            po.order_id, s.code AS store_code, s.name AS store_name
       FROM pick_orders po
       LEFT JOIN stores s ON s.id = po.store_id
      WHERE po.tracking_code = $1
         OR po.order_id IN (SELECT id FROM orders WHERE wc_order_number::text = $1)
      ORDER BY po.created_at DESC`,
    [ALVO],
  );
  if (!p.rows.length) { console.log('  (nenhum pick-order encontrado)'); }

  for (const pick of p.rows) {
    console.log(`\n── PICK ${pick.id}`);
    console.log(`   loja=${pick.store_code} ${pick.store_name} · status=${pick.status}`);
    console.log(`   rastreio=${pick.tracking_code} carrier=${pick.carrier} prepostagem=${pick.correios_prepostagem_id}`);
    console.log(`   gerado_em=${pick.correios_generated_at} · etiqueta gravada=${pick.tem_etiqueta_gravada}`);

    const o = await db.query(
      `SELECT id, source, wc_order_number, status, paid_at, is_pickup, live_cart_id,
              customer_name, customer_cpf, customer_email, customer_phone,
              shipping_cep, shipping_address, total_amount, created_at
         FROM orders WHERE id = $1`, [pick.order_id]);
    const ord = o.rows[0];
    if (!ord) { console.log('   (pedido não encontrado!)'); continue; }
    console.log(`   PEDIDO ${ord.wc_order_number} · source=${ord.source} · status=${ord.status} · pago=${ord.paid_at} · pickup=${ord.is_pickup}`);
    console.log(`   cliente="${ord.customer_name}" cpf="${ord.customer_cpf}" tel="${ord.customer_phone}"`);
    console.log(`   cep=${ord.shipping_cep} endereco=${ord.shipping_address}`);

    const picks = await db.query('SELECT COUNT(*)::int AS n FROM pick_orders WHERE order_id = $1', [pick.order_id]);
    console.log(`   pedido dividido em ${picks.rows[0].n} pick(s)`);

    const it = await db.query(
      `SELECT oi.sku, oi.product_name, oi.quantity, oi.unit_price, oi.assigned_store_id, s.code AS assigned_code
         FROM order_items oi LEFT JOIN stores s ON s.id = oi.assigned_store_id
        WHERE oi.order_id = $1`, [pick.order_id]);
    for (const i of it.rows) {
      console.log(`     item sku=${i.sku} "${i.product_name}" qtd=${i.quantity} preco=${i.unit_price} assigned=${i.assigned_code || '—'}`);
    }

    const n = await db.query(
      `SELECT id, status, c_stat, x_motivo, erro, tp_amb, serie, numero, chave,
              from_store_code, to_store_code, cfop, valor_total_cents, created_at
         FROM nfe_docs WHERE shipment_id = $1 ORDER BY created_at DESC`,
      [`envio:${pick.id}`]);
    if (!n.rows.length) {
      console.log('   ⚠️  NENHUMA tentativa de NF-e gravada pra este envio (nfe_docs vazio)');
    } else {
      for (const d of n.rows) {
        console.log(`   NF-e ${d.status} amb=${d.tp_amb} serie=${d.serie} num=${d.numero} cStat=${d.c_stat} "${d.x_motivo}" emit=${d.from_store_code} cfop=${d.cfop} em ${d.created_at}`);
        if (d.erro) console.log(`        erro: ${String(d.erro).slice(0, 400)}`);
      }
    }
  }

  console.log('\n════════ ENVIOS DO SITE/LIVE — 14 dias: com e sem NF-e ════════');
  const g = await db.query(`
    SELECT o.source,
           COUNT(*)::int AS envios_gerados,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM nfe_docs d
              WHERE d.shipment_id = 'envio:' || po.id AND d.status = 'authorized'))::int AS com_nota,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM nfe_docs d
              WHERE d.shipment_id = 'envio:' || po.id) AND NOT EXISTS (
             SELECT 1 FROM nfe_docs d
              WHERE d.shipment_id = 'envio:' || po.id AND d.status = 'authorized'))::int AS so_falha,
           COUNT(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM nfe_docs d WHERE d.shipment_id = 'envio:' || po.id))::int AS nem_tentou
      FROM pick_orders po
      JOIN orders o ON o.id = po.order_id
     WHERE po.correios_generated_at >= NOW() - INTERVAL '14 days'
     GROUP BY o.source`);
  for (const r of g.rows) {
    console.log(`  source=${String(r.source).padEnd(10)} envios=${String(r.envios_gerados).padStart(4)} | com nota=${String(r.com_nota).padStart(4)} | tentou e falhou=${String(r.so_falha).padStart(4)} | nem tentou=${String(r.nem_tentou).padStart(4)}`);
  }

  console.log('\n════════ MOTIVOS DE REJEIÇÃO — 14 dias ════════');
  const m = await db.query(`
    SELECT status, c_stat, COALESCE(x_motivo, LEFT(erro, 120)) AS motivo, COUNT(*)::int AS n
      FROM nfe_docs
     WHERE shipment_id LIKE 'envio:%' AND created_at >= NOW() - INTERVAL '14 days'
       AND status <> 'authorized'
     GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 20`);
  if (!m.rows.length) console.log('  (nenhuma rejeição gravada)');
  for (const r of m.rows) console.log(`  ${String(r.n).padStart(3)}× ${r.status} cStat=${r.c_stat} ${r.motivo}`);

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
