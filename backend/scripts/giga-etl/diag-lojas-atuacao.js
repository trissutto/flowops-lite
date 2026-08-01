/**
 * Em que FORMATO o campo `lojas_atuacao` está gravado?
 *
 * A correção do ponto multi-loja procura o código da loja dentro desse campo.
 * Se ele estiver como ["03","10"] o filtro precisa das aspas; se estiver como
 * 03,10 ou [3,10], o filtro com aspas não acha NADA — e a Brenda continua sem
 * bater ponto, com o problema parecendo resolvido.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-lojas-atuacao.js
 */

const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  const b = await c.query(
    `SELECT name, store_code_origin, lojas_atuacao,
            (face_descriptors IS NOT NULL) AS tem_rosto
       FROM sellers WHERE name ILIKE '%brenda%' LIMIT 3`,
  );
  console.log('--- BRENDA ---');
  if (!b.rows.length) console.log('  (nao achei)');
  for (const r of b.rows) {
    console.log(`  ${r.name}`);
    console.log(`    loja origem: ${r.store_code_origin || '-'}`);
    console.log(`    lojasAtuacao: ${JSON.stringify(r.lojas_atuacao)}`);
    console.log(`    tem rosto cadastrado: ${r.tem_rosto}`);
  }

  console.log('');
  console.log('--- FORMATOS NA TABELA ---');
  const t = await c.query(
    `SELECT lojas_atuacao, COUNT(*)::int AS n FROM sellers
      WHERE lojas_atuacao IS NOT NULL AND lojas_atuacao <> ''
      GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
  );
  if (!t.rows.length) console.log('  (ninguem tem lojasAtuacao preenchido)');
  for (const r of t.rows) console.log(`  ${JSON.stringify(r.lojas_atuacao)}  (${r.n} vendedora[s])`);

  // O filtro que eu escrevi funciona? Testa com o codigo 03 (Vinhedo).
  console.log('');
  console.log('--- O FILTRO DA CORRECAO ACHA ALGUEM? ---');
  for (const [rotulo, cond, p] of [
    ['com aspas: lojas_atuacao LIKE \'%"03"%\'', `lojas_atuacao LIKE '%"03"%'`, []],
    ['sem aspas: lojas_atuacao LIKE \'%03%\'', `lojas_atuacao LIKE '%03%'`, []],
  ]) {
    const r = await c.query(
      `SELECT COUNT(*)::int AS n FROM sellers
        WHERE active = true AND face_descriptors IS NOT NULL AND ${cond}`, p,
    );
    console.log(`  ${rotulo} -> ${r.rows[0].n} vendedora(s) com rosto`);
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
