/**
 * Conferência do crediário criado no FLOW. Rodar DEPOIS do deploy.
 *
 * As colunas e a tabela de sequência só passam a existir quando o
 * `prisma db push` roda no deploy — por isso este script não pode rodar antes.
 *
 * Ele responde três perguntas, nesta ordem de gravidade:
 *   1. A estrutura subiu? (colunas + índice único + sequência)
 *   2. Alguma parcela do Flow ficou SEM chegar no Giga? (réplica travada)
 *   3. Alguma venda tem parcela DUPLICADA? (o pior cenário: cobrar duas vezes)
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/conferir-crediario-flow.js
 */

const { Client } = require('pg');
const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();
  let problemas = 0;

  // ── 1. Estrutura ────────────────────────────────────────────────────────
  console.log('--- ESTRUTURA ---');
  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'crediario_parcelas'
        AND column_name IN ('giga_ok','giga_at','giga_error','baixa_giga_ok','cancelado','sale_id')`,
  );
  const achadas = cols.rows.map((r) => r.column_name);
  for (const esperada of ['giga_ok', 'giga_at', 'giga_error', 'baixa_giga_ok', 'cancelado', 'sale_id']) {
    const ok = achadas.includes(esperada);
    console.log(`  ${ok ? 'OK  ' : 'FALTA'} coluna ${esperada}`);
    if (!ok) problemas++;
  }

  const idx = await c.query(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = 'crediario_parcelas' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%sale_id%'`,
  );
  console.log(`  ${idx.rows.length ? 'OK   ' : 'FALTA'} indice unico (sale_id, parcela)`);
  if (!idx.rows.length) problemas++;

  const seq = await c.query(
    `SELECT escopo, base, proximo, teto FROM crediario_seq ORDER BY escopo`,
  ).catch(() => null);
  if (!seq) {
    console.log('  FALTA tabela crediario_seq');
    problemas++;
  } else if (!seq.rows.length) {
    console.log('  ..... crediario_seq vazia (normal ate a 1a venda a crediario)');
  } else {
    for (const r of seq.rows) {
      const usados = Number(r.proximo) - Number(r.base);
      console.log(`  OK   seq ${r.escopo}: base ${nf(r.base)} · proximo ${nf(r.proximo)} · ${nf(usados)} usados`);
    }
  }

  // ── 2. Réplica pendente ─────────────────────────────────────────────────
  console.log('');
  console.log('--- REPLICA PRO GIGA ---');
  const pend = await c.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(valor_parcela),0)::float AS v,
            MIN(synced_at) AS mais_antiga
       FROM crediario_parcelas
      WHERE flow_is_source = true AND giga_ok = false AND cancelado = false`,
  );
  const p = pend.rows[0];
  console.log(`  pendentes: ${nf(p.n)} parcela(s) · ${brl(p.v)}`);
  if (p.n) {
    console.log(`  mais antiga: ${p.mais_antiga}`);
    // Pendente e NORMAL por ~30s (o cron do outbox). Horas significa fila presa.
    const horas = (Date.now() - new Date(p.mais_antiga).getTime()) / 3600000;
    if (horas > 2) {
      console.log(`  *** ha ${horas.toFixed(1)}h sem replicar — conferir erp_outbox (kind crediario_criacao)`);
      problemas++;
    } else {
      console.log('  (dentro do esperado — o cron roda a cada 30s)');
    }
  }

  const jobs = await c.query(
    `SELECT status, COUNT(*)::int AS n FROM erp_outbox
      WHERE kind = 'crediario_criacao' GROUP BY status`,
  );
  if (jobs.rows.length) {
    console.log('  jobs na fila: ' + jobs.rows.map((r) => `${r.status}=${r.n}`).join(' · '));
    const falhos = jobs.rows.find((r) => r.status === 'failed');
    if (falhos) problemas++;
  }

  // ── 3. Duplicata — o pior cenário ───────────────────────────────────────
  console.log('');
  console.log('--- DUPLICATA (cobrar duas vezes) ---');
  const dup = await c.query(
    `SELECT sale_id, parcela, COUNT(*)::int AS n
       FROM crediario_parcelas
      WHERE sale_id IS NOT NULL AND cancelado = false
      GROUP BY sale_id, parcela HAVING COUNT(*) > 1 LIMIT 20`,
  );
  if (!dup.rows.length) {
    console.log('  nenhuma — o indice unico esta segurando');
  } else {
    console.log(`  *** ${dup.rows.length} par(es) duplicado(s):`);
    for (const r of dup.rows) console.log(`     venda ${r.sale_id} parcela ${r.parcela} -> ${r.n}x`);
    problemas++;
  }

  // Venda com crediário mas sem parcela nenhuma = dívida perdida.
  const orfas = await c.query(
    `SELECT COUNT(*)::int AS n FROM pdv_sales s
      WHERE s.crediario_lock_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM crediario_parcelas p WHERE p.sale_id = s.id)`,
  );
  console.log('');
  console.log('--- SENTINELA SEM PARCELA (tentativa que morreu no meio) ---');
  console.log(`  ${nf(orfas.rows[0].n)} venda(s)`);
  if (orfas.rows[0].n) {
    console.log('  *** essas vendas travaram: a sentinela foi tomada e nada foi criado.');
    console.log('      A vendedora vê "criação em andamento". Destravar limpando');
    console.log('      crediario_lock_id DEPOIS de confirmar que nao ha parcela.');
    problemas++;
  }

  console.log('');
  console.log('=========================================');
  console.log(problemas ? `${problemas} ponto(s) de atencao acima.` : 'Tudo certo.');
  await c.end();
  process.exit(problemas ? 1 : 0);
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
