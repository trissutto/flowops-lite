/**
 * PERGUNTA DO DONO (01/08): as parcelas de cartão em aberto estão com DATA DE
 * PAGAMENTO preenchida e o campo PAGO em 'N'?
 *
 * Se sim, a conclusão anterior está errada: o dinheiro FOI liquidado no Giga e
 * o Flow é que não reconhece. Aí não se trata de "criar a baixa automática" e
 * sim de "consertar a leitura" — o que é um conserto MUITO mais barato e sem
 * risco de baixar o que não foi pago.
 *
 * Olha os DOIS lados:
 *   · o espelho do Flow (crediario_parcelas)
 *   · a tabela `movimento` do Giga ao vivo, que é a fonte
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-pago-n-com-data.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const BRL = (n) => `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

const CARTAO = [
  'CREDICARD', 'VISANET', 'VISA ELECTRON', 'VISAELECTRON', 'REDESHOP', 'REDE SHOP',
  'CIELO', 'ELO', 'AMEX', 'HIPERCARD', 'SOROCRED', 'CREDSYSTEM', 'SISPUMI',
  'GREMIO', 'MASTERCARD', 'MAESTRO', 'BANRICOMPRAS', 'GETNET', 'STONE',
];

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await pg.connect();

  const like = CARTAO.map((_, i) => `UPPER(COALESCE(g.nome,'')) LIKE $${i + 1}`).join(' OR ');
  const params = CARTAO.map((n) => `%${n}%`);

  console.log('══════ NO ESPELHO DO FLOW (crediario_parcelas) ══════');
  console.log('');
  const f = await pg.query(
    `SELECT p.pago,
            (p.data_pagamento IS NOT NULL) AS tem_data,
            COUNT(*)::int AS parcelas,
            COALESCE(SUM(p.valor_parcela),0)::float AS valor
       FROM crediario_parcelas p
       LEFT JOIN giga_clientes g ON g.loja = p.loja AND g.codigo = p.cod_cliente
      WHERE p.cancelado = false AND (${like})
      GROUP BY 1,2 ORDER BY 1,2`,
    params,
  );
  console.log('  CARTAO — cruzamento pago × tem data de pagamento:');
  for (const r of f.rows) {
    const rot = `pago=${r.pago ? 'SIM' : 'NAO'} · data=${r.tem_data ? 'PREENCHIDA' : 'vazia'}`;
    const alerta = !r.pago && r.tem_data ? '  ← ESTE É O CASO DA PERGUNTA' : '';
    console.log(`    ${rot.padEnd(34)} ${String(r.parcelas).padStart(7)} parc · ${BRL(r.valor).padStart(18)}${alerta}`);
  }

  console.log('');
  console.log('  MESMO CRUZAMENTO, PARCELAS DE PESSOA (nao-cartao):');
  const fp = await pg.query(
    `SELECT p.pago, (p.data_pagamento IS NOT NULL) AS tem_data,
            COUNT(*)::int AS parcelas, COALESCE(SUM(p.valor_parcela),0)::float AS valor
       FROM crediario_parcelas p
       LEFT JOIN giga_clientes g ON g.loja = p.loja AND g.codigo = p.cod_cliente
      WHERE p.cancelado = false AND NOT (${like})
      GROUP BY 1,2 ORDER BY 1,2`,
    params,
  );
  for (const r of fp.rows) {
    const rot = `pago=${r.pago ? 'SIM' : 'NAO'} · data=${r.tem_data ? 'PREENCHIDA' : 'vazia'}`;
    console.log(`    ${rot.padEnd(34)} ${String(r.parcelas).padStart(7)} parc · ${BRL(r.valor).padStart(18)}`);
  }

  // ── A FONTE: a `movimento` do Giga ao vivo ──
  console.log('');
  console.log('══════ NA FONTE (movimento do Giga ao vivo) ══════');
  let my;
  try {
    my = await mysql.createConnection({
      host: process.env.ERP_HOST, port: Number(process.env.ERP_PORT || 3306),
      user: process.env.ERP_USER, password: process.env.ERP_PASSWORD,
      database: process.env.ERP_DATABASE, connectTimeout: 15000,
    });
  } catch (e) {
    console.log(`  (nao consegui conectar no Giga: ${e.message})`);
    await pg.end();
    return;
  }

  // Quais colunas a `movimento` tem de verdade? Nao assumir nomes.
  const [cols] = await my.query(
    `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'movimento'
        AND (COLUMN_NAME LIKE '%PAG%' OR COLUMN_NAME LIKE '%VENC%'
             OR COLUMN_NAME LIKE '%VALOR%' OR COLUMN_NAME LIKE '%CLIENTE%')
      ORDER BY ORDINAL_POSITION`,
    [process.env.ERP_DATABASE],
  );
  console.log('  colunas relevantes:', cols.map((c) => `${c.COLUMN_NAME}(${c.DATA_TYPE})`).join(', '));

  // Distribuicao do PAGO x PAGAMENTO na fonte.
  const [dist] = await my.query(
    `SELECT PAGO,
            (PAGAMENTO IS NOT NULL AND PAGAMENTO <> '0000-00-00') AS tem_data,
            COUNT(*) AS parcelas, SUM(VALORPARCELA) AS valor
       FROM movimento
      GROUP BY PAGO, tem_data
      ORDER BY parcelas DESC`,
  );
  console.log('');
  console.log('  TODA a movimento — PAGO × tem data:');
  for (const r of dist) {
    const rot = `PAGO='${r.PAGO === null ? 'NULL' : r.PAGO}' · data=${Number(r.tem_data) ? 'PREENCHIDA' : 'vazia'}`;
    console.log(`    ${rot.padEnd(34)} ${String(r.parcelas).padStart(8)} parc · ${BRL(r.valor).padStart(18)}`);
  }

  await my.end();
  await pg.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
