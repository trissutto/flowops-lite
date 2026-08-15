/**
 * DIAGNÓSTICO — os avisos ao cliente estão saindo? (e-mail + WhatsApp/n8n)
 *
 * Mede pelos CARIMBOS que o backend grava, não pela intenção do código:
 *   pixResgateAvisadoEm  → toque do PIX não pago entregue ao n8n
 *   rastreioAvisadoEm    → aviso de envio (e-mail + n8n) disparado
 *
 *   railway run --service Postgres -- node backend/scripts/diag-avisos-cliente.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log('════════ PEDIDOS DO SITE NOVO — últimos 14 dias ════════');
  const q = await db.query(`
    SELECT source,
           COUNT(*)::int                                             AS pedidos,
           COUNT(paid_at)::int                                       AS pagos,
           COUNT(pix_resgate_avisado_em)::int                        AS resgate_pix_tocado,
           COUNT(rastreio_avisado_em)::int                           AS rastreio_avisado,
           COUNT(*) FILTER (WHERE tracking_code IS NOT NULL)::int     AS com_rastreio
      FROM orders
     WHERE created_at >= NOW() - INTERVAL '14 days'
     GROUP BY source
     ORDER BY pedidos DESC`);
  for (const r of q.rows) {
    console.log(`  source=${String(r.source).padEnd(12)} pedidos=${String(r.pedidos).padStart(4)} pagos=${String(r.pagos).padStart(4)} | PIX tocado=${String(r.resgate_pix_tocado).padStart(3)} | c/ rastreio=${String(r.com_rastreio).padStart(3)} avisados=${String(r.rastreio_avisado).padStart(3)}`);
  }

  console.log('\n════════ PIX EM ABERTO (candidatos ao resgate) — 14 dias ════════');
  const pix = await db.query(`
    SELECT COUNT(*)::int AS abertos,
           COUNT(pix_resgate_avisado_em)::int AS tocados
      FROM orders
     WHERE source = 'ecommerce'
       AND paid_at IS NULL
       AND status = 'awaiting_payment'
       AND created_at >= NOW() - INTERVAL '14 days'`);
  console.log(`  PIX não pagos: ${pix.rows[0].abertos} · tocados pelo resgate: ${pix.rows[0].tocados}`);

  console.log('\n════════ ENVIADOS SEM AVISO (o buraco, se houver) ════════');
  const semAviso = await db.query(`
    SELECT source, wc_order_number, tracking_code, status, updated_at
      FROM orders
     WHERE tracking_code IS NOT NULL
       AND rastreio_avisado_em IS NULL
       AND created_at >= NOW() - INTERVAL '14 days'
     ORDER BY updated_at DESC
     LIMIT 15`);
  for (const r of semAviso.rows) {
    console.log(`  ${String(r.source).padEnd(11)} ${String(r.wc_order_number || '-').padEnd(12)} rastreio=${r.tracking_code} status=${r.status} em ${String(r.updated_at).slice(0, 16)}`);
  }
  console.log(`  total sem aviso: ${semAviso.rows.length}`);

  console.log('\n════════ LEADS DO POPUP (cupom) — recebem algo? ════════');
  try {
    const leads = await db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE criado_em >= NOW() - INTERVAL '14 days')::int AS ultimos14
        FROM site_lead`);
    console.log(`  leads totais=${leads.rows[0].total} · últimos 14 dias=${leads.rows[0].ultimos14} (nenhum e-mail/whats é disparado hoje)`);
  } catch (e) {
    console.log(`  (site_lead: ${e.message})`);
  }

  await db.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
