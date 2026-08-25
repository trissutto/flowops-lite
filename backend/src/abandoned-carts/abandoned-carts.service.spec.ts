import { HttpException } from '@nestjs/common';
import { AbandonedCartsService } from './abandoned-carts.service';

describe('AbandonedCartsService checkout recovery', () => {
  const upsert = jest.fn().mockResolvedValue({});
  const makeService = () => new AbandonedCartsService({} as any, {} as any, {
    checkoutRecovery: { upsert },
  } as any);

  beforeEach(() => upsert.mockClear());

  it('ignora status de conversão enviado pelo navegador e sanitiza atribuição', async () => {
    const service = makeService();
    await service.captureCheckout({
      sessionId: 'session-12345678', name: 'Maria', phone: '(11) 98765-4321', status: 'converted',
      attribution: { utm_source: ' meta ', utm_campaign: 'verao', segredo: 'não guardar' },
      items: [{ productId: 'REF1', name: 'Vestido', quantity: 1, unitPrice: 199.9 }],
    }, '127.0.0.1');

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: 'active', telefone: '11987654321', recoveryConsent: false }),
      update: expect.not.objectContaining({ status: expect.anything(), convertedAt: expect.anything() }),
    }));
    const data = upsert.mock.calls[0][0].create;
    expect(data.attribution).toEqual({ utm_source: 'meta', utm_campaign: 'verao' });
  });

  it('persiste somente consentimento explícito para recuperação', async () => {
    const service = makeService();
    await service.captureCheckout({
      sessionId: 'session-consentida', name: 'Bia', phone: '11999998888',
      recoveryConsent: true, items: [],
    }, '127.0.0.2');

    expect(upsert.mock.calls[0][0].create.recoveryConsent).toBe(true);
  });

  it('limita rajadas do mesmo contato', async () => {
    const service = makeService();
    const body = { sessionId: 'session-abcdefgh', name: 'Ana', phone: '11987654321', items: [] };
    for (let i = 0; i < 10; i++) await service.captureCheckout(body, '10.0.0.1');
    await expect(service.captureCheckout(body, '10.0.0.1')).rejects.toBeInstanceOf(HttpException);
  });
});

/**
 * O caso real (24/08/2026): HELEMAR VALIM levou 3 recusas de cartão e a 4ª
 * tentativa passou 23 segundos depois. Os 3 pedidos mortos apareciam como
 * "carrinho abandonado" com botão de WhatsApp — cobrando quem acabou de pagar.
 */
