/**
 * RELATÓRIO PRA CONTABILIDADE — vendas por vendedora, Wincred × Flow.
 *
 * Gera um .xlsx com três abas: por vendedora, por loja, e a virada de cada
 * loja pro Flow.
 *
 * ── POR QUE OS DOIS LADOS NÃO BATEM (e não é erro) ──
 *
 * 1. As franquias entraram no Flow COM JULHO EM ANDAMENTO. Antes da virada, a
 *    venda só existe no Wincred; depois, nos dois. A aba "Virada" mostra a data
 *    da primeira venda de cada loja no Flow — é o que explica a maior parte da
 *    diferença, e por isso ela vai no relatório.
 *
 * 2. O Wincred NÃO registra as trocas feitas no Flow. O Flow desconta
 *    devolução, o Wincred não. Em julho foram 276 devoluções / R$ 54.487,03.
 *
 * 3. O Flow grava em UTC. O recorte do mês usa borda de Brasília (03:00 UTC),
 *    senão venda das 21h do dia 31 cairia em agosto.
 *
 * Só faz SELECT nos dois bancos.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/relatorio-vendas-wincred-flow.js [AAAA-MM]
 */

const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const ExcelJS = require('exceljs');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const hojeBR = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const YM = process.argv[2] || hojeBR.slice(0, 7);
const [ANO, MES] = YM.split('-').map(Number);

// Bordas do mês em Brasília, expressas em UTC (que é como o Flow grava).
const INI = new Date(Date.UTC(ANO, MES - 1, 1, 3, 0, 0));
const FIM = new Date(Date.UTC(ANO, MES, 1, 3, 0, 0));
const INI_SQL = `${YM}-01`;
const FIM_SQL = `${MES === 12 ? ANO + 1 : ANO}-${String(MES === 12 ? 1 : MES + 1).padStart(2, '0')}-01`;

