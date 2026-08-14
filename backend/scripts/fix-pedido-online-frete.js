/**
 * CORREÇÃO — o FRETE do pedido online vira CAMPO DE FRETE (não item).
 *
 * O primeiro pedido online (ON-000001, 14/08) nasceu com a linha `FRETE` da
 * venda copiada como OrderItem: o roteamento acusou "ruptura" de um SKU que
 * não existe em loja nenhuma e a NF-e do envio levaria "FRETE - ENVIO" como
 * PRODUTO (sem NCM, sem estoque). O código já não cria mais assim; este
 * script arruma os pedidos que nasceram antes.
 *
 * O que faz (idempotente — rodar 2× não muda nada):
 *   1. soma as linhas FRETE do pedido;
 *   2. grava esse valor no campo de frete (`checkout_info.shipping.price`) e
 *      a forma de entrega em `shipping_method` (vira o `vFrete` da NF-e);
 *   3. APAGA as linhas FRETE de `order_items`.
 *
 * NÃO mexe na venda do PDV, no caixa, na comissão nem no total do pedido —
 * o dinheiro do frete já está no `total_amount` e no caixa da loja vendedora.
 *
 *   node backend/scripts/fix-pedido-online-frete.js ON-000001 sedex
 *   node backend/scripts/fix-pedido-online-frete.js --todos pac
 *   (acrescente --dry pra só ver o que mudaria)
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client } = require('pg');

const METODOS = {
  sedex: { id: 'sedex', kind: 'correios', label: 'SEDEX' },
  pac: { id: 'pac', kind: 'correios', label: 'PAC' },
  motoboy: { id: 'motoboy', kind: 'motoboy', label: 'MOTOBOY' },
  retirada: { id: 'retirada', kind: 'pickup', label: 'RETIRADA NA LOJA' },
};

const args = process.argv.slice(2).filter((a) => a !== '--dry');
const DRY = process.argv.includes('--dry');
const ALVO = (args[0] || 'ON-000001').trim();
const METODO = METODOS[(args[1] || 'sedex').trim().toLowerCase()];

async function main() {
  if (!METODO) {
    console.error(`Forma de entrega inválida. Use: ${Object.keys(METODOS).join(' | ')}`);
    process.exit(1);
  }
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não encontrada (backend/.env)');
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const where = ALVO === '--todos'
    ? `source = 'pdv_online'`
    : `wc_order_number = $1 AND source = 'pdv_online'`;
  const params = ALVO === '--todos' ? [] : [ALVO];
  const { rows: pedidos } = await db.query(
    `SELECT id, wc_order_number, wc_order_id, shipping_method, checkout_info, total_amount, seller_store_code
       FROM orders WHERE ${where} ORDER BY wc_order_id`,
    params,
  );
  if (!pedidos.length) {
    console.log(`Nenhum pedido online encontrado pra "${ALVO}".`);
    await db.end();
    return;
  }

  for (const p of pedidos) {
    const { rows: fretes } = await db.query(
      `SELECT id, sku, product_name, quantity, unit_price
         FROM order_items
        WHERE order_id = $1 AND UPPER(TRIM(sku)) = 'FRETE'`,
      [p.id],
    );
    const valorItens = fretes.reduce(
      (s, i) => s + (Number(i.unit_price) || 0) * (Number(i.quantity) || 1),
      0,
    );

    let ck = {};
    try { ck = JSON.parse(p.checkout_info || '{}'); } catch { ck = {}; }
    const jaNoCampo = Number(ck?.shipping?.price || 0);
    const frete = Math.round((valorItens || jaNoCampo) * 100) / 100;

    console.log(`\n──── ${p.wc_order_number} (wc ${p.wc_order_id}) · loja ${p.seller_store_code || '?'}`);
    console.log(`     total do pedido: R$ ${Number(p.total_amount || 0).toFixed(2)}`);
    console.log(`     método atual: ${p.shipping_method || '—'} · frete no campo: R$ ${jaNoCampo.toFixed(2)}`);
    console.log(`     linhas FRETE em order_items: ${fretes.length} (R$ ${valorItens.toFixed(2)})`);
    if (!fretes.length && jaNoCampo > 0 && p.shipping_method === METODO.label) {
      console.log('     ✔ já está correto — nada a fazer.');
      continue;
    }

    ck.shipping = { ...(ck.shipping || {}), ...METODO, price: frete, etaDays: ck?.shipping?.etaDays ?? null };
    console.log(`     → frete R$ ${frete.toFixed(2)} no campo de frete · método "${METODO.label}"`);
    console.log(`     → apagando ${fretes.length} linha(s) FRETE de order_items`);
    if (DRY) { console.log('     (--dry: nada gravado)'); continue; }

    await db.query('BEGIN');
    try {
      await db.query(
        `UPDATE orders SET checkout_info = $2, shipping_method = $3,
                is_pickup = $4, pickup_store_code = $5, updated_at = NOW()
          WHERE id = $1`,
        [
          p.id,
          JSON.stringify(ck),
          METODO.id === 'retirada' ? `${METODO.label} — ${p.seller_store_code || ''}`.trim() : METODO.label,
          METODO.id === 'retirada',
          METODO.id === 'retirada' ? p.seller_store_code : null,
        ],
      );
      if (fretes.length) {
        await db.query(
          `DELETE FROM order_items WHERE order_id = $1 AND UPPER(TRIM(sku)) = 'FRETE'`,
          [p.id],
        );
      }
      await db.query('COMMIT');
      console.log('     ✔ gravado.');
    } catch (e) {
      await db.query('ROLLBACK');
      console.error(`     ✖ falhou: ${e.message}`);
    }
  }

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
