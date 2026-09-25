#!/usr/bin/env node
/**
 * DIAGNÓSTICO — pedidos do site que nasceram com a COR errada (25/09/2026).
 *
 * O caso: a cliente comprou a Blusa VOGUE MARROM 52 e o pedido chegou como
 * VOGUE PRETA 52 (separada e entregue errada). A sacola mandava só a REF e o
 * guard resolvia o código "pelo que sobrava" no tamanho. O conserto está em
 * `loja-orders/carrinho-guard.service.ts` (a peça é o CÓDIGO; sem cor numa
 * REF de várias cores é recusa). Este script mede o ESTRAGO que já existe e
 * mapeia onde o mesmo erro podia acontecer de novo.
 *
 * SÓ LEITURA. Três relatórios:
 *
 *  1. PEDIDOS COM COR DIVERGENTE — `order_items` do site cujo `cor` (o que a
 *     cliente escolheu) difere da `cor` do espelho para o `sku` gravado (o que
 *     a loja separou). São os pedidos a conferir com a cliente.
 *  2. PEDIDOS SEM CÓDIGO — `sku` que não é código do espelho (ficou a REF):
 *     pedido que nasceu impossível de separar.
 *  3. ESTRUTURA DE RISCO — REFs publicadas no site com 2+ cores que dividem
 *     o MESMO tamanho (o formato exato da VOGUE). É onde um palpite por
 *     tamanho erra a cor.
 *
 * Como rodar (ver memória railway-link-por-pasta): de uma pasta linkada ao
 * projeto heroic-mercy / serviço Postgres,
 *   railway run node <repo>/backend/scripts/diag-cor-variacao-pedidos.js [--dias=60] [--ref=VOGUE]
 */
const path = require('path');
const { Client } = require(path.join(__dirname, '..', 'node_modules', 'pg'));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }),
);
const DIAS = Math.max(1, Number(args.dias) || 60);
const REF = args.ref ? String(args.ref).toUpperCase().trim() : null;

const brt = (d) =>
  d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_PUBLIC_URL ausente — rode via `railway run`');
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

  // ── 1) pedidos com cor divergente ─────────────────────────────────────
  const divergentes = await db.query(
    `
    SELECT o.id AS order_id, o.wc_order_number AS numero, o.status, o.created_at AS criado,
           i.id AS item_id, i.sku, i.ref, i.cor AS cor_pedido, i.tamanho AS tam_pedido,
           i.product_name AS nome,
           p.ref AS ref_espelho, p.cor AS cor_espelho, p.tamanho AS tam_espelho
      FROM order_items i
      JOIN orders o ON o.id = i.order_id
      JOIN wincred_produtos p ON p.codigo = TRIM(i.sku)
     WHERE o.created_at >= NOW() - ($1 || ' days')::interval
       AND o.source = 'ecommerce'
       AND i.cor IS NOT NULL AND TRIM(i.cor) <> ''
       AND UPPER(TRIM(translate(i.cor, 'ÁÀÂÃÉÊÍÓÔÕÚÇáàâãéêíóôõúç', 'AAAAEEIOOOUCaaaaeeiooouc')))
        <> UPPER(TRIM(translate(COALESCE(p.cor, ''), 'ÁÀÂÃÉÊÍÓÔÕÚÇáàâãéêíóôõúç', 'AAAAEEIOOOUCaaaaeeiooouc')))
       ${REF ? `AND (UPPER(TRIM(i.ref)) LIKE $2 OR UPPER(TRIM(p.ref)) LIKE $2)` : ''}
     ORDER BY o.created_at DESC
     LIMIT 300
    `,
    REF ? [String(DIAS), `${REF}%`] : [String(DIAS)],
  );
  console.log(`\n== 1) PEDIDOS COM COR DIVERGENTE (${DIAS} dias): ${divergentes.rowCount} linha(s)`);
  for (const r of divergentes.rows) {
    console.log(
      `  ${r.numero || r.order_id} ${r.status} ${brt(r.criado)} | sku ${r.sku} | pedido: ${r.ref} ${r.cor_pedido} ${r.tam_pedido} | espelho: ${r.ref_espelho} ${r.cor_espelho} ${r.tam_espelho} | ${r.nome}`,
    );
  }

  // ── 2) pedidos sem código ─────────────────────────────────────────────
  const semCodigo = await db.query(
    `
    SELECT o.wc_order_number AS numero, o.status, o.created_at AS criado, i.sku, i.ref, i.cor, i.tamanho
      FROM order_items i
      JOIN orders o ON o.id = i.order_id
      LEFT JOIN wincred_produtos p ON p.codigo = TRIM(i.sku)
     WHERE o.created_at >= NOW() - ($1 || ' days')::interval
       AND o.source = 'ecommerce'
       AND p.codigo IS NULL
       AND i.cancelled_at IS NULL
     ORDER BY o.created_at DESC
     LIMIT 100
    `,
    [String(DIAS)],
  );
  console.log(`\n== 2) PEDIDOS COM SKU QUE NÃO É CÓDIGO (${DIAS} dias): ${semCodigo.rowCount} linha(s)`);
  for (const r of semCodigo.rows) {
    console.log(`  ${r.numero} ${r.status} ${brt(r.criado)} | sku "${r.sku}" | ${r.ref} ${r.cor || ''} ${r.tamanho || ''}`);
  }

  // ── 3) estrutura de risco: REF publicada com 2+ cores no mesmo tamanho ──
  const risco = await db.query(
    `
    WITH pub AS (
      SELECT DISTINCT UPPER(TRIM(ref)) AS ref FROM site_produto WHERE publicado = true
    ),
    var AS (
      SELECT UPPER(TRIM(p.ref)) AS ref, NULLIF(TRIM(p.cor), '') AS cor, NULLIF(TRIM(p.tamanho), '') AS tamanho,
             COALESCE(e.total, 0) AS estoque
        FROM wincred_produtos p
        JOIN pub ON pub.ref = UPPER(TRIM(p.ref))
        LEFT JOIN (SELECT codigo, SUM(COALESCE(estoque, 0)) AS total FROM wincred_estoque GROUP BY codigo) e
          ON e.codigo = p.codigo
    )
    SELECT ref, tamanho, COUNT(DISTINCT COALESCE(cor, '(sem cor)')) AS cores, SUM(estoque) AS estoque
      FROM var
     WHERE tamanho IS NOT NULL
     GROUP BY ref, tamanho
    HAVING COUNT(DISTINCT COALESCE(cor, '(sem cor)')) >= 2 AND SUM(estoque) > 0
     ORDER BY cores DESC, estoque DESC
     LIMIT 400
    `,
  );
  const porRef = new Map();
  for (const r of risco.rows) {
    const cur = porRef.get(r.ref) || { tamanhos: 0, maxCores: 0, estoque: 0 };
    cur.tamanhos += 1;
    cur.maxCores = Math.max(cur.maxCores, Number(r.cores));
    cur.estoque += Number(r.estoque);
    porRef.set(r.ref, cur);
  }
  console.log(`\n== 3) REFs PUBLICADAS com 2+ cores no MESMO tamanho (com estoque): ${porRef.size} REF(s)`);
  for (const [ref, v] of [...porRef.entries()].sort((a, b) => b[1].maxCores - a[1].maxCores).slice(0, 80)) {
    console.log(`  ${ref.padEnd(14)} tamanhos dividindo cor: ${v.tamanhos}  cores no pior tamanho: ${v.maxCores}  estoque: ${v.estoque}`);
  }

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
