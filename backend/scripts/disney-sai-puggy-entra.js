/**
 * DECISÕES DO DONO 13/08 (tarde) — duas ações de curadoria:
 *
 * 1. DISNEY SAI DO SITE: despublica DISNEY001, DISNEY001V e DISNEY-003 em
 *    `site_produto` (personagem licenciado fora do e-commerce/catálogo Meta;
 *    loja física segue vendendo). origem_conteudo vira 'flow' pra importação
 *    do WooCommerce nunca reativar.
 *
 * 2. PUGGY: AS 3 VARIANTES NO AR. BEGE MOCHA já tem foto; CAMELO (23 pç) e
 *    OFF WHITE (4 pç) não têm — ganham linha na ficha com
 *    status_publicacao='publicado' EXPLÍCITO. Passam a aparecer quando o
 *    deploy da regra nova da vitrine chegar (cor sem foto: >10 pç OU
 *    publicado explícito da ficha).
 *
 *   railway run --service Postgres node backend/scripts/disney-sai-puggy-entra.js --aplicar
 */
const { Client } = require('pg');

const APLICAR = process.argv.includes('--aplicar');
const DISNEY = ['DISNEY001', 'DISNEY001V', 'DISNEY-003'];
const EDITOR = 'decisao-dono-13-08';

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const rows = await db.query(
    `SELECT ref, publicado FROM site_produto WHERE UPPER(TRIM(ref)) = ANY($1)`, [DISNEY],
  );
  console.log('── DISNEY a despublicar ──');
  for (const r of rows.rows) console.log(`  ${r.ref} (publicado=${r.publicado})`);

  const fichaPuggy = await db.query(
    `SELECT f.id, f.ref, f.marca,
            ARRAY(SELECT c.cor FROM produto_ficha_cor c WHERE c.ficha_id = f.id) AS cores
       FROM produto_ficha f WHERE UPPER(TRIM(f.ref)) = 'PUGGY'`,
  );
  console.log('── Fichas PUGGY ──');
  for (const f of fichaPuggy.rows) console.log(`  ficha ${f.id} marca="${f.marca}" cores=[${f.cores.join(', ')}]`);
  if (!fichaPuggy.rows.length) throw new Error('PUGGY sem ficha — criar antes');

  if (!APLICAR) { console.log('\nSECO.'); await db.end(); return; }

  const up = await db.query(
    `UPDATE site_produto
        SET publicado = FALSE, origem_conteudo = 'flow',
            editado_por = $2, editado_em = NOW(), updated_at = NOW()
      WHERE UPPER(TRIM(ref)) = ANY($1)`,
    [DISNEY, EDITOR],
  );
  console.log(`DISNEY despublicadas: ${up.rowCount}`);

  // A ficha mais completa da família (a que tem a cor BEGE MOCHA já publicada)
  const alvo = fichaPuggy.rows.find((f) => f.cores.length) ?? fichaPuggy.rows[0];
  for (const cor of ['CAMELO', 'OFF WHITE']) {
    if (alvo.cores.includes(cor)) {
      await db.query(
        `UPDATE produto_ficha_cor SET status_publicacao = 'publicado', updated_at = NOW()
          WHERE ficha_id = $1 AND UPPER(TRIM(cor)) = $2`, [alvo.id, cor],
      );
      console.log(`PUGGY ${cor}: linha existente → publicado`);
    } else {
      await db.query(
        `INSERT INTO produto_ficha_cor (id, ficha_id, cor, status_publicacao, swatch_tipo, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'publicado', 'cor', NOW(), NOW())`,
        [alvo.id, cor],
      );
      console.log(`PUGGY ${cor}: linha criada como publicado`);
    }
  }
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
