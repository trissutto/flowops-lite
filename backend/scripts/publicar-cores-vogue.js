/**
 * PUBLICA AS CORES FOTOGRAFADAS DA FICHA VOGUE (mãe).
 *
 * As linhas de `produto_ficha_cor` da REF VOGUE nasceram entre 03–07/08 pela
 * varredura automática da bolinha, com o DEFAULT do campo ('nao_publicar') —
 * na época o status não tinha efeito nenhum. Em 13/08 a vitrine passou a
 * honrar o campo e as cores da mãe sumiram do card unificado (MARROM DOURADO
 * 66 pç, PRETO 110 pç, VINHO e PRETO DOURADO 101 pç), enquanto as irmãs
 * (criadas pela tela, já 'publicado') continuaram no ar.
 *
 * Publica SÓ as cores que têm FOTO no R2 — as sem foto (BEGE, MARROM,
 * PISTACHE, VERMELH) ficam 'nao_publicar', que é a fila legítima da tela
 * /retaguarda/cores-sem-foto.
 *
 *   railway run --service Postgres node backend/scripts/publicar-cores-vogue.js
 *   railway run --service Postgres node backend/scripts/publicar-cores-vogue.js --aplicar
 */
const { Client } = require('pg');

const APLICAR = process.argv.includes('--aplicar');
const CORES = ['MARROM DOURADO', 'PRETO', 'VINHO', 'PRETO DOURADO'];

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const alvo = await db.query(
    `SELECT c.id, f.ref, c.cor, c.status_publicacao
       FROM produto_ficha f JOIN produto_ficha_cor c ON c.ficha_id = f.id
      WHERE UPPER(TRIM(f.ref)) = 'VOGUE' AND UPPER(TRIM(c.cor)) = ANY($1)`,
    [CORES],
  );
  for (const l of alvo.rows) {
    console.log(`  ${l.ref} · ${l.cor}: ${l.status_publicacao} → publicado`);
  }
  if (!APLICAR) {
    console.log('SECO — nada gravado. Rode com --aplicar.');
    await db.end();
    return;
  }
  const r = await db.query(
    `UPDATE produto_ficha_cor c
        SET status_publicacao = 'publicado', updated_at = NOW()
       FROM produto_ficha f
      WHERE c.ficha_id = f.id
        AND UPPER(TRIM(f.ref)) = 'VOGUE'
        AND UPPER(TRIM(c.cor)) = ANY($1)`,
    [CORES],
  );
  console.log(`Atualizadas: ${r.rowCount} linhas.`);
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
