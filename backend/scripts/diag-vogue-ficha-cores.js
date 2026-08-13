/**
 * DIAGNÓSTICO fase 3 — status de publicação POR COR nas fichas da família
 * VOGUE. As bolinhas MARROM DOURADO/PRETO/VINHO sumiram do card unificado;
 * hipótese: linhas de `produto_ficha_cor` nascidas com o default
 * 'nao_publicar' (a varredura da bolinha cria sem status) e a vitrine
 * passou a honrar o campo em 13/08.
 *
 *   railway run --service Postgres node backend/scripts/diag-vogue-ficha-cores.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const r = await db.query(
    `SELECT f.ref, c.cor, c.status_publicacao, c.swatch_tipo, c.cor_hex,
            c.titulo_comercial, c.created_at::date AS criada
       FROM produto_ficha f
       JOIN produto_ficha_cor c ON c.ficha_id = f.id
      WHERE UPPER(TRIM(f.ref)) LIKE 'VOGUE%'
      ORDER BY f.ref, c.cor`,
  );
  console.log('ref          | cor              | status        | hex      | criada');
  for (const l of r.rows) {
    console.log(
      `${String(l.ref).padEnd(12)} | ${String(l.cor).padEnd(16)} | ${String(l.status_publicacao).padEnd(13)} | ${String(l.cor_hex || '—').padEnd(8)} | ${l.criada.toISOString().slice(0, 10)}`,
    );
  }
  console.log(`→ ${r.rows.length} linhas de cor nas fichas da família`);
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
