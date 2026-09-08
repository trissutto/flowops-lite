/**
 * DIAGNÓSTICO — relatórios da Márcia (investidora das franquias) × Flow.
 * Lê produção (read-only). Compara:
 *  1. Venda mensal jan–ago/2026 por franquia: caixa_mov (régua oficial do
 *     Faturamento) × caixa_diario (portal franquias/royalties) × pdv_sales
 *     (Flow puro) × números dos relatórios dela.
 *  2. Agosto quebrado em 01–23 × 24–31 (hipótese: fonte dela morreu com o Giga 24/08).
 *  3. Compras rede→franquia: giga_transferencia_item (lado Wincred) ×
 *     transfer_orders/realignment (Flow, snapshot × preço atual) ×
 *     inter_store_obligations (÷2,5) — janelas do demonstrativo dela.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

const MARCIA = {
  SUZANO:  { '2026-01': 41420.55, '2026-02': 30340.93, '2026-03': 59605.44, '2026-04': 47262.28, '2026-05': 73515.26, '2026-06': 61455.24, '2026-07': 49231.83, '2026-08': 41569.40 },
  ANALIA:  { '2026-06': 40715.67, '2026-07': 39895.27, '2026-08': 28307.00 },
  VINHEDO: { '2026-01': 34152.10, '2026-02': 35307.53, '2026-03': 49126.24, '2026-04': 40977.62, '2026-05': 41706.49, '2026-06': 40983.89, '2026-07': 34172.68, '2026-08': 43085.91 },
  JUNDIAI: { '2026-01': 51473.96, '2026-02': 51884.65, '2026-03': 54832.94, '2026-04': 75716.31, '2026-05': 93408.58, '2026-06': 61855.51, '2026-07': 63520.21, '2026-08': 44657.59 },
  SJC:     { '2026-01': 73158.61, '2026-02': 54344.95, '2026-03': 90121.98, '2026-04': 81548.46, '2026-05': 96974.31, '2026-06': 88708.83, '2026-07': 75078.32, '2026-08': 64860.41 },
};
const MARCIA_COMPRAS = {
  // demonstrativo "01/06 a 20/06" (ano não informado no papel)
  WICRED:   { SJC: 217246.40, VINHEDO: 204403.84, JUNDIAI: 196849.12, SUZANO: 147122.76, ANALIA: 160342.68 },
  LURDSNET: { SJC: 260089.36, VINHEDO: 167551.98, JUNDIAI: 192132.06, SUZANO: 172806.36, ANALIA: 200312.18 },
  ORDER_ONE_TOTAL: 293195.86, // 21/06 a 01/08
};

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  // ── 1. Lojas: mapa code→apelido ─────────────────────────────────────────
  const lojas = await db.query(`SELECT code, name, tipo, active FROM stores ORDER BY code`);
  console.log('== LOJAS ==');
  console.table(lojas.rows);

  const apelido = (nm) => {
    const n = String(nm || '').toUpperCase();
    if (n.includes('SUZANO')) return 'SUZANO';
    if (n.includes('AN') && n.includes('LIA')) return 'ANALIA'; // Anália
    if (n.includes('VINHEDO')) return 'VINHEDO';
    if (n.includes('JUNDIA')) return 'JUNDIAI';
    if (n.includes('JOS') || n.includes('SJC')) return 'SJC';
    return null;
  };
  const codeToApelido = new Map();
  const apelidoToCodes = new Map();
  for (const r of lojas.rows) {
    const a = apelido(r.name);
    if (a) {
      codeToApelido.set(String(r.code).trim(), a);
      const arr = apelidoToCodes.get(a) || [];
      arr.push(String(r.code).trim());
      apelidoToCodes.set(a, arr);
    }
  }
  console.log('mapa apelido→codes:', Object.fromEntries(apelidoToCodes));

  const normLojaSql = (col) => `LPAD(REPLACE(UPPER(TRIM(${col})),'LJ',''),2,'0')`;

  // ── 2. Venda mensal jan–ago/2026, 3 réguas ──────────────────────────────
  const cxMov = await db.query(
    `SELECT ${normLojaSql('loja')} loja, to_char(data_fec,'YYYY-MM') mes, SUM(valor_total)::float8 v
       FROM giga_caixa_mov
      WHERE data_fec >= '2026-01-01' AND data_fec < '2026-09-01'
        AND (marcado IS NULL OR marcado <> 'SIM')
      GROUP BY 1,2`);
  const cxDia = await db.query(
    `SELECT ${normLojaSql('loja')} loja, to_char(data,'YYYY-MM') mes, SUM(bruto)::float8 v
       FROM giga_caixa_diario
      WHERE data >= '2026-01-01' AND data < '2026-09-01'
      GROUP BY 1,2`);
  const pdv = await db.query(
    `SELECT ${normLojaSql('store_code')} loja,
            to_char(finalized_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') mes,
            SUM(total)::float8 v
       FROM pdv_sales
      WHERE status='finalized' AND is_training=false
        AND finalized_at >= '2026-01-01T00:00:00-03:00' AND finalized_at < '2026-09-01T00:00:00-03:00'
      GROUP BY 1,2`);

  const pick = (rows, ap) => {
    const codes = new Set((apelidoToCodes.get(ap) || []).map((c) => c.padStart(2, '0')));
    const out = {};
    for (const r of rows) if (codes.has(r.loja)) out[r.mes] = (out[r.mes] || 0) + Number(r.v);
    return out;
  };

  for (const ap of Object.keys(MARCIA)) {
    const m1 = pick(cxMov.rows, ap), m2 = pick(cxDia.rows, ap), m3 = pick(pdv.rows, ap);
    const meses = Object.keys(MARCIA[ap]);
    console.log(`\n== VENDA ${ap} (Márcia × caixa_mov × caixa_diario × pdv_sales) ==`);
    const tbl = meses.map((mes) => {
      const dela = MARCIA[ap][mes];
      return {
        mes,
        marcia: fmt(dela),
        caixa_mov: fmt(m1[mes]),
        d_mov: m1[mes] != null ? fmt(m1[mes] - dela) : '—',
        caixa_diario: fmt(m2[mes]),
        d_dia: m2[mes] != null ? fmt(m2[mes] - dela) : '—',
        pdv_sales: fmt(m3[mes]),
        d_pdv: m3[mes] != null ? fmt(m3[mes] - dela) : '—',
      };
    });
    console.table(tbl);
    const sum = (o) => meses.reduce((s, m) => s + (o[m] || 0), 0);
    console.log(`TOTAIS ${ap}: marcia=${fmt(meses.reduce((s, m) => s + MARCIA[ap][m], 0))} mov=${fmt(sum(m1))} diario=${fmt(sum(m2))} pdv=${fmt(sum(m3))}`);
  }

  // ── 3. Agosto 01–23 × 24–31 ─────────────────────────────────────────────
  const ago = await db.query(
    `SELECT ${normLojaSql('loja')} loja,
            SUM(CASE WHEN data_fec < '2026-08-24' THEN valor_total ELSE 0 END)::float8 a01_23,
            SUM(CASE WHEN data_fec >= '2026-08-24' THEN valor_total ELSE 0 END)::float8 a24_31
       FROM giga_caixa_mov
      WHERE data_fec >= '2026-08-01' AND data_fec < '2026-09-01'
        AND (marcado IS NULL OR marcado <> 'SIM')
      GROUP BY 1 ORDER BY 1`);
  console.log('\n== AGOSTO por loja: 01–23 × 24–31 (caixa_mov) ==');
  console.table(ago.rows.filter((r) => codeToApelido.has(r.loja) || codeToApelido.has(String(Number(r.loja)))).map((r) => ({
    loja: r.loja, apelido: codeToApelido.get(r.loja) || codeToApelido.get(String(Number(r.loja))),
    a01_23: fmt(r.a01_23), a24_31: fmt(r.a24_31),
    marcia_ago: fmt((MARCIA[codeToApelido.get(r.loja) || codeToApelido.get(String(Number(r.loja)))] || {})['2026-08']),
  })));

  // ── 4. COMPRAS rede→franquia ────────────────────────────────────────────
  // 4a. Espelho Wincred: giga_transferencia_item por destino (janelas candidatas)
  const janelas = [
    ['2025-06-01', '2026-06-21', 'jun25→20jun26'],
    ['2026-01-01', '2026-06-21', 'jan26→20jun26'],
    ['2026-06-01', '2026-06-21', '01–20jun26'],
    ['2026-06-21', '2026-08-02', '21jun–01ago26'],
  ];
  for (const [d1, d2, label] of janelas) {
    const t = await db.query(
      `SELECT ${normLojaSql('lj_destino')} dest, SUM(total_preco)::float8 total, SUM(qty)::int pecas
         FROM giga_transferencia_item
        WHERE data >= $1 AND data < $2
        GROUP BY 1 ORDER BY 2 DESC`, [d1, d2]);
    const rows = t.rows.filter((r) => codeToApelido.has(r.dest)).map((r) => ({
      dest: r.dest, apelido: codeToApelido.get(r.dest), pecas: r.pecas,
      total_preco: fmt(r.total), div25: fmt(r.total / 2.5),
      wicred_dela: fmt(MARCIA_COMPRAS.WICRED[codeToApelido.get(r.dest)]),
      lurdsnet_dela: fmt(MARCIA_COMPRAS.LURDSNET[codeToApelido.get(r.dest)]),
    }));
    console.log(`\n== giga_transferencia_item → franquias [${label}] ==`);
    console.table(rows);
  }

  // 4b. Flow: transfer_orders de remessas rede→franquia — snapshot × preço atual
  for (const [d1, d2, label] of janelas) {
    const t = await db.query(
      `SELECT ${normLojaSql('s.to_store_code')} dest,
              SUM(o.qty_origem)::int pecas,
              SUM(o.qty_origem * COALESCE(o.preco_unit_cents,0))::float8/100 v_snapshot,
              SUM(CASE WHEN o.preco_unit_cents IS NULL OR o.preco_unit_cents=0 THEN o.qty_origem ELSE 0 END)::int pecas_sem_snap,
              SUM(o.qty_origem * COALESCE(w."vendaUn",0))::float8 v_atual,
              SUM(CASE WHEN COALESCE(w."vendaUn",0)=0 THEN o.qty_origem ELSE 0 END)::int pecas_sem_preco_atual
         FROM transfer_orders o
         JOIN realignment_shipments s ON s.id = o.shipment_id
         LEFT JOIN wincred_produtos w ON ltrim(w.codigo,'0') = ltrim(COALESCE(o.codigo_bipado,''),'0')
        WHERE s.opened_at >= $1 AND s.opened_at < $2
          AND s.status <> 'cancelled'
          AND COALESCE(o.realignment_status,'') <> 'cancelled'
          AND s.order_id IS NULL
        GROUP BY 1 ORDER BY 3 DESC`, [d1, d2]);
    const rows = t.rows.filter((r) => codeToApelido.has(r.dest)).map((r) => ({
      dest: r.dest, apelido: codeToApelido.get(r.dest), pecas: r.pecas,
      v_snapshot: fmt(r.v_snapshot), snap_div25: fmt(r.v_snapshot / 2.5),
      v_atual: fmt(r.v_atual), atual_div25: fmt(r.v_atual / 2.5),
      sem_snap: r.pecas_sem_snap, sem_preco: r.pecas_sem_preco_atual,
    }));
    console.log(`\n== transfer_orders (Flow) rede→franquia [${label}] (opened_at) ==`);
    console.table(rows);
  }

  // 4c. Obrigações intercompany por franquia devedora × mês
  const ob = await db.query(
    `SELECT to_store_code dest, mes_referencia mes, status,
            SUM(preco_total)::float8 preco_total, SUM(valor_obrigacao)::float8 obrigacao, COUNT(*)::int itens
       FROM inter_store_obligations
      GROUP BY 1,2,3 ORDER BY 1,2,3`);
  const obRows = ob.rows.filter((r) => codeToApelido.has(String(r.dest).trim().padStart(2, '0')));
  console.log('\n== inter_store_obligations (franquia deve à rede) ==');
  console.table(obRows.map((r) => ({
    dest: r.dest, apelido: codeToApelido.get(String(r.dest).trim().padStart(2, '0')),
    mes: r.mes, status: r.status, itens: r.itens, preco_total: fmt(r.preco_total), obrigacao: fmt(r.obrigacao),
  })));
  const porAp = new Map();
  for (const r of obRows) {
    const a = codeToApelido.get(String(r.dest).trim().padStart(2, '0'));
    porAp.set(a, (porAp.get(a) || 0) + Number(r.obrigacao));
  }
  console.log('TOTAL obrigações por franquia (todas as datas/status):',
    Object.fromEntries(Array.from(porAp.entries()).map(([k, v]) => [k, fmt(v)])));

  await db.end();
}
main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
