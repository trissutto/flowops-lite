/**
 * A lista de operadoras do dono cobre quanto da "dívida"?
 *
 * O dono achou o de-para das bandeiras (REDESHOP, VISAELECTRON, CREDICARD,
 * VISANET, SISPUMI, SOROCRED, CREDSYSTEM, GREMIO, AMEX, HIPERCARD, ELO, CIELO).
 *
 * O código é POR LOJA — a mesma operadora tem número diferente em cada uma, e
 * há código que mistura operadora com pessoa real (cod 5 = CIELO + OSVALDIR).
 * Por isso a classificação tem que ser por NOME da ficha, não por número.
 *
 * Este script mostra: quantas fichas casam, quanto de dívida sai do crediário,
 * e o que sobra sem classificação — que é onde mora a decisão do dono.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-classificar-operadoras.js
 */

const { Client } = require('pg');
const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

const OPERADORAS = [
  'REDESHOP', 'VISAELECTRON', 'CREDICARD', 'VISANET', 'SISPUMI', 'SOROCRED',
  'CREDSYSTEM', 'GREMIO', 'AMEX', 'HIPERCARD', 'ELO', 'CIELO', 'VINHECARD',
];
const CANAIS = ['VENDA ONLINE', 'CONSUMIDOR'];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  // Regex de nome — âncora nas pontas pra 'ELO' não pegar "ANGELO", "MARCELO".
  const reOp = '^(' + OPERADORAS.join('|') + ')$';
  const reCanal = '^(' + CANAIS.join('|') + ')$';

  const tot = await c.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(valor_parcela),0)::float AS v
       FROM crediario_parcelas WHERE pago = false AND cancelado = false`,
  );

  console.log('--- POR OPERADORA (nome exato) ---');
  let somaOp = 0, somaOpN = 0;
  for (const nome of OPERADORAS) {
    const r = await c.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(valor_parcela),0)::float AS v,
              COUNT(DISTINCT loja || '/' || cod_cliente)::int AS fichas
         FROM crediario_parcelas
        WHERE pago = false AND cancelado = false
          AND UPPER(TRIM(COALESCE(nome_cliente,''))) = $1`,
      [nome],
    );
    const x = r.rows[0];
    if (!x.n) continue;
    somaOp += Number(x.v); somaOpN += Number(x.n);
    console.log(`  ${nome.padEnd(14)} ${String(nf(x.n)).padStart(7)} parcelas · ${brl(x.v).padStart(16)} · ${x.fichas} ficha(s)`);
  }

  console.log('');
  console.log('--- CANAIS ---');
  const canal = await c.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(valor_parcela),0)::float AS v
       FROM crediario_parcelas
      WHERE pago = false AND cancelado = false
        AND UPPER(TRIM(COALESCE(nome_cliente,''))) ~ $1`,
    [reCanal],
  );
  console.log(`  VENDA ONLINE   ${String(nf(canal.rows[0].n)).padStart(7)} parcelas · ${brl(canal.rows[0].v).padStart(16)}`);

  // Sem nome nenhum — o cod 0 e companhia.
  const semNome = await c.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(valor_parcela),0)::float AS v
       FROM crediario_parcelas
      WHERE pago = false AND cancelado = false
        AND COALESCE(TRIM(nome_cliente),'') = ''`,
  );

  const resto = Number(tot.rows[0].v) - somaOp - Number(canal.rows[0].v) - Number(semNome.rows[0].v);
  const restoN = Number(tot.rows[0].n) - somaOpN - Number(canal.rows[0].n) - Number(semNome.rows[0].n);

  console.log('');
  console.log('=========================================');
  console.log(`  TOTAL contado como aberto:  ${String(nf(tot.rows[0].n)).padStart(7)} · ${brl(tot.rows[0].v).padStart(16)}`);
  console.log(`  (-) operadoras de cartao:   ${String(nf(somaOpN)).padStart(7)} · ${brl(somaOp).padStart(16)}`);
  console.log(`  (-) canal VENDA ONLINE:     ${String(nf(canal.rows[0].n)).padStart(7)} · ${brl(canal.rows[0].v).padStart(16)}`);
  console.log(`  (-) SEM NOME (cod 0 e cia): ${String(nf(semNome.rows[0].n)).padStart(7)} · ${brl(semNome.rows[0].v).padStart(16)}`);
  console.log(`  = CLIENTE PESSOA FISICA:    ${String(nf(restoN)).padStart(7)} · ${brl(resto).padStart(16)}`);

  // Quem sobra e ainda parece operadora? Nome nao listado pelo dono.
  console.log('');
  console.log('--- SOBROU COM CARA DE OPERADORA (fora da sua lista) ---');
  const suspeitos = await c.query(
    `SELECT UPPER(TRIM(nome_cliente)) AS nome, COUNT(*)::int AS n,
            COALESCE(SUM(valor_parcela),0)::float AS v
       FROM crediario_parcelas
      WHERE pago = false AND cancelado = false
        AND COALESCE(TRIM(nome_cliente),'') <> ''
        AND UPPER(TRIM(nome_cliente)) !~ $1
        AND UPPER(TRIM(nome_cliente)) !~ $2
        AND UPPER(nome_cliente) ~ '(CARD|CARTAO|CARTÃO|BANC|CRED|PAG|SHOP|NET|VISA|MASTER|TICKET|ALELO|SODEXO|VALE|CONVENIO|CONVÊNIO|SIND)'
      GROUP BY 1 ORDER BY 3 DESC LIMIT 12`,
    [reOp, reCanal],
  );
  if (!suspeitos.rows.length) console.log('  (nenhum)');
  for (const s of suspeitos.rows) {
    console.log(`  ${String(s.nome).slice(0, 34).padEnd(36)} ${String(nf(s.n)).padStart(6)} · ${brl(s.v).padStart(14)}`);
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
