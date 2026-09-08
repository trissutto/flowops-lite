/** Parte 2 — devoluções × deltas de jul/ago; obrigações com preço suspeito;
 *  transferências reversas (franquia→rede); cumulativo mensal do espelho Wincred. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const norm = (col) => `LPAD(REPLACE(UPPER(TRIM(${col})),'LJ',''),2,'0')`;
  const FR = ['03', '08', '10', '17', '18'];

  // 1. Devoluções do Flow por loja × mês (jul/ago)
  const dev = await db.query(
    `SELECT ${norm('store_code')} loja, to_char(created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') mes,
            SUM(valor_total)::float8 v, COUNT(*)::int n
       FROM pdv_returns
      WHERE COALESCE(is_training,false)=false
        AND created_at >= '2026-07-01T00:00:00-03:00' AND created_at < '2026-09-01T00:00:00-03:00'
      GROUP BY 1,2 ORDER BY 1,2`);
  console.log('== pdv_returns (devoluções Flow) jul/ago por franquia ==');
  console.table(dev.rows.filter((r) => FR.includes(r.loja)).map((r) => ({ loja: r.loja, mes: r.mes, devolucoes: fmt(r.v), qtd: r.n })));

  // devoluções de agosto SÓ até dia 24 (fatia que o mov NÃO abate)
  const devAgoParcial = await db.query(
    `SELECT ${norm('store_code')} loja,
            SUM(CASE WHEN created_at < '2026-08-25T00:00:00-03:00' THEN valor_total ELSE 0 END)::float8 ate24,
            SUM(CASE WHEN created_at >= '2026-08-25T00:00:00-03:00' THEN valor_total ELSE 0 END)::float8 depois
       FROM pdv_returns
      WHERE COALESCE(is_training,false)=false
        AND created_at >= '2026-08-01T00:00:00-03:00' AND created_at < '2026-09-01T00:00:00-03:00'
      GROUP BY 1 ORDER BY 1`);
  console.log('== devoluções AGO: 01–24 × 25–31 ==');
  console.table(devAgoParcial.rows.filter((r) => FR.includes(r.loja)).map((r) => ({ loja: r.loja, ate24: fmt(r.ate24), depois25: fmt(r.depois) })));

  // 2. SJC julho dia a dia: mov × diario × pdv
  const dj = await db.query(
    `WITH mov AS (
       SELECT to_char(data_fec,'YYYY-MM-DD') d, SUM(valor_total)::float8 v
         FROM giga_caixa_mov
        WHERE ${norm('loja')}='08' AND data_fec >= '2026-07-01' AND data_fec < '2026-08-01'
          AND (marcado IS NULL OR marcado <> 'SIM') GROUP BY 1),
     dia AS (
       SELECT to_char(data,'YYYY-MM-DD') d, SUM(bruto)::float8 v FROM giga_caixa_diario
        WHERE ${norm('loja')}='08' AND data >= '2026-07-01' AND data < '2026-08-01' GROUP BY 1),
     pdv AS (
       SELECT to_char(finalized_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') d, SUM(total)::float8 v
         FROM pdv_sales
        WHERE ${norm('store_code')}='08' AND status='finalized' AND is_training=false
          AND finalized_at >= '2026-07-01T00:00:00-03:00' AND finalized_at < '2026-08-01T00:00:00-03:00' GROUP BY 1)
     SELECT COALESCE(mov.d, dia.d, pdv.d) d, mov.v mov, dia.v diario, pdv.v pdv
       FROM mov FULL JOIN dia ON dia.d = mov.d FULL JOIN pdv ON pdv.d = COALESCE(mov.d, dia.d)
      ORDER BY 1`);
  console.log('== SJC JULHO dia a dia (mov × diario × pdv) ==');
  console.table(dj.rows.map((r) => ({ d: r.d, mov: fmt(r.mov), diario: fmt(r.diario), pdv: fmt(r.pdv), mov_menos_diario: fmt((r.mov || 0) - (r.diario || 0)) })));

  // 3. Obrigações: distribuição do preço unitário por mês (bug ÷100?)
  const ob = await db.query(
    `SELECT mes_referencia mes, COUNT(*)::int itens,
            MIN(preco_unitario)::float8 mn, ROUND(AVG(preco_unitario)::numeric,2)::float8 avg, MAX(preco_unitario)::float8 mx,
            SUM(CASE WHEN preco_unitario < 5 THEN 1 ELSE 0 END)::int abaixo5
       FROM inter_store_obligations GROUP BY 1 ORDER BY 1`);
  console.log('== obrigações: preco_unitario por mês ==');
  console.table(ob.rows);
  const obex = await db.query(
    `SELECT mes_referencia mes, ref_code, qty, preco_unitario, preco_total, valor_obrigacao, to_store_code dest
       FROM inter_store_obligations WHERE preco_unitario < 5 ORDER BY mes_referencia LIMIT 12`);
  console.log('== exemplos preco_unitario < R$ 5 ==');
  console.table(obex.rows);

  // 4. Reversas: franquia → rede no espelho Wincred (devolução de mercadoria)
  const rev = await db.query(
    `SELECT ${norm('lj_origem')} origem, to_char(date_trunc('month', data),'YYYY-MM') mes,
            SUM(total_preco)::float8 etiqueta, SUM(qty)::int pecas
       FROM giga_transferencia_item
      WHERE ${norm('lj_origem')} = ANY($1) AND NOT (${norm('lj_destino')} = ANY($1))
        AND data >= '2026-01-01'
      GROUP BY 1,2 ORDER BY 1,2`, [FR]);
  console.log('== espelho Wincred: FRANQUIA → REDE (mercadoria devolvida) 2026 ==');
  console.table(rev.rows.map((r) => ({ origem: r.origem, mes: r.mes, etiqueta: fmt(r.etiqueta), pecas: r.pecas })));

  // 5. Cumulativo mensal REDE→FRANQUIA no espelho Wincred (pra achar a janela dela)
  const cum = await db.query(
    `SELECT ${norm('lj_destino')} dest, to_char(date_trunc('month', data),'YYYY-MM') mes, SUM(total_preco)::float8 etiqueta
       FROM giga_transferencia_item
      WHERE ${norm('lj_destino')} = ANY($1) AND NOT (${norm('lj_origem')} = ANY($1))
      GROUP BY 1,2 ORDER BY 1,2`, [FR]);
  console.log('== espelho Wincred: REDE→FRANQUIA etiqueta por mês (histórico completo) ==');
  const porDest = {};
  for (const r of cum.rows) { (porDest[r.dest] = porDest[r.dest] || []).push([r.mes, Number(r.etiqueta)]); }
  for (const [dest, arr] of Object.entries(porDest)) {
    console.log(`\n-- destino ${dest} --`);
    console.table(arr.map(([mes, v]) => ({ mes, etiqueta: fmt(v), div25: fmt(v / 2.5) })));
    const tot = arr.reduce((s, [, v]) => s + v, 0);
    console.log(`total ${dest}: etiqueta=${fmt(tot)} ÷2,5=${fmt(tot / 2.5)}`);
  }

  // 6. Primeira/última venda no PDV Flow por franquia (quando cada uma migrou)
  const first = await db.query(
    `SELECT ${norm('store_code')} loja,
            MIN(finalized_at AT TIME ZONE 'America/Sao_Paulo') primeira,
            MAX(finalized_at AT TIME ZONE 'America/Sao_Paulo') ultima, COUNT(*)::int vendas
       FROM pdv_sales WHERE status='finalized' AND is_training=false GROUP BY 1 ORDER BY 1`);
  console.log('\n== primeira venda no PDV Flow por loja ==');
  console.table(first.rows.filter((r) => FR.includes(r.loja)));

  await db.end();
}
main().catch((e) => { console.error('ERRO:', e && (e.stack || e.message)); process.exit(1); });
