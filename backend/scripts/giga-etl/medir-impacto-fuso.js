/**
 * Quanto do faturamento caía no dia errado por causa do fuso?
 *
 * As vendas são gravadas em UTC. Toda venda feita das 21h à meia-noite de
 * Brasília fica com data UTC do DIA SEGUINTE — e todo relatório que recortava
 * por dia usando o relógio do servidor a jogava pro dia errado.
 *
 * Isso mexia em: comissão da vendedora (período de apuração), faturamento do
 * dia, meta, DRE e fechamento.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/medir-impacto-fuso.js
 */

const { Client } = require('pg');
const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  const tot = await c.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0)::float AS v
       FROM pdv_sales
      WHERE status = 'finalized' AND finalized_at > NOW() - INTERVAL '90 days'`,
  );

  // Hora CRUA 00,01,02 = 21h,22h,23h de Brasilia. Sao as que trocavam de dia.
  const desloc = await c.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0)::float AS v
       FROM pdv_sales
      WHERE status = 'finalized' AND finalized_at > NOW() - INTERVAL '90 days'
        AND EXTRACT(HOUR FROM finalized_at) < 3`,
  );

  const T = tot.rows[0];
  const D = desloc.rows[0];
  console.log(`Vendas finalizadas (90 dias): ${nf(T.n)} · ${brl(T.v)}`);
  console.log(`Feitas das 21h a meia-noite:  ${nf(D.n)} · ${brl(D.v)}`);
  console.log('');
  const pct = T.v ? (D.v / T.v) * 100 : 0;
  console.log(`  ${pct.toFixed(2)}% do faturamento era contado no DIA SEGUINTE`);
  console.log('  (e saia da comissao daquele dia, entrando na do dia posterior)');

  // Por loja — quem fecha tarde sofre mais.
  const porLoja = await c.query(
    `SELECT store_code,
            COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM finalized_at) < 3)::int AS n_desloc,
            COALESCE(SUM(total) FILTER (WHERE EXTRACT(HOUR FROM finalized_at) < 3),0)::float AS v_desloc,
            COALESCE(SUM(total),0)::float AS v_total
       FROM pdv_sales
      WHERE status = 'finalized' AND finalized_at > NOW() - INTERVAL '90 days'
      GROUP BY 1 HAVING COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM finalized_at) < 3) > 0
      ORDER BY 3 DESC LIMIT 10`,
  );
  if (porLoja.rows.length) {
    console.log('');
    console.log('--- LOJAS MAIS AFETADAS (as que vendem depois das 21h) ---');
    for (const r of porLoja.rows) {
      const p = r.v_total ? (r.v_desloc / r.v_total) * 100 : 0;
      console.log(`  loja ${String(r.store_code).padEnd(3)} ${String(nf(r.n_desloc)).padStart(5)} venda(s) · ${brl(r.v_desloc).padStart(14)} · ${p.toFixed(1)}% do que ela fatura`);
    }
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
