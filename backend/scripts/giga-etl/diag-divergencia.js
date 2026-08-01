/**
 * De ONDE vêm as 855 divergências de estoque?
 *
 * A medição bruta (divergencia-estoque.js) deu 99,70% de pares idênticos. Esse
 * resto pode ser três coisas muito diferentes, e a decisão de virar a
 * propriedade do estoque depende de qual delas é:
 *
 *   a) fila do outbox ainda não drenada  → transitório, esperado, inofensivo
 *   b) estoque negativo no Giga          → lixo histórico do ERP, o Flow está CERTO
 *   c) escrita que não passa pelo Flow   → PROBLEMA REAL, bloqueia a virada
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo, não de backend/ — lá o railway aponta pro projeto errado):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-divergencia.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const semZeros = (s) => String(s ?? '').trim().replace(/^0+/, '') || '0';
const chave = (codigo, loja) => `${semZeros(codigo)}|${semZeros(loja)}`;

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST,
    port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER,
    password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });
  const pg = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await pg.connect();

  // ---- 1. A fila explica? -------------------------------------------------
  console.log('--- FILA erp_outbox ---');
  try {
    const q = await pg.query(
      `SELECT kind, status, COUNT(*)::int AS n
         FROM erp_outbox
        WHERE status <> 'done'
        GROUP BY kind, status ORDER BY n DESC LIMIT 20`,
    );
    if (!q.rows.length) console.log('  fila vazia — nao e a fila');
    for (const r of q.rows) console.log(`  ${r.kind} / ${r.status}: ${r.n}`);

    const velho = await pg.query(
      `SELECT MIN("createdAt") AS mais_antigo, COUNT(*)::int AS n
         FROM erp_outbox WHERE status <> 'done'`,
    );
    if (velho.rows[0]?.n) {
      console.log(`  pendente mais antigo: ${velho.rows[0].mais_antigo}`);
    }
  } catch (e) {
    console.log('  (erp_outbox: ' + e.message + ')');
  }

  // ---- 2. Quando o espelho sincronizou pela ultima vez? --------------------
  console.log('');
  console.log('--- IDADE DO ESPELHO ---');
  const idade = await pg.query(
    `SELECT MAX(synced_at) AS ultimo,
            EXTRACT(EPOCH FROM (NOW() - MAX(synced_at)))/60 AS minutos
       FROM wincred_estoque`,
  );
  console.log(`  ultimo sync: ${idade.rows[0].ultimo} (${Number(idade.rows[0].minutos).toFixed(0)} min atras)`);

  // ---- 3. Classificar cada divergencia ------------------------------------
  const [gigaRows] = await my.query(`SELECT CODIGO, LOJA, COALESCE(ESTOQUE,0) AS ESTOQUE FROM estoque`);
  const giga = new Map();
  for (const r of gigaRows) giga.set(chave(r.CODIGO, r.LOJA), Number(r.ESTOQUE) || 0);

  const flowRes = await pg.query(
    `SELECT codigo, loja, COALESCE(estoque,0) AS estoque, synced_at FROM wincred_estoque`,
  );
  const flow = new Map();
  for (const r of flowRes.rows) {
    flow.set(chave(r.codigo, r.loja), { v: Number(r.estoque) || 0, at: r.synced_at });
  }

  let negativoNoGiga = 0;
  let flowMenor = 0;
  let flowMaior = 0;
  const codsDivergentes = [];

  for (const [k, g] of giga) {
    const f = flow.get(k);
    if (!f || f.v === g) continue;
    if (g < 0) negativoNoGiga++;
    else if (f.v < g) flowMenor++;
    else flowMaior++;
    if (codsDivergentes.length < 400) codsDivergentes.push(k.split('|')[0]);
  }

  console.log('');
  console.log('--- CLASSIFICACAO DAS DIVERGENCIAS ---');
  console.log(`  Giga NEGATIVO (lixo do ERP, Flow certo):  ${negativoNoGiga}`);
  console.log(`  Flow MENOR que Giga (Flow ja baixou):     ${flowMenor}`);
  console.log(`  Flow MAIOR que Giga (Flow nao baixou):    ${flowMaior}`);

  // ---- 4. Sao pecas que venderam recentemente? ----------------------------
  // Se a divergencia se concentra em codigo que teve venda nas ultimas horas,
  // e timing de fila. Se aparece em codigo parado ha meses, e escrita fora do Flow.
  console.log('');
  console.log('--- AS DIVERGENCIAS TIVERAM VENDA RECENTE? ---');
  try {
    const uniq = [...new Set(codsDivergentes)];
    const r = await pg.query(
      `SELECT COUNT(DISTINCT i."productCode")::int AS n
         FROM pdv_sale_items i
         JOIN pdv_sales s ON s.id = i."saleId"
        WHERE s."createdAt" > NOW() - INTERVAL '48 hours'
          AND COALESCE(NULLIF(LTRIM(TRIM(i."productCode"),'0'),''),'0') = ANY($1::text[])`,
      [uniq],
    );
    console.log(`  ${r.rows[0].n} de ${uniq.length} codigos divergentes venderam nas ultimas 48h`);
    if (r.rows[0].n / uniq.length > 0.5) {
      console.log('  >> maioria vendeu recente: e TIMING DE FILA, nao escrita paralela');
    } else {
      console.log('  >> maioria NAO vendeu recente: investigar outra origem');
    }
  } catch (e) {
    console.log('  (venda recente: ' + e.message + ')');
  }

  await my.end();
  await pg.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
