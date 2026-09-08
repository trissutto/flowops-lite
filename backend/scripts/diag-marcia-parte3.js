/** Parte 3 — dimensão do buraco ÷100 nas obrigações + conferência Order One. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  // Itens suspeitos de ÷100: preco_unitario < 5 e > 0 (etiqueta real minima ~R$ 9,90)
  const r = await db.query(`
    SELECT mes_referencia mes, status, COUNT(*)::int itens,
           SUM(preco_total)::float8 gravado,
           SUM(preco_total*100)::float8 corrigido_x100,
           SUM(valor_obrigacao)::float8 obrig_gravada,
           SUM(valor_obrigacao*100)::float8 obrig_corrigida
      FROM inter_store_obligations
     WHERE preco_unitario > 0 AND preco_unitario < 5
     GROUP BY 1,2 ORDER BY 1,2`);
  console.log('== itens com preco ÷100 (0 < preco_unit < R$5) ==');
  console.table(r.rows.map((x) => ({ mes: x.mes, status: x.status, itens: x.itens, gravado: fmt(x.gravado), corrigido: fmt(x.corrigido_x100), obrig_gravada: fmt(x.obrig_gravada), obrig_corrigida: fmt(x.obrig_corrigida) })));
  const z = await db.query(`
    SELECT mes_referencia mes, COUNT(*)::int itens_preco_zero, SUM(qty)::int pecas
      FROM inter_store_obligations WHERE COALESCE(preco_unitario,0) = 0 GROUP BY 1 ORDER BY 1`);
  console.log('== itens com preco ZERO ==');
  console.table(z.rows);
  // Total devido por franquia como está × como ficaria corrigido (pending)
  const t = await db.query(`
    SELECT to_store_code dest,
           SUM(valor_obrigacao)::float8 pend_gravado,
           SUM(CASE WHEN preco_unitario > 0 AND preco_unitario < 5 THEN valor_obrigacao*99 ELSE 0 END)::float8 acrescimo_fix
      FROM inter_store_obligations
     WHERE status = 'pending' AND to_store_code IN ('03','08','10','17','18')
     GROUP BY 1 ORDER BY 1`);
  console.log('== obrigações PENDING por franquia: gravado × acréscimo se corrigir ÷100 ==');
  console.table(t.rows.map((x) => ({ dest: x.dest, pend_gravado: fmt(x.pend_gravado), acrescimo_se_corrigir: fmt(x.acrescimo_fix), pend_corrigido: fmt(Number(x.pend_gravado) + Number(x.acrescimo_fix)) })));
  // Order One: obrigações por DATA DE CRIAÇÃO 21/06–01/08 (não mesReferencia)
  const o = await db.query(`
    SELECT SUM(preco_total)::float8 cheio, SUM(valor_obrigacao)::float8 div25, COUNT(*)::int itens
      FROM inter_store_obligations
     WHERE created_at >= '2026-06-21T00:00:00-03:00' AND created_at < '2026-08-02T00:00:00-03:00'
       AND to_store_code IN ('03','08','10','17','18') AND status <> 'cancelled'`);
  console.log('== obrigações CRIADAS 21/06–01/08 (franquias) ==');
  console.table(o.rows.map((x) => ({ itens: x.itens, preco_cheio: fmt(x.cheio), div25: fmt(x.div25), order_one_dela: fmt(293195.86) })));
  await db.end();
}
main().catch((e) => { console.error('ERRO:', e && (e.stack || e.message)); process.exit(1); });
