/**
 * ETIQUETA QUE NÃO BATE COM O QUE A CLIENTE PAGOU — nas DUAS direções.
 *
 *   node -r dotenv/config scripts/etiqueta-pac-com-sedex-pago.js
 *   node -r dotenv/config scripts/etiqueta-pac-com-sedex-pago.js --dias 90
 *
 * Só LÊ — não altera pedido, não cancela pré-postagem, não gera etiqueta.
 *
 * ── POR QUE ISTO EXISTE ──
 *
 * O gerador de etiqueta escolhia o serviço por conta própria e nunca lia o
 * pedido. Aconteceu dos dois lados, e os dois custaram:
 *
 *  1. **Pagou SEDEX, saiu PAC** (Correios, até 12/08) — a regra era
 *     `uf === 'SP' ? 'SEDEX' : 'PAC'`. Quem morava fora de SP e pagava o
 *     expresso recebia econômico: prazo quebrado com o dinheiro já no caixa.
 *     Corrigido em `common/servico-envio.ts`.
 *  2. **Pagou PAC, saiu SEDEX** (Mais Envios, até 15/08) — os dois caminhos do
 *     Mais Envios mandavam `'SEDEX'` chumbado. Vendíamos econômico e postávamos
 *     expresso: a diferença saía do nosso bolso, e a tela da loja mostrava PAC
 *     enquanto a etiqueta saía SEDEX (foi assim que o dono achou). Corrigido em
 *     `pick-orders.service.ts` (`servicoMaisEnvios`).
 *
 * Os dois já estão corrigidos, mas isso vale dali pra frente: este script acha
 * quem JÁ saiu errado e serve de sentinela — se a divergência voltar a crescer
 * depois de um deploy, ela aparece aqui antes de virar reclamação.
 *
 * Casa o serviço PAGO (checkout_info.shipping.id → título do método → regra de
 * UF) com o serviço POSTADO (pick_orders.carrier: "Correios PAC", "Mais Envios
 * SEDEX"...). 'sem-informacao' fica de fora das duas listas: ali o pedido não
 * diz nada e a regra de UF é o único critério que existe.
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

function linhaDe(d) {
  const data = d.correios_generated_at ? new Date(d.correios_generated_at).toISOString().slice(0, 10) : '—';
  return [
    data,
    String(d.wc_order_number || d.pick_id.slice(0, 8)).padEnd(12),
    (d.uf || '??').padEnd(3),
    String(d.loja || '—').padEnd(18),
    String(d.tracking_code || '').padEnd(15),
    `pagou ${d.pago.servico} (${d.pago.origem}) · postado ${d.carrier}`,
    d.pick_status === 'shipped' ? '· JÁ POSTADO' : '· ainda não postado → dá pra Reabrir',
  ].join(' ');
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
        AND p.correios_generated_at >= now() - ($1 || ' days')::interval
      ORDER BY p.correios_generated_at DESC`,
    [String(DIAS)],
  );

  const linhas = rows.map((r) => {
    let uf = '';
    try { uf = String(JSON.parse(r.shipping_address || '{}').state || '').toUpperCase(); } catch { /* endereço cru */ }
    const pago = servicoPago(r.checkout_info, r.shipping_method, uf);
    const postado = normalizar(r.carrier).includes('sedex') ? 'SEDEX' : 'PAC';
    const via = normalizar(r.carrier).includes('mais envios') ? 'Mais Envios' : 'Correios';
    return { ...r, uf, pago, postado, via };
  });

  console.log(`Pré-postagens nos últimos ${DIAS} dias: ${linhas.length}\n`);

  // De onde o serviço foi lido em CADA pedido — mede a saúde do dado, não só o
  // erro. 'sem-informacao' é o único grupo onde a regra de UF ainda manda: se
  // ele crescer, é o checkout que parou de gravar o método escolhido.
  const porOrigem = {};
  for (const l of linhas) porOrigem[l.pago.origem] = (porOrigem[l.pago.origem] || 0) + 1;
  console.log('Serviço lido de:', Object.entries(porOrigem).map(([o, n]) => `${o}=${n}`).join('  '), '\n');

  const divergentes = linhas.filter((l) => l.pago.servico !== l.postado && l.pago.origem !== 'sem-informacao');
  const pagouSedex = divergentes.filter((l) => l.pago.servico === 'SEDEX'); // levou econômico
  const pagouPac = divergentes.filter((l) => l.pago.servico === 'PAC');     // saiu expresso

  for (const [titulo, grupo, explicacao] of [
    ['PAGOU SEDEX, FOI POSTADO PAC', pagouSedex, 'prazo prometido quebrado — a cliente reclama do atraso, não do sistema'],
    ['PAGOU PAC, FOI POSTADO SEDEX', pagouPac, 'vendemos econômico e pagamos expresso — a diferença sai do nosso bolso'],
  ]) {
    console.log(`── ${titulo}: ${grupo.length} (${explicacao})`);
    if (!grupo.length) { console.log(''); continue; }
    const porVia = {};
    for (const d of grupo) porVia[d.via] = (porVia[d.via] || 0) + 1;
    console.log('   por transportadora:', Object.entries(porVia).map(([v, n]) => `${v}=${n}`).join('  '));
    const porUf = {};
    for (const d of grupo) porUf[d.uf || '??'] = (porUf[d.uf || '??'] || 0) + 1;
    console.log('   por UF:', Object.entries(porUf).sort((a, b) => b[1] - a[1]).map(([u, n]) => `${u}=${n}`).join('  '), '\n');
    for (const d of grupo) console.log('  ', linhaDe(d));
    console.log('');
  }

  const reabriveis = divergentes.filter((d) => d.pick_status !== 'shipped').length;
  console.log(
    `${reabriveis} das ${divergentes.length} divergências ainda não foram postadas — nessas o ` +
    `"Reabrir" no pick-order cancela a etiqueta errada e gera de novo. As demais já estão a caminho.`,
  );

  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
