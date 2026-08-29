/**
 * BACKFILL — pedido da loja (venda online do PDV) com preço CHEIO no item.
 *
 * O bug (ON-000215, 29/08): o `PedidoOnlineService` copiava `PdvSaleItem.precoUnit`
 * — o preço de TABELA — pro `OrderItem.unitPrice`, ignorando a promoção da linha.
 * A peça de R$ 179,90 com 50% entrava no pedido por R$ 179,90 enquanto o
 * `totalAmount` (= `sale.total`) trazia o R$ 154,90 correto. A tela de separação
 * somava R$ 309,80 em peças num pedido de R$ 154,90 — e `unitPrice` é o que vira
 * FATURAMENTO, item da NF-e e valor da declaração de conteúdo.
 *
 * O código já nasce certo; este script conserta o que ficou no banco. A verdade
 * está na venda do PDV (`checkoutInfo.pdvSaleId` → `pdv_sale_items`):
 *
 *   unit_price      ← total da linha ÷ qty   (o COBRADO, com promoção)
 *   base_unit_price ← preco_unit             (o CHEIO — base do acerto ÷2,5)
 *
 * ⚠️ NÃO mexe em `orders.total_amount` (esse sempre esteve certo) nem em pedido
 * de outra origem. Casa item por SKU; SKU repetido na mesma venda é pulado e
 * listado no fim pra conferência na mão.
 *
 * Somente leitura por padrão. Pra gravar, passe --apply:
 *
 *   railway run --service Postgres node backend/scripts/backfill-pedido-online-preco-promo.js
 *   railway run --service Postgres node backend/scripts/backfill-pedido-online-preco-promo.js --apply
 */
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const brl = (v) => `R$ ${(Number(v) || 0).toFixed(2).replace('.', ',')}`;
const cents = (v) => Math.round((Number(v) || 0) * 100);

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL / DATABASE_PUBLIC_URL não definida');
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const { rows: pedidos } = await db.query(
    `SELECT id, wc_order_number, total_amount, checkout_info
       FROM orders
      WHERE source = 'pdv_online'
      ORDER BY created_at ASC`,
  );
  console.log(`${pedidos.length} pedido(s) de venda online da loja.\n`);

  let corrigidos = 0;
  let itensCorrigidos = 0;
  const semVenda = [];
  const ambiguos = [];

  for (const p of pedidos) {
    let ck = {};
    try {
      ck = JSON.parse(p.checkout_info || '{}');
    } catch {
      /* snapshot cru — segue sem ele */
    }
    const saleId = ck?.pdvSaleId;
    if (!saleId) {
      semVenda.push(p.wc_order_number);
      continue;
    }

    const { rows: doPdv } = await db.query(
      `SELECT sku, qty, preco_unit, desconto, total, promo_tag
         FROM pdv_sale_items
        WHERE sale_id = $1`,
      [saleId],
    );
    if (!doPdv.length) {
      semVenda.push(p.wc_order_number);
      continue;
    }

    // SKU repetido na mesma venda não dá pra casar com segurança (duas linhas,
    // promoções possivelmente diferentes). Fica de fora e sai na lista do fim.
    const porSku = new Map();
    const repetidos = new Set();
    for (const it of doPdv) {
      const k = String(it.sku || '').trim();
      if (!k) continue;
      if (porSku.has(k)) repetidos.add(k);
      porSku.set(k, it);
    }

    const { rows: itens } = await db.query(
      `SELECT id, sku, quantity, unit_price, base_unit_price, product_name
         FROM order_items
        WHERE order_id = $1`,
      [p.id],
    );

    const mudancas = [];
    for (const oi of itens) {
      const k = String(oi.sku || '').trim();
      if (repetidos.has(k)) {
        ambiguos.push(`${p.wc_order_number} · SKU ${k}`);
        continue;
      }
      const src = porSku.get(k);
      if (!src) continue;

      const qty = Math.max(1, Number(src.qty || 1));
      const totalLinha = Number(src.total);
      const cobrado = Number.isFinite(totalLinha) && totalLinha > 0
        ? Math.round((totalLinha / qty) * 100) / 100
        : Math.max(0, Math.round((Number(src.preco_unit || 0) - Number(src.desconto || 0) / qty) * 100) / 100);
      const cheio = Number(src.preco_unit || 0);

      if (cents(oi.unit_price) === cents(cobrado) && cents(oi.base_unit_price) === cents(cheio)) continue;

      mudancas.push({
        id: oi.id,
        nome: oi.product_name || k,
        de: Number(oi.unit_price || 0),
        para: cobrado,
        cheio,
        tag: src.promo_tag || null,
      });
    }

    if (!mudancas.length) continue;

    corrigidos++;
    itensCorrigidos += mudancas.length;
    const somaAntes = itens.reduce((s, i) => s + Number(i.unit_price || 0) * Number(i.quantity || 1), 0);
    console.log(`── ${p.wc_order_number} · total do pedido ${brl(p.total_amount)} · peças somavam ${brl(somaAntes)}`);
    for (const m of mudancas) {
      console.log(
        `   ${m.nome}: ${brl(m.de)} → ${brl(m.para)} (cheio ${brl(m.cheio)}${m.tag ? ` · ${m.tag}` : ''})`,
      );
      if (APPLY) {
        await db.query(
          `UPDATE order_items SET unit_price = $1, base_unit_price = $2 WHERE id = $3`,
          [m.para, m.cheio, m.id],
        );
      }
    }
  }

  console.log(
    `\n${APPLY ? 'CORRIGIDOS' : 'A CORRIGIR (simulação)'}: ${itensCorrigidos} item(ns) em ${corrigidos} pedido(s).`,
  );
  if (semVenda.length) console.log(`Sem venda do PDV pra conferir (pulados): ${semVenda.join(', ')}`);
  if (ambiguos.length) console.log(`SKU repetido na venda — conferir na mão: ${ambiguos.join(', ')}`);
  if (!APPLY) console.log('\nNada foi gravado. Rode de novo com --apply pra aplicar.');

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
