/**
 * QUEM PAGOU SEDEX E FOI POSTADO COMO PAC.
 *
 *   node -r dotenv/config scripts/etiqueta-pac-com-sedex-pago.js
 *   node -r dotenv/config scripts/etiqueta-pac-com-sedex-pago.js --dias 90
 *
 * Só LÊ — não altera pedido, não cancela pré-postagem, não gera etiqueta.
 *
 * ── POR QUE ISTO EXISTE ──
 *
 * Até 12/08/2026 o gerador de etiqueta escolhia o serviço pela UF do destino
 * (`uf === 'SP' ? 'SEDEX' : 'PAC'`) e nunca lia o pedido. Quem morava fora de
 * São Paulo, escolhia SEDEX no checkout e pagava o expresso, recebia uma
 * pré-postagem PAC — prazo quebrado, sem erro em lugar nenhum. O código já foi
 * corrigido (common/servico-envio.ts), mas isso vale dali pra frente: este
 * script encontra quem já saiu errado.
 *
 * Casa o serviço PAGO (checkout_info.shipping.id → título do método) com o
 * serviço POSTADO (pick_orders.carrier, que grava "Correios PAC"/"Correios
 * SEDEX"). Lista só a divergência que custa dinheiro: pagou SEDEX, foi PAC.
 *
 * O caminho MAIS ENVIOS posta SEDEX sempre, de propósito — carrier "Mais
 * Envios SEDEX" nunca aparece aqui.
 */
const { Client } = require('pg');

const arg = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
};
const DIAS = Math.max(1, Number(arg('dias', 180)) || 180);

const normalizar = (v) =>
  String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Mesma ordem de leitura do backend (common/servico-envio.ts). */
function servicoPago(checkoutInfo, shippingMethod, uf) {
  try {
    const id = normalizar(JSON.parse(checkoutInfo || 'null')?.shipping?.id);
    if (id.includes('sedex')) return { servico: 'SEDEX', origem: 'checkout' };
    if (id.includes('pac')) return { servico: 'PAC', origem: 'checkout' };
  } catch { /* checkout_info corrompido → título */ }
  const t = normalizar(shippingMethod);
  if (t.includes('sedex')) return { servico: 'SEDEX', origem: 'titulo' };
  if (/\bpac\b/.test(t)) return { servico: 'PAC', origem: 'titulo' };
  const porUf = String(uf || '').toUpperCase() === 'SP' ? 'SEDEX' : 'PAC';
  if (t.includes('promocional') || t.includes('promo ')) return { servico: porUf, origem: 'promocional-uf' };
  return { servico: porUf, origem: 'sem-informacao' };
}

(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const { rows } = await c.query(
    `SELECT p.id            AS pick_id,
            p.carrier,
            p.tracking_code,
            p.status        AS pick_status,
            p.correios_generated_at,
            o.wc_order_number,
            o.shipping_method,
            o.checkout_info,
            o.shipping_address,
            o.source,
            s.name          AS loja
       FROM pick_orders p
       JOIN orders o ON o.id = p.order_id
       LEFT JOIN stores s ON s.id = p.store_id
      WHERE p.tracking_code IS NOT NULL
        AND p.carrier ILIKE '%correios%'
        AND p.correios_generated_at >= now() - ($1 || ' days')::interval
      ORDER BY p.correios_generated_at DESC`,
    [String(DIAS)],
  );

  const divergentes = [];
  for (const r of rows) {
    let uf = '';
    try { uf = String(JSON.parse(r.shipping_address || '{}').state || '').toUpperCase(); } catch { /* endereço cru */ }
    const pago = servicoPago(r.checkout_info, r.shipping_method, uf);
    const postado = normalizar(r.carrier).includes('sedex') ? 'SEDEX' : 'PAC';
    // Só o prejuízo: pagou expresso, levou econômico. O contrário (pagou PAC,
    // foi SEDEX) é entrega melhor que o prometido — não é problema.
    if (pago.servico === 'SEDEX' && postado === 'PAC' && pago.origem !== 'sem-informacao') {
      divergentes.push({ ...r, uf, origem: pago.origem });
    }
  }

  console.log(`Pré-postagens Correios nos últimos ${DIAS} dias: ${rows.length}`);
  console.log(`Pagou SEDEX e foi postado PAC: ${divergentes.length}\n`);

  // De onde o serviço foi lido em CADA pedido — mede a saúde do dado, não só o
  // erro. 'sem-informacao' é o único grupo onde a regra de UF ainda manda: se
  // ele crescer, é o checkout que parou de gravar o método escolhido.
  const porOrigem = {};
  for (const r of rows) {
    let ufR = '';
    try { ufR = String(JSON.parse(r.shipping_address || '{}').state || '').toUpperCase(); } catch { /* endereço cru */ }
    const o = servicoPago(r.checkout_info, r.shipping_method, ufR).origem;
    porOrigem[o] = (porOrigem[o] || 0) + 1;
  }
  console.log('Serviço lido de:', Object.entries(porOrigem).map(([o, n]) => `${o}=${n}`).join('  '), '\n');

  if (!divergentes.length) { await c.end(); return; }

  const porUf = {};
  for (const d of divergentes) porUf[d.uf || '??'] = (porUf[d.uf || '??'] || 0) + 1;
  console.log('Por UF:', Object.entries(porUf).sort((a, b) => b[1] - a[1]).map(([u, n]) => `${u}=${n}`).join('  '), '\n');

  for (const d of divergentes) {
    const data = d.correios_generated_at ? new Date(d.correios_generated_at).toISOString().slice(0, 10) : '—';
    console.log(
      [
        data,
        (d.wc_order_number || d.pick_id.slice(0, 8)).padEnd(12),
        (d.uf || '??').padEnd(3),
        (d.loja || '—').padEnd(18),
        (d.tracking_code || '').padEnd(15),
        `pagou SEDEX (${d.origem}) · postado ${d.carrier}`,
        d.pick_status === 'shipped' ? '· JÁ POSTADO' : '· ainda não postado → dá pra Reabrir',
      ].join(' '),
    );
  }

  const reabriveis = divergentes.filter((d) => d.pick_status !== 'shipped').length;
  console.log(
    `\n${reabriveis} ainda não foram postados nos Correios — nesses o "Reabrir" no ` +
    `pick-order cancela a etiqueta PAC e gera SEDEX. Os demais já estão a caminho.`,
  );

  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
