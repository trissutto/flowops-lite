/**
 * As bandeiras de cartão AINDA entram como crediário, ou isso parou?
 *
 * A pergunta decide o trabalho:
 *   · PAROU  → é só herança. Basta classificar as fichas e excluir do cálculo.
 *              Nada no fluxo de venda precisa mudar.
 *   · CONTINUA → tem caminho de venda ATIVO empilhando cartão no crediário, e
 *                classificar só esconde o sintoma — todo mês entra mais.
 *
 * O teste: a data de compra das parcelas de CREDICARD/VISANET/CIELO/etc. Se a
 * mais recente for antiga, parou. Se for de ontem, continua.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-cartao-ainda-vira-crediario.js
 */

const { Client } = require('pg');
const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

const OPERADORA =
  '^(REDESHOP|VISAELECTRON|CREDICARD|VISANET|SISPUMI|SOROCRED|CREDSYSTEM|GREMIO|' +
  'AMEX|HIPERCARD|ELO|CIELO|VINHECARD)$';

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  console.log('--- PARCELAS DE OPERADORA, POR ANO DE COMPRA ---');
  const anos = await c.query(
    `SELECT EXTRACT(YEAR FROM data_compra)::int AS ano,
            COUNT(*)::int AS n, COALESCE(SUM(valor_parcela),0)::float AS v
       FROM crediario_parcelas
      WHERE UPPER(TRIM(COALESCE(nome_cliente,''))) ~ $1
        AND data_compra IS NOT NULL
      GROUP BY 1 ORDER BY 1 DESC LIMIT 10`,
    [OPERADORA],
  );
  for (const a of anos.rows) {
    console.log(`  ${a.ano}  ${String(nf(a.n)).padStart(7)} parcelas · ${brl(a.v).padStart(15)}`);
  }

  const [{ ultima }] = (await c.query(
    `SELECT MAX(data_compra) AS ultima FROM crediario_parcelas
      WHERE UPPER(TRIM(COALESCE(nome_cliente,''))) ~ $1`,
    [OPERADORA],
  )).rows;
  console.log('');
  console.log(`  compra mais RECENTE de operadora: ${ultima ? String(ultima).slice(0, 15) : '(nenhuma)'}`);

  // Comparacao: e o crediario de pessoa fisica, ate quando vai?
  const [{ ultima_pf }] = (await c.query(
    `SELECT MAX(data_compra) AS ultima_pf FROM crediario_parcelas
      WHERE COALESCE(TRIM(nome_cliente),'') <> ''
        AND UPPER(TRIM(nome_cliente)) !~ $1`,
    [OPERADORA],
  )).rows;
  console.log(`  compra mais recente de PESSOA:    ${ultima_pf ? String(ultima_pf).slice(0, 15) : '(nenhuma)'}`);

  // O Flow ja separa? Vendas do PDV nativo por forma de pagamento.
  console.log('');
  console.log('--- COMO O FLOW REGISTRA HOJE (pdv_sale_payments, 90 dias) ---');
  const fp = await c.query(
    `SELECT method, COUNT(*)::int AS n, COALESCE(SUM(valor),0)::float AS v
       FROM pdv_sale_payments p
       JOIN pdv_sales s ON s.id = p.sale_id
      WHERE s.created_at > NOW() - INTERVAL '90 days' AND s.status = 'finalized'
      GROUP BY 1 ORDER BY 3 DESC`,
  );
  for (const r of fp.rows) {
    console.log(`  ${String(r.method).padEnd(14)} ${String(nf(r.n)).padStart(7)} · ${brl(r.v).padStart(15)}`);
  }

  // Parcelas criadas PELO FLOW (faixa 900M) — alguma e de operadora?
  const flow = await c.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE UPPER(TRIM(COALESCE(nome_cliente,''))) ~ $1)::int AS de_operadora
       FROM crediario_parcelas WHERE flow_is_source = true`,
    [OPERADORA],
  );
  console.log('');
  console.log('--- PARCELAS CRIADAS PELO FLOW (faixa 900.000.000+) ---');
  console.log(`  total: ${nf(flow.rows[0].n)} · de operadora: ${nf(flow.rows[0].de_operadora)}`);

  console.log('');
  console.log('=========================================');
  const anoUlt = ultima ? new Date(ultima).getFullYear() : 0;
  const anoPF = ultima_pf ? new Date(ultima_pf).getFullYear() : 0;
  if (anoUlt && anoPF && anoUlt >= anoPF) {
    console.log('VEREDITO: AINDA ESTA ACONTECENDO. A compra de operadora e tao');
    console.log('recente quanto a de pessoa — existe caminho de venda ativo');
    console.log('empilhando cartao no crediario. Classificar so esconde: todo');
    console.log('mes entra mais. Achar e fechar a origem primeiro.');
  } else {
    console.log('VEREDITO: PAROU. E heranca do Wincred antigo.');
    console.log('Basta classificar as fichas e excluir do calculo — nenhum');
    console.log('fluxo de venda precisa mudar.');
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