describe('AbandonedCartsService carrinhos do site novo', () => {
  const T = (min: number) => new Date(Date.UTC(2026, 7, 24, 11, min, 0));
  const pedido = (over: any) => ({
    wcOrderId: 950000000 + Math.round(Math.random() * 1000),
    customerName: 'Helemar Valim',
    customerEmail: 'helemarvalim@yahoo.com.br',
    customerPhone: '35991720547',
    totalAmount: 229.69,
    status: 'payment_failed',
    paidAt: null,
    createdAt: T(38),
    wcOrderNumber: 'LP-000195',
    items: [],
    ...over,
  });

  const makeService = (encontrados: any[], pagos: any[]) => {
    const findMany = jest.fn().mockImplementation((args: any) =>
      Promise.resolve(args?.where?.paidAt?.not === null ? pagos : encontrados),
    );
    return new AbandonedCartsService({} as any, {} as any, {
      order: { findMany },
      checkoutRecovery: { findMany: jest.fn().mockResolvedValue([]) },
    } as any);
  };

  it('esconde a tentativa recusada quando a mesma cliente fechou a venda na sequência', async () => {
    const recusados = [
      pedido({ wcOrderNumber: 'LP-000197', createdAt: T(39) }),
      pedido({ wcOrderNumber: 'LP-000196', createdAt: T(39) }),
      pedido({ wcOrderNumber: 'LP-000195', createdAt: T(38) }),
    ];
    const service = makeService(recusados, [
      { customerEmail: 'helemarvalim@yahoo.com.br', customerPhone: '35991720547', createdAt: T(39) },
    ]);

    const r: any = await service.listEcommercePending({ status: 'abandoned' });
    expect(r.items).toHaveLength(0);
    expect(r.stats.abandoned).toBe(0);
  });

  it('casa a venda pelo TELEFONE quando o e-mail do pedido pago é outro', async () => {
    const service = makeService([pedido({ customerEmail: 'digitou@errado.com' })], [
      { customerEmail: 'helemarvalim@yahoo.com.br', customerPhone: '(35) 99172-0547', createdAt: T(39) },
    ]);

    const r: any = await service.listEcommercePending({ status: 'abandoned' });
    expect(r.items).toHaveLength(0);
  });

  it('mantém o abandono de verdade e marca o status cru do pedido', async () => {
    const service = makeService([pedido({ wcOrderNumber: 'LP-000199' })], [
      { customerEmail: 'outra@cliente.com', customerPhone: '11988887777', createdAt: T(42) },
    ]);

    const r: any = await service.listEcommercePending({ status: 'abandoned' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].order_number).toBe('LP-000199');
    expect(r.items[0].pedido_status).toBe('payment_failed');
    expect(r.items[0].order_status).toBe('abandoned');
  });

  it('marca quem já chamou a cliente com o usuário logado, por telefone', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const service = new AbandonedCartsService({} as any, {} as any, {
      carrinhoAtendimento: { upsert },
    } as any);

    const r: any = await service.assumirAtendimento('(35) 99172-0547', {
      sub: 'user-1',
      name: 'Karine',
      email: 'karine@lurds.com.br',
    });

    expect(r.ok).toBe(true);
    expect(r.por).toBe('Karine');
    // Telefone normalizado: é a chave que faz a tag valer em TODAS as linhas
    // daquela cliente, não só na que ela clicou.
    expect(upsert.mock.calls[0][0].where).toEqual({ telefone: '35991720547' });
    expect(upsert.mock.calls[0][0].create).toMatchObject({ usuarioNome: 'Karine', usuarioId: 'user-1' });
  });

  it('telefone incompleto não vira atendimento', async () => {
    const upsert = jest.fn();
    const service = new AbandonedCartsService({} as any, {} as any, {
      carrinhoAtendimento: { upsert },
    } as any);

    const r: any = await service.assumirAtendimento('9917', { name: 'Karine' });
    expect(r.ok).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  // O dono cancelou o prazo de 2h em 25/08: atendimento de carrinho não acaba
  // no relógio. Quem tira a tag agora é a baixa (`marcarNaoConvertido`).
  it('a tag de atendimento não vence mais por tempo — sem corte de data na query', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { telefone: '35991720547', usuarioNome: 'Karine', assumidoEm: new Date('2026-08-20T11:40:00Z') },
    ]);
    const service = new AbandonedCartsService({} as any, {} as any, {
      carrinhoAtendimento: { findMany },
    } as any);

    const r: any = await service.atendimentosAtivos();
    // 5 dias atrás e a tag continua de pé.
    expect(r.ativos).toEqual([
      { telefone: '35991720547', por: 'Karine', desde: '2026-08-20T11:40:00.000Z' },
    ]);
    expect(findMany.mock.calls[0][0].where).toBeUndefined();
    expect(r.valeMin).toBeNull();
  });

  it('falha ao ler atendimento não derruba a lista — só perde a tag', async () => {
    const service = new AbandonedCartsService({} as any, {} as any, {
      carrinhoAtendimento: { findMany: jest.fn().mockRejectedValue(new Error('sem tabela')) },
    } as any);

    const r: any = await service.atendimentosAtivos();
    expect(r).toMatchObject({ ok: true, ativos: [] });
  });

  it('não esconde nada quando a venda da mesma cliente está fora da janela', async () => {
    const service = makeService([pedido({})], [
      {
        customerEmail: 'helemarvalim@yahoo.com.br',
        customerPhone: '35991720547',
        createdAt: new Date(Date.UTC(2026, 7, 26, 11, 38, 0)), // 2 dias depois
      },
    ]);

    const r: any = await service.listEcommercePending({ status: 'abandoned' });
    expect(r.items).toHaveLength(1);
  });
});

/**
 * A ESPERA DE 1 HORA (dono, 25/08/2026).
 *
 * Ele abriu a tela às 11:55 e viu o carrinho das 11:41 já na fila, com botão de
 * WhatsApp do lado — a cliente ainda estava NA TELA DE PAGAMENTO.
 */
describe('AbandonedCartsService espera de 1h antes de virar abandono', () => {
  const minutosAtras = (min: number) => new Date(Date.now() - min * 60_000);
  const pedido = (over: any) => ({
    wcOrderId: 950000123,
    customerName: 'Mariana Correa',
    customerEmail: 'mariana@exemplo.com',
    customerPhone: '19981411939',
    totalAmount: 139.9,
    status: 'awaiting_payment',
    paidAt: null,
    createdAt: minutosAtras(600),
    wcOrderNumber: 'LP-000900',
    items: [],
    ...over,
  });
  const makeService = (pedidos: any[], capturas: any[] = [], desfechos: any[] = []) =>
    new AbandonedCartsService({} as any, {} as any, {
      order: {
        findMany: jest.fn().mockImplementation((args: any) =>
          Promise.resolve(args?.where?.paidAt?.not === null ? [] : pedidos),
        ),
      },
      checkoutRecovery: { findMany: jest.fn().mockResolvedValue(capturas) },
      carrinhoDesfecho: { findMany: jest.fn().mockResolvedValue(desfechos) },
    } as any);

  it('esconde o pedido que nasceu há 14 minutos — ela ainda está pagando', async () => {
    const service = makeService([pedido({ createdAt: minutosAtras(14) })]);
    const r: any = await service.listEcommercePending({ status: 'all' });
    expect(r.items).toHaveLength(0);
    expect(r.stats.abandoned).toBe(0);
    expect(r.stats.no_forno).toBe(1);
  });

  it('solta o mesmo pedido depois de 1 hora', async () => {
    const service = makeService([pedido({ createdAt: minutosAtras(61) })]);
    const r: any = await service.listEcommercePending({ status: 'all' });
    expect(r.items).toHaveLength(1);
    expect(r.stats.abandoned).toBe(1);
  });

  it('conta a espera do NASCIMENTO da captura, não do último toque', async () => {
    // Ela digitou o telefone há 10 minutos e continua mexendo na sacola: o
    // `updatedAt` é de agora, mas o carrinho ainda não é abandono.
    const service = makeService([], [{
      id: 'rec-1', sessionId: 'sess-1', nome: 'Tatiany Mendes', telefone: '85999197103',
      subtotal: 209.7, items: [], status: 'active', recoveryConsent: true,
      createdAt: minutosAtras(10), updatedAt: new Date(),
    }]);
    const r: any = await service.listEcommercePending({ status: 'all' });
    expect(r.items).toHaveLength(0);
  });

  it('pagamento confirmado aparece na hora — a espera só vale pro abandono', async () => {
    const service = makeService([
      pedido({ createdAt: minutosAtras(3), paidAt: minutosAtras(1) }),
    ]);
    const r: any = await service.listEcommercePending({ status: 'all' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].order_status).toBe('recovered');
  });
});

