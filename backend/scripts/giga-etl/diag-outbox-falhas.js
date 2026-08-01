/**
 * Os jobs de estoque que NUNCA chegaram no Giga.
 *
 * O diagnóstico de divergência apontou 7 jobs `estoque_delta` em `failed` e 3
 * em `pending`. Cada um é uma baixa de estoque que saiu no Flow e não foi
 * replicada — é a explicação mais provável dos casos "Flow menor que Giga".
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-outbox-falhas.js
 */

const { Client } = require('pg');

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await pg.connect();

  console.log('--- JOBS NAO CONCLUIDOS ---');
  const r = await pg.query(
    `SELECT id, kind, sale_id, status, attempts, created_at, next_retry_at,
            caixa_done_at, stock_done_at, LEFT(COALESCE(last_error,''), 240) AS erro
       FROM erp_outbox
      WHERE status <> 'done'
      ORDER BY created_at`,
  );
  for (const j of r.rows) {
    console.log('');
    console.log(`  ${j.kind} / ${j.status} / tentativas=${j.attempts}`);
    console.log(`    venda:   ${j.sale_id}`);
    console.log(`    criado:  ${j.created_at}`);
    console.log(`    caixaOk: ${j.caixa_done_at || '-'}   estoqueOk: ${j.stock_done_at || '-'}`);
    if (j.erro) console.log(`    erro:    ${j.erro}`);
  }
  console.log('');
  console.log(`  total nao concluido: ${r.rows.length}`);

  // Quanto tempo a fila leva normalmente? Se o p95 e baixo, os pendentes de
  // agora sao so timing; se e alto, a fila esta doente.
  console.log('');
  console.log('--- SAUDE DA FILA (ultimas 24h, concluidos) ---');
  const s = await pg.query(
    `SELECT kind,
            COUNT(*)::int AS n,
            ROUND(AVG(EXTRACT(EPOCH FROM (done_at - created_at))))::int AS seg_medio,
            MAX(attempts) AS max_tentativas
       FROM erp_outbox
      WHERE status = 'done' AND done_at > NOW() - INTERVAL '24 hours'
      GROUP BY kind ORDER BY n DESC`,
  );
  if (!s.rows.length) console.log('  (nenhum job concluido nas ultimas 24h)');
  for (const k of s.rows) {
    console.log(`  ${k.kind}: ${k.n} jobs, ${k.seg_medio}s em media, max ${k.max_tentativas} tentativas`);
  }

  // A divergencia se concentra em peca que vendeu recente? Se sim, e timing.
  console.log('');
  console.log('--- VENDAS DAS ULTIMAS 2H ---');
  const v = await pg.query(
    `SELECT COUNT(DISTINCT s.id)::int AS vendas, COUNT(i.id)::int AS itens
       FROM pdv_sales s JOIN pdv_sale_items i ON i.sale_id = s.id
      WHERE s.created_at > NOW() - INTERVAL '2 hours'`,
  );
  console.log(`  ${v.rows[0].vendas} vendas, ${v.rows[0].itens} itens desde as 2h atras`);

  await pg.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
