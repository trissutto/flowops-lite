/**
 * Limpeza dos pedidos-lixo do ataque de teste de cartão de 28/08/2026.
 *
 * O bot deixou ~650 Orders `payment_failed` que afundam a aba Carrinhos, o
 * KPI "não pagos" e a tela de pedidos. Critério CONSERVADOR (não encosta em
 * recusa legítima):
 *
 *   - status = payment_failed
 *   - criado em 28/08 (BRT)
 *   - E (total ∈ {95,35 · 99,89} — o carrinho fixo do bot —
 *        OU cliente_ip começando com 200.219.50. — os IPs do aquecimento)
 *
 * O que ele NÃO pega (e é de propósito): as recusas reais de hoje
 * (R$ 229,69 helemar, R$ 100,52 gsfdgsafra etc.) e qualquer payment_failed
 * de outros dias.
 *
 * Vira `status='cancelled'` com carimbo `ataque` DENTRO do paymentInfo
 * (reversível por query). `cancelled` some das listas sozinho.
 *
 *   node backend/scripts/limpar-pedidos-ataque-28-08.js           → só conta
 *   node backend/scripts/limpar-pedidos-ataque-28-08.js --aplicar → executa
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

const APLICAR = process.argv.includes('--aplicar');

const FILTRO = `
  status = 'payment_failed'
  AND created_at >= '2026-08-28 03:00:00Z'
  AND created_at <  '2026-08-29 03:00:00Z'
  AND (
    total_amount IN (95.35, 99.89)
    OR cliente_ip LIKE '200.219.50.%'
  )
`;

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const alvo = await db.query(
    `SELECT COUNT(*)::int n, MIN(wc_order_number) primeiro, MAX(wc_order_number) ultimo
       FROM orders WHERE ${FILTRO}`,
  );
  console.log('ALVO da limpeza:', alvo.rows[0]);

  const sobra = await db.query(
    `SELECT wc_order_number lp, customer_email email, total_amount total, cliente_ip ip,
            to_char(created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') criado
       FROM orders
      WHERE status='payment_failed' AND NOT (${FILTRO})
      ORDER BY created_at DESC LIMIT 20`,
  );
  console.log('\npayment_failed que FICAM (recusa real, fora do critério):');
  console.table(sobra.rows);

  if (!APLICAR) {
    console.log('\n(dry-run — rode com --aplicar pra executar)');
    await db.end();
    return;
  }

  const r = await db.query(
    `UPDATE orders
        SET status = 'cancelled',
            payment_info = CASE
              WHEN payment_info ~ '^\\s*\\{'
                THEN (payment_info::jsonb || '{"ataque":"teste-cartao-28-08"}'::jsonb)::text
              ELSE '{"ataque":"teste-cartao-28-08"}'
            END
      WHERE ${FILTRO}`,
  );
  console.log(`\nAPLICADO: ${r.rowCount} pedidos marcados cancelled + carimbo ataque.`);

  const depois = await db.query(
    `SELECT COUNT(*)::int payment_failed_restantes FROM orders WHERE status='payment_failed'`,
  );
  console.table(depois.rows);

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
