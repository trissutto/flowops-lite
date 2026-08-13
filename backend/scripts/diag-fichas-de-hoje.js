/**
 * DIAGNÓSTICO — as linhas de ficha_cor 'nao_publicar' criadas HOJE (13/08):
 * rajada da varredura (segundos de diferença, em lote) ou clique humano na
 * tela (espaçado)? Decide se o destrave também vale pra elas.
 *
 *   railway run --service Postgres node backend/scripts/diag-fichas-de-hoje.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const r = await db.query(
    `SELECT f.ref, c.cor, c.status_publicacao, c.cor_hex, c.titulo_comercial,
            c.created_at, c.updated_at
       FROM produto_ficha f JOIN produto_ficha_cor c ON c.ficha_id = f.id
      WHERE c.created_at >= '2026-08-13'::date
        AND c.status_publicacao = 'nao_publicar'
      ORDER BY c.created_at`,
  );
  console.log(`Linhas nao_publicar criadas hoje: ${r.rows.length}`);
  let anterior = null;
  for (const l of r.rows) {
    const t = l.created_at;
    const gap = anterior ? Math.round((t - anterior) / 1000) : null;
    anterior = t;
    console.log(
      `  ${t.toISOString().slice(11, 19)} (+${gap === null ? '—' : gap + 's'})` +
      ` ${String(l.ref).padEnd(14)} ${String(l.cor).padEnd(18)} hex=${l.cor_hex || '—'}` +
      ` titulo=${l.titulo_comercial ? 'SIM' : '—'} upd=${l.updated_at.toISOString().slice(11, 19)}`,
    );
  }
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
