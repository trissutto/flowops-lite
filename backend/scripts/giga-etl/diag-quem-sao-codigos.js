/**
 * Quem são os códigos que concentram a dívida?
 *
 * Hipótese do dono: as bandeiras de cartão eram cadastradas como cliente de
 * crediário antigamente. Se for isso, a "dívida" delas é recebível de operadora
 * — não é cliente devendo, e não pode entrar no limite por pessoa.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-quem-sao-codigos.js
 */

const { Client } = require('pg');
const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  const q = await c.query(
    `SELECT cod_cliente,
            COUNT(*)::int AS n,
            COALESCE(SUM(valor_parcela),0)::float AS v,
            COUNT(DISTINCT loja)::int AS lojas,
            STRING_AGG(DISTINCT COALESCE(NULLIF(TRIM(nome_cliente),''),'(sem nome)'), ' | ') AS nomes
       FROM crediario_parcelas
      WHERE pago = false AND cancelado = false
      GROUP BY 1 ORDER BY 2 DESC LIMIT 16`,
  );

  console.log('--- CODIGOS QUE CONCENTRAM A DIVIDA ---');
  for (const r of q.rows) {
    console.log('');
    console.log(`  cod ${String(r.cod_cliente).padEnd(6)} ${String(nf(r.n)).padStart(7)} parcelas · ${brl(r.v).padStart(16)} · ${r.lojas} loja(s)`);
    console.log(`      ${String(r.nomes).slice(0, 100)}`);
  }

  // Quanto e "cara de operadora" pelo nome.
  const RE = "(VISA|MASTER|ELO|AMEX|AMERICAN|HIPER|CIELO|REDE|STONE|GETNET|PAGSEGURO|PAGBANK|SIPAG|BANRI|CABAL|SOROCRED|CREDSYSTEM|CARTAO|CARTÃO|TICKET|ALELO|SODEXO|VR |VALE)";
  const op = await c.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(valor_parcela),0)::float AS v
       FROM crediario_parcelas
      WHERE pago = false AND cancelado = false
        AND UPPER(COALESCE(nome_cliente,'')) ~ $1`,
    [RE],
  );
  const tot = await c.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(valor_parcela),0)::float AS v
       FROM crediario_parcelas WHERE pago = false AND cancelado = false`,
  );
  console.log('');
  console.log('--- PELO NOME, CARA DE OPERADORA DE CARTAO ---');
  console.log(`  ${nf(op.rows[0].n)} parcelas · ${brl(op.rows[0].v)}`);
  console.log(`  de um total de ${nf(tot.rows[0].n)} · ${brl(tot.rows[0].v)}`);
  const pct = tot.rows[0].v ? (op.rows[0].v / tot.rows[0].v) * 100 : 0;
  console.log(`  >> ${pct.toFixed(1)}% da "divida" e recebivel de operadora, nao de cliente`);

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
