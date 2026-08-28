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

  json({ error: 'mock: rota nao coberta ' + url.pathname }, 404);
});

server.listen(3001, () => console.log('mock-api na 3001 (prefixo /api)'));
