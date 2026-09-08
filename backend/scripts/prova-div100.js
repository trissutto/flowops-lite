require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const r = await db.query(`
    SELECT o.mes_referencia mes, o.to_store_name loja, o.ref_code ref, o.cor, o.tamanho,
           o.preco_unitario::float8 gravado, w."vendaUn"::float8 etiqueta_espelho,
           ROUND((w."vendaUn" / NULLIF(o.preco_unitario,0))::numeric, 1)::float8 razao
      FROM inter_store_obligations o
      JOIN wincred_produtos w ON ltrim(w.codigo,'0') = ltrim(COALESCE(o.sku,''),'0') AND w."vendaUn" > 0
     WHERE o.mes_referencia IN ('2026-05','2026-06') AND o.status='pending'
       AND o.preco_unitario > 0 AND o.preco_unitario < 6
     ORDER BY o.mes_referencia, o.ref_code LIMIT 15`);
  console.table(r.rows);
  const agg = await db.query(`
    SELECT COUNT(*)::int pecas_conferidas,
           SUM(CASE WHEN ABS(w."vendaUn" / NULLIF(o.preco_unitario,0) - 100) < 1 THEN 1 ELSE 0 END)::int razao_e_100
      FROM inter_store_obligations o
      JOIN wincred_produtos w ON ltrim(w.codigo,'0') = ltrim(COALESCE(o.sku,''),'0') AND w."vendaUn" > 0
     WHERE o.mes_referencia IN ('2026-05','2026-06') AND o.status='pending'
       AND o.preco_unitario > 0 AND o.preco_unitario < 6`);
  console.log('conferência em massa:', agg.rows[0]);
  await db.end();
}
main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
