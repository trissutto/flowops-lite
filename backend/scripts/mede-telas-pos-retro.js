/** Mede o efeito das correções nas TELAS, 01/01/2026→hoje:
 *  [C] r% no caixa por corte · [B] Faturamento híbrido em 3 sabores ·
 *  [A] rede×franquia preço-atual × snapshot-first. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const fmt = (n) => Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const c = await db.query(`
    SELECT SUM(CASE WHEN data < '2026-08-25' THEN -valor_total ELSE 0 END)::float8 retro,
           SUM(CASE WHEN data >= '2026-08-25' THEN -valor_total ELSE 0 END)::float8 ponte
      FROM giga_caixa_mov WHERE registro LIKE 'r%'`);
  console.log('[C] r% no caixa: retro(<25/08)=', fmt(c.rows[0].retro), ' ponte(>=25/08)=', fmt(c.rows[0].ponte));
  const b = await db.query(`
    WITH flow AS (
      SELECT COALESCE(SUM(s.total - COALESCE(vt.vale,0)),0)::float8 v
        FROM pdv_sales s
        LEFT JOIN (SELECT sale_id, SUM(valor)::float8 vale FROM pdv_sale_payments
                    WHERE LOWER(TRIM(method)) IN ('vale_troca','vale','troca') GROUP BY sale_id) vt ON vt.sale_id = s.id
       WHERE s.finalized_at >= '2026-01-01T00:00:00-03:00' AND s.status='finalized' AND s.is_training=false
         AND (s.payment_method IS NULL OR s.payment_method <> 'MARCADO')
    ), g AS (
      SELECT COALESCE(SUM(valor_total),0)::float8 com_r,
             COALESCE(SUM(valor_total) FILTER (WHERE registro NOT LIKE 'r%'),0)::float8 sem_r,
             COALESCE(SUM(valor_total) FILTER (WHERE registro NOT LIKE 'r%' OR data >= '2026-08-25'),0)::float8 so_ponte
        FROM giga_caixa_mov
       WHERE data_fec >= '2026-01-01' AND (marcado IS NULL OR marcado <> 'SIM')
         AND COALESCE(obs_pedido,'') NOT LIKE 'flowops-%'
    ), dev AS (
      SELECT COALESCE(SUM(valor_total),0)::float8 v FROM pdv_returns
       WHERE created_at >= '2026-01-01T00:00:00-03:00' AND is_training=false
         AND modo IN ('dinheiro','pix') AND COALESCE(status,'') <> 'cancelled'
    )
    SELECT f.v flow, g.com_r, g.sem_r, g.so_ponte, d.v dev FROM flow f, g, dev d`);
  const r = b.rows[0];
  console.log('[B] FATURAMENTO tela (hibrido) 01/01→hoje:');
  console.log('    ontem (dobro so da ponte):', fmt(r.flow + r.so_ponte - r.dev));
  console.log('    AGORA (retro dentro):     ', fmt(r.flow + r.com_r - r.dev));
  console.log('    POS-FIX (sem r%):         ', fmt(r.flow + r.sem_r - r.dev));
  const a = await db.query(`
    SELECT SUM(o.qty_origem * COALESCE(w."vendaUn",0))::float8 preco_atual,
           SUM(o.qty_origem * CASE WHEN COALESCE(o.preco_unit_cents,0) > 0 THEN o.preco_unit_cents/100.0
                                   ELSE COALESCE(w."vendaUn",0) END)::float8 snapshot_first,
           SUM(o.qty_origem) FILTER (WHERE COALESCE(o.preco_unit_cents,0) > 0)::int pecas_com_snap,
           SUM(o.qty_origem)::int pecas
      FROM transfer_orders o
      JOIN realignment_shipments s ON s.id = o.shipment_id
      LEFT JOIN wincred_produtos w ON ltrim(w.codigo,'0') = ltrim(COALESCE(o.codigo_bipado,''),'0')
     WHERE s.opened_at >= '2026-01-01' AND s.status <> 'cancelled'
       AND COALESCE(o.realignment_status,'') <> 'cancelled'`);
  console.log('[A] REDE×FRANQUIA 01/01→hoje (aprox. sem fallback-REF):');
  console.log('    preco ATUAL:', fmt(a.rows[0].preco_atual), '| snapshot-first:', fmt(a.rows[0].snapshot_first),
    '| dif:', fmt(a.rows[0].snapshot_first - a.rows[0].preco_atual), '| pecas com snapshot:', a.rows[0].pecas_com_snap, '/', a.rows[0].pecas);
  await db.end();
}
main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
