import { ConciliacaoService } from './conciliacao.service';

/**
 * A tela /retaguarda/conciliacao: lista e números de cima no MESMO recorte,
 * com o dia contado em BRASÍLIA. Prisma de mentira — só o que o serviço chama.
 */
function montar(transacoes: Array<{ id: string; storeCode: string | null; dataVenda: string | null; cents?: number; status?: string }>) {
  const txs = transacoes.map((t) => ({
    id: t.id, storeCode: t.storeCode, dataVenda: t.dataVenda ? new Date(t.dataVenda) : null,
    tipoPagamento: 'pix', rawJson: null,
  }));
  const concs = transacoes.map((t) => ({
    id: `c-${t.id}`, transactionId: t.id, pedidoRef: null, status: t.status || 'CONCILIADO',
    gateway: 'PAGBANK', origem: 'loja', valorGatewayCents: t.cents ?? 1000,
  }));
  const porIds = (linhas: any[]) => jest.fn(async (args: any = {}) => {
    const ids: string[] | undefined = args?.where?.id?.in;
    return ids ? linhas.filter((l) => ids.includes(l.id)) : linhas;
  });
  const vazio = { findMany: jest.fn(async () => []) };
  const prisma: any = {
    financialConciliacao: { findMany: porIds(concs) },
    financialTransaction: { findMany: porIds(txs), groupBy: jest.fn(async () => []) },
    pdvSale: vazio, livePdvCart: vazio, crediarioBaixa: vazio, order: vazio, pdvSalePayment: vazio,
  };
  return { svc: new ConciliacaoService(prisma), prisma };
}

describe('ConciliacaoService — motor barato o bastante pra rodar toda hora', () => {
  /** 3 pagamentos pagos sem dono → veredito NAO_ENCONTRADO "pagamento sem venda vinculada", origem null. */
  function montarMotor(conciliacoesAtuais: any[]) {
    const txs = ['t1', 't2', 't3'].map((id) => ({
      id, pedidoRef: null, transactionId: `ORDE_${id}`, valorBrutoCents: 1000, tipoPagamento: 'pix',
      statusGateway: 'paid', gateway: 'PAGBANK', statusInterno: 'nao_encontrado',
    }));
    const vazio = { findMany: jest.fn(async () => []) };
    const prisma: any = {
      financialTransaction: { findMany: jest.fn(async () => txs), update: jest.fn(async () => ({})) },
      financialConciliacao: { findMany: jest.fn(async () => conciliacoesAtuais), upsert: jest.fn(async () => ({})) },
      pdvSale: vazio, livePdvCart: vazio, crediarioBaixa: vazio, order: vazio, pdvSalePayment: vazio,
    };
    return { svc: new ConciliacaoService(prisma), prisma };
  }
  const jaGravada = (transactionId: string) => ({
    transactionId, status: 'NAO_ENCONTRADO', pedidoRef: null, valorSistemaCents: null,
    valorGatewayCents: 1000, diferencaCents: null, motivo: 'pagamento sem venda vinculada', origem: null,
  });

  it('rodada sem novidade não escreve NADA (antes regravava ~6 mil linhas por rodada)', async () => {
    const { svc, prisma } = montarMotor(['t1', 't2', 't3'].map(jaGravada));
    const r = await svc.conciliar();
    expect(r).toMatchObject({ total: 3, semVenda: 3, gravadas: 0 });
    expect(prisma.financialConciliacao.upsert).not.toHaveBeenCalled();
    expect(prisma.financialTransaction.update).not.toHaveBeenCalled();
  });

  it('escreve só a linha que mudou — e a que ainda não existia', async () => {
    const mudada = { ...jaGravada('t2'), motivo: 'texto de uma versão antiga do motor' };
    const { svc, prisma } = montarMotor([jaGravada('t1'), mudada]); // t3 nunca foi conciliada
    const r = await svc.conciliar();
    expect(r.gravadas).toBe(2);
    const escritas = prisma.financialConciliacao.upsert.mock.calls.map((c: any[]) => c[0].where.transactionId);
    expect(escritas.sort()).toEqual(['t2', 't3']);
  });

  it('cron da hora e clique em "Conciliar" ao mesmo tempo = UMA rodada', async () => {
    const { svc, prisma } = montarMotor(['t1', 't2', 't3'].map(jaGravada));
    const [a, b] = await Promise.all([svc.conciliar(), svc.conciliar()]);
    expect(a).toBe(b);
    expect(prisma.financialTransaction.findMany).toHaveBeenCalledTimes(1);
  });

  it('"atualizado às" aparece no resumo depois da rodada', async () => {
    const { svc, prisma } = montarMotor(['t1', 't2', 't3'].map(jaGravada));
    prisma.financialTransaction.groupBy = jest.fn(async () => []);
    expect((await svc.status({})).atualizadoEm).toBeNull();
    await svc.conciliar();
    expect(typeof (await svc.status({})).atualizadoEm).toBe('string');
  });
});

