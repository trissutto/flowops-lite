/**
 * DIAGNÓSTICO — PEDIDO DIVIDIDO ENTRE LOJAS QUE CABIA NUMA SÓ.
 *
 * A regra do routing é: 1) UMA LOJA SÓ; 2) mínimo de lojas. A REGRA 1 roda
 * ANTES de tudo (routing.engine.ts), então todo pedido dividido significa que,
 * PARA O ESTOQUE QUE A ENGINE RECEBEU, nenhuma loja cobria o pedido inteiro.
 * A pergunta é se esse estoque estava certo.
 *
 * Este script responde isso sem achismo, usando duas fontes:
 *   1. `orders.routing_result` → `scoreBreakdown[].fullCoverage` — o que a
 *      engine ENXERGOU no momento da decisão, loja por loja.
 *   2. `wincred_estoque` HOJE — o que a rede tem agora.
 *
 * Cada pedido dividido cai num balde:
 *   [LOGICA]  alguma loja tinha fullCoverage=true e mesmo assim dividiu → bug
 *             de decisão (a REGRA 1 foi atropelada).
 *   [JUNTADA] dividiu mas com âncora (consolidateStoreCode) → é 1 pacote só,
 *             o frete não dobrou; não é o problema.
 *   [ESTOQUE] ninguém cobria na hora, MAS hoje alguma loja cobre tudo → o dado
 *             de estoque na hora do routing estava errado/atrasado.
 *   [REAL]    ninguém cobria na hora nem hoje → divisão legítima.
 *
 * Também aponta o CARD ÓRFÃO: pick-order criado sem nenhum item apontando pra
 * ele. O confirmRoute HOJE rateia a linha quando o mesmo SKU é dividido entre
 * lojas (`planSplitAssignment`), então órfão novo não deveria mais nascer — o
 * que aparecer aqui é resíduo de pedido roteado ANTES desse conserto, ou sinal
 * de que a divisão escapou por outro caminho.
 *
 *   railway run --service Postgres node backend/scripts/diag-separacao-dividida.js [dias]
 */
const { Client } = require('pg');

const DIAS = Number(process.argv[2]) || 30;