describe('AbandonedCartsService baixa do carrinho', () => {
  const minutosAtras = (min: number) => new Date(Date.now() - min * 60_000);

  it('carrinho com baixa sai da fila e vira nao_convertido', async () => {
    const service = new AbandonedCartsService({} as any, {} as any, {
      order: {
        findMany: jest.fn().mockImplementation((args: any) =>
          Promise.resolve(
            args?.where?.paidAt?.not === null
              ? []
              : [{
                  wcOrderId: 950000123, customerName: 'Andrea Ferreira',
                  customerEmail: '', customerPhone: '11993928942', totalAmount: 409.7,
                  status: 'awaiting_payment', paidAt: null, createdAt: minutosAtras(300),
                  wcOrderNumber: 'LP-000901', items: [],
                }],
          ),
        ),
      },
      checkoutRecovery: { findMany: jest.fn().mockResolvedValue([]) },
      carrinhoDesfecho: {
        findMany: jest.fn().mockResolvedValue([
          {
            chave: 'pedido:950000123', telefone: '11993928942', motivo: 'preco',
            observacao: null, usuarioNome: 'Karine', criadoEm: minutosAtras(10), valor: 409.7,
          },
        ]),
      },
    } as any);

    const r: any = await service.listEcommercePending({ status: 'all' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].order_status).toBe('nao_convertido');
    expect(r.items[0].desfecho).toMatchObject({ motivo: 'preco', motivoLabel: 'Achou caro', por: 'Karine' });
    // O que importa pra fila: ele não conta mais como abandono em aberto.
    expect(r.stats.abandoned).toBe(0);
    expect(r.stats.nao_convertido).toBe(1);
  });

  it('a baixa registra o motivo e LIBERA o atendimento da cliente', async () => {
    const upsert = jest.fn().mockImplementation(({ create }: any) => Promise.resolve({
      ...create, criadoEm: new Date('2026-08-25T14:00:00Z'),
    }));
    const del = jest.fn().mockResolvedValue({});
    const service = new AbandonedCartsService({} as any, {} as any, {
      carrinhoDesfecho: { upsert },
      carrinhoAtendimento: { delete: del },
    } as any);

    const r: any = await service.marcarNaoConvertido(
      { chave: 'contato:rec-9', telefone: '(11) 99392-8942', motivo: 'frete', observacao: 'frete pra BA', valor: 409.7 },
      { sub: 'user-1', name: 'Karine' },
    );

    expect(r.ok).toBe(true);
    expect(upsert.mock.calls[0][0].where).toEqual({ chave: 'contato:rec-9' });
    expect(upsert.mock.calls[0][0].create).toMatchObject({ motivo: 'frete', telefone: '11993928942', usuarioNome: 'Karine' });
    // Caso encerrado, telefone liberado: sem isso a tag ficaria pra sempre.
    expect(del).toHaveBeenCalledWith({ where: { telefone: '11993928942' } });
  });

  it('recusa motivo fora da lista e "outro" sem explicação', async () => {
    const upsert = jest.fn();
    const service = new AbandonedCartsService({} as any, {} as any, {
      carrinhoDesfecho: { upsert },
    } as any);

    expect(await service.marcarNaoConvertido({ chave: 'pedido:1', motivo: 'sei_la' }, {})).toMatchObject({ ok: false });
    expect(await service.marcarNaoConvertido({ chave: 'pedido:1', motivo: 'outro' }, {})).toMatchObject({ ok: false });
    expect(await service.marcarNaoConvertido({ chave: 'sem-prefixo', motivo: 'preco' }, {})).toMatchObject({ ok: false });
    expect(upsert).not.toHaveBeenCalled();
  });
});
