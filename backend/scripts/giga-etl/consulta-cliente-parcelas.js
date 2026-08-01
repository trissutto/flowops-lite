/**
 * Parcelas em aberto de um cliente, separadas em VENCIDAS e A VENCER.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/consulta-cliente-parcelas.js VISANET
 *
 * "Hoje" é o dia de BRASÍLIA, não o do servidor: depois das 21h o servidor já
 * virou o dia e classificaria como vencida uma parcela que vence amanhã.
 */

const { Client } = require('pg');

const busca = (process.argv[2] || 'VISANET').toUpperCase();
const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  console.log(`Cliente contendo: "${busca}"`);
  console.log(`Hoje (Brasilia):  ${hoje}`);
  console.log('');

  // Quem sao — o mesmo nome pode ter codigo diferente por loja.
  const quem = await c.query(
    `SELECT loja, cod_cliente, nome_cliente, COUNT(*)::int AS parcelas
       FROM crediario_parcelas
      WHERE UPPER(COALESCE(nome_cliente,'')) LIKE '%' || $1 || '%'
      GROUP BY loja, cod_cliente, nome_cliente
      ORDER BY parcelas DESC`,
    [busca],
  );
  if (!quem.rows.length) {
    console.log('Nenhum cliente com esse nome em crediario_parcelas.');
    await c.end();
    return;
  }
  console.log('--- CADASTROS ENCONTRADOS ---');
  for (const r of quem.rows) {
    console.log(`  loja ${String(r.loja).padEnd(3)} cod ${String(r.cod_cliente).padEnd(10)} ${String(r.nome_cliente).slice(0, 40).padEnd(42)} ${nf(r.parcelas)} parcela(s) no total`);
  }

  // O recorte que interessa: em aberto, vencidas x a vencer.
  const q = await c.query(
    `SELECT
       COUNT(*) FILTER (WHERE vencimento <  $2::date)::int AS n_vencidas,
       COALESCE(SUM(valor_parcela) FILTER (WHERE vencimento <  $2::date),0)::float AS v_vencidas,
       COUNT(*) FILTER (WHERE vencimento >= $2::date)::int AS n_avencer,
       COALESCE(SUM(valor_parcela) FILTER (WHERE vencimento >= $2::date),0)::float AS v_avencer,
       COUNT(*) FILTER (WHERE vencimento IS NULL)::int AS n_sem_venc,
       MIN(vencimento) AS mais_antiga,
       MAX(vencimento) AS mais_distante
     FROM crediario_parcelas
    WHERE UPPER(COALESCE(nome_cliente,'')) LIKE '%' || $1 || '%'
      AND pago = false AND cancelado = false`,
    [busca, hoje],
  );
  const r = q.rows[0];

  console.log('');
  console.log('--- EM ABERTO ---');
  console.log(`  VENCIDAS:  ${String(nf(r.n_vencidas)).padStart(6)} parcela(s)  ${brl(r.v_vencidas).padStart(16)}`);
  console.log(`  A VENCER:  ${String(nf(r.n_avencer)).padStart(6)} parcela(s)  ${brl(r.v_avencer).padStart(16)}`);
  if (r.n_sem_venc) console.log(`  sem data:  ${String(nf(r.n_sem_venc)).padStart(6)} parcela(s)`);
  console.log(`  ${'-'.repeat(46)}`);
  console.log(`  TOTAL:     ${String(nf(r.n_vencidas + r.n_avencer)).padStart(6)} parcela(s)  ${brl(r.v_vencidas + r.v_avencer).padStart(16)}`);
  console.log('');
  console.log(`  vencimento mais antigo:   ${r.mais_antiga ? String(r.mais_antiga).slice(0, 15) : '-'}`);
  console.log(`  vencimento mais distante: ${r.mais_distante ? String(r.mais_distante).slice(0, 15) : '-'}`);

  // Faixas de atraso — quem esta so atrasado e quem ja e perda provavel.
  const faixas = await c.query(
    `SELECT
       COUNT(*) FILTER (WHERE $2::date - vencimento BETWEEN 1 AND 30)::int AS a30,
       COALESCE(SUM(valor_parcela) FILTER (WHERE $2::date - vencimento BETWEEN 1 AND 30),0)::float AS v30,
       COUNT(*) FILTER (WHERE $2::date - vencimento BETWEEN 31 AND 90)::int AS a90,
       COALESCE(SUM(valor_parcela) FILTER (WHERE $2::date - vencimento BETWEEN 31 AND 90),0)::float AS v90,
       COUNT(*) FILTER (WHERE $2::date - vencimento > 90)::int AS a90p,
       COALESCE(SUM(valor_parcela) FILTER (WHERE $2::date - vencimento > 90),0)::float AS v90p
     FROM crediario_parcelas
    WHERE UPPER(COALESCE(nome_cliente,'')) LIKE '%' || $1 || '%'
      AND pago = false AND cancelado = false AND vencimento < $2::date`,
    [busca, hoje],
  );
  const f = faixas.rows[0];
  if (r.n_vencidas) {
    console.log('');
    console.log('--- AS VENCIDAS, POR TEMPO DE ATRASO ---');
    console.log(`  ate 30 dias:  ${String(nf(f.a30)).padStart(6)}  ${brl(f.v30).padStart(16)}`);
    console.log(`  31 a 90 dias: ${String(nf(f.a90)).padStart(6)}  ${brl(f.v90).padStart(16)}`);
    console.log(`  mais de 90:   ${String(nf(f.a90p)).padStart(6)}  ${brl(f.v90p).padStart(16)}`);
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
