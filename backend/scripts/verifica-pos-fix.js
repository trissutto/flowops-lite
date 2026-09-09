require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const a = await db.query(`SELECT COUNT(*)::int n FROM inter_store_obligations WHERE mes_referencia IN ('2026-05','2026-06') AND status='pending' AND preco_unitario > 0 AND preco_unitario < 6`);
  const z = await db.query(`SELECT mes_referencia mes, COUNT(*)::int n FROM inter_store_obligations WHERE COALESCE(preco_unitario,0)=0 AND status='pending' GROUP BY 1 ORDER BY 1`);
  const t = await db.query(`SELECT to_store_code dest, SUM(valor_obrigacao)::float8 pend FROM inter_store_obligations WHERE status='pending' AND to_store_code IN ('03','08','10','17','18') GROUP BY 1 ORDER BY 1`);
  console.log('pending 0<preco<6 em mai/jun (esperado 0):', a.rows[0].n);
  console.log('zeros pending restantes:'); console.table(z.rows);
  console.log('obrigações pending por franquia (novo total):');
  console.table(t.rows.map((r) => ({ dest: r.dest, pendente: fmt(r.pend) })));
  // Faturamento jul/ago das franquias agora (mov líquido) × Márcia
  const MARCIA = { '03': [34172.68, 43085.91], '08': [75078.32, 64860.41], '10': [63520.21, 44657.59], '17': [49231.83, 41569.40], '18': [39895.27, 28307.00] };
  const f = await db.query(`
    SELECT LPAD(REPLACE(UPPER(TRIM(loja)),'LJ',''),2,'0') loja, to_char(data_fec,'YYYY-MM') mes, SUM(valor_total)::float8 v
      FROM giga_caixa_mov
     WHERE data_fec >= '2026-07-01' AND data_fec < '2026-09-01' AND (marcado IS NULL OR marcado <> 'SIM')
       AND LPAD(REPLACE(UPPER(TRIM(loja)),'LJ',''),2,'0') IN ('03','08','10','17','18')
     GROUP BY 1,2 ORDER BY 1,2`);
  console.log('faturamento (caixa_mov LÍQUIDO agora) × Márcia:');
  console.table(f.rows.map((r) => {
    const i = r.mes === '2026-07' ? 0 : 1;
    return { loja: r.loja, mes: r.mes, flow: fmt(r.v), marcia: fmt(MARCIA[r.loja][i]), delta: fmt(r.v - MARCIA[r.loja][i]) };
  }));
  await db.end();
}
main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
