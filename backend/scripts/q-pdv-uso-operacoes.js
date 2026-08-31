// Medição de uso das operações do PDV — briefing da reforma visual (etapa 1).
// Janela: 60 dias. Sempre exclui is_training. Leitura pura (SELECTs).
const { Client } = require('pg');

const J = 60; // dias

(async () => {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql) => (await db.query(sql)).rows;
  const win = `NOW() - INTERVAL '${J} days'`;

  // A. Vendas finalizadas + recursos usados dentro da venda
  const [a] = await q(`
    SELECT COUNT(*)::int vendas,
           COUNT(DISTINCT store_code)::int lojas,
           COUNT(*) FILTER (WHERE customer_cpf IS NOT NULL OR person_id IS NOT NULL)::int com_cliente,
           COUNT(*) FILTER (WHERE desconto > 0)::int com_desconto_cabecalho,
           COUNT(*) FILTER (WHERE crediario_criado_em IS NOT NULL)::int com_crediario,
           COUNT(*) FILTER (WHERE marcados_registros IS NOT NULL)::int de_marcados,
           COUNT(*) FILTER (WHERE carrinho_order_id IS NOT NULL OR carrinho_recovery_id IS NOT NULL)::int de_carrinho_importado,
           COUNT(*) FILTER (WHERE entrega_tipo IS NOT NULL)::int venda_online_painel,
           COUNT(*) FILTER (WHERE sent_whatsapp_at IS NOT NULL)::int cupom_whatsapp,
           COUNT(*) FILTER (WHERE sent_email_at IS NOT NULL)::int cupom_email,
           COUNT(*) FILTER (WHERE nfce_status IS NOT NULL)::int nfce_tentada
    FROM pdv_sales
    WHERE status='finalized' AND is_training=false AND finalized_at > ${win}`);

  const [a2] = await q(`SELECT COUNT(*)::int n FROM pdv_sales WHERE is_training=false AND cancelled_at > ${win}`);
  const [treino] = await q(`SELECT COUNT(*)::int n FROM pdv_sales WHERE is_training=true AND created_at > ${win}`);
  const a3 = await q(`SELECT COALESCE(nfce_status,'(sem nfce)') s, COUNT(*)::int n FROM pdv_sales WHERE status='finalized' AND is_training=false AND finalized_at > ${win} GROUP BY 1 ORDER BY n DESC`);

  // B. Pagamentos por método + split
  const b = await q(`
    SELECT p.method, COUNT(*)::int n, ROUND(SUM(p.valor)::numeric, 0)::int total_reais
    FROM pdv_sale_payments p JOIN pdv_sales s ON s.id = p.sale_id
    WHERE s.status='finalized' AND s.is_training=false AND s.finalized_at > ${win}
    GROUP BY 1 ORDER BY n DESC`);
  const [b2] = await q(`
    SELECT COUNT(*)::int n FROM (
      SELECT p.sale_id FROM pdv_sale_payments p JOIN pdv_sales s ON s.id = p.sale_id
      WHERE s.status='finalized' AND s.is_training=false AND s.finalized_at > ${win}
      GROUP BY p.sale_id HAVING COUNT(*) > 1) x`);

  // C. Itens (promos, descontos, vendedora por item)
  const [c] = await q(`
    SELECT COUNT(*)::int itens,
           COUNT(*) FILTER (WHERE i.promo_tag IS NOT NULL)::int com_promo_tag,
           COUNT(*) FILTER (WHERE i.forcar_promo)::int forcar_promo,
           COUNT(*) FILTER (WHERE i.desconto > 0)::int com_desconto_item,
           COUNT(*) FILTER (WHERE i.preco_de_cents IS NOT NULL)::int com_preco_de,
           COUNT(*) FILTER (WHERE i.seller_name IS NOT NULL)::int vendedora_por_item
    FROM pdv_sale_items i JOIN pdv_sales s ON s.id = i.sale_id
    WHERE s.status='finalized' AND s.is_training=false AND s.finalized_at > ${win}`);

  // D. Devoluções/trocas + vale-troca consumido
  const d = await q(`SELECT modo, source, COUNT(*)::int n FROM pdv_returns WHERE is_training=false AND created_at > ${win} GROUP BY 1,2 ORDER BY n DESC`);
  const [d2] = await q(`SELECT COUNT(*)::int n FROM pdv_returns WHERE is_training=false AND created_at > ${win}`);
  const [e] = await q(`SELECT COUNT(*)::int n FROM pdv_returns WHERE is_training=false AND credito_usado_at > ${win}`);

  // F. Marcados (provar em casa)
  const f = await q(`
    SELECT 'criados no PDV (origem flow)' op, COUNT(*)::int n FROM marcados WHERE is_training=false AND origem='flow' AND created_at > ${win}
    UNION ALL SELECT 'puxados pra venda', COUNT(*)::int FROM marcados WHERE is_training=false AND fechado_at > ${win}
    UNION ALL SELECT 'devolvidos', COUNT(*)::int FROM marcados WHERE is_training=false AND devolvido_at > ${win}
    UNION ALL SELECT 'baixados (perda/defeito)', COUNT(*)::int FROM marcados WHERE is_training=false AND baixado_at > ${win}`);

  // G. Crediário — recebimento de parcelas no balcão
  const [g] = await q(`SELECT COUNT(*)::int baixas, COALESCE(SUM(total_parcelas),0)::int parcelas, ROUND(COALESCE(SUM(total_pago),0)::numeric,0)::int reais FROM crediario_baixas WHERE status='paid' AND created_at > ${win}`);
  const g2 = await q(`SELECT "formaPagamento" forma_pagamento, COUNT(*)::int n FROM crediario_baixas WHERE status='paid' AND created_at > ${win} GROUP BY 1 ORDER BY n DESC`);

  // H. Caixa: sessões, sangria/suprimento, adiantamento
  const [h] = await q(`SELECT COUNT(*)::int sessoes FROM pdv_cash_sessions WHERE is_training=false AND opened_at > ${win}`);
  const h2 = await q(`SELECT tipo, is_fechamento, COUNT(*)::int n FROM pdv_cash_movements WHERE is_training=false AND created_at > ${win} GROUP BY 1,2 ORDER BY n DESC`);
  const [h3] = await q(`SELECT COUNT(*)::int n FROM adiantamentos_funcionaria WHERE created_at > ${win}`);

  // I. Cobranças online (PIX PagBank + link Pagar.me)
  const i1 = await q(`SELECT COALESCE(origem,'balcao') origem, status, COUNT(*)::int n FROM pagbank_payments WHERE created_at > ${win} GROUP BY 1,2 ORDER BY n DESC`);
  const i2 = await q(`SELECT status, COUNT(*)::int n FROM pagarme_payments WHERE created_at > ${win} GROUP BY 1 ORDER BY n DESC`);

  // J. Diversos
  const [j] = await q(`SELECT COUNT(*)::int n FROM convenio_compras WHERE created_at > ${win}`);
  const [l] = await q(`SELECT COUNT(*)::int n FROM pdv_payment_audits WHERE changed_at > ${win}`);

  // K. Vendas por loja
  const k = await q(`SELECT store_code, COUNT(*)::int n FROM pdv_sales WHERE status='finalized' AND is_training=false AND finalized_at > ${win} GROUP BY 1 ORDER BY n DESC`);

  const pd = (n) => (n / J).toFixed(1);
  const pct = (n, base) => base ? ((100 * n) / base).toFixed(1) + '%' : '—';

  console.log(`=== USO DO PDV — últimos ${J} dias (sem treino) ===\n`);
  console.log(`VENDAS finalizadas: ${a.vendas} (${pd(a.vendas)}/dia na rede, ${a.lojas} lojas)`);
  console.log(`  com cliente identificado: ${a.com_cliente} (${pct(a.com_cliente, a.vendas)}) | desconto no cabeçalho: ${a.com_desconto_cabecalho} (${pct(a.com_desconto_cabecalho, a.vendas)})`);
  console.log(`  crediário: ${a.com_crediario} (${pct(a.com_crediario, a.vendas)}) | de marcados: ${a.de_marcados} | carrinho importado: ${a.de_carrinho_importado}`);
  console.log(`  painel Venda Online: ${a.venda_online_painel} (${pct(a.venda_online_painel, a.vendas)}) | cupom WhatsApp: ${a.cupom_whatsapp} | cupom e-mail: ${a.cupom_email}`);
  console.log(`  NFC-e tentada: ${a.nfce_tentada} (${pct(a.nfce_tentada, a.vendas)}) | canceladas: ${a2.n} | vendas de TREINO: ${treino.n}`);
  console.log(`\nNFC-e por status:`); a3.forEach(r => console.log(`  ${r.s}: ${r.n}`));
  console.log(`\nPAGAMENTOS por método:`); b.forEach(r => console.log(`  ${r.method}: ${r.n} (R$ ${r.total_reais})`));
  console.log(`  vendas com split (2+ métodos): ${b2.n} (${pct(b2.n, a.vendas)})`);
  console.log(`\nITENS: ${c.itens} (${(c.itens / (a.vendas || 1)).toFixed(1)}/venda)`);
  console.log(`  promo automática: ${c.com_promo_tag} (${pct(c.com_promo_tag, c.itens)}) | forçar promo (botão azul): ${c.forcar_promo} | desconto por item: ${c.com_desconto_item}`);
  console.log(`  DE riscado: ${c.com_preco_de} | vendedora por item (2 vendedoras): ${c.vendedora_por_item}`);
  console.log(`\nDEVOLUÇÕES/TROCAS: ${d2.n} (${pd(d2.n)}/dia)`); d.forEach(r => console.log(`  ${r.modo} · ${r.source}: ${r.n}`));
  console.log(`  vale-troca consumido em venda: ${e.n}`);
  console.log(`\nMARCADOS:`); f.forEach(r => console.log(`  ${r.op}: ${r.n} (${pd(r.n)}/dia)`));
  console.log(`\nCREDIÁRIO recebimento no balcão: ${g.baixas} baixas (${pd(g.baixas)}/dia) · ${g.parcelas} parcelas · R$ ${g.reais}`);
  g2.forEach(r => console.log(`  ${r.forma_pagamento}: ${r.n}`));
  console.log(`\nCAIXA: ${h.sessoes} sessões (${pd(h.sessoes)}/dia)`);
  h2.forEach(r => console.log(`  ${r.tipo}${r.is_fechamento ? ' (fechamento automático)' : ' (manual)'}: ${r.n} (${pd(r.n)}/dia)`));
  console.log(`  adiantamento funcionária: ${h3.n}`);
  console.log(`\nCOBRANÇAS PagBank (janela ${J}d):`); i1.forEach(r => console.log(`  ${r.origem} · ${r.status}: ${r.n}`));
  console.log(`Links/QRs Pagar.me:`); i2.forEach(r => console.log(`  ${r.status}: ${r.n}`));
  console.log(`\nCONVÊNIO compras: ${j.n} | ajustes de pagamento (supervisor): ${l.n}`);
  console.log(`\nVENDAS POR LOJA:`); k.forEach(r => console.log(`  loja ${r.store_code}: ${r.n} (${pd(r.n)}/dia)`));

  await db.end();
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
