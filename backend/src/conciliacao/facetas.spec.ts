import { facetarConciliacoes, filtrarLinhas, LinhaResumo, periodoDosFiltros } from './facetas';

const l = (status: string, gateway: string, origem: string | null, storeCode: string | null, reais: number): LinhaResumo => ({
  status, gateway, origem, storeCode, cents: Math.round(reais * 100),
});

// Itanhaém (01): 3 pagbank (2 crediário conciliados + 1 loja divergente) e 1 pagarme link.
// Site: 2 pagamentos, um deles divergente. Santos (02): 1 loja.
const LINHAS: LinhaResumo[] = [
  l('CONCILIADO', 'PAGBANK', 'crediario', '01', 317),
  l('CONCILIADO', 'PAGBANK', 'crediario', '01', 233),
  l('DIVERGENTE', 'PAGBANK', 'loja', '01', 100),
  l('CONCILIADO', 'PAGARME', 'link', '01', 500),
  l('CONCILIADO', 'PAGARME', 'site', 'SITE', 275.61),
  l('DIVERGENTE', 'PAGBANK', 'site', 'SITE', 1137.41),
  l('CONCILIADO', 'PAGBANK', 'loja', '02', 59.9),
  l('NAO_ENCONTRADO', 'PAGBANK', null, '02', 88),
];

const qtd = (lista: Array<{ qtd: number }>, chave: string, campo: string) =>
  (lista as any[]).find((x) => x[campo] === chave)?.qtd ?? 0;

describe('facetarConciliacoes — os números de cima obedecem os filtros', () => {
  it('sem filtro é o total da rede', () => {
    const r = facetarConciliacoes(LINHAS, {});
    expect(r.total).toEqual({ qtd: 8, cents: 271092 });
    expect(r.conciliacoes).toEqual([
      { status: 'CONCILIADO', qtd: 5 },
      { status: 'DIVERGENTE', qtd: 2 },
      { status: 'NAO_ENCONTRADO', qtd: 1 },
    ]);
    expect(r.lojas).toEqual([
      { storeCode: '01', qtd: 4 },
      { storeCode: '02', qtd: 2 },
      { storeCode: 'SITE', qtd: 2 },
    ]);
  });

  it('o caso do dono: filtrou ITANHAÉM → cartões, gateways e origens viram de Itanhaém', () => {
    const r = facetarConciliacoes(LINHAS, { storeCode: '01' });
    expect(r.total).toEqual({ qtd: 4, cents: 115000 });
    expect(r.conciliacoes).toEqual([
      { status: 'CONCILIADO', qtd: 3 },
      { status: 'DIVERGENTE', qtd: 1 },
    ]);
    expect(r.gateways).toEqual([
      { gateway: 'PAGARME', qtd: 1, cents: 50000 },
      { gateway: 'PAGBANK', qtd: 3, cents: 65000 },
    ]);
    expect(r.origens).toEqual([
      { origem: 'crediario', qtd: 2, cents: 55000 },
      { origem: 'link', qtd: 1, cents: 50000 },
      { origem: 'loja', qtd: 1, cents: 10000 },
    ]);
  });

  it('cada grupo ignora o PRÓPRIO filtro — senão o cartão clicado apagaria os outros', () => {
    const r = facetarConciliacoes(LINHAS, { storeCode: '01', gateway: 'PAGBANK' });
    // gateways continua mostrando o PAGARME de Itanhaém (dá pra trocar num clique)…
    expect(qtd(r.gateways, 'PAGARME', 'gateway')).toBe(1);
    expect(qtd(r.gateways, 'PAGBANK', 'gateway')).toBe(3);
    // …as lojas contam dentro do PAGBANK (o filtro de loja é o delas, fica de fora)…
    expect(r.lojas).toEqual([
      { storeCode: '01', qtd: 3 },
      { storeCode: '02', qtd: 2 },
      { storeCode: 'SITE', qtd: 1 },
    ]);
    // …e status/origem/total respeitam os DOIS filtros.
    expect(r.conciliacoes).toEqual([
      { status: 'CONCILIADO', qtd: 2 },
      { status: 'DIVERGENTE', qtd: 1 },
    ]);
    expect(r.origens.map((o) => o.origem)).toEqual(['crediario', 'loja']);
    expect(r.total).toEqual({ qtd: 3, cents: 65000 });
  });

  it('status clicado filtra gateways, origens e lojas — "onde estão os divergentes?"', () => {
    const r = facetarConciliacoes(LINHAS, { status: 'DIVERGENTE' });
    expect(r.lojas).toEqual([
      { storeCode: '01', qtd: 1 },
      { storeCode: 'SITE', qtd: 1 },
    ]);
    expect(r.origens).toEqual([
      { origem: 'loja', qtd: 1, cents: 10000 },
      { origem: 'site', qtd: 1, cents: 113741 },
    ]);
    // os cartões seguem mostrando os outros status
    expect(qtd(r.conciliacoes, 'CONCILIADO', 'status')).toBe(5);
    expect(r.total.qtd).toBe(2);
  });

  it('o código SITE (dinheiro do checkout, fora do cadastro de lojas) é loja como outra qualquer', () => {
    const r = facetarConciliacoes(LINHAS, { storeCode: 'SITE' });
    expect(r.total).toEqual({ qtd: 2, cents: 141302 });
    expect(r.origens).toEqual([{ origem: 'site', qtd: 2, cents: 141302 }]);
  });

  it('pagamento sem dono não tem origem — não vira um chip vazio', () => {
    const r = facetarConciliacoes(LINHAS, { storeCode: '02' });
    expect(r.origens).toEqual([{ origem: 'loja', qtd: 1, cents: 5990 }]);
    expect(r.total.qtd).toBe(2);
  });

  it('filtro vazio, nulo ou só com espaço não filtra nada', () => {
    const tudo = facetarConciliacoes(LINHAS, {});
    expect(facetarConciliacoes(LINHAS, { status: '', gateway: null, origem: '  ', storeCode: undefined })).toEqual(tudo);
  });

  it('recorte que não existe dá zero, sem quebrar', () => {
    const r = facetarConciliacoes(LINHAS, { storeCode: '99' });
    expect(r.total).toEqual({ qtd: 0, cents: 0 });
    expect(r.conciliacoes).toEqual([]);
    // as lojas continuam listadas: é por elas que se sai do filtro
    expect(r.lojas.length).toBe(3);
  });
});

