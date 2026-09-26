/**
 * BACKFILL — CARD RECEPTOR DA RETIRADA (26/09/2026, caso LP-001652).
 *
 * O código novo (`common/retirada-receptora.ts`) cria o card receptor na loja
 * de retirada quando ela não tem peça nenhuma do pedido — no roteamento, no
 * "mover peça" e na entrada da caixa. Este script conserta os pedidos que
 * nasceram ANTES: retirada/motoboy com alimentador apontando pra loja de
 * destino e nenhum card próprio lá. Sem o card, a loja onde a cliente vai
 * buscar não vê o pedido e ninguém consegue registrar "Cliente retirou".
 *
 * Só toca pedido ABERTO (status fora de delivered/cancelled). O card nasce
 * `separated` quando todas as caixas dos alimentadores já deram entrada
 * (a peça está na loja — falta a cliente) e `new` nos outros casos.
 *
 * `--reabrir LP-000000`: pedido de retirada que o "📦 Enviei pra loja X" da
 * origem fechou como ENTREGUE antes da hora (o bug do LP-001652). Volta o
 * pedido pra `shipped` (delivered_at nulo), grava no histórico e deixa o
 * backfill criar o receptor — a loja de retirada fecha de verdade quando a
 * cliente buscar. Só reabre se o pedido ainda tem alimentador e nenhum card
 * próprio no destino.
 *
 *   DRY-RUN (padrão, nada é gravado):
 *     railway run --service Postgres node backend/scripts/retirada-card-receptor.js
 *   APLICAR:
 *     railway run --service Postgres node backend/scripts/retirada-card-receptor.js --apply
 *   REABRIR + APLICAR:
 *     railway run --service Postgres node backend/scripts/retirada-card-receptor.js --apply --reabrir LP-001652
 */
process.env.TZ = 'UTC';
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
/**
 * JANELA (medido no ensaio de 26/09): sem filtro apareciam 19 pedidos de
 * abril a agosto, todos `shipped`, todos SEM caixa — retiradas fechadas pelo
 * clique da origem antes do trilho da caixa existir (27/08), quase certamente
 * já buscadas. Card "aguardando a peça" neles seria alarme falso na fila de
 * 8 lojas. Por padrão só entra pedido com caixa (em trânsito ou recebida) ou
 * dos últimos 30 dias; `--todos` desliga o filtro.
 */
const TODOS = process.argv.includes('--todos');
const reabrirArg = (() => {
  const i = process.argv.indexOf('--reabrir');
  return i >= 0 ? String(process.argv[i + 1] || '').trim() : '';
})();

const BR = (col) => `to_char((${col}) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI')`;
const MORTO = `('cancelled','canceled')`;