describe('ConciliacaoService — filtro por data', () => {
  it('o dia é o de BRASÍLIA: PIX das 22h30 do dia 19 (01h30 UTC do dia 20) é do dia 19', async () => {
    const { svc } = montar([
      { id: 'noite-do-19', storeCode: '01', dataVenda: '2026-09-20T01:30:00.000Z' },
      { id: 'manha-do-20', storeCode: '01', dataVenda: '2026-09-20T13:00:00.000Z' },
    ]);
    const dia19 = await svc.listar({ from: '2026-09-19', to: '2026-09-19' });
    expect(dia19.rows.map((r: any) => r.transactionId)).toEqual(['noite-do-19']);
    const dia20 = await svc.listar({ from: '2026-09-20', to: '2026-09-20' });
    expect(dia20.rows.map((r: any) => r.transactionId)).toEqual(['manha-do-20']);
  });

  it('lista e números de cima saem do MESMO recorte', async () => {
    const { svc } = montar([
      { id: 'a', storeCode: '01', dataVenda: '2026-09-19T15:00:00.000Z', cents: 31700 },
      { id: 'b', storeCode: '01', dataVenda: '2026-09-19T18:00:00.000Z', cents: 23300, status: 'DIVERGENTE' },
      { id: 'c', storeCode: '02', dataVenda: '2026-09-19T18:00:00.000Z', cents: 5990 },
      { id: 'd', storeCode: '01', dataVenda: '2026-09-18T18:00:00.000Z', cents: 9999 },
    ]);
    const f = { storeCode: '01', from: '2026-09-19', to: '2026-09-19' };
    const [lista, resumo] = await Promise.all([svc.listar(f), svc.status(f)]);
    expect(lista.total).toBe(2);
    expect(resumo.total).toEqual({ qtd: 2, cents: 55000 });
    expect(resumo.conciliacoes).toEqual([{ status: 'CONCILIADO', qtd: 1 }, { status: 'DIVERGENTE', qtd: 1 }]);
    // o seletor de loja mostra as lojas DAQUELE dia
    expect(resumo.lojas).toEqual([{ storeCode: '01', qtd: 2 }, { storeCode: '02', qtd: 1 }]);
  });

  it('ordem da lista = venda mais nova primeiro; transação sem data vai pro fim', async () => {
    const { svc } = montar([
      { id: 'velha', storeCode: '01', dataVenda: '2026-09-01T12:00:00.000Z' },
      { id: 'sem-data', storeCode: '01', dataVenda: null },
      { id: 'nova', storeCode: '01', dataVenda: '2026-09-21T12:00:00.000Z' },
      { id: 'meio', storeCode: '01', dataVenda: '2026-09-10T12:00:00.000Z' },
    ]);
    const r = await svc.listar({});
    expect(r.rows.map((x: any) => x.transactionId)).toEqual(['nova', 'meio', 'velha', 'sem-data']);
    // …e sem data não entra em período nenhum
    expect((await svc.listar({ from: '2026-01-01', to: '2026-12-31' })).total).toBe(3);
  });

  it('pagina em cima do recorte, mantendo a ordem', async () => {
    const dozes = Array.from({ length: 12 }, (_, i) => ({
      id: `t${String(i).padStart(2, '0')}`, storeCode: '01',
      dataVenda: `2026-09-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`,
    }));
    const { svc } = montar(dozes);
    const p1 = await svc.listar({ perPage: 10, page: 1 });
    const p2 = await svc.listar({ perPage: 10, page: 2 });
    expect(p1.total).toBe(12);
    expect(p1.rows.map((x: any) => x.transactionId)).toEqual(['t11', 't10', 't09', 't08', 't07', 't06', 't05', 't04', 't03', 't02']);
    expect(p2.rows.map((x: any) => x.transactionId)).toEqual(['t01', 't00']);
  });

  it('cada clique de filtro NÃO relê a base: 15s em memória', async () => {
    const { svc, prisma } = montar([{ id: 'a', storeCode: '01', dataVenda: '2026-09-19T15:00:00.000Z' }]);
    await svc.status({});
    await svc.status({ storeCode: '01' });
    await svc.status({ from: '2026-09-19', to: '2026-09-19' });
    // 1 leitura da base (findMany sem `where.id`) apesar dos 3 cliques
    const leiturasDaBase = prisma.financialConciliacao.findMany.mock.calls.filter((c: any[]) => !c[0]?.where?.id).length;
    expect(leiturasDaBase).toBe(1);
  });

  it('recorte vazio devolve lista vazia sem ir buscar linha nenhuma', async () => {
    const { svc, prisma } = montar([{ id: 'a', storeCode: '01', dataVenda: '2026-09-19T15:00:00.000Z' }]);
    const r = await svc.listar({ from: '2026-01-01', to: '2026-01-02' });
    expect(r).toMatchObject({ total: 0, rows: [] });
    expect(prisma.financialConciliacao.findMany.mock.calls.some((c: any[]) => c[0]?.where?.id)).toBe(false);
  });
});
