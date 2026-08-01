/**
 * O que já existe de cashback ANTES de construir o novo?
 *
 * Achei TRÊS estruturas no schema e nenhuma faz o que o dono pediu:
 *   1) cashback_balances + cashback_transactions  → por Customer.id (POR LOJA)
 *   2) customer_accounts.cashback_balance_cents   → por PESSOA, mas só quem
 *      instalou o app; alimentado por pedido do site
 *   3) customer_cashback_txs                      → extrato do (2)
 *
 * Antes de mexer preciso saber se alguma delas tem DINHEIRO DE VERDADE.
 * Saldo que já foi prometido a cliente não pode ser zerado por refatoração —
 * é dívida da empresa com a pessoa.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/medir-cashback-existente.js
 */

const { Client } = require('pg');

const BRL = (n) => `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  const existe = async (t) => {
    const r = await c.query(`SELECT to_regclass($1) AS t`, [t]);
    return !!r.rows[0].t;
  };

  console.log('══════ 1) CASHBACK DO CRM (por cadastro/loja) ══════');
  if (await existe('cashback_balances')) {
    const b = await c.query(
      `SELECT COUNT(*)::int AS fichas,
              COUNT(*) FILTER (WHERE balance_cents > 0)::int AS com_saldo,
              COALESCE(SUM(balance_cents),0)::bigint AS saldo,
              COALESCE(SUM(accumulated_total_cents),0)::bigint AS acumulado,
              COALESCE(SUM(redeemed_total_cents),0)::bigint AS resgatado
         FROM cashback_balances`,
    );
    const x = b.rows[0];
    console.log(`  fichas com registro: ${x.fichas} · com saldo > 0: ${x.com_saldo}`);
    console.log(`  SALDO EM ABERTO: ${BRL(Number(x.saldo) / 100)}`);
    console.log(`  ja acumulado: ${BRL(Number(x.acumulado) / 100)} · ja resgatado: ${BRL(Number(x.resgatado) / 100)}`);

    const t = await c.query(
      `SELECT type, COUNT(*)::int AS n, COALESCE(SUM(value_cents),0)::bigint AS v,
              MIN(created_at) AS de, MAX(created_at) AS ate
         FROM cashback_transactions GROUP BY 1 ORDER BY 2 DESC`,
    );
    if (!t.rows.length) console.log('  extrato: VAZIO (nunca creditou nada)');
    for (const r of t.rows) {
      console.log(`    ${String(r.type).padEnd(20)} ${String(r.n).padStart(6)}x  ${BRL(Number(r.v) / 100).padStart(16)}  ${String(r.de).slice(0, 10)} a ${String(r.ate).slice(0, 10)}`);
    }
  } else console.log('  (tabela nao existe)');

  console.log('');
  console.log('══════ 2) CASHBACK DO APP (por pessoa) ══════');
  if (await existe('customer_accounts')) {
    const a = await c.query(
      `SELECT COUNT(*)::int AS contas,
              COUNT(*) FILTER (WHERE cashback_balance_cents > 0)::int AS com_saldo,
              COALESCE(SUM(cashback_balance_cents),0)::bigint AS saldo,
              COALESCE(SUM(cashback_earned_cents),0)::bigint AS ganho,
              COALESCE(SUM(cashback_spent_cents),0)::bigint AS gasto
         FROM customer_accounts`,
    );
    const x = a.rows[0];
    console.log(`  contas no app: ${x.contas} · com saldo > 0: ${x.com_saldo}`);
    console.log(`  SALDO EM ABERTO: ${BRL(Number(x.saldo) / 100)}`);
    console.log(`  ja ganho: ${BRL(Number(x.ganho) / 100)} · ja gasto: ${BRL(Number(x.gasto) / 100)}`);

    const t = await c.query(
      `SELECT type, COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS v,
              MIN(created_at) AS de, MAX(created_at) AS ate
         FROM customer_cashback_txs GROUP BY 1 ORDER BY 2 DESC`,
    );
    if (!t.rows.length) console.log('  extrato: VAZIO (nunca creditou nada)');
    for (const r of t.rows) {
      console.log(`    ${String(r.type).padEnd(20)} ${String(r.n).padStart(6)}x  ${BRL(Number(r.v) / 100).padStart(16)}  ${String(r.de).slice(0, 10)} a ${String(r.ate).slice(0, 10)}`);
    }
  } else console.log('  (tabela nao existe)');

  console.log('');
  console.log('══════ 3) A CONFIG QUE ESTA VALENDO ══════');
  if (await existe('app_config')) {
    const cfg = await c.query(`SELECT value_json FROM app_config WHERE key = 'cashback-config'`);
    if (!cfg.rows.length) {
      console.log('  nao ha config salva → vale o PADRAO do codigo:');
      console.log('    creditoPct 5% · usoMaxPct 30% · minimo R$ 20 · validade 90 dias · ATIVO true');
    } else console.log(`  ${cfg.rows[0].value_json}`);
  } else console.log('  (app_config nao existe)');

  // ── O CUSTO DO QUE O DONO PEDIU ──
  // 10% na 1a compra + 3% nas demais, sobre as vendas REAIS do PDV.
  console.log('');
  console.log('══════ 4) QUANTO CUSTARIA A REGRA NOVA (vendas do Flow) ══════');
  const sim = await c.query(
    `WITH v AS (
       SELECT regexp_replace(COALESCE(customer_cpf,''), '\\D', '', 'g') AS cpf,
              total, created_at,
              ROW_NUMBER() OVER (
                PARTITION BY regexp_replace(COALESCE(customer_cpf,''), '\\D', '', 'g')
                ORDER BY created_at
              ) AS ordem
         FROM pdv_sales
        WHERE status = 'finalized' AND is_training = false
          AND regexp_replace(COALESCE(customer_cpf,''), '\\D', '', 'g') <> ''
          AND created_at >= NOW() - INTERVAL '30 days'
     )
     SELECT COUNT(*)::int AS vendas,
            COUNT(DISTINCT cpf)::int AS pessoas,
            COALESCE(SUM(total),0)::float AS faturado,
            COUNT(*) FILTER (WHERE ordem = 1)::int AS primeiras,
            COALESCE(SUM(total) FILTER (WHERE ordem = 1),0)::float AS base_10,
            COALESCE(SUM(total) FILTER (WHERE ordem > 1),0)::float AS base_3
       FROM v`,
  );
  const s = sim.rows[0];
  const c10 = Number(s.base_10) * 0.10;
  const c3 = Number(s.base_3) * 0.03;
  console.log(`  ultimos 30 dias · ${s.vendas} vendas COM CPF · ${s.pessoas} pessoas`);
  console.log(`  faturado com CPF: ${BRL(s.faturado)}`);
  console.log(`  1a compra (10%): ${s.primeiras} vendas sobre ${BRL(s.base_10)} = ${BRL(c10)}`);
  console.log(`  demais    (3%):  sobre ${BRL(s.base_3)} = ${BRL(c3)}`);
  console.log(`  CUSTO MENSAL SE TODAS USASSEM: ${BRL(c10 + c3)}`);
  console.log(`  (teto de uso 30% por compra e expiracao em 30 dias reduzem isso na pratica)`);

  // Quantas vendas NAO tem CPF? Sem CPF nao ha cashback — e o tamanho disso
  // decide se a regra vai ter alcance ou vai morrer na porta.
  const semCpf = await c.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE regexp_replace(COALESCE(customer_cpf,''), '\\D','','g') = '')::int AS sem,
            COALESCE(SUM(total),0)::float AS tot,
            COALESCE(SUM(total) FILTER (WHERE regexp_replace(COALESCE(customer_cpf,''), '\\D','','g') = ''),0)::float AS tot_sem
       FROM pdv_sales
      WHERE status='finalized' AND is_training=false AND created_at >= NOW() - INTERVAL '30 days'`,
  );
  const q = semCpf.rows[0];
  const pct = q.n ? (q.sem / q.n) * 100 : 0;
  console.log('');
  console.log(`  ⚠ VENDAS SEM CPF: ${q.sem} de ${q.n} (${pct.toFixed(1)}%) · ${BRL(q.tot_sem)} de ${BRL(q.tot)}`);
  console.log(`    essas nao geram nem usam cashback — a regra so alcanca quem identifica.`);

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
