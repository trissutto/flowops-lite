/**
 * O fechamento de comissão do mês está pegando as vendas certas?
 *
 * Primeira apuração pelo sistema novo — vale conferir a borda antes de pagar.
 *
 * O teste compara, para o mês corrente, três recortes:
 *   A) bordas de BRASÍLIA (o certo)  — 03:00 UTC do dia 1 até 03:00 do dia 1
 *      do mês seguinte;
 *   B) bordas do SERVIDOR (o errado) — 00:00 UTC, três horas cedo demais;
 *   C) o que o período GRAVADO na tabela realmente delimita.
 *
 * Se A e C baterem, o fechamento está correto. A diferença entre A e B é
 * quanto dinheiro trocaria de mês.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/conferir-comissao-fuso.js [AAAA-MM]
 */

const { Client } = require('pg');
const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

const hojeBR = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const YM = process.argv[2] || hojeBR.slice(0, 7);

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  const [y, m] = YM.split('-').map(Number);
  const brInicio = new Date(Date.UTC(y, m - 1, 1, 3, 0, 0));
  const brFim = new Date(Date.UTC(y, m, 1, 3, 0, 0));            // exclusivo
  const svInicio = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const svFim = new Date(Date.UTC(y, m, 1, 0, 0, 0));

  const soma = async (ini, fim) => {
    const r = await c.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0)::float AS v
         FROM pdv_sales
        WHERE status = 'finalized' AND is_training = false
          AND finalized_at >= $1 AND finalized_at < $2`,
      [ini, fim],
    );
    return r.rows[0];
  };

  console.log(`Mes de apuracao: ${YM}`);
  console.log('');
  const A = await soma(brInicio, brFim);
  const B = await soma(svInicio, svFim);
  console.log(`  A) bordas de BRASILIA (correto):  ${String(nf(A.n)).padStart(6)} vendas · ${brl(A.v).padStart(16)}`);
  console.log(`  B) bordas do SERVIDOR (errado):   ${String(nf(B.n)).padStart(6)} vendas · ${brl(B.v).padStart(16)}`);
  console.log(`     diferenca:                     ${String(nf(A.n - B.n)).padStart(6)} vendas · ${brl(A.v - B.v).padStart(16)}`);

  // C) o periodo REALMENTE gravado
  const p = await c.query(
    'SELECT year_month, start_date, end_date, status FROM commission_periods WHERE year_month = $1',
    [YM],
  );
  console.log('');
  if (!p.rows.length) {
    console.log('  C) periodo ainda NAO existe na tabela — sera criado no fechamento.');
    console.log('     Nesse caso as bordas nascem corretas (Date.UTC com 3h).');
  } else {
    const r = p.rows[0];
    const C = await soma(r.start_date, new Date(new Date(r.end_date).getTime() + 1));
    console.log(`  C) periodo GRAVADO (${r.status}):`);
    console.log(`     de ${String(r.start_date).slice(0, 24)}`);
    console.log(`     ate ${String(r.end_date).slice(0, 24)}`);
    console.log(`     -> ${String(nf(C.n)).padStart(6)} vendas · ${brl(C.v).padStart(16)}`);
    console.log('');
    if (C.n === A.n && Math.abs(C.v - A.v) < 0.01) {
      console.log('  >> O periodo gravado bate com as bordas de Brasilia. Fechamento CORRETO.');
    } else {
      console.log('  *** O periodo gravado NAO bate com Brasilia — conferir antes de pagar.');
    }
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
