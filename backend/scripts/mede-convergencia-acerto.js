/** Convergência: obrigações corrigidas × débito recalculado (régua da conta corrente), ago/26. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const fmt = (n) => Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const ob = await db.query(`
    SELECT mes_referencia mes, SUM(valor_obrigacao)::float8 v, COUNT(*)::int itens
      FROM inter_store_obligations
     WHERE status <> 'cancelled' AND mes_referencia IN ('2026-07','2026-08')
       AND to_store_tipo = 'FILIAL' AND from_store_tipo = 'REDE'
     GROUP BY 1 ORDER BY 1`);
  console.log('[obrigações CORRIGIDAS] rede→franquia por mês de envio:');
  console.table(ob.rows.map((r) => ({ mes: r.mes, itens: r.itens, valor: fmt(r.v) })));
  const cc = await db.query(`
    SELECT to_char(date_trunc('month', s.received_at),'YYYY-MM') mes,
           SUM(o.qty_origem * COALESCE(w."vendaUn",0) / 2.5)::float8 v, SUM(o.qty_origem)::int pecas
      FROM transfer_orders o
      JOIN realignment_shipments s ON s.id = o.shipment_id
      LEFT JOIN wincred_produtos w ON ltrim(w.codigo,'0') = ltrim(COALESCE(o.codigo_bipado,''),'0')
      JOIN stores fo ON fo.code = lpad(regexp_replace(s.from_store_code,'[^0-9]','','g'),2,'0')
      JOIN stores de ON de.code = lpad(regexp_replace(s.to_store_code,'[^0-9]','','g'),2,'0')
     WHERE s.received_at >= '2026-07-01' AND s.received_at < '2026-09-01'
       AND s.status = 'received' AND s.order_id IS NULL
       AND COALESCE(o.realignment_status,'') <> 'cancelled'
       AND COALESCE(fo.tipo,'REDE') <> 'FILIAL' AND de.tipo = 'FILIAL'
     GROUP BY 1 ORDER BY 1`);
  console.log('[régua da conta corrente] rede→franquia RECEBIDAS no mês (espelho ÷2,5):');
  console.table(cc.rows.map((r) => ({ mes: r.mes, pecas: r.pecas, valor: fmt(r.v) })));
  await db.end();
}
main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
