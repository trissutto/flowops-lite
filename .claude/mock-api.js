// Mock da API do FlowOps pra preview local do FRONTEND (porta 3001, prefixo /api).
// Uso: entrada "mock-api" do .claude/launch.json. Cobre só o que a tela em
// desenvolvimento precisa — hoje: /loja/reposicao (cascata).
const http = require('http');

const GRADE = (de, ate) => { const t = []; for (let x = de; x <= ate; x += 2) t.push(String(x)); return t; };
let seq = 5000000;
const sku = () => String(seq++);

const PRODUTOS = [];
const add = (ref, descricao, cor, tamanhos, preco) => {
  for (const t of tamanhos) PRODUTOS.push({ codigo: sku(), ref, cor, tamanho: t, preco, descricao });
};
add('BMM-100', 'BLUSA FEMININA PLUS SIZE MANGA CURTA BMM-100 MARRIE', 'EST OFF WHITE', GRADE(46, 60), 89.9);
add('BMM-100', 'BLUSA FEMININA PLUS SIZE MANGA CURTA BMM-100 MARRIE', 'EST ROSA', GRADE(44, 60), 99.9);
add('BMM-100', 'BLUSA FEMININA PLUS SIZE MANGA CURTA BMM-100 MARRIE', 'MANTEIGA', GRADE(46, 52), 69.9);
add('BMM-100', 'BLUSA FEMININA PLUS SIZE MANGA CURTA BMM-100 MARRIE', 'PISTACHE', ['P', 'M', 'G', 'GG'], 69.9);
add('VLM-222', 'VESTIDO LONGO MANGA CURTA PLUS SIZE VLM-222 MARRIE', 'LARANJA', GRADE(46, 54), 139.9);
add('VLM-222', 'VESTIDO LONGO MANGA CURTA PLUS SIZE VLM-222 MARRIE', 'VINHO', GRADE(46, 54), 139.9);

