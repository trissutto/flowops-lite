/**
 * Quanto cada vendedora perde de comissão por causa das trocas?
 *
 * Primeira apuração pelo sistema novo. O Wincred não registra as trocas feitas
 * no Flow, então a comissão de lá é MAIOR — o Flow desconta devolução, o
 * Wincred não. O Flow está certo; o número é que vai ser diferente do que a
 * vendedora esperava.
 *
 * Este script mostra, por vendedora: vendido, devolvido, líquido e quanto a
 * troca custou de comissão. Serve pra explicar antes de pagar, em vez de
 * responder reclamação depois.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/comissao-impacto-trocas.js [AAAA-MM]
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
  const ini = new Date(Date.UTC(y, m - 1, 1, 3, 0, 0));
  const fim = new Date(Date.UTC(y, m, 1, 3, 0, 0));

  // O que o fechamento efetivamente gravou — se ja existe.
  const per = await c.query(
    `SELECT p.year_month, p.status,
            e.seller_name, e.store_code, e.total_vendido, e.total_trocas,
            e.vendido_liquido, e.total
       FROM commission_periods p
       JOIN commission_entries e ON e.period_id = p.id
      WHERE p.year_month = $1
      ORDER BY e.total DESC`,
    [YM],
  ).catch(() => ({ rows: [] }));

  console.log(`Apuracao de ${YM}`);
  console.log('');

  if (per.rows.length) {
    console.log('--- O QUE O FECHAMENTO GRAVOU (por vendedora) ---');
    let sv = 0, st = 0, sc = 0;
    for (const r of per.rows) {
      const vend = Number(r.total_vendido) || 0;
      const troc = Number(r.total_trocas) || 0;
      const com = Number(r.total) || 0;
      sv += vend; st += troc; sc += com;
      // Quanto a troca custou: a mesma taxa aplicada sobre o que foi devolvido.
      const taxa = vend > 0 ? com / (vend - troc || 1) : 0;
      const perdeu = troc * taxa;
      console.log(
        `  ${String(r.seller_name || '?').slice(0, 26).padEnd(28)} loja ${String(r.store_code).padEnd(3)}` +
        ` vendeu ${brl(vend).padStart(13)} · trocou ${brl(troc).padStart(11)}` +
        ` · comissao ${brl(com).padStart(10)}` +
        (troc > 0 ? `  (troca custou ~${brl(perdeu)})` : ''),
      );
    }
    console.log('');
    console.log(`  TOTAIS: vendido ${brl(sv)} · trocas ${brl(st)} · comissao ${brl(sc)}`);
    console.log(`  >> sem descontar troca, a comissao seria ~${brl(sc + (sv > 0 ? st * (sc / (sv - st || 1)) : 0))}`);
  } else {
    console.log('  (periodo ainda nao fechado — mostrando o que ele vai encontrar)');
  }

  // As devolucoes do periodo, direto da fonte.
  console.log('');
  console.log('--- DEVOLUCOES/TROCAS NO PERIODO (o que o Wincred nao tem) ---');
  const dev = await c.query(
    `SELECT r.store_code, COUNT(*)::int AS n, COALESCE(SUM(r.valor_total),0)::float AS v,
            COUNT(*) FILTER (WHERE r.modo = 'troca')::int AS trocas,
            COUNT(*) FILTER (WHERE r.modo <> 'troca')::int AS outras
       FROM pdv_returns r
      WHERE r.created_at >= $1 AND r.created_at < $2
      GROUP BY 1 ORDER BY 3 DESC`,
    [ini, fim],
  ).catch(() => ({ rows: [] }));

  let tot = 0, totN = 0;
  for (const r of dev.rows) {
    tot += Number(r.v); totN += Number(r.n);
    console.log(`  loja ${String(r.store_code).padEnd(3)} ${String(nf(r.n)).padStart(5)} devolucao(oes) · ${brl(r.v).padStart(13)}  (troca ${r.trocas} · outras ${r.outras})`);
  }
  console.log('');
  console.log(`  TOTAL: ${nf(totN)} · ${brl(tot)}`);
  console.log('');
  console.log('  Este e o valor que o Wincred NAO desconta e o Flow desconta.');
  console.log('  A comissao pelo Flow sai menor — e e a correta: a peca voltou.');

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