/** Destino obrigatório — a MESMA régua de `common/destino-obrigatorio.ts`. */
const DESTINO_SQL = `
  CASE WHEN o.pickup_store_code IS NOT NULL AND btrim(o.pickup_store_code) <> ''
        AND (o.is_pickup OR o.shipping_method ~* 'moto\\s*boy')
       THEN btrim(o.pickup_store_code) END`;

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  if (!APPLY) await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

  const agora = (await db.query(`select to_char(now() AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') as br`)).rows[0].br;
  console.log(`${APPLY ? 'APLICANDO' : 'DRY-RUN (nada gravado)'} · agora ${agora} BRT`);

  // ── 1) reabrir um pedido entregue antes da hora (opcional) ──
  if (reabrirArg) {
    const r = (
      await db.query(
        `SELECT o.id, o.wc_order_number, o.status, ${BR('o.delivered_at')} entregue_br, ${DESTINO_SQL} AS destino
           FROM orders o WHERE o.wc_order_number = $1`,
        [reabrirArg],
      )
    ).rows[0];
    if (!r) throw new Error(`pedido ${reabrirArg} não existe`);
    if (r.status !== 'delivered') {
      console.log(`--reabrir ${reabrirArg}: status é ${r.status}, não delivered — nada a reabrir`);
    } else {
      const feeders = (
        await db.query(
          `SELECT s.code, s.name, p.status FROM pick_orders p JOIN stores s ON s.id = p.store_id
            WHERE p.order_id = $1 AND p.is_transfer AND p.transfer_to_store_code = $2 AND p.status NOT IN ${MORTO}`,
          [r.id, r.destino],
        )
      ).rows;
      const proprios = (
        await db.query(
          `SELECT p.id FROM pick_orders p JOIN stores s ON s.id = p.store_id
            WHERE p.order_id = $1 AND NOT p.is_transfer AND s.code = $2 AND p.status NOT IN ${MORTO}`,
          [r.id, r.destino],
        )
      ).rows;
      if (!r.destino || !feeders.length || proprios.length) {
        console.log(`--reabrir ${reabrirArg}: não é o caso (destino=${r.destino}, feeders=${feeders.length}, próprios=${proprios.length})`);
      } else {
        console.log(`--reabrir ${reabrirArg}: entregue em ${r.entregue_br} pelo clique da origem (${feeders.map((f) => f.name).join(', ')}) → volta pra shipped`);
        if (APPLY) {
          await db.query('BEGIN');
          await db.query(`UPDATE orders SET status = 'shipped', delivered_at = NULL, updated_at = now() WHERE id = $1 AND status = 'delivered'`, [r.id]);
          await db.query(
            `INSERT INTO order_history (id, order_id, from_status, to_status, note, created_at)
             VALUES (gen_random_uuid()::text, $1, 'delivered', 'shipped', $2, now())`,
            [
              r.id,
              `Pedido REABERTO como enviado: constava entregue desde ${r.entregue_br} pelo "Enviei pra loja" da origem, ` +
                `com a peça ainda na estrada (bug corrigido em 26/09). A loja de retirada registra a entrega quando a cliente buscar.`,
            ],
          );
          await db.query('COMMIT');
          console.log(`  ✔ ${reabrirArg} reaberto`);
        }
      }
    }
  }

  // ── 2) pedidos abertos de retirada/motoboy sem card na loja de destino ──
  const candidatos = (
    await db.query(
      `WITH base AS (
         SELECT o.id, o.created_at, o.wc_order_number, o.status, o.customer_name, ${BR('o.created_at')} criado_br, ${DESTINO_SQL} AS destino
           FROM orders o
          WHERE o.status NOT IN ('delivered','cancelled','canceled','refunded')
       )
       SELECT b.*, s.id AS store_id, s.name AS destino_nome,
              (SELECT string_agg(sf.name, ', ') FROM pick_orders f JOIN stores sf ON sf.id = f.store_id
                WHERE f.order_id = b.id AND f.is_transfer AND f.transfer_to_store_code = b.destino AND f.status NOT IN ${MORTO}) AS origens,
              (SELECT count(*)::int FROM pick_orders f
                WHERE f.order_id = b.id AND f.is_transfer AND f.transfer_to_store_code = b.destino AND f.status NOT IN ${MORTO}) AS feeders,
              (SELECT count(*)::int FROM pick_orders f
                WHERE f.order_id = b.id AND f.is_transfer AND f.transfer_to_store_code = b.destino AND f.status NOT IN ${MORTO}
                  AND EXISTS (SELECT 1 FROM realignment_shipments r WHERE r.pick_order_id = f.id AND r.status = 'received')) AS feeders_chegaram,
              (SELECT string_agg(r.code, ', ') FROM realignment_shipments r JOIN pick_orders f ON f.id = r.pick_order_id
                WHERE f.order_id = b.id AND f.is_transfer AND f.transfer_to_store_code = b.destino AND r.status <> 'cancelled') AS caixas
         FROM base b
         JOIN stores s ON s.code = b.destino
        WHERE b.destino IS NOT NULL
          AND EXISTS (SELECT 1 FROM pick_orders f WHERE f.order_id = b.id AND f.is_transfer
                        AND f.transfer_to_store_code = b.destino AND f.status NOT IN ${MORTO})
          AND NOT EXISTS (SELECT 1 FROM pick_orders p JOIN stores sp ON sp.id = p.store_id
                           WHERE p.order_id = b.id AND NOT p.is_transfer AND sp.code = b.destino AND p.status NOT IN ${MORTO})
          ${TODOS ? '' : `AND (b.created_at >= now() - interval '30 days'
                 OR EXISTS (SELECT 1 FROM realignment_shipments r JOIN pick_orders f ON f.id = r.pick_order_id
                             WHERE f.order_id = b.id AND f.is_transfer AND f.transfer_to_store_code = b.destino
                               AND r.status IN ('in_transit','received')))`}
        ORDER BY b.created_at`,
    )
  ).rows;
  if (!TODOS) console.log('(janela: últimos 30 dias ou com caixa em trânsito/recebida — use --todos pra ver tudo)');

  if (!candidatos.length) {
    console.log('nenhum pedido aberto de retirada/motoboy sem card na loja de destino');
  } else {
    console.log(`\n${candidatos.length} pedido(s) sem card receptor:`);
    console.table(
      candidatos.map((c) => ({
        pedido: c.wc_order_number,
        status: c.status,
        criado_br: c.criado_br,
        cliente: c.customer_name,
        destino: `${c.destino} ${c.destino_nome}`,
        origens: c.origens,
        caixas: c.caixas,
        chegaram: `${c.feeders_chegaram}/${c.feeders}`,
        card_nasce: c.feeders_chegaram === c.feeders ? 'separated (peça aqui)' : 'new (aguardando)',
      })),
    );
  }

  if (APPLY) {
    let criados = 0;
    for (const c of candidatos) {
      const status = c.feeders_chegaram === c.feeders ? 'separated' : 'new';
      await db.query('BEGIN');
      const ins = await db.query(
        `INSERT INTO pick_orders (id, order_id, store_id, status, is_transfer, transfer_to_store_code, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, false, NULL, now(), now()) RETURNING id`,
        [c.id, c.store_id, status],
      );
      await db.query(
        `INSERT INTO order_history (id, order_id, from_status, to_status, note, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, $2, $3, now())`,
        [
          c.id,
          c.status,
          `🏬 Card de RETIRADA criado na loja ${c.destino_nome} (${c.destino}): a cliente busca lá e nenhuma peça é de lá — ` +
            `${c.origens} manda(m) por transferência. ` +
            (status === 'separated' ? 'As caixas já deram entrada: falta a cliente buscar.' : 'Fica "aguardando a peça chegar" até a caixa dar entrada.') +
            ' · backfill 26/09',
        ],
      );
      await db.query('COMMIT');
      criados++;
      console.log(`  ✔ ${c.wc_order_number}: card ${ins.rows[0].id.slice(0, 8)} na ${c.destino} (${status})`);
    }
    console.log(`\n${criados} card(s) criado(s)`);
  } else if (candidatos.length) {
    console.log('\n(dry-run — rode com --apply pra criar os cards)');
  }

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
