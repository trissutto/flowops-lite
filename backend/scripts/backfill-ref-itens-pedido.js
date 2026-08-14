/**
 * REF · COR · TAMANHO nos itens de pedido que já existem.
 *
 *   railway run --service Postgres node backend/scripts/backfill-ref-itens-pedido.js
 *   railway run --service Postgres node backend/scripts/backfill-ref-itens-pedido.js --aplicar
 *
 * SEM `--aplicar` é ensaio: mostra o que preencheria e não grava nada.
 *
 * ── POR QUE ISTO EXISTE ──
 *
 * Até 13/08/2026 o pedido do site gravava só `sku` (= o CÓDIGO do ERP, sete
 * dígitos) e o nome com cor e tamanho grudados. A loja separa pela REF, então
 * a tela de separação e o cupom impresso não tinham o dado que a vendedora
 * usa. As colunas `ref`/`cor`/`tamanho` passaram a nascer preenchidas — este
 * script preenche o que já estava no banco.
 *
 * Duas fontes, nesta ordem:
 *   1. `orders.checkout_info` — o snapshot do checkout, que guarda `productId`
 *      (a REF que o carrinho mandou), `color` e `size`. É a verdade DAQUELE
 *      pedido, então ganha do catálogo de hoje.
 *   2. `wincred_produtos` pelo código — pros itens sem snapshot.
 *
 * A ordem importa por causa de REF reciclada: o catálogo de hoje pode ter dado
 * o mesmo código a outra peça, e aí o pedido antigo passaria a mentir.
 */
const { Client } = require('pg');

const APLICAR = process.argv.includes('--aplicar');

const limpar = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s || null;
};

(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const { rows: itens } = await c.query(`
    SELECT oi.id, oi.sku, oi.product_name, o.id AS order_id, o.wc_order_number, o.checkout_info
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE oi.ref IS NULL
     ORDER BY o.created_at DESC
  `);

  if (!itens.length) {
    console.log('Nada a preencher — todo item já tem REF.');
    await c.end();
    return;
  }

  // Snapshot do checkout, por pedido: sku → { ref, cor, tamanho }.
  const porPedido = new Map();
  for (const it of itens) {
    if (porPedido.has(it.order_id)) continue;
    const mapa = new Map();
    try {
      const ck = JSON.parse(it.checkout_info || 'null');
      for (const linha of ck?.items || []) {
        const chave = limpar(linha?.sku);
        if (!chave || mapa.has(chave)) continue;
        mapa.set(chave, {
          ref: limpar(linha?.ref) || limpar(linha?.productId),
          cor: limpar(linha?.color),
          tamanho: limpar(linha?.size),
        });
      }
    } catch {
      /* checkout_info corrompido ou ausente (live/WooCommerce) → catálogo */
    }
    porPedido.set(it.order_id, mapa);
  }

  // Catálogo, pros itens que o snapshot não cobre.
  const semSnapshot = itens.filter((it) => !porPedido.get(it.order_id)?.get(limpar(it.sku)));
  const codigos = [...new Set(semSnapshot.map((it) => limpar(it.sku)).filter(Boolean))];
  const catalogo = new Map();
  if (codigos.length) {
    const { rows } = await c.query(
      `SELECT codigo, UPPER(TRIM(ref)) AS ref, NULLIF(TRIM(cor), '') AS cor, NULLIF(TRIM(tamanho), '') AS tamanho
         FROM wincred_produtos WHERE codigo = ANY($1)`,
      [codigos],
    );
    for (const r of rows) catalogo.set(String(r.codigo), r);
  }

  let doSnapshot = 0;
  let doCatalogo = 0;
  let semFonte = 0;
  const aGravar = [];

  for (const it of itens) {
    const chave = limpar(it.sku);
    const snap = porPedido.get(it.order_id)?.get(chave);
    const cat = chave ? catalogo.get(chave) : null;
    const dado = {
      ref: snap?.ref || cat?.ref || null,
      cor: snap?.cor || cat?.cor || null,
      tamanho: snap?.tamanho || cat?.tamanho || null,
    };
    if (!dado.ref) {
      semFonte++;
      continue;
    }
    if (snap?.ref) doSnapshot++;
    else doCatalogo++;
    aGravar.push({ id: it.id, pedido: it.wc_order_number, sku: chave, ...dado });
  }

  console.log(`Itens sem REF: ${itens.length}`);
  console.log(`  pelo snapshot do checkout: ${doSnapshot}`);
  console.log(`  pelo catálogo (código):    ${doCatalogo}`);
  console.log(`  sem fonte nenhuma:         ${semFonte}`);
  console.log('');
  for (const l of aGravar.slice(0, 20)) {
    console.log(`  #${l.pedido || '—'} · ${l.sku} → REF ${l.ref} · ${l.cor || '—'} ${l.tamanho || '—'}`);
  }
  if (aGravar.length > 20) console.log(`  … e mais ${aGravar.length - 20}`);

  if (!APLICAR) {
    console.log('\nEnsaio. Rode com --aplicar pra gravar.');
    await c.end();
    return;
  }

  for (const l of aGravar) {
    await c.query('UPDATE order_items SET ref = $1, cor = $2, tamanho = $3 WHERE id = $4', [
      l.ref,
      l.cor,
      l.tamanho,
      l.id,
    ]);
  }
  console.log(`\n${aGravar.length} item(ns) atualizado(s).`);
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
