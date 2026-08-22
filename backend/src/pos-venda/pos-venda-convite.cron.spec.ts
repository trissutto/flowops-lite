import { PosVendaConviteCron } from './pos-venda-convite.cron';

/**
 * A trava que estes testes protegem é uma decisão do dono (22/08): a
 * reconciliação do rastreio fechou 255 pedidos entregues havia semanas, e 68
 * deles cairiam na régua do convite. "Não mande as mensagens."
 *
 * Cada linha que passa daqui vira um WhatsApp pra uma cliente de verdade —
 * por isso a regra tem teste próprio, e não só o comentário.
 */
function montar(estreia: string[] = [], env: Record<string, string | undefined> = {}) {
  const findMany = jest.fn().mockResolvedValue(estreia.map((codigo) => ({ codigo })));
  const cron = new PosVendaConviteCron(
    { rastreioObjeto: { findMany } } as any,
    {} as any,
    {} as any,
  );
  jest.spyOn((cron as any).logger, 'log').mockImplementation(() => undefined);
  jest.spyOn((cron as any).logger, 'warn').mockImplementation(() => undefined);
  const antes = { ...process.env };
  Object.entries(env).forEach(([k, v]) => {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  });
  return { cron, findMany, restaurar: () => { process.env = antes; } };
}

const ped = (id: string, codigo: string | null, caixas: string[] = []) => ({
  id, wcOrderNumber: id, trackingCode: codigo,
  pickOrders: caixas.map((c) => ({ trackingCode: c })),
});

describe('PosVendaConviteCron · semEntregaVelha', () => {
  afterEach(() => jest.restoreAllMocks());

  it('segura o convite de quem entrou no radar JÁ entregue', async () => {
    const t = montar(['AD111111111BR']);
    const r = await (t.cron as any).semEntregaVelha([
      ped('velho', 'AD111111111BR'),
      ped('novo', 'AD222222222BR'),
    ]);
    expect(r.map((p: any) => p.id)).toEqual(['novo']);
    t.restaurar();
  });

  it('entrega acompanhada ao vivo continua convidando', async () => {
    const t = montar([]);
    const r = await (t.cron as any).semEntregaVelha([ped('a', 'AD1BR'), ped('b', 'AD2BR')]);
    expect(r).toHaveLength(2);
    expect(t.findMany).toHaveBeenCalled();
    t.restaurar();
  });

  /** Pedido dividido: se UMA caixa foi descoberta tarde, a entrega foi tarde. */
  it('uma caixa marcada segura o pedido inteiro', async () => {
    const t = montar(['AD999999999BR']);
    const r = await (t.cron as any).semEntregaVelha([ped('dividido', 'AD1BR', ['AD999999999BR'])]);
    expect(r).toHaveLength(0);
    t.restaurar();
  });

  it('compara sem depender de caixa/espaço do código', async () => {
    const t = montar(['AD111111111BR']);
    const r = await (t.cron as any).semEntregaVelha([ped('minusculo', ' ad111111111br ')]);
    expect(r).toHaveLength(0);
    t.restaurar();
  });

  it('banco falhou: convida (a trava é proteção A MAIS, não gate)', async () => {
    const t = montar([]);
    t.findMany.mockRejectedValueOnce(new Error('sem conexão'));
    const r = await (t.cron as any).semEntregaVelha([ped('a', 'AD1BR')]);
    expect(r).toHaveLength(1);
    t.restaurar();
  });

  it('POS_VENDA_CONVIDA_ESTREIA=1 derruba a trava sem nem consultar', async () => {
    const t = montar(['AD1BR'], { POS_VENDA_CONVIDA_ESTREIA: '1' });
    const r = await (t.cron as any).semEntregaVelha([ped('a', 'AD1BR')]);
    expect(r).toHaveLength(1);
    expect(t.findMany).not.toHaveBeenCalled();
    t.restaurar();
  });

  it('pedido sem código nenhum passa (retirada/motoboy não tem o que conferir)', async () => {
    const t = montar(['AD1BR']);
    const r = await (t.cron as any).semEntregaVelha([ped('retirada', null)]);
    expect(r).toHaveLength(1);
    expect(t.findMany).not.toHaveBeenCalled();
    t.restaurar();
  });
});
