/**
 * Diagnóstico do surto de pedidos com falha de pagamento (suspeita de ataque
 * de teste de cartão): conta, linha do tempo, agrupa por IP / e-mail / CPF /
 * aparelho / valor e imprime uma amostra com o retorno do gateway.
 *
 *   node backend/scripts/diag-ataque-payment-failed.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log('── 1. pedidos por status (30 dias, por source) ──');
  const porStatus = await db.query(
    `SELECT source, status, COUNT(*)::int n,
            to_char(MIN(created_at) AT TIME ZONE 'America/Sao_Paulo','MM-DD HH24:MI') primeiro,
            to_char(MAX(created_at) AT TIME ZONE 'America/Sao_Paulo','MM-DD HH24:MI') ultimo
       FROM orders
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY 1,2 ORDER BY n DESC`,
  );
  console.table(porStatus.rows);

  console.log('── 2. payment_failed por hora (últimas 72h, hora de Brasília) ──');
  const porHora = await db.query(
    `SELECT to_char(date_trunc('hour', created_at AT TIME ZONE 'America/Sao_Paulo'),'DD/MM HH24h') hora,
            COUNT(*)::int n
       FROM orders
      WHERE status='payment_failed' AND created_at > NOW() - INTERVAL '72 hours'
      GROUP BY date_trunc('hour', created_at AT TIME ZONE 'America/Sao_Paulo')
      ORDER BY date_trunc('hour', created_at AT TIME ZONE 'America/Sao_Paulo')`,
  );
  console.table(porHora.rows);

  console.log('── 3. payment_failed por IP (7 dias) ──');
  const porIp = await db.query(
    `SELECT COALESCE(cliente_ip,'(sem ip)') ip, COUNT(*)::int n,
            COUNT(DISTINCT customer_email)::int emails,
            COUNT(DISTINCT customer_cpf)::int cpfs,
            COUNT(DISTINCT total_amount)::int valores,
            to_char(MIN(created_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') de,
            to_char(MAX(created_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') ate
       FROM orders
      WHERE status='payment_failed' AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY 1 ORDER BY n DESC LIMIT 25`,
  );
  console.table(porIp.rows);

  console.log('── 4. payment_failed por e-mail (7 dias, top 25) ──');
  const porEmail = await db.query(
    `SELECT COALESCE(customer_email,'(sem)') email, COUNT(*)::int n,
            COUNT(DISTINCT cliente_ip)::int ips,
            COUNT(DISTINCT customer_cpf)::int cpfs,
            MIN(total_amount) v_min, MAX(total_amount) v_max
       FROM orders
      WHERE status='payment_failed' AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY 1 ORDER BY n DESC LIMIT 25`,
  );
  console.table(porEmail.rows);

  console.log('── 5. payment_failed por aparelho (anonymous_id do trackingInfo, 7 dias) ──');
  const porDevice = await db.query(
    `SELECT COALESCE(NULLIF(tracking_info,'')::jsonb->>'anonymous_id','(sem)') aparelho,
            COUNT(*)::int n, COUNT(DISTINCT cliente_ip)::int ips,
            COUNT(DISTINCT customer_email)::int emails
       FROM orders
      WHERE status='payment_failed' AND created_at > NOW() - INTERVAL '7 days'
        AND (tracking_info IS NULL OR tracking_info = '' OR tracking_info ~ '^\\s*\\{')
      GROUP BY 1 ORDER BY n DESC LIMIT 15`,
  );
  console.table(porDevice.rows);

  console.log('── 6. payment_failed por valor (7 dias, top 15) ──');
  const porValor = await db.query(
    `SELECT total_amount valor, COUNT(*)::int n,
            COUNT(DISTINCT customer_email)::int emails
       FROM orders
      WHERE status='payment_failed' AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY 1 ORDER BY n DESC LIMIT 15`,
  );
  console.table(porValor.rows);

  console.log('── 7. amostra: 30 payment_failed mais recentes ──');
  const amostra = await db.query(
    `SELECT wc_order_number lp,
            to_char(created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI:SS') criado,
            customer_name nome, customer_email email, customer_cpf cpf,
            cliente_ip ip, total_amount total,
            CASE WHEN payment_info ~ '^\\s*\\{' THEN payment_info::jsonb->>'method' END metodo,
            CASE WHEN payment_info ~ '^\\s*\\{' THEN payment_info::jsonb#>>'{transacao,last4}' END last4,
            CASE WHEN payment_info ~ '^\\s*\\{' THEN payment_info::jsonb#>>'{transacao,titular}' END titular,
            CASE WHEN payment_info ~ '^\\s*\\{' THEN COALESCE(
              payment_info::jsonb#>>'{transacao,retornoAdquirente}',
              payment_info::jsonb#>>'{transacao,acquirer_message}',
              payment_info::jsonb#>>'{transacao,gateway_response,errors,0,message}') END retorno
       FROM orders
      WHERE status='payment_failed'
      ORDER BY created_at DESC LIMIT 30`,
  );
  console.table(amostra.rows);

  console.log('── 8. chaves do paymentInfo de 1 payment_failed recente (pra ver o formato) ──');
  const um = await db.query(
    `SELECT payment_info FROM orders
      WHERE status='payment_failed' AND payment_info IS NOT NULL AND payment_info ~ '^\\s*\\{'
      ORDER BY created_at DESC LIMIT 1`,
  );
  if (um.rows[0]) {
    try {
      const pi = JSON.parse(um.rows[0].payment_info);
      console.log(JSON.stringify(pi, null, 2).slice(0, 3000));
    } catch (e) {
      console.log('(payment_info não é JSON)', um.rows[0].payment_info.slice(0, 400));
    }
  }

  console.log('── 9. total geral de payment_failed (sem janela) ──');
  const total = await db.query(
    `SELECT COUNT(*)::int total,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int ult24h,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '48 hours')::int ult48h,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int ult7d
       FROM orders WHERE status='payment_failed'`,
  );
  console.table(total.rows);

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
