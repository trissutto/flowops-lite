/**
 * CORREÇÃO — pedido ON-000214 (960000214), card da Suzano (17).
 *
 * O QUE ACONTECEU: Suzano bipou as 5 peças dela e finalizou (00:48:51) — o card
 * virou `separated` e ganhou o carimbo `debit_approved_at`. Às 01:11 a matriz
 * trocou a CAJ224 PRETO 48 → 52 e moveu a peça nova pra Suzano. O
 * `moverItensParaLoja` devolve o card pra `separating` (chegou peça nova), mas
 * NÃO limpa o `debit_approved_at` — e o `registerScan` recusa qualquer bipe em
 * card carimbado ("Estoque deste pedido já foi baixado"). Card na fila, peça na
 * lista, bipe impossível.
 *
 * POR QUE LIMPAR É SEGURO: a baixa é peça a peça no bipe desde 18/08. As 5
 * peças têm `stock_decreased_at` preenchido, então `pendingDebitItems` já as
 * desconta — o `runAutoDebit` do próximo finish só baixa o que faltou (a 52).
 * O log do auto-debit deste card é `applied: []` ("nada a baixar"), e não
 * existe `debit.real.applied`: o ERP nunca foi tocado por ele.
 *
 * Mesma auditoria do `reopenDebit`: log `debit.reopened` + linha no histórico.
 *
 *   railway run --service Postgres node backend/scripts/fix-960000214-destrava-bipe-suzano.js
 *
 * Roda em DRY-RUN por padrão. Pra aplicar de verdade:
 *   ... fix-960000214-destrava-bipe-suzano.js --aplicar
 */
const { Client } = require('pg');

const CARD = 'f76befdd-c360-4dbc-8420-bc6bb63a5632';
const ORDER = '7f8be2d4-37a0-4dd0-8960-e415d13da968';
const APLICAR = process.argv.includes('--aplicar');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  // ── CONFERE ANTES DE MEXER ──────────────────────────────────────────────
  const po = await db.query(
    `SELECT po.id, po.status, po.debit_approved_at, po.debit_approved_by,
            s.code AS loja, s.name AS loja_nome
       FROM pick_orders po JOIN stores s ON s.id = po.store_id
      WHERE po.id = $1`,
    [CARD],
  );
  if (!po.rows.length) throw new Error('card não encontrado');
  const card = po.rows[0];
  console.log('CARD:', card.loja_nome, `(${card.loja})`, '· status', card.status);
  console.log('  debit_approved_at:', card.debit_approved_at);

  if (!card.debit_approved_at) {
    console.log('\n✔ carimbo já está limpo — nada a fazer.');
    await db.end();
    return;
  }
  if (!['new', 'separating'].includes(card.status)) {
    throw new Error(`status é "${card.status}" — só destrava card em new/separating`);
  }

  // O ERP não pode ter sido tocado por este card (mesma trava do reopenDebit).
  const live = await db.query(
    `SELECT id, created_at FROM integration_logs
      WHERE source='erp' AND event='debit.real.applied' AND payload LIKE '%' || $1 || '%'`,
    [CARD],
  );
  if (live.rows.length) {
    throw new Error(
      `existe debit.real.applied (#${live.rows[0].id}) — reabrir causaria baixa dupla. NÃO aplicar.`,
    );
  }

  // Toda peça já bipada tem que estar com a baixa registrada; a peça nova, não.
  const conf = await db.query(
    `SELECT oi.sku,
            (SELECT count(*) FROM pick_order_scans sc
              WHERE sc.pick_order_id = $1 AND sc.sku = oi.sku
                AND sc.reverted_at IS NULL AND sc.stock_decreased_at IS NOT NULL) AS baixadas,
            oi.quantity
       FROM order_items oi
      WHERE oi.order_id = $2 AND oi.assigned_store_id = (SELECT store_id FROM pick_orders WHERE id = $1)
      ORDER BY oi.sku`,
    [CARD, ORDER],
  );
  console.log('\nPEÇAS DO CARD (baixadas / esperadas):');
  for (const r of conf.rows) {
    const falta = Number(r.quantity) - Number(r.baixadas);
    console.log(`  ${r.sku}  ${r.baixadas}/${r.quantity}${falta > 0 ? `  ← falta ${falta}` : ''}`);
  }
  const pendentes = conf.rows.filter((r) => Number(r.quantity) - Number(r.baixadas) > 0);
  console.log(`\nDepois de destravar, o bipe vai baixar ${pendentes.length} peça(s): ` +
    (pendentes.map((r) => r.sku).join(', ') || '—'));

  if (!APLICAR) {
    console.log('\n── DRY-RUN — nada foi alterado. Rode com --aplicar pra valer. ──');
    await db.end();
    return;
  }

  // ── APLICA ──────────────────────────────────────────────────────────────
  await db.query('BEGIN');
  try {
    await db.query(
      `INSERT INTO integration_logs (source, direction, event, payload, status)
       VALUES ('pick-order', 'internal', 'debit.reopened', $1, 200)`,
      [
        JSON.stringify({
          pickOrderId: CARD,
          reopenedBy: 'script:fix-960000214-destrava-bipe-suzano',
          storeCode: card.loja,
          storeName: card.loja_nome,
          previousApprovedAt: card.debit_approved_at,
          reason:
            'Peça CAJ224 PRETO 52 (3644904) entrou no card DEPOIS do finish. ' +
            'moverItensParaLoja devolveu o card pra separating mas manteve o carimbo, ' +
            'e o registerScan recusava o bipe. Baixa é peça a peça — sem risco de dobrar.',
        }),
      ],
    );
    const upd = await db.query(
      `UPDATE pick_orders SET debit_approved_at = NULL, debit_approved_by = NULL
        WHERE id = $1 AND debit_approved_at IS NOT NULL
        RETURNING id, status, debit_approved_at`,
      [CARD],
    );
    if (upd.rowCount !== 1) throw new Error('UPDATE não afetou 1 linha — abortando');
    await db.query(
      `INSERT INTO order_history (id, order_id, from_status, to_status, note, created_at)
       VALUES (gen_random_uuid()::text, $1, 'separating', 'separating', $2, now())`,
      [
        ORDER,
        'Bipe da Suzano destravado: o card tinha sido finalizado antes da CAJ224 PRETO 52 ' +
          'entrar nele, e o carimbo da baixa barrava a peça nova. As 5 peças já bipadas ' +
          'continuam baixadas — só a 52 sai do estoque agora.',
      ],
    );
    await db.query('COMMIT');
    console.log('\n✔ APLICADO —', JSON.stringify(upd.rows[0]));
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }

  const depois = await db.query(
    `SELECT id, status, debit_approved_at FROM pick_orders WHERE id = $1`,
    [CARD],
  );
  console.log('DEPOIS:', depois.rows[0]);
  await db.end();
}

main().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
