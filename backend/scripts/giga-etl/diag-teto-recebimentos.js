/**
 * A tela de Recebimentos está escondendo dívida?
 *
 * `listAbertasDoEspelho` lê `wincred_movimento_aberto` com
 * `orderBy: vencimento asc` e `take: 5000`. Como a ordem é do vencimento mais
 * ANTIGO pro mais NOVO, o que passa do teto são justamente as parcelas de
 * vencimento mais distante — as das vendas mais recentes.
 *
 * Não é hipótese: são 82.681 parcelas em aberto na rede. A pergunta é se
 * alguma loja isolada já passa de 5.000, porque a tela filtra por loja.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-teto-recebimentos.js
 */

const { Client } = require('pg');

const TETO = 5000;
const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  const total = await c.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(valor_parcela),0)::float AS v FROM wincred_movimento_aberto`,
  );
  console.log(`Espelho de abertas: ${nf(total.rows[0].n)} parcelas · ${brl(total.rows[0].v)}`);
  console.log('');

  const porLoja = await c.query(
    `SELECT loja, COUNT(*)::int AS n, COALESCE(SUM(valor_parcela),0)::float AS v
       FROM wincred_movimento_aberto GROUP BY loja ORDER BY n DESC`,
  );

  console.log('--- POR LOJA (a tela filtra por loja) ---');
  let lojasEstourando = 0;
  let escondidoTotal = 0;
  for (const r of porLoja.rows) {
    const estoura = r.n > TETO;
    if (estoura) lojasEstourando++;
    const escondidas = estoura ? r.n - TETO : 0;

    // Quanto vale o que fica FORA do teto: as `escondidas` de vencimento mais
    // distante, que e exatamente o que o `take` corta.
    let valorEscondido = 0;
    if (estoura) {
      const q = await c.query(
        `SELECT COALESCE(SUM(valor_parcela),0)::float AS v FROM (
           SELECT valor_parcela FROM wincred_movimento_aberto
            WHERE loja = $1 ORDER BY vencimento ASC OFFSET $2
         ) t`,
        [r.loja, TETO],
      );
      valorEscondido = q.rows[0].v;
      escondidoTotal += valorEscondido;
    }
    console.log(
      `  loja ${String(r.loja).padEnd(3)} ${nf(r.n).padStart(7)} parcelas  ${brl(r.v).padStart(18)}` +
      (estoura ? `   *** ${nf(escondidas)} INVISIVEIS (${brl(valorEscondido)})` : ''),
    );
  }

  // Visao ADMIN (sem filtro de loja) — o teto vale pra rede inteira.
  console.log('');
  console.log('--- VISAO ADMIN (todas as lojas, sem filtro) ---');
  if (total.rows[0].n > TETO) {
    const q = await c.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(valor_parcela),0)::float AS v FROM (
         SELECT valor_parcela FROM wincred_movimento_aberto ORDER BY vencimento ASC OFFSET $1
       ) t`,
      [TETO],
    );
    console.log(`  *** ${nf(q.rows[0].n)} parcelas INVISIVEIS · ${brl(q.rows[0].v)}`);
  } else {
    console.log('  dentro do teto');
  }

  console.log('');
  console.log('=========================================');
  if (lojasEstourando) {
    console.log(`VEREDITO: ${lojasEstourando} loja(s) passam do teto de ${nf(TETO)}.`);
    console.log(`Dividas invisiveis na tela por loja: ${brl(escondidoTotal)}.`);
    console.log('Como a ordem e por vencimento ASC, o que some sao as parcelas');
    console.log('mais NOVAS — as vendas recentes.');
  } else {
    console.log(`VEREDITO: nenhuma loja isolada passa de ${nf(TETO)} — por loja a tela esta inteira.`);
    console.log('A visao ADMIN (rede toda) acima e que decide se ha corte.');
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