const norm = (s) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
const chaveLoja = (s) => String(s ?? '').replace(/\D/g, '').padStart(2, '0').slice(-2);

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST, port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER, password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });
  const pg = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await pg.connect();

  console.log(`Montando relatorio de ${YM}...`);

  // ── WINCRED: venda por vendedora e loja ─────────────────────────────────
  // MARCADO='SIM' fica de fora: e peca reservada, nao venda.
  const [wRows] = await my.query(
    `SELECT c.LOJA AS loja, c.VENDEDOR AS cod,
            COALESCE(NULLIF(TRIM(f.NOME),''), NULLIF(TRIM(f.APELIDO),'')) AS nome,
            COUNT(DISTINCT c.NUMERO) AS cupons,
            COALESCE(SUM(c.VALORTOTAL),0) AS total
       FROM caixa c
       LEFT JOIN funcionarios f
         ON CAST(f.CODIGO AS UNSIGNED) = CAST(c.VENDEDOR AS UNSIGNED)
        AND f.LOJA = c.LOJA
      WHERE c.DATA >= ? AND c.DATA < ?
        AND UPPER(COALESCE(c.MARCADO,'')) <> 'SIM'
      GROUP BY c.LOJA, c.VENDEDOR, nome`,
    [INI_SQL, FIM_SQL],
  );
  console.log(`  Wincred: ${wRows.length} combinacoes vendedora+loja`);

  // ── FLOW ────────────────────────────────────────────────────────────────
  const fRes = await pg.query(
    `SELECT s.store_code AS loja,
            COALESCE(NULLIF(TRIM(s.seller_name),''), '(sem vendedora)') AS nome,
            COUNT(*)::int AS cupons,
            COALESCE(SUM(s.total),0)::float AS total
       FROM pdv_sales s
      WHERE s.status = 'finalized' AND s.is_training = false
        AND s.finalized_at >= $1 AND s.finalized_at < $2
      GROUP BY 1, 2`,
    [INI, FIM],
  );
  console.log(`  Flow: ${fRes.rows.length} combinacoes vendedora+loja`);

  // Devolucoes do Flow (o Wincred nao tem) — por loja.
  const dRes = await pg.query(
    `SELECT store_code AS loja, COUNT(*)::int AS n, COALESCE(SUM(valor_total),0)::float AS v
       FROM pdv_returns WHERE created_at >= $1 AND created_at < $2 GROUP BY 1`,
    [INI, FIM],
  );
  const devPorLoja = new Map(dRes.rows.map((r) => [chaveLoja(r.loja), r]));

  // Primeira venda de cada loja no Flow — a "virada".
  const vRes = await pg.query(
    `SELECT store_code AS loja, MIN(finalized_at) AS primeira, COUNT(*)::int AS n
       FROM pdv_sales WHERE status = 'finalized' AND is_training = false
      GROUP BY 1 ORDER BY 2`,
  );

  // Nome das lojas.
  const lojasRes = await pg.query('SELECT code, name FROM stores');
  const nomeLoja = new Map(lojasRes.rows.map((r) => [chaveLoja(r.code), r.name]));

  // ── CRUZA por loja + nome da vendedora ──────────────────────────────────
  const mapa = new Map();
  const pega = (loja, nome) => {
    const k = `${chaveLoja(loja)}|${norm(nome)}`;
    if (!mapa.has(k)) {
      mapa.set(k, {
        loja: chaveLoja(loja), lojaNome: nomeLoja.get(chaveLoja(loja)) || '',
        vendedora: String(nome || '').trim() || '(sem vendedora)',
        wCupons: 0, wTotal: 0, fCupons: 0, fTotal: 0,
      });
    }
    return mapa.get(k);
  };
  for (const r of wRows) {
    const e = pega(r.loja, r.nome || `cod ${r.cod}`);
    e.wCupons += Number(r.cupons) || 0;
    e.wTotal += Number(r.total) || 0;
  }
  for (const r of fRes.rows) {
    const e = pega(r.loja, r.nome);
    e.fCupons += Number(r.cupons) || 0;
    e.fTotal += Number(r.total) || 0;
  }

  const linhas = Array.from(mapa.values()).sort(
    (a, b) => a.loja.localeCompare(b.loja) || b.fTotal - a.fTotal,
  );

  // ── EXCEL ───────────────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FlowOps';
  const MOEDA = '#,##0.00';

  const cabecalho = (ws, cols) => {
    ws.columns = cols;
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3E9C9' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };

  // Aba 1 — por vendedora
  const s1 = wb.addWorksheet('Por vendedora');
  cabecalho(s1, [
    { header: 'Loja', key: 'loja', width: 8 },
    { header: 'Nome da loja', key: 'lojaNome', width: 22 },
    { header: 'Vendedora', key: 'vendedora', width: 30 },
    { header: 'Cupons WINCRED', key: 'wCupons', width: 16 },
    { header: 'Vendas WINCRED', key: 'wTotal', width: 18, style: { numFmt: MOEDA } },
    { header: 'Cupons FLOW', key: 'fCupons', width: 14 },
    { header: 'Vendas FLOW', key: 'fTotal', width: 18, style: { numFmt: MOEDA } },
    { header: 'Diferença (Flow − Wincred)', key: 'dif', width: 24, style: { numFmt: MOEDA } },
    { header: 'Observação', key: 'obs', width: 40 },
  ]);
  for (const l of linhas) {
    const dif = l.fTotal - l.wTotal;
    let obs = '';
    if (l.wTotal > 0 && l.fTotal === 0) obs = 'Só no Wincred — loja ainda não estava no Flow';
    else if (l.fTotal > 0 && l.wTotal === 0) obs = 'Só no Flow — conferir cadastro da vendedora no Wincred';
    else if (Math.abs(dif) > 0.01) obs = 'Diferença — ver aba Diferenças';
    s1.addRow({ ...l, dif, obs });
  }

  // Aba 2 — por loja
  const s2 = wb.addWorksheet('Por loja');
  cabecalho(s2, [
    { header: 'Loja', key: 'loja', width: 8 },
    { header: 'Nome', key: 'nome', width: 24 },
    { header: 'Vendas WINCRED', key: 'w', width: 18, style: { numFmt: MOEDA } },
    { header: 'Vendas FLOW', key: 'f', width: 18, style: { numFmt: MOEDA } },
    { header: 'Diferença', key: 'dif', width: 16, style: { numFmt: MOEDA } },
    { header: 'Devoluções no Flow', key: 'dev', width: 20, style: { numFmt: MOEDA } },
    { header: 'Entrou no Flow em', key: 'virada', width: 20 },
  ]);
  const porLoja = new Map();
  for (const l of linhas) {
    if (!porLoja.has(l.loja)) porLoja.set(l.loja, { loja: l.loja, nome: l.lojaNome, w: 0, f: 0 });
    const e = porLoja.get(l.loja);
    e.w += l.wTotal; e.f += l.fTotal;
  }
  const viradaPorLoja = new Map(
    vRes.rows.map((r) => [chaveLoja(r.loja), new Date(new Date(r.primeira).getTime() - 3 * 3600_000)]),
  );
  let tW = 0, tF = 0, tD = 0;
  for (const e of Array.from(porLoja.values()).sort((a, b) => a.loja.localeCompare(b.loja))) {
    const dev = devPorLoja.get(e.loja);
    const virada = viradaPorLoja.get(e.loja);
    tW += e.w; tF += e.f; tD += Number(dev?.v || 0);
    s2.addRow({
      ...e, dif: e.f - e.w, dev: Number(dev?.v || 0),
      virada: virada ? virada.toISOString().slice(0, 10) : 'ainda não',
    });
  }
  const tot = s2.addRow({ loja: '', nome: 'TOTAL', w: tW, f: tF, dif: tF - tW, dev: tD, virada: '' });
  tot.font = { bold: true };

  // Aba 3 — a virada de cada loja (explica a diferença)
  const s3 = wb.addWorksheet('Virada pro Flow');
  cabecalho(s3, [
    { header: 'Loja', key: 'loja', width: 8 },
    { header: 'Nome', key: 'nome', width: 24 },
    { header: 'Primeira venda no Flow', key: 'primeira', width: 24 },
    { header: 'Dia do mês', key: 'dia', width: 12 },
    { header: 'Vendas no Flow (total histórico)', key: 'n', width: 28 },
  ]);
  for (const r of vRes.rows) {
    const k = chaveLoja(r.loja);
    const d = new Date(new Date(r.primeira).getTime() - 3 * 3600_000);
    const noMes = d.toISOString().slice(0, 7) === YM;
    s3.addRow({
      loja: k, nome: nomeLoja.get(k) || '',
      primeira: d.toISOString().replace('T', ' ').slice(0, 16),
      dia: noMes ? `dia ${d.getUTCDate()} de ${YM}` : (d < INI ? 'antes do mês' : 'depois do mês'),
      n: r.n,
    });
  }

  // Aba 4 — nota metodológica, pra contabilidade não adivinhar
  const s4 = wb.addWorksheet('Como ler');
  s4.columns = [{ width: 110 }];
  const texto = [
    `RELATÓRIO DE VENDAS POR VENDEDORA — ${YM}`,
    '',
    'Duas fontes, lado a lado: WINCRED (ERP antigo) e FLOW (sistema novo).',
    '',
    'POR QUE OS NÚMEROS DIFEREM — três motivos, todos esperados:',
    '',
    '1) AS LOJAS ENTRARAM NO FLOW COM O MÊS EM ANDAMENTO.',
    '   Antes da virada a venda existe só no Wincred. A aba "Virada pro Flow"',
    '   mostra a data da primeira venda de cada loja — vendedora com valor só na',
    '   coluna Wincred quase sempre é isso.',
    '',
    '2) O WINCRED NÃO REGISTRA AS TROCAS FEITAS NO FLOW.',
    '   O Flow desconta a devolução do vendido; o Wincred não. A coluna',
    '   "Devoluções no Flow" na aba Por loja mostra o valor.',
    '',
    '3) RECORTE DO MÊS EM HORÁRIO DE BRASÍLIA.',
    '   O Flow grava em UTC. O mês vai de 01 às 00:00 até 01 do mês seguinte às',
    '   00:00, horário de Brasília. Sem isso, venda das 21h do último dia cairia',
    '   no mês seguinte.',
    '',
    'CRITÉRIOS:',
    '  · Wincred: tabela `caixa`, excluindo MARCADO=SIM (peça reservada não é venda).',
    '  · Flow: vendas finalizadas, sem treinamento.',
    '  · O cruzamento é por LOJA + NOME da vendedora.',
    '',
    'ATENÇÃO: vendedora que aparece só em uma das colunas pode ser diferença de',
    'cadastro de nome entre os dois sistemas, não venda faltando. Vale conferir',
    'antes de concluir.',
    '',
    `Gerado em ${new Date(Date.now() - 3 * 3600_000).toISOString().replace('T', ' ').slice(0, 16)} (Brasília).`,
  ];
  texto.forEach((t, i) => {
    const r = s4.addRow([t]);
    if (i === 0) r.font = { bold: true, size: 13 };
    if (/^\d\)/.test(t) || /^(POR QUE|CRITÉRIOS|ATENÇÃO)/.test(t)) r.font = { bold: true };
  });

  const arquivo = path.join(process.cwd(), `vendas-vendedora-${YM}.xlsx`);
  await wb.xlsx.writeFile(arquivo);
  console.log('');
  console.log(`OK: ${arquivo}`);
  console.log(`  Wincred ${tW.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} · Flow ${tF.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
  console.log(`  diferenca ${(tF - tW).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} · devolucoes no Flow ${tD.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);

  await my.end();
  await pg.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
