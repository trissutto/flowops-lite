/**
 * O bot do ataque SUJOU o funil de tracking? Compara site_eventos da janela do
 * ataque (28/08 20-23h BRT) com a mesma janela dos 3 dias anteriores, e mede a
 * venda paga do site por dia (a régua do ROAS) nos últimos 7 dias.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log('── eventos de checkout por noite (20h-23h59 BRT, últimos 4 dias) ──');
  const ev = await db.query(
    `SELECT (criado_em AT TIME ZONE 'America/Sao_Paulo')::date dia, evento, COUNT(*)::int n,
            COUNT(DISTINCT session_id)::int sessoes
       FROM site_eventos
      WHERE criado_em > NOW() - INTERVAL '4 days'
        AND EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Sao_Paulo') BETWEEN 20 AND 23
        AND evento IN ('begin_checkout','checkout_submission','checkout_error','purchase','add_to_cart','checkout_payment_selected')
      GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  console.table(ev.rows);

  console.log('── venda PAGA do site por dia (7 dias, régua do ROAS) ──');
  const pagos = await db.query(
    `SELECT (paid_at AT TIME ZONE 'America/Sao_Paulo')::date dia,
            COUNT(*)::int pedidos, SUM(total_amount)::numeric(12,2) receita
       FROM orders
      WHERE source='ecommerce' AND paid_at IS NOT NULL
        AND paid_at > NOW() - INTERVAL '7 days'
      GROUP BY 1 ORDER BY 1`,
  );
  console.table(pagos.rows);

  await db.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
