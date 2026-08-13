/**
 * SOLTA AS CORES COM FOTO PRESAS EM nao_publicar — rede inteira.
 *
 * `produto_ficha_cor.status_publicacao` tem DEFAULT 'nao_publicar' e a
 * varredura automática da bolinha sempre criou linha assim — sem efeito até
 * 13/08, quando a vitrine passou a honrar o campo. Resultado medido
 * (diag-esgotado-falso, 13/08): 466 cores COM FOTO e estoque escondidas
 * (19.855 pç), e 362 cards "Esgotado no site" com peça na arara (caso
 * ROLLING: PRETO, 54 pç, foto no R2, invisível).
 *
 * Regra do conserto — só o que é inequívoco:
 *   · linha criada ANTES de 13/08 (o campo não tinha efeito → 'nao_publicar'
 *     ali NUNCA foi decisão humana com consequência);
 *   · e a cor TEM FOTO na família da REF (mesma REF-BASE) — a regra do dono
 *     "não libere cor sem foto" continua intacta.
 * Linha criada em 13/08+ não é tocada: pode ser a tela /retaguarda/
 * cores-sem-foto escondendo de propósito.
 *
 *   railway run --service Postgres node backend/scripts/publicar-cores-com-foto.js
 *   railway run --service Postgres node backend/scripts/publicar-cores-com-foto.js --aplicar
 *
 * `--aplicar` salva backup (publicar-cores-com-foto-backup-antes.json) antes.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const APLICAR = process.argv.includes('--aplicar');

/** Mesma REF-BASE do sistema: corta o sufixo não-numérico do fim. */
const REF_BASE_SQL = (col) =>
  `COALESCE(NULLIF(regexp_replace(UPPER(TRIM(${col})), '[^0-9]+$', ''), ''), UPPER(TRIM(${col})))`;

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const alvo = await db.query(
    `SELECT c.id, f.ref, c.cor, c.status_publicacao, c.created_at
       FROM produto_ficha f
       JOIN produto_ficha_cor c ON c.ficha_id = f.id
      WHERE c.status_publicacao = 'nao_publicar'
        /* pré-13/08 (campo sem efeito) OU nunca editada por humano — a rajada
         * da varredura de 03:14–03:55 de 13/08 tem updated_at = created_at;
         * quem a tela tocar daqui pra frente ganha updated_at novo e escapa. */
        AND (c.created_at < '2026-08-13'::date OR c.updated_at = c.created_at)
        AND EXISTS (
          SELECT 1 FROM product_photos ph
           WHERE UPPER(TRIM(COALESCE(ph.cor, ''))) = UPPER(TRIM(c.cor))
             AND ${REF_BASE_SQL('ph.ref')} = ${REF_BASE_SQL('f.ref')}
        )
      ORDER BY f.ref, c.cor`,
  );

  console.log(`Cores COM FOTO presas em nao_publicar (linhas pré-13/08): ${alvo.rows.length}`);
  for (const l of alvo.rows.slice(0, 25)) {
    console.log(`  ${String(l.ref).padEnd(14)} ${String(l.cor).padEnd(18)} criada ${l.created_at.toISOString().slice(0, 10)}`);
  }
  if (alvo.rows.length > 25) console.log(`  … e mais ${alvo.rows.length - 25}`);

  if (!APLICAR) {
    console.log('\nSECO — nada gravado. Rode com --aplicar.');
    await db.end();
    return;
  }

  const backupPath = path.join(
    __dirname, `publicar-cores-com-foto-backup-antes-${Date.now()}.json`,
  );
  fs.writeFileSync(backupPath, JSON.stringify({
    quando: new Date().toISOString(),
    linhas: alvo.rows,
  }, null, 2));
  console.log(`\nBackup salvo em ${backupPath}`);

  const r = await db.query(
    `UPDATE produto_ficha_cor SET status_publicacao = 'publicado', updated_at = NOW()
      WHERE id = ANY($1)`,
    [alvo.rows.map((l) => l.id)],
  );
  console.log(`Atualizadas: ${r.rowCount} linhas.`);
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
