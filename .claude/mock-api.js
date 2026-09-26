// Mock da API do FlowOps pra preview local do FRONTEND (porta 3001, prefixo /api).
// Uso: entrada "mock-api" do .claude/launch.json. Cobre só o que a tela em
// desenvolvimento precisa — hoje: /loja/reposicao (cascata) e /site/estornos
// (senha do mock: "123").
//
// ⚠️ Rodando de dentro de um WORKTREE: o launch.json lido é o do repo
// PRINCIPAL e o caminho `.claude/mock-api.js` resolve lá. Pra previewar a tela
// de um worktree, crie uma entrada temporária apontando pro caminho ABSOLUTO
// deste arquivo (e apague depois) — foi assim que /site/estornos foi conferida.
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
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-estorno-sessao, x-training-mode');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  const json = (obj, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === '/api/etiqueta-config') return json({});

  // ── RH — espelho de ponto + atestado de HORAS (26/09/2026) ─────────────────
  // Uma funcionária, setembro/2026, jornada 09–18 (almoço 12–13) seg–sex e
  // 09–13 no sábado. Dia 21/09 (segunda) ela entrou 11:00 com atestado: é o
  // caso do "até tal hora". A prévia repete a conta do backend (interseção da
  // janela com a jornada, sem o almoço) pra tela mostrar o número real.
  const RH_JANELA = (d) => {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow === 0) return null;
    if (dow === 6) return { inicio: '09:00', fim: '13:00', almocoInicio: null, almocoFim: null };
    return { inicio: '09:00', fim: '18:00', almocoInicio: '12:00', almocoFim: '13:00' };
  };
  const rhMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const rhPrevisto = (j) => {
    if (!j) return 0;
    let t = rhMin(j.fim) - rhMin(j.inicio);
    if (j.almocoInicio && j.almocoFim) t -= Math.max(0, rhMin(j.almocoFim) - rhMin(j.almocoInicio));
    return Math.max(0, t);
  };
  const rhIso = (d, hhmm) => new Date(`${d}T${hhmm}:00-03:00`).toISOString();
  if (url.pathname === '/api/sellers') {
    return json([{ id: 's1', name: 'MARIA APARECIDA', active: true, cargo: 'VENDEDORA', responsibleStoreId: 'loja01' }]);
  }
  if (url.pathname === '/api/ponto/dia') {
    return json({ data: url.searchParams.get('data'), geradoEm: new Date().toISOString(),
      totais: { funcionarias: 0, trabalhando: 0, almoco: 0, sairam: 0, batidas: 0 }, lojas: [] });
  }
  if (url.pathname === '/api/rh/eventos/tipos') {
    return json([
      { codigo: 'ATESTADO_MEDICO', label: 'Atestado médico', grupo: 'saude', pedeDocumento: true, exigeDocumento: true, admiteParcial: true, abonaJornada: true, justificaAusencia: true, debitaBanco: false, contaComoTrabalhado: false, descontaSalario: false, descontaDSR: false, contaArt130: false, limiteDias: null, esocial: null, nota: 'Até 15 dias, pago pela empresa.' },
      { codigo: 'FOLGA', label: 'Folga (escala)', grupo: 'programado', pedeDocumento: false, exigeDocumento: false, admiteParcial: false, abonaJornada: true, justificaAusencia: true, debitaBanco: false, contaComoTrabalhado: false, descontaSalario: false, descontaDSR: false, contaArt130: false, limiteDias: null, esocial: null, nota: null },
      { codigo: 'TREINAMENTO', label: 'Treinamento', grupo: 'presente', pedeDocumento: false, exigeDocumento: false, admiteParcial: true, abonaJornada: false, justificaAusencia: true, debitaBanco: false, contaComoTrabalhado: true, descontaSalario: false, descontaDSR: false, contaArt130: false, limiteDias: null, esocial: null, nota: null },
      { codigo: 'FALTA_INJUSTIFICADA', label: 'Falta injustificada', grupo: 'ausencia', pedeDocumento: false, exigeDocumento: false, admiteParcial: false, abonaJornada: false, justificaAusencia: false, debitaBanco: false, contaComoTrabalhado: false, descontaSalario: true, descontaDSR: true, contaArt130: true, limiteDias: null, esocial: null, nota: null },
    ]);
  }
  if (url.pathname === '/api/rh/eventos/atestados-pendentes') return json([]);
  if (url.pathname === '/api/rh/eventos' && req.method === 'GET') return json([]);
  if (url.pathname === '/api/rh/eventos' && req.method === 'POST') {
    return lerCorpo(req, (body) => {
      console.log(`[mock] POST /rh/eventos ${JSON.stringify(body)}`);
      json({ ok: true, id: 'ev-mock', ...body });
    });
  }
  if (url.pathname === '/api/rh/eventos/previa') {
    const data = url.searchParams.get('data');
    const tipo = url.searchParams.get('tipo');
    const janela = RH_JANELA(data);
    const minPrevisto = rhPrevisto(janela);
    const parcialPedido = url.searchParams.get('diaInteiro') === '0';
    const hi = rhMin(url.searchParams.get('horaInicio'));
    const hf = rhMin(url.searchParams.get('horaFim'));
    const admiteParcial = ['ATESTADO_MEDICO', 'TREINAMENTO'].includes(tipo);
    const parcial = admiteParcial && parcialPedido && hi !== null && hf !== null && hf > hi;
    let afetados = minPrevisto;
    if (parcial && janela) {
      const ji = rhMin(janela.inicio), jf = rhMin(janela.fim);
      afetados = Math.max(0, Math.min(jf, hf) - Math.max(ji, hi));
      if (janela.almocoInicio) {
        const ai = rhMin(janela.almocoInicio), af = rhMin(janela.almocoFim);
        afetados -= Math.max(0, Math.min(Math.min(jf, hf), af) - Math.max(Math.max(ji, hi), ai));
      }
      afetados = Math.max(0, Math.min(minPrevisto, afetados));
    }
    const efeito = tipo === 'ATESTADO_MEDICO' || tipo === 'FOLGA' ? 'abona' : tipo === 'TREINAMENTO' ? 'credita' : 'nenhum';
    if (efeito === 'nenhum') afetados = 0;
    const dow = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'][new Date(`${data}T12:00:00Z`).getUTCDay()];
    console.log(`[mock] previa ${tipo} ${data} ${parcial ? `${url.searchParams.get('horaInicio')}-${url.searchParams.get('horaFim')}` : 'dia inteiro'} -> ${afetados}/${minPrevisto}`);
    return json({ data, diaSemana: dow, janela, folga: dow === 'DOM', semCadastro: false,
      minPrevisto, minAfetados: afetados, minRestantes: Math.max(0, minPrevisto - afetados),
      efeito, parcial, foraDaJornada: parcial && minPrevisto > 0 && efeito !== 'nenhum' && afetados === 0,
      tipo: { codigo: tipo, label: tipo, admiteParcial } });
  }
  if (url.pathname === '/api/ponto/espelho') {
    const ano = Number(url.searchParams.get('ano')) || 2026;
    const mes = Number(url.searchParams.get('mes')) || 9;
    const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
    const dias = [];
    let tT = 0, tP = 0;
    for (let d = 1; d <= ultimo; d++) {
      const data = `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const janela = RH_JANELA(data);
      const diaSemana = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'][new Date(`${data}T12:00:00Z`).getUTCDay()];
      const minPrevisto = rhPrevisto(janela);
      const passado = data <= '2026-09-25' && janela;
      const atrasada = data === '2026-09-21';
      const horas = !passado ? null
        : diaSemana === 'SAB' ? { entrada: '09:02', saida: '13:01' }
        : { entrada: atrasada ? '11:00' : '08:58', saida_almoco: '12:03', volta_almoco: '13:00', saida: '18:04' };
      const registros = horas ? Object.entries(horas).map(([tipo, h]) => ({ id: `r-${d}-${tipo}`, tipo, timestamp: rhIso(data, h), source: 'face_pdv', storeId: 'loja01', justificado: false })) : [];
      const ts = (t) => registros.find((r) => r.tipo === t)?.timestamp ?? null;
      let minTrabalhado = 0;
      if (ts('entrada') && ts('saida')) {
        minTrabalhado = (new Date(ts('saida')) - new Date(ts('entrada'))) / 60000;
        if (ts('saida_almoco') && ts('volta_almoco')) minTrabalhado -= (new Date(ts('volta_almoco')) - new Date(ts('saida_almoco'))) / 60000;
      }
      minTrabalhado = Math.round(minTrabalhado);
      tT += minTrabalhado; tP += minPrevisto;
      dias.push({ data, diaSemana, folga: !janela, entrada: ts('entrada'), saidaAlmoco: ts('saida_almoco'), voltaAlmoco: ts('volta_almoco'), saida: ts('saida'),
        minTrabalhado, minPrevisto, saldoMin: minTrabalhado - minPrevisto, batidas: registros.length, registros,
        completo: !!ts('entrada') && !!ts('saida'), justificado: false, eventos: [], minAbonado: 0, minDebitadoBanco: 0, abonado: false, faltaInjustificada: false, janela });
    }
    return json({ seller: { id: 's1', name: 'MARIA APARECIDA', cargo: 'VENDEDORA', storeId: 'loja01' }, periodo: { ano, mes },
      dias, totais: { minTrabalhado: tT, minPrevisto: tP, saldoMin: tT - tP, minAbonado: 0, minDebitadoBanco: 0 } });
  }

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

  // ── ESTORNOS E DEVOLUCOES (22/09) — /site/estornos ──
  // Senha do mock: "123". Cobre porta, busca, ficha, estorno e historico.
  if (url.pathname === '/api/admin/estornos/sessao') {
    return lerCorpo(req, (body) => {
      if (String(body.password || '') !== '123') return json({ message: 'Senha Master/Suprema invalida' }, 403);
      json({ token: 'mock-sessao', nivel: 'MASTER', minutos: 15 });
    });
  }
  if (url.pathname === '/api/admin/estornos/motivos') {
    return json({
      motivos: [
        { codigo: 'devolucao_produto', label: 'Devolucao de produto', exigeTexto: false },
        { codigo: 'cancelamento_pedido', label: 'Cancelamento do pedido', exigeTexto: false },
        { codigo: 'cobranca_duplicada', label: 'Cobranca duplicada', exigeTexto: false },
        { codigo: 'outros', label: 'Outros', exigeTexto: true },
      ],
    });
  }
  if (url.pathname === '/api/admin/estornos/buscar') {
    return json({ pagamentos: ESTORNOS_PAGAMENTOS, total: ESTORNOS_PAGAMENTOS.length });
  }
  if (url.pathname.startsWith('/api/admin/estornos/pagamento/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const p = ESTORNOS_PAGAMENTOS.find((x) => x.pagamentoId === id) || ESTORNOS_PAGAMENTOS[0];
    return json({ pagamento: p, gatewayOnline: true, statusGateway: 'PAID', historico: [] });
  }
  if (url.pathname === '/api/admin/estornos/solicitar') {
    return lerCorpo(req, (body) => {
      if (String(body.password || '') !== '123') return json({ message: 'Senha Master/Suprema invalida' }, 403);
      const p = ESTORNOS_PAGAMENTOS.find((x) => x.pagamentoId === body.pagamentoId) || ESTORNOS_PAGAMENTOS[0];
      json({
        estorno: {
          id: 'mock-est-1',
          status: body.tipo === 'integral' ? 'processado' : 'processando',
          tipo: body.tipo,
          valorCents: body.tipo === 'integral' ? p.saldoCents : body.valorCents,
          metodo: p.metodo,
          motivo: body.motivo,
          statusGateway: body.tipo === 'integral' ? 'CANCELED' : 'PAID',
          refNumero: p.refNumero,
          clienteEmail: p.clienteEmail,
          createdAt: new Date().toISOString(),
        },
        mensagem: 'ok',
      });
    });
  }
  if (url.pathname === '/api/admin/estornos/historico') {
    const linhas = [
      { id: 'h1', createdAt: new Date().toISOString(), refNumero: 'LP-001311', origem: 'site', clienteNome: 'Maria Aparecida', metodo: 'credit_card', valorCents: 18990, status: 'processado', motivo: 'devolucao_produto', usuarioNome: 'Thiago', nivelAutorizacao: 'SUPREMA' },
      { id: 'h2', createdAt: new Date(Date.now() - 864e5).toISOString(), refNumero: 'ON-000221', origem: 'pdv_online', clienteNome: 'Jussara Lima', metodo: 'pix', valorCents: 7500, status: 'processando', motivo: 'cobranca_duplicada', usuarioNome: 'Marcia', nivelAutorizacao: 'MASTER' },
      { id: 'h3', createdAt: new Date(Date.now() - 2 * 864e5).toISOString(), refNumero: 'LP-001290', origem: 'live', clienteNome: 'Rita de Cassia', metodo: 'pix', valorCents: 12000, status: 'recusado', motivo: 'outros', motivoTexto: 'cliente desistiu', usuarioNome: 'Thiago', nivelAutorizacao: 'MASTER' },
    ];
    return json({
      linhas,
      total: linhas.length,
      resumo: { quantidade: 3, totalCents: 26490, pixCents: 7500, pixQtd: 1, cartaoCents: 18990, cartaoQtd: 1, pendentes: 1, pendentesCents: 7500, erros: 1 },
    });
  }

  json({ error: 'mock: rota nao coberta ' + url.pathname }, 404);
});

/** Corpo JSON do POST — o mock nasceu só com GET. */
function lerCorpo(req, cb) {
  let bruto = '';
  req.on('data', (c) => { bruto += c; });
  req.on('end', () => {
    try { cb(JSON.parse(bruto || '{}')); } catch { cb({}); }
  });
}

const ESTORNOS_PAGAMENTOS = [
  {
    pagamentoId: 'pagbank:p1', gateway: 'pagbank', chargeId: 'CHAR_ABC123', gatewayOrderId: 'ORDE_1',
    metodo: 'credit_card', metodoLabel: 'Cartao de credito', storeCode: 'SITE',
    valorPagoCents: 18990, pagoEm: new Date(Date.now() - 3 * 864e5).toISOString(),
    estornadoCents: 0, saldoCents: 18990, pode: true, emAndamento: false,
    origem: 'site', refId: 'uuid-1', refNumero: 'LP-001311', refWcOrderId: 1311, refStatus: 'delivered',
    clienteNome: 'Maria Aparecida', clienteCpf: '123.456.789-09', clienteEmail: 'maria@exemplo.com',
    totalCents: 18990, pdvSaleId: null,
    aviso: 'O estorno devolve o dinheiro. O pedido NAO e cancelado automaticamente.',
  },
  {
    pagamentoId: 'pagbank:p2', gateway: 'pagbank', chargeId: 'CHAR_DEF456', gatewayOrderId: 'ORDE_2',
    metodo: 'pix', metodoLabel: 'PIX', storeCode: '01',
    valorPagoCents: 15000, pagoEm: new Date(Date.now() - 10 * 864e5).toISOString(),
    estornadoCents: 5000, saldoCents: 10000, pode: true, emAndamento: false,
    origem: 'pdv_online', refId: 'uuid-2', refNumero: 'ON-000221', refWcOrderId: 950000221, refStatus: 'shipped',
    clienteNome: 'Jussara Lima', clienteCpf: null, clienteEmail: 'jussara@exemplo.com',
    totalCents: 15000, pdvSaleId: 'venda-2',
    aviso: 'Venda online do PDV. O estorno devolve o dinheiro; a venda e o estoque continuam como estao.',
  },
  {
    pagamentoId: 'pagarme:p3', gateway: 'pagarme', chargeId: 'ch_old', gatewayOrderId: 'or_old',
    metodo: 'pix', metodoLabel: 'PIX', storeCode: 'SITE',
    valorPagoCents: 22000, pagoEm: new Date(Date.now() - 120 * 864e5).toISOString(),
    estornadoCents: 0, saldoCents: 22000, pode: false,
    motivoBloqueio: 'Devolucao de PIX so ate 90 dias do pagamento (este tem 120 dias). Faca por outro meio.',
    emAndamento: false,
    origem: 'live', refId: 'uuid-3', refNumero: 'LP-001290', refWcOrderId: 1290, refStatus: 'delivered',
    clienteNome: 'Rita de Cassia', clienteCpf: null, clienteEmail: null, totalCents: 22000, pdvSaleId: null,
  },
];

server.listen(3001, () => console.log('mock-api na 3001 (prefixo /api)'));
