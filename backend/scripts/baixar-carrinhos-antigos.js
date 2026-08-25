/**
 * TIRAR DA FILA OS CARRINHOS ANTERIORES À VIRADA DO SITE (ordem do dono, 25/08/2026).
 *
 * "Excluir todos os carrinhos de 18/08 pra trás, independente de qualquer canal
 * de aquisição." O corte é 19/08/2026 porque é o dia em que o site novo virou
 * (o WooCommerce parou em 19/08): tudo que ficou pra trás é lixo da migração —
 * PIX vencido há semanas, cartão recusado, contato capturado que nunca voltou.
 * Fila com alarme falso velho é fila em que ninguém confia.
 *
 * NÃO APAGA NADA (decisão do dono na pergunta de 25/08): o pedido continua no
 * histórico, no faturamento e na cascata de campanha. O que muda é o ESTADO,
 * pra fila parar de oferecer a linha:
 *
 *   · `orders` (site novo, não pagos)  → status = 'cancelled'
 *     Some da aba "abandonados" da retaguarda e da fila de Carrinhos do PDV —
 *     as duas já filtram `status != 'cancelled'`. É a verdade do dado: link
 *     de pagamento vencido e cartão recusado há dias não vão virar venda.
 *
 *   · `checkout_recoveries` (contato capturado) → status = 'discarded'
 *     A fila do PDV pede `status='active'`; qualquer outro valor sai. Não
 *     inventa métrica nova: 'converted' continua sendo só quem comprou, e o
 *     ROAS (campanhas-roas.sql) casa por telefone/data, não por status.
 *
 * O QUE ELE NÃO TOCA: pedido PAGO (de qualquer data), qualquer coisa de 19/08
 * em diante, estoque, e nenhuma linha de outro `source` (site velho/live) —
 * essas nem aparecem na fila de carrinhos.
 *
 *   railway run --service Postgres node backend/scripts/baixar-carrinhos-antigos.js           # simulação
 *   railway run --service Postgres node backend/scripts/baixar-carrinhos-antigos.js --apply   # grava
 *   ... --corte 2026-08-19    → outra data de corte (default 2026-08-19)
 */
const { Client } = require('pg');

const APLICAR = process.argv.includes('--apply');
const argDe = (nome, padrao) => {
  const i = process.argv.indexOf(nome);
  return i > 0 ? String(process.argv[i + 1] || '').trim() : padrao;
};
const CORTE = argDe('--corte', '2026-08-19');
if (!/^\d{4}-\d{2}-\d{2}$/.test(CORTE)) {
  console.error('--corte precisa ser YYYY-MM-DD');
  process.exit(1);
}

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('sem DATABASE_URL — rode com `railway run --service Postgres`');
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  console.log(`\n=== CARRINHOS ANTERIORES A ${CORTE} — ${APLICAR ? 'APLICANDO' : 'SIMULAÇÃO'} ===`);

  // ── 1. Pedidos do site novo que nunca foram pagos ────────────────────────
  const pedidos = await c.query(
    `SELECT wc_order_id, wc_order_number, customer_name, status,
            total_amount, created_at::date AS dia
       FROM orders
      WHERE source = 'ecommerce'
        AND paid_at IS NULL
        AND status <> 'cancelled'
        AND created_at < TIMESTAMP '${CORTE} 00:00:00'
      ORDER BY created_at`,
  );
  console.log(`\n── ${pedidos.rowCount} pedido(s) não pago(s) pra cancelar`);
  console.table(pedidos.rows);

  /**
   * TRAVA DE SEGURANÇA: pedido que já foi SEPARADO não é carrinho abandonado.
   *
   * Se alguma dessas linhas tiver ordem de separação, ela teve vida real na
   * operação (loja bipou peça, estoque se mexeu) — cancelar em massa poderia
   * esconder um caso que precisa de gente. Aqui ela é PULADA e listada pra
   * decisão humana.
   */
  const comOperacao = await c.query(
    `SELECT o.wc_order_id, count(p.id) AS pick_orders
       FROM orders o
       JOIN pick_orders p ON p.order_id = o.id
      WHERE o.source = 'ecommerce'
        AND o.paid_at IS NULL
        AND o.status <> 'cancelled'
        AND o.created_at < TIMESTAMP '${CORTE} 00:00:00'
      GROUP BY o.wc_order_id`,
  );
  if (comOperacao.rowCount) {
    console.log(`\n⚠️  ${comOperacao.rowCount} pedido(s) com separação — NÃO serão tocados:`);
    console.table(comOperacao.rows);
  }
  const pular = comOperacao.rows.map((r) => Number(r.wc_order_id));

  // ── 2. Contatos capturados no checkout que nunca viraram pedido ──────────
  const capturas = await c.query(
    `SELECT count(*) AS linhas, min(created_at)::date AS mais_antigo,
            max(created_at)::date AS mais_novo
       FROM checkout_recoveries
      WHERE status = 'active'
        AND created_at < TIMESTAMP '${CORTE} 00:00:00'`,
  );
  console.log(`\n── contatos capturados pra descartar`);
  console.table(capturas.rows);

  if (!APLICAR) {
    console.log('\n(simulação — rode com --apply pra gravar)\n');
    await c.end();
    return;
  }

  const filtroPular = pular.length ? `AND wc_order_id <> ALL($1::bigint[])` : '';
  const upPedidos = await c.query(
    `UPDATE orders
        SET status = 'cancelled', updated_at = now()
      WHERE source = 'ecommerce'
        AND paid_at IS NULL
        AND status <> 'cancelled'
        AND created_at < TIMESTAMP '${CORTE} 00:00:00'
        ${filtroPular}`,
    pular.length ? [pular] : [],
  );
  const upCapturas = await c.query(
    `UPDATE checkout_recoveries
        SET status = 'discarded', updated_at = now()
      WHERE status = 'active'
        AND created_at < TIMESTAMP '${CORTE} 00:00:00'`,
  );

  console.log(`\n✅ ${upPedidos.rowCount} pedido(s) cancelado(s) · ${upCapturas.rowCount} contato(s) descartado(s)`);
  console.log('   Nada foi apagado: as linhas continuam no histórico e na cascata de campanha.\n');
  await c.end();
}

main().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