describe('filtro por DATA (dono, 21/09: "acrescente filtro por data")', () => {
  const d = (dia: string | null, storeCode: string, reais: number, status = 'CONCILIADO'): LinhaResumo => ({
    status, gateway: 'PAGBANK', origem: 'loja', storeCode, cents: Math.round(reais * 100), dia,
  });
  const DIAS: LinhaResumo[] = [
    d('2026-09-18', '01', 10),
    d('2026-09-19', '01', 20),
    d('2026-09-19', '02', 30, 'DIVERGENTE'),
    d('2026-09-20', '01', 40),
    d('2026-09-21', '02', 50),
    d(null, '01', 999), // transação sem data de venda
  ];

  it('De e Até são INCLUSOS', () => {
    const r = facetarConciliacoes(DIAS, { from: '2026-09-19', to: '2026-09-20' });
    expect(r.total).toEqual({ qtd: 3, cents: 9000 });
  });

  it('um dia só (atalhos Hoje e Ontem): from = to', () => {
    expect(facetarConciliacoes(DIAS, { from: '2026-09-19', to: '2026-09-19' }).total).toEqual({ qtd: 2, cents: 5000 });
  });

  it('só De, ou só Até, deixa o outro lado aberto', () => {
    expect(facetarConciliacoes(DIAS, { from: '2026-09-20' }).total.qtd).toBe(2);
    expect(facetarConciliacoes(DIAS, { to: '2026-09-18' }).total.qtd).toBe(1);
  });

  it('o período recorta TODOS os grupos de cima — cartões, gateways, origens e lojas', () => {
    const r = facetarConciliacoes(DIAS, { from: '2026-09-19', to: '2026-09-19' });
    expect(r.conciliacoes).toEqual([{ status: 'CONCILIADO', qtd: 1 }, { status: 'DIVERGENTE', qtd: 1 }]);
    expect(r.gateways).toEqual([{ gateway: 'PAGBANK', qtd: 2, cents: 5000 }]);
    expect(r.lojas).toEqual([{ storeCode: '01', qtd: 1 }, { storeCode: '02', qtd: 1 }]);
  });

  it('combina com os outros filtros: Itanhaém no dia 19', () => {
    const r = facetarConciliacoes(DIAS, { storeCode: '01', from: '2026-09-19', to: '2026-09-19' });
    expect(r.total).toEqual({ qtd: 1, cents: 2000 });
    // o seletor de loja segue mostrando a 02 DAQUELE dia (o filtro de loja é o dele; o período vale sempre)
    expect(r.lojas).toEqual([{ storeCode: '01', qtd: 1 }, { storeCode: '02', qtd: 1 }]);
  });

  it('linha sem data de venda não entra em período nenhum — mas entra sem filtro de data', () => {
    expect(facetarConciliacoes(DIAS, {}).total.qtd).toBe(6);
    expect(facetarConciliacoes(DIAS, { from: '2000-01-01', to: '2099-12-31' }).total.qtd).toBe(5);
  });

  it('data torta do input (ano parcial enquanto digita) é ignorada em vez de zerar a tela', () => {
    expect(periodoDosFiltros({ from: '0002-09-21', to: '2026-09-21' })).toEqual({ from: null, to: '2026-09-21' });
    expect(periodoDosFiltros({ from: '2026-13-40', to: 'ontem' })).toEqual({ from: null, to: null });
    expect(facetarConciliacoes(DIAS, { from: '0002-09-21' }).total.qtd).toBe(6);
  });

  it('De maior que Até (clicou na ordem trocada) vale como o intervalo entre as duas', () => {
    expect(periodoDosFiltros({ from: '2026-09-20', to: '2026-09-19' })).toEqual({ from: '2026-09-19', to: '2026-09-20' });
    expect(facetarConciliacoes(DIAS, { from: '2026-09-20', to: '2026-09-19' }).total.qtd).toBe(3);
  });

  it('a LISTA usa o mesmo predicado: filtrarLinhas bate com o total', () => {
    const f = { storeCode: '01', from: '2026-09-18', to: '2026-09-20' };
    const linhas = filtrarLinhas(DIAS, f);
    expect(linhas.map((x) => x.dia)).toEqual(['2026-09-18', '2026-09-19', '2026-09-20']);
    expect(linhas.length).toBe(facetarConciliacoes(DIAS, f).total.qtd);
  });
});
