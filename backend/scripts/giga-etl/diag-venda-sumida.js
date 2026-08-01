/**
 * A venda existe, e em que "dia" ela caiu?
 *
 * Caso concreto: venda em Itu (loja 19) de R$ 23,90, feita em 31/07/2026 por
 * volta das 22h50 de Brasília, que NÃO apareceu no resumo do dia.
 *
 * Duas explicações possíveis, e elas exigem ações opostas:
 *   a) a venda não gravou       → problema de venda, investigar o PDV
 *   b) gravou, mas o relatório  → problema de FUSO: 22h50 em Brasília é
 *      procura no dia errado       01h50 de 01/08 em UTC, e o servidor roda UTC
 *
 * Este script mostra o horário da venda nos dois fusos e diz em que dia cada
 * critério a coloca.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-venda-sumida.js
 */

const { Client } = require('pg');

const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  console.log('--- RELOGIOS ---');
  const t = await c.query(
    `SELECT NOW() AS agora_tz,
            NOW() AT TIME ZONE 'America/Sao_Paulo' AS agora_brasilia,
            NOW() AT TIME ZONE 'UTC' AS agora_utc,
            CURRENT_DATE AS current_date_do_banco,
            (NOW() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje_brasilia`,
  );
  const r0 = t.rows[0];
  console.log(`  agora (Brasilia):        ${r0.agora_brasilia}`);
  console.log(`  agora (UTC):             ${r0.agora_utc}`);
  console.log(`  CURRENT_DATE do banco:   ${r0.current_date_do_banco}`);
  console.log(`  data de hoje em Brasilia:${r0.hoje_brasilia}`);
  if (String(r0.current_date_do_banco) !== String(r0.hoje_brasilia)) {
    console.log('  *** O BANCO E A LOJA ESTAO EM DIAS DIFERENTES AGORA.');
    console.log('      Todo relatorio que usar CURRENT_DATE vai olhar o dia errado.');
  }

  console.log('');
  console.log('--- ULTIMAS VENDAS (todas as lojas, 6h) ---');
  const v = await c.query(
    `SELECT s.id, s.store_code, s.total, s.status, s.created_at,
            s.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo' AS criada_brasilia,
            s.finalized_at
       FROM pdv_sales s
      WHERE s.created_at > NOW() - INTERVAL '6 hours'
      ORDER BY s.created_at DESC LIMIT 15`,
  );
  if (!v.rows.length) {
    console.log('  (nenhuma venda nas ultimas 6h)');
  }
  for (const s of v.rows) {
    const diaUtc = new Date(s.created_at).toISOString().slice(0, 10);
    const diaBr = String(s.criada_brasilia).slice(0, 10);
    const marca = diaUtc !== diaBr ? '  *** DIAS DIFERENTES' : '';
    console.log(
      `  loja ${String(s.store_code).padEnd(3)} ${brl(s.total).padStart(12)} ${String(s.status).padEnd(10)}` +
      ` | UTC ${diaUtc} | BR ${diaBr}${marca}`,
    );
  }

  console.log('');
  console.log('--- LOJA 19 (ITU) HOJE ---');
  for (const [nome, cond] of [
    ['criterio UTC (o que o servidor chama de hoje)', `s.created_at::date = (NOW() AT TIME ZONE 'UTC')::date`],
    ['criterio BRASILIA (o dia da loja)', `(s.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`],
  ]) {
    const q = await c.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(s.total),0)::float AS v
         FROM pdv_sales s
        WHERE s.store_code IN ('19','ITU') AND s.status = 'finalized' AND ${cond}`,
    );
    console.log(`  ${nome}: ${q.rows[0].n} venda(s) · ${brl(q.rows[0].v)}`);
  }

  console.log('');
  console.log('--- REDE HOJE: quanto muda conforme o criterio ---');
  const rede = await c.query(
    `SELECT
       COUNT(*) FILTER (WHERE s.created_at::date = (NOW() AT TIME ZONE 'UTC')::date)::int AS n_utc,
       COALESCE(SUM(s.total) FILTER (WHERE s.created_at::date = (NOW() AT TIME ZONE 'UTC')::date),0)::float AS v_utc,
       COUNT(*) FILTER (WHERE (s.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS n_br,
       COALESCE(SUM(s.total) FILTER (WHERE (s.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date),0)::float AS v_br
     FROM pdv_sales s WHERE s.status = 'finalized'`,
  );
  const R = rede.rows[0];
  console.log(`  criterio UTC:      ${R.n_utc} venda(s) · ${brl(R.v_utc)}`);
  console.log(`  criterio BRASILIA: ${R.n_br} venda(s) · ${brl(R.v_br)}`);
  console.log(`  diferenca:         ${R.n_br - R.n_utc} venda(s) · ${brl(R.v_br - R.v_utc)}`);

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
