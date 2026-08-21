/**
 * VLM-222 · tira a "cor VINHO" da família LISOS (20/08/2026, ordem do dono).
 *
 * O QUE ESTÁ ERRADO
 * O conserto de 15/08 (corrigir-vlm222-estampado.js) assumiu que a REF `VLM222`
 * (sem hífen, 33 peças, R$ 179,90, cor VINHO) era a versão vinho da LISA e fez
 * a ponte via grupo_ref pro card VLM-222. Mas:
 *   - as 2 "fotos da VINHO" sob VLM-222 são BYTE A BYTE a foto da ESTAMPA VINHO
 *     (md5 85d1cf97... idêntico) — a vitrine mostrava o estampado como card
 *     "VLM-222 · Vinho" a R$ 139,90;
 *   - a REF VLM222 é reciclada (dataAlt nov/2025, descricaoPdv NULL, preço
 *     179,90 ≠ 139,90 da lisa) — não é a lisa vinho.
 *
 * O QUE ESTE SCRIPT FAZ
 *   1. Apaga as 2 fotos falsas (VLM-222 / VINHO) — as originais da estampada
 *      continuam intactas sob VLM222EST.
 *   2. Apaga a cor VINHO da ficha da lisa (a lisa não tem estoque VINHO).
 *   3. Desfaz a ponte: site_produto VLM222 sai da família (grupo_ref = NULL) e
 *      é despublicada (sem foto própria e sem ficha, card ficaria vazio —
 *      regra do dono: sem foto oficial não sai no site). grupo_ref_manual
 *      fica true pra nenhuma varredura reagrupar.
 *
 *   railway run node fix-vlm222-vinho-fora.js
 *   railway run node fix-vlm222-vinho-fora.js --apply
 */
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const log = (s = '') => console.log(s);

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  log(APPLY ? '\n>>> APLICANDO <<<\n' : '\n>>> SIMULAÇÃO (rode com --apply pra valer) <<<\n');
  await db.query('BEGIN');

  try {
    // 1) fotos falsas fora
    const fotos = await db.query(
      `DELETE FROM product_photos
        WHERE ref = 'VLM-222' AND UPPER(TRIM(cor)) = 'VINHO'
        RETURNING ordem, url`);
    log(`1) fotos apagadas de VLM-222 [VINHO]: ${fotos.rowCount}`);
    for (const r of fotos.rows) log(`     #${r.ordem} ${r.url}`);

    // 2) cor VINHO fora da ficha da lisa
    const ficha = await db.query(
      `DELETE FROM produto_ficha_cor c USING produto_ficha f
        WHERE c.ficha_id = f.id AND f.ref = 'VLM-222' AND UPPER(TRIM(c.cor)) = 'VINHO'
        RETURNING c.cor, c.status_publicacao`);
    log(`\n2) cor tirada da ficha da lisa: ${ficha.rowCount}`);
    for (const r of ficha.rows) log(`     [${r.cor}] era ${r.status_publicacao}`);

    // 3) ponte desfeita + despublica a REF reciclada
    const ponte = await db.query(
      `UPDATE site_produto
          SET grupo_ref = NULL, publicado = false, grupo_ref_manual = true,
              editado_por = 'fix-vlm222-vinho-fora', editado_em = NOW(), updated_at = NOW()
        WHERE ref = 'VLM222'
        RETURNING ref, publicado, grupo_ref`);
    log(`\n3) VLM222 (sem hífen): ${ponte.rowCount ? `publicado=${ponte.rows[0].publicado}, grupo_ref=${ponte.rows[0].grupo_ref}` : 'NADA ENCONTRADO'}`);

    // retrato de conferência: o que sobra na família
    const sobra = await db.query(
      `SELECT c.cor, c.status_publicacao,
              EXISTS (SELECT 1 FROM product_photos p
                       WHERE p.ref = 'VLM-222' AND UPPER(TRIM(p.cor)) = UPPER(TRIM(c.cor))) AS tem_foto
         FROM produto_ficha_cor c JOIN produto_ficha f ON f.id = c.ficha_id
        WHERE f.ref = 'VLM-222' ORDER BY c.cor`);
    log('\n── ficha da lisa depois ──');
    for (const r of sobra.rows) {
      log(`   [${String(r.cor).padEnd(15)}] ${r.status_publicacao.padEnd(13)} foto=${r.tem_foto ? 'sim' : 'NÃO'}`);
    }

    if (APPLY) {
      await db.query('COMMIT');
      log('\n✓ aplicado. Cache do catálogo é 60s — a vitrine reflete em até 1 min.');
    } else {
      await db.query('ROLLBACK');
      log('\n(simulação — nada foi gravado.)');
    }
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
