/**
 * CORRIGE o estoque das trocas do site aceitas com a LOJA ERRADA.
 * A tela /site/trocas vinha com "01 — ITANHAÉM" como default, então a peça
 * entregue no balcão da loja X entrou no estoque da 01.
 * Correção: -1 na 01, +1 na loja de quem clicou.
 *
 * Rodar da RAIZ do repo, com o railway linkado em heroic-mercy > Postgres.
 * Dry-run por padrão. `railway run node backend/scripts/fix-trocas-loja-errada.js --apply` grava.
 */
const { Client } = require('pg');
const APPLY = process.argv.includes('--apply');

// loja de quem clicou (user_name do login de loja) -> code
const LOGIN_TO_STORE = { 'campinas':'07','jundiaí':'10','jundiai':'10','indaiatuba':'04','sorocaba':'06','itanhaém':'01','itanhaem':'01' };

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
  await db.connect();

  const { rows: rets } = await db.query(`
    SELECT w.id, w.wc_order_number, w.customer_name, w.user_name, w.receiving_store_code,
           w.modo, to_char(w.created_at,'DD/MM/YY HH24:MI') AS quando,
           i.sku, i.qty, left(i.product_name,38) AS peca, i.stock_returned_at
    FROM wc_return_requests w JOIN wc_return_request_items i ON i.return_request_id=w.id
    WHERE w.receiving_store_code='01' AND i.stock_returned_at IS NOT NULL
      AND lower(w.user_name) NOT IN ('grazi','site','itanhaém','itanhaem')
      AND w.user_name NOT ILIKE '%como SITE%'
    ORDER BY w.created_at`);

  const plano = [];
  for (const r of rets) {
    const destino = LOGIN_TO_STORE[String(r.user_name||'').toLowerCase().trim()];
    if (!destino || destino === '01') { console.log(`⚠️  PULADO (login "${r.user_name}" não mapeia pra loja): pedido ${r.wc_order_number}`); continue; }
    plano.push({ ...r, destino });
  }

  console.log(`\n${plano.length} peça(s) pra mover da 01 pra loja certa:\n`);
  for (const p of plano) {
    const q = async (loja) => {
      const g = await db.query(`SELECT id, estoque FROM giga_estoque WHERE regexp_replace(codigo,'^0+','')=$1 AND loja=$2`, [p.sku.replace(/^0+/,''), loja]);
      return g.rows[0] || null;
    };
    p.origemRow = await q('01');
    p.destinoRow = await q(p.destino);
    console.log(`#${p.wc_order_number} ${p.quando} · ${p.user_name} · ${p.peca}`);
    console.log(`   SKU ${p.sku} qty ${p.qty} · modo ${p.modo} · cliente ${p.customer_name}`);
    console.log(`   01 ITANHAÉM : ${p.origemRow ? p.origemRow.estoque : '(sem linha)'} → ${p.origemRow ? p.origemRow.estoque - p.qty : 'n/a'}`);
    console.log(`   ${p.destino} destino    : ${p.destinoRow ? p.destinoRow.estoque : '(sem linha)'} → ${p.destinoRow ? p.destinoRow.estoque + p.qty : p.qty}`);
    if (p.origemRow && p.origemRow.estoque - p.qty < 0) console.log(`   ⛔ FICARIA NEGATIVO na 01 — não vou aplicar esta`);
    console.log('');
  }

  if (!APPLY) { console.log('DRY-RUN. Nada gravado. Rode com --apply pra valer.'); await db.end(); return; }

  await db.query('BEGIN');
  try {
    for (const p of plano) {
      if (!p.origemRow || p.origemRow.estoque - p.qty < 0) { console.log(`PULADO ${p.wc_order_number} (origem sem saldo)`); continue; }
      const codNorm = p.sku.replace(/^0+/,'');
      // -1 na 01
      await db.query(`UPDATE giga_estoque SET estoque=$1, synced_at=now() WHERE id=$2`, [p.origemRow.estoque - p.qty, p.origemRow.id]);
      await db.query(`UPDATE wincred_estoque SET estoque=$1, synced_at=now() WHERE codigo=$2 AND loja='01'`, [p.origemRow.estoque - p.qty, codNorm]);
      // +1 na loja certa
      if (p.destinoRow) {
        await db.query(`UPDATE giga_estoque SET estoque=$1, synced_at=now() WHERE id=$2`, [p.destinoRow.estoque + p.qty, p.destinoRow.id]);
      } else {
        await db.query(`INSERT INTO giga_estoque (id, codigo, loja, estoque, synced_at) VALUES (gen_random_uuid()::text,$1,$2,$3,now())`, [codNorm, p.destino, p.qty]);
      }
      const novo = (p.destinoRow ? p.destinoRow.estoque : 0) + p.qty;
      await db.query(`INSERT INTO wincred_estoque (codigo, loja, estoque, synced_at) VALUES ($1,$2,$3,now())
                      ON CONFLICT (codigo, loja) DO UPDATE SET estoque=$3, synced_at=now()`, [codNorm, p.destino, novo]);
      console.log(`✅ #${p.wc_order_number} ${p.sku}: 01 ${p.origemRow.estoque}→${p.origemRow.estoque-p.qty} · ${p.destino} ${p.destinoRow?p.destinoRow.estoque:0}→${novo}`);
    }
    await db.query('COMMIT');
    console.log('\nCOMMIT ok.');
  } catch (e) { await db.query('ROLLBACK'); console.error('ROLLBACK:', e.message); process.exit(1); }
  await db.end();
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