const normCodigo = (raw) => {
  if (raw == null) return null;
  const s = String(raw).replace(/\D/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(n);
};
const normLoja = (raw) =>
  String(raw || '').trim().toUpperCase().replace(/^LJ/i, '').padStart(2, '0');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const lojas = (await db.query(`SELECT id, code, name, active FROM stores`)).rows;
  const lojaById = new Map(lojas.map((l) => [l.id, l]));
  const ativas = lojas.filter((l) => l.active);

  // Pedidos com 2+ lojas na separação
  const pedidos = (
    await db.query(
      `SELECT o.id, o.wc_order_number, o.created_at, o.status, o.source,
              o.is_pickup, o.pickup_store_code, o.routing_result,
              COUNT(DISTINCT p.store_id)::int AS lojas
         FROM orders o
         JOIN pick_orders p ON p.order_id = o.id
        WHERE o.created_at >= NOW() - ($1 || ' days')::interval
        GROUP BY o.id
       HAVING COUNT(DISTINCT p.store_id) > 1
        ORDER BY o.created_at DESC`,
      [DIAS],
    )
  ).rows;

  console.log(`\n=== PEDIDOS DIVIDIDOS — últimos ${DIAS} dias ===`);
  console.log(`Total dividido: ${pedidos.length}\n`);
  if (!pedidos.length) {
    await db.end();
    return;
  }

  const ids = pedidos.map((p) => p.id);

  const itens = (
    await db.query(
      `SELECT order_id, sku, quantity, assigned_store_id FROM order_items WHERE order_id = ANY($1)`,
      [ids],
    )
  ).rows;
  const cards = (
    await db.query(
      `SELECT id, order_id, store_id, status FROM pick_orders WHERE order_id = ANY($1)`,
      [ids],
    )
  ).rows;

  const itensPorPedido = new Map();
  for (const it of itens) {
    if (!itensPorPedido.has(it.order_id)) itensPorPedido.set(it.order_id, []);
    itensPorPedido.get(it.order_id).push(it);
  }
  const cardsPorPedido = new Map();
  for (const c of cards) {
    if (!cardsPorPedido.has(c.order_id)) cardsPorPedido.set(c.order_id, []);
    cardsPorPedido.get(c.order_id).push(c);
  }

  // Estoque de HOJE pros SKUs envolvidos
  const skusNorm = [...new Set(itens.map((i) => normCodigo(i.sku)).filter(Boolean))];
  const est = (
    await db.query(
      `SELECT codigo, loja, estoque FROM wincred_estoque WHERE codigo = ANY($1)`,
      [skusNorm],
    )
  ).rows;
  const estoqueHoje = new Map(); // `${loja2}|${codigo}` → qty
  for (const r of est) {
    const k = `${normLoja(r.loja)}|${String(r.codigo).trim()}`;
    estoqueHoje.set(k, (estoqueHoje.get(k) || 0) + (Number(r.estoque) || 0));
  }
  const cobreHoje = (storeCode, linhas) =>
    linhas.every((l) => {
      const c = normCodigo(l.sku);
      if (!c) return false;
      return (estoqueHoje.get(`${normLoja(storeCode)}|${c}`) || 0) >= Number(l.quantity || 1);
    });

  const baldes = { LOGICA: [], JUNTADA: [], ESTOQUE: [], REAL: [], SEM_RESULT: [] };
  const orfaos = [];

  for (const p of pedidos) {
    const linhas = itensPorPedido.get(p.id) || [];
    const meus = cardsPorPedido.get(p.id) || [];

    // Card órfão: nenhum item apontando pra ele
    for (const c of meus) {
      const n = linhas.filter((l) => l.assigned_store_id === c.store_id).length;
      if (n === 0) {
        orfaos.push({
          pedido: p.wc_order_number || p.id.slice(0, 8),
          loja: lojaById.get(c.store_id)?.code || c.store_id,
          status: c.status,
        });
      }
    }

    let rr = null;
    try {
      rr = p.routing_result ? JSON.parse(p.routing_result) : null;
    } catch (e) {
      rr = null;
    }

    const linha = {
      pedido: p.wc_order_number || p.id.slice(0, 8),
      data: new Date(p.created_at).toISOString().slice(0, 16).replace('T', ' '),
      lojas: p.lojas,
      pecas: linhas.reduce((s, l) => s + Number(l.quantity || 0), 0),
      strategy: (rr && rr.strategy) || '?',
      cards: meus.map((c) => (lojaById.get(c.store_id) || {}).code).join('+'),
    };

    if (!rr) {
      baldes.SEM_RESULT.push(linha);
      continue;
    }
    if (rr.consolidateStoreCode) {
      linha.ancora = rr.consolidateStoreCode;
      baldes.JUNTADA.push(linha);
      continue;
    }

    const cobriamNaHora = (rr.scoreBreakdown || []).filter((s) => s.fullCoverage);
    if (cobriamNaHora.length > 0) {
      linha.cobriam = cobriamNaHora.map((s) => s.storeCode).join(',');
      baldes.LOGICA.push(linha);
      continue;
    }

    const cobremHoje = ativas.filter((l) => cobreHoje(l.code, linhas));
    if (cobremHoje.length > 0) {
      linha.cobremHoje = cobremHoje.map((l) => l.code).join(',');
      baldes.ESTOQUE.push(linha);
    } else {
      baldes.REAL.push(linha);
    }
  }

  const pct = (n) => `${((n / pedidos.length) * 100).toFixed(1)}%`;
  console.log('--- VEREDITO ---');
  console.log(`[LOGICA]  alguma loja cobria TUDO e mesmo assim dividiu : ${baldes.LOGICA.length} (${pct(baldes.LOGICA.length)})`);
  console.log(`[JUNTADA] dividido com âncora (1 pacote só, frete ok)   : ${baldes.JUNTADA.length} (${pct(baldes.JUNTADA.length)})`);
  console.log(`[ESTOQUE] ninguém cobria na hora, mas HOJE alguém cobre : ${baldes.ESTOQUE.length} (${pct(baldes.ESTOQUE.length)})`);
  console.log(`[REAL]    divisão legítima (nem hoje alguém cobre)      : ${baldes.REAL.length} (${pct(baldes.REAL.length)})`);
  console.log(`[?]       sem routing_result gravado                    : ${baldes.SEM_RESULT.length} (${pct(baldes.SEM_RESULT.length)})`);

  const mostra = (nome, arr, extra) => {
    if (!arr.length) return;
    console.log(`\n--- ${nome} (${arr.length}) — até 25 ---`);
    for (const l of arr.slice(0, 25)) {
      console.log(
        `  ${l.data}  #${l.pedido}  ${l.pecas} peca(s) em ${l.lojas} loja(s) [${l.cards}]  ` +
          `strategy=${l.strategy}` +
          (extra && l[extra] ? `  ${extra}=${l[extra]}` : ''),
      );
    }
  };
  mostra('LOGICA — REGRA 1 atropelada', baldes.LOGICA, 'cobriam');
  mostra('ESTOQUE — dado errado/atrasado na hora do routing', baldes.ESTOQUE, 'cobremHoje');
  mostra('REAL — divisão legítima', baldes.REAL);
  mostra('SEM routing_result', baldes.SEM_RESULT);

  // ── AS DUAS TABELAS DE ESTOQUE ────────────────────────────────────────
  // O ROTEAMENTO lê `giga_estoque` (ErpService.getStockFromMirror, ligado por
  // GIGA_MIRROR_READS=1). O site/PDV lê `wincred_estoque`. As duas são
  // mantidas pelo mesmo write-through — se divergem, o roteamento está
  // decidindo com um número que ninguém mais vê.
  //
  // `giga_estoque` NÃO tem unique em (codigo, loja) — só `id` cuid. O write
  // usa findFirst+update numa linha só, mas a LEITURA SOMA todas as linhas:
  // linha duplicada = estoque inflado na leitura e delta errado na escrita.
  console.log('\n=== SAÚDE DAS TABELAS DE ESTOQUE ===');
  const dup = (
    await db.query(
      `SELECT COUNT(*)::int AS pares, COALESCE(SUM(n - 1), 0)::int AS linhas_extras
         FROM (SELECT codigo, loja, COUNT(*)::int AS n
                 FROM giga_estoque GROUP BY codigo, loja HAVING COUNT(*) > 1) t`,
    )
  ).rows[0];
  console.log(`giga_estoque com (codigo,loja) DUPLICADO: ${dup.pares} par(es), ${dup.linhas_extras} linha(s) extra(s)`);

  const idade = (
    await db.query(
      `SELECT MAX(synced_at) AS mais_novo, MIN(synced_at) AS mais_velho, COUNT(*)::int AS linhas
         FROM giga_estoque`,
    )
  ).rows[0];
  console.log(`giga_estoque: ${idade.linhas} linhas · escrita mais recente ${idade.mais_novo} · mais antiga ${idade.mais_velho}`);
  const idadeW = (
    await db.query(
      `SELECT MAX(synced_at) AS mais_novo, COUNT(*)::int AS linhas FROM wincred_estoque`,
    )
  ).rows[0];
  console.log(`wincred_estoque: ${idadeW.linhas} linhas · escrita mais recente ${idadeW.mais_novo}`);

  // Divergência nos SKUs que apareceram nos pedidos divididos.
  const gigaAgg = new Map();
  const gigaRows = (
    await db.query(
      `SELECT codigo, loja, SUM(estoque)::int AS estoque
         FROM giga_estoque GROUP BY codigo, loja`,
    )
  ).rows;
  for (const r of gigaRows) {
    const c = normCodigo(r.codigo);
    if (!c) continue;
    const k = `${normLoja(r.loja)}|${c}`;
    gigaAgg.set(k, (gigaAgg.get(k) || 0) + (Number(r.estoque) || 0));
  }
  const chaves = new Set([...estoqueHoje.keys(), ...gigaAgg.keys()]);
  const skuSet = new Set(skusNorm);
  let divergem = 0;
  const exemplos = [];
  for (const k of chaves) {
    const cod = k.split('|')[1];
    if (!skuSet.has(cod)) continue;
    const g = gigaAgg.get(k) || 0;
    const w = estoqueHoje.get(k) || 0;
    if (g !== w) {
      divergem++;
      if (exemplos.length < 20) exemplos.push({ k, giga: g, wincred: w });
    }
  }
  console.log(
    `\nSKUs dos pedidos divididos com estoque DIFERENTE nas duas tabelas: ${divergem}`,
  );
  for (const e of exemplos) {
    const [loja, cod] = e.k.split('|');
    console.log(`  loja ${loja} · codigo ${cod} → giga_estoque=${e.giga} (o routing usa este) · wincred_estoque=${e.wincred}`);
  }

  if (orfaos.length) {
    console.log(`\n--- CARDS ÓRFÃOS (pick-order sem nenhum item) — ${orfaos.length} ---`);
    for (const o of orfaos.slice(0, 25)) {
      console.log(`  #${o.pedido}  loja ${o.loja}  status=${o.status}`);
    }
    console.log('  → confirmRoute ja rateia a linha no SKU dividido (planSplitAssignment).');
    console.log('    Orfao aqui = pedido roteado ANTES desse conserto, ou divisao por');
    console.log('    outro caminho. Confira a data do pedido antes de concluir.');
  }

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
