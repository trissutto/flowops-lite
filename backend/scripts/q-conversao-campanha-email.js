/**
 * A campanha de e-mail vendeu? Conta NO NOSSO BANCO, por UTM — o painel do
 * Mautic não serve (rastreio cego pra e-mail criado por API, medido em 15/08).
 *
 * `pg` direto e não Prisma: rodando da máquina do dono, o DATABASE_URL aponta
 * pro host INTERNO da Railway (postgres.railway.internal), que só resolve lá
 * dentro. O DATABASE_PUBLIC_URL é o que funciona de fora.
 *
 * Uso (da RAIZ):
 *   railway run --service flowops-lite node backend/scripts/q-conversao-campanha-email.js [horas]
 */
const { Client } = require('pg');

const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function main() {
  const horas = Number(process.argv[2] || 24);
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_PUBLIC_URL/DATABASE_URL ausente — rode com railway run'); process.exit(2); }
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  console.log(`══ CAMPANHA DE E-MAIL · últimas ${horas}h · ${agora} ══`);

  const { rows } = await db.query(
    `SELECT utm_campaign,
            COUNT(*)                                                        AS pedidos,
            COUNT(*) FILTER (WHERE status NOT IN ('cancelled','failed','pending','payment_failed')) AS pagos,
            COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('cancelled','failed','pending','payment_failed')), 0) AS receita
       FROM orders
      WHERE utm_source = 'email'
        AND created_at >= NOW() - ($1 || ' hours')::interval
      GROUP BY utm_campaign
      ORDER BY receita DESC`,
    [String(horas)],
  );

  if (!rows.length) {
    console.log('  nenhum pedido com utm_source=email ainda.');
  } else {
    for (const r of rows) {
      console.log(`\n  ${r.utm_campaign || '(sem nome)'}`);
      console.log(`    ${r.pedidos} pedidos · ${r.pagos} pagos · ${brl(r.receita)}`);
    }
  }

  // Sem pedido não quer dizer sem gente chegando — mostra o tráfego do e-mail.
  try {
    // A UTM viaja em `dados` (jsonb) ou aparece no próprio `path`.
    const t = await db.query(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT session_id) AS pessoas FROM site_eventos
        WHERE criado_em >= NOW() - ($1 || ' hours')::interval
          AND (dados->>'utm_source' = 'email' OR path ILIKE '%utm_source=email%')`,
      [String(horas)],
    );
    console.log(`\n  visitas vindas do e-mail: ${t.rows[0].n} eventos · ${t.rows[0].pessoas} pessoas`);
    // Quem entrou na Linha Conforto no período, venha de onde vier — serve de
    // termômetro enquanto a UTM não aparece no evento.
    const c = await db.query(
      `SELECT COUNT(DISTINCT session_id) AS pessoas FROM site_eventos
        WHERE criado_em >= NOW() - ($1 || ' hours')::interval AND path ILIKE '%linha-conforto%'`,
      [String(horas)],
    );
    console.log(`  pessoas na página Linha Conforto: ${c.rows[0].pessoas}`);
  } catch (e) {
    console.log(`\n  (tráfego não medido: ${String(e.message).slice(0, 80)})`);
  }

  const ult = await db.query(
    `SELECT wc_order_number, total_amount, status, created_at, customer_name
       FROM orders
      WHERE utm_source = 'email' AND created_at >= NOW() - ($1 || ' hours')::interval
      ORDER BY created_at DESC LIMIT 10`,
    [String(horas)],
  );
  if (ult.rows.length) {
    console.log('\n  últimos pedidos:');
    for (const p of ult.rows) {
      const hora = new Date(p.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      console.log(`    ${hora} · ${p.wc_order_number ?? '—'} · ${brl(p.total_amount)} · ${p.status} · ${String(p.customer_name || '').slice(0, 22)}`);
    }
  }

  await db.end();
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