const norm = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  const json = (obj, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === '/api/etiqueta-config') return json({});

  if (url.pathname === '/api/purchase-orders/reposicao/buscar') {
    const q = norm(url.searchParams.get('q'));
    const out = PRODUTOS.filter((p) => norm(p.ref).includes(q) || norm(p.descricao).includes(q));
    console.log(`[mock] buscar q="${url.searchParams.get('q')}" -> ${out.length}`);
    return json(out);
  }

  if (url.pathname === '/api/purchase-orders/reposicao/confirmar' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { items = [], apenasEtiqueta } = JSON.parse(body || '{}');
      const labels = [];
      for (const i of items) {
        for (let n = 0; n < (i.qty || 0); n++) {
          labels.push({ ref: i.ref, cor: i.cor, tamanho: i.tamanho, codigo: i.codigo, preco: i.preco, marca: 'MARRIE', descricao: i.descricao });
        }
      }
      console.log(`[mock] confirmar apenasEtiqueta=${!!apenasEtiqueta} items=${items.length} labels=${labels.length}`);
      json({ ok: true, total: labels.length, labels });
    });
    return;
  }

  // ── PDV mínimo pro header renderizar (metas, 29/08) ────────────────────────
  if (url.pathname === '/api/stores') {
    return json([
      { code: '01', name: 'SANTOS', active: true },
      { code: '06', name: 'SOROCABA', active: true },
      { code: '07', name: 'PRAIA GRANDE', active: true },
      { code: '11', name: 'ITANHAEM', active: true },
      { code: '13', name: 'SITE', active: true },
    ]);
  }
  if (url.pathname === '/api/auth/me') return json({ role: 'store', storeCode: '01', name: 'Loja Santos' });
  if (url.pathname === '/api/pdv/discount-policy') return json({ freeUpToPct: 5, caixaUpToPct: 10 });
  if (url.pathname === '/api/pdv/convenio/ativo') return json(null);
  if (url.pathname === '/api/pick-orders/mine') return json([]);
  if (url.pathname === '/api/realignment/mine') return json([]);
  if (url.pathname === '/api/pdv/cobrancas-online') return json([]);
  if (url.pathname === '/api/pdv/carrinhos-abandonados') return json([]);
  if (url.pathname === '/api/pdv/sales' && req.method === 'GET') return json([]);

  // ── Metas (gamificação) — números reais da loja 01 em 29/08/2026 ──────────
  if (url.pathname === '/api/pdv/metas') {
    const metaMes = 192595.57, diasUteis = 26; // seg–sáb de ago/2026
    const metaV = metaMes / 10, metaDiaV = metaV / diasUteis;
    const v = (nome, mes, hoje, extra) => ({
      nome, apelido: null, metaMes: metaV, metaDia: metaDiaV,
      realizadoMes: mes, realizadoHoje: hoje,
      pctMes: Math.round((mes / metaV) * 1000) / 10,
      pctHoje: Math.round((hoje / metaDiaV) * 1000) / 10,
      naWhitelist: extra ? false : true,
    });
    return json({
      mesLabel: 'Agosto de 2026', mesRefLabel: 'Agosto de 2025',
      diasUteisMes: diasUteis,
      diaDoMes: 29, diasNoMes: 31,
      loja: {
        storeCode: '01', storeName: 'SANTOS',
        metaMes, metaDia: metaMes / diasUteis,
        realizadoMes: 149850.44, realizadoHoje: 5095.25,
        pctMes: 77.8, pctHoje: 71.4,
        faltaMes: metaMes - 149850.44, projecaoMes: (149850.44 / 29) * 31,
        semBase: false,
      },
      vendedoras: [
        v('JOELMA', 36958.66, 1804.15),
        v('LETICIA', 18209.66, 163.9),
        v('MARIANA', 16792.95, 2165.35),
        v('ELAINE', 14391.42, 691.95),
        v('MARIA', 13993.49, 269.9),
        v('ZORANTE', 8473.66, 0),
        v('GERENTE REGIONAL', 5000, 0, true),
        v('MAYARA', 159.8, 0),
        v('CAMILA', 0, 0),
        v('THIAGO', 0, 0),
      ],
      atualizadoEm: new Date().toISOString(),
    });
  }
  if (url.pathname === '/api/pdv/metas/ranking') {
    // Participação nas vendas globais da rede (soma = 100)
    const L = (code, name, pct, posicao, minha) => ({
      storeCode: code, storeName: name, pct, posicao, minha: !!minha,
    });
    return json({
      periodo: { from: '2026-07-31', to: '2026-08-29' },
      lojas: [
        L('07', 'PRAIA GRANDE', 18.6, 1),
        L('01', 'SANTOS', 16.2, 2, true),
        L('06', 'SOROCABA', 14.8, 3),
        L('11', 'ITANHAEM', 12.4, 4),
        L('13', 'SITE', 11.1, 5),
        L('08', 'INDAIATUBA', 10.3, 6),
        L('05', 'CAMPINAS', 9.2, 7),
        L('17', 'LOJA NOVA', 7.4, 8),
      ],
      atualizadoEm: new Date().toISOString(),
    });
  }

  // ── Transferências REDE × FRANQUIA (02/09) ────────────────────────────────
  if (url.pathname === '/api/transferencias/rede-franquia') {
    const f = (pecas, valorTotal, shipments) => ({ pecas, valorTotal, valorCusto: Math.round((valorTotal / 2.5) * 100) / 100, shipments });
    return json({
      period: { from: url.searchParams.get('from') || '2026-06-04', to: url.searchParams.get('to') || '2026-09-02' },
      divisor: 2.5,
      flows: {
        redeToFilial: f(6500, 1024956.1, 193),
        filialToRede: f(367, 69946.18, 133),
        redeToRede: f(15324, 2384922.86, 946),
        filialToFilial: f(259, 53196.29, 155),
      },
      totals: f(22450, 3533021.43, 1427),
      pairs: [],
      meta: { ordersWithoutPrice: 28, ordersTotal: 22466 },
    });
  }
  if (url.pathname === '/api/transferencias/estoque-lojas') {
    // Números reais da validação em produção (02/09)
    const L = (code, name, tipo, pecas, valorVenda, pecasSemPreco = 0) => ({
      code, name, tipo, pecas, valorVenda, valorCusto: Math.round((valorVenda / 2.5) * 100) / 100, pecasSemPreco,
    });
    const lojas = [
      L('01', 'SANTOS', 'REDE', 89379, 6584156.59, 7462),
      L('06', 'SOROCABA', 'REDE', 14457, 2669793.14, 13),
      L('07', 'PRAIA GRANDE', 'REDE', 12837, 2242613.69, 3),
      L('11', 'ITANHAEM', 'REDE', 11026, 2013216.32, 6),
      L('15', 'CAMPINAS', 'FILIAL', 9912, 1752025.1, 3),
      L('05', 'INDAIATUBA', 'FILIAL', 9699, 1719945.0, 1),
      L('14', 'PIRACICABA', 'REDE', 9779, 1712104.9, 7),
      L('13', 'SITE', 'REDE', 52, 6844.8, 0),
    ];
    const soma = (list) => {
      const pecas = list.reduce((s, l) => s + l.pecas, 0);
      const valorVenda = Math.round(list.reduce((s, l) => s + l.valorVenda, 0) * 100) / 100;
      return { pecas, valorVenda, valorCusto: Math.round((valorVenda / 2.5) * 100) / 100, pecasSemPreco: list.reduce((s, l) => s + l.pecasSemPreco, 0), lojas: list.length };
    };
    return json({
      divisor: 2.5,
      lojas,
      porTipo: { rede: soma(lojas.filter((l) => l.tipo === 'REDE')), franquia: soma(lojas.filter((l) => l.tipo === 'FILIAL')) },
      totais: soma(lojas),
    });
  }

  json({ error: 'mock: rota nao coberta ' + url.pathname }, 404);
});

server.listen(3001, () => console.log('mock-api na 3001 (prefixo /api)'));
