import { OrdersController } from './orders.controller';

/**
 * CANCELAMENTO ANÔNIMO E MUDO (26/08/2026, ordem do dono).
 *
 * O `PATCH /orders/wc/:id` cancelava o pedido com a nota fixa
 * `Pedido CANCELADO pelo Flow` — sem autor e sem porquê. Medido em produção:
 * **18 cancelamentos em 60 dias, 0 com `user_id`**.
 *
 * Caso que provou: **ON-000017** (venda online de Suzano, R$ 159,80, paga em
 * 18/08). Loja 18 reportou ruptura em 21/08, e em 22/08 12:28 o pedido foi
 * cancelado sem uma linha de explicação. Reconstruir o "por quê" exigiu ler o
 * reporte da loja e conferir o estoque da rede peça por peça.
 */
describe('OrdersController — cancelar exige motivo e grava quem foi', () => {
  const PEDIDO = { id: 'order-1', source: 'pdv_online', status: 'pending' };
  const USUARIA = { id: 'user-karine', name: 'Karine', role: 'admin' };

  const fazController = (opts: { usuarioExiste?: boolean } = {}) => {
    const ctrl = Object.create(OrdersController.prototype) as OrdersController;
    const historico: any[] = [];
    const updates: any[] = [];
    (ctrl as any).prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(PEDIDO),
        update: jest.fn().mockImplementation((args: any) => {
          updates.push(args);
          return Promise.resolve({ ...PEDIDO, ...args.data });
        }),
      },
      pickOrder: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      orderHistory: {
        create: jest.fn().mockImplementation((args: any) => {
          historico.push(args.data);
          return Promise.resolve(args.data);
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue(
          opts.usuarioExiste === false ? null : { id: USUARIA.id },
        ),
      },
    };
    (ctrl as any).pickScans = { revertOrderStock: jest.fn().mockResolvedValue({ pecas: 0 }) };
    // Criar card de separação é outro assunto (tem spec próprio) — aqui só
    // interessa o que o PATCH escreve no histórico.
    (ctrl as any).ensurePickOrdersForWc = jest
      .fn()
      .mockResolvedValue({ ok: true, already: true, pickOrders: [] });
    return { ctrl, historico, updates };
  };

  const patch = (ctrl: OrdersController, body: any, user: any = USUARIA) =>
    (ctrl as any).wcUpdate('960000017', body, { user });

  it('cancelar SEM motivo é recusado — e nada é escrito', async () => {
    const { ctrl, historico, updates } = fazController();
    const r = await patch(ctrl, { status: 'cancelled' });

    expect(r.ok).toBe(false);
    expect(r.statusApplied).toBe(false);
    expect(r.warning).toContain('Motivo do cancelamento');
    // A trava vem ANTES de qualquer escrita: o pedido continua vivo.
    expect(updates).toHaveLength(0);
    expect(historico).toHaveLength(0);
  });

  it('reembolso sem motivo também é recusado', async () => {
    const { ctrl, updates } = fazController();
    const r = await patch(ctrl, { status: 'refunded' });

    expect(r.ok).toBe(false);
    expect(r.warning).toContain('reembolsar');
    expect(updates).toHaveLength(0);
  });

  it('"ok" não é motivo — texto curto demais não passa', async () => {
    const { ctrl, updates } = fazController();
    const r = await patch(ctrl, { status: 'cancelled', cancelReason: 'ok' });

    expect(r.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('com motivo: cancela, grava o PORQUÊ e QUEM no histórico', async () => {
    const { ctrl, historico, updates } = fazController();
    const r = await patch(ctrl, {
      status: 'cancelled',
      cancelReason: 'ruptura — nenhuma loja tem a SMILE 54',
    });

    expect(r.ok).toBe(true);
    expect(updates[0].data.status).toBe('cancelled');

    const linha = historico.find((h) => h.toStatus === 'cancelled');
    expect(linha.note).toContain('motivo: ruptura — nenhuma loja tem a SMILE 54');
    expect(linha.note).toContain('por Karine');
    expect(linha.userId).toBe('user-karine');
  });

  it('motivo pode vir da nota do pedido — quem já escrevia não é obrigado a repetir', async () => {
    const { ctrl, historico } = fazController();
    const r = await patch(ctrl, {
      status: 'cancelled',
      addNote: { text: 'cliente desistiu e o PIX foi devolvido' },
    });

    expect(r.ok).toBe(true);
    expect(historico.find((h) => h.toStatus === 'cancelled').note).toContain(
      'motivo: cliente desistiu e o PIX foi devolvido',
    );
  });

  it('usuário apagado não derruba o histórico — nome fica na nota, user_id vai null', async () => {
    const { ctrl, historico } = fazController({ usuarioExiste: false });
    const r = await patch(ctrl, { status: 'cancelled', cancelReason: 'peça avariada' });

    expect(r.ok).toBe(true);
    const linha = historico.find((h) => h.toStatus === 'cancelled');
    expect(linha.userId).toBeNull();
    expect(linha.note).toContain('por Karine');
  });

  it('sem ninguém logado, a nota ADMITE que não sabe quem foi', async () => {
    const { ctrl, historico } = fazController({ usuarioExiste: false });
    const r = await patch(ctrl, { status: 'cancelled', cancelReason: 'duplicidade' }, null);

    expect(r.ok).toBe(true);
    expect(historico.find((h) => h.toStatus === 'cancelled').note).toContain(
      'por usuário não identificado',
    );
  });

  it('login de LOJA aparece pelo nome da loja, igual ao reporte de ruptura', async () => {
    const { ctrl, historico } = fazController();
    const r = await patch(
      ctrl,
      { status: 'cancelled', cancelReason: 'cliente veio buscar e desistiu' },
      { sub: 'user-karine', storeName: 'Mogi das Cruzes', role: 'store' },
    );

    expect(r.ok).toBe(true);
    expect(historico.find((h) => h.toStatus === 'cancelled').note).toContain('por Mogi das Cruzes');
  });

  it('mudar status que NÃO é cancelamento segue livre — e agora também assina', async () => {
    const { ctrl, historico } = fazController();
    const r = await patch(ctrl, { status: 'separacao' });

    expect(r.ok).toBe(true);
    const linha = historico.find((h) => h.toStatus === 'separating');
    expect(linha.note).toContain('por Karine');
    expect(linha.userId).toBe('user-karine');
  });
});
