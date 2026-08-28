import { LojaOrdersService } from './loja-orders.service';

/**
 * RETENTATIVA RECOBRA O MESMO PEDIDO (dono, 24/08/2026).
 *
 * O caso real: HELEMAR VALIM levou 3 recusas de cartão e a 4ª passou 23s depois
 * — quatro pedidos (LP-000195/196/197/198) pra uma compra só. Aqui o que se
 * testa é a decisão de reaproveitar: quando reaproveita, quando NÃO reaproveita
 * (que é onde mora o risco de cobrança dupla) e o que sobrevive do histórico.
 */
describe('LojaOrdersService — retentativa recobra o mesmo pedido', () => {
  const CPF = '12345678901';

  const input = (over: any = {}) => ({
    customer: { name: 'Helemar Valim', email: 'helemarvalim@yahoo.com.br', phone: '35991720547', cpf: CPF },
    payment: { method: 'card', installments: 4 },
    items: [],
    ...over,
  }) as any;

  const recusado = {
    id: 'ord-195',
    wcOrderNumber: 'LP-000195',
    paymentInfo: JSON.stringify({
      method: 'card',
      installments: 4,
      falha: 'cartão recusado pela operadora',
      falhaTipo: 'recusa',
      falhaEm: '2026-08-24T11:38:30.000Z',
      gatewayOrderId: 'or_4xRw6GTaafjAdQem',
    }),
  };

  const makeService = (prisma: any) =>
    // As dependências viram stub — este teste é do reaproveitamento do
    // pedido recusado, não da injeção. As duas penúltimas são o módulo de
    // risco (chaves + análise, 27/08); a última é o escudo anti-teste-de-
    // cartão (28/08).
    new LojaOrdersService(
      prisma,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any,
    );

  const prismaMock = (over: any = {}) => ({
    order: {
      findFirst: jest.fn().mockResolvedValue(recusado),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'ord-195', wcOrderNumber: 'LP-000195', ...data })),
      ...over,
    },
  });

  const chamar = (service: any, prisma: any, over: any = {}) =>
    service.reaproveitarRecusado(input(over), { status: 'awaiting_payment', wcDateCreated: new Date() }, []);

  beforeEach(() => {
    delete process.env.LOJA_RETRY_MESMO_PEDIDO;
    delete process.env.LOJA_RETRY_MIN;
  });

  it('reaproveita o pedido recusado da mesma cliente — mesmo LP, tentativa 2', async () => {
    const prisma = prismaMock();
    const r = await chamar(makeService(prisma), prisma);

    expect(r).toBeTruthy();
    expect(r.wcOrderNumber).toBe('LP-000195');
    expect(r.tentativa).toBe(2);
    // Só o pedido recusado da PRÓPRIA cliente entra no radar.
    expect(prisma.order.findFirst.mock.calls[0][0].where).toMatchObject({
      status: 'payment_failed',
      paidAt: null,
      customerCpf: CPF,
    });
  });

  it('guarda o que já falhou — juntar as tentativas não pode apagar o histórico', async () => {
    const prisma = prismaMock();
    const r = await chamar(makeService(prisma), prisma);

    const salvo = JSON.parse(prisma.order.update.mock.calls[0][0].data.paymentInfo);
    expect(salvo.tentativa).toBe(2);
    expect(salvo.tentativasAnteriores).toHaveLength(1);
    expect(salvo.tentativasAnteriores[0]).toMatchObject({
      falha: 'cartão recusado pela operadora',
      falhaTipo: 'recusa',
      gatewayOrderId: 'or_4xRw6GTaafjAdQem',
    });
    expect(r.tentativasAnteriores).toHaveLength(1);
  });

  it('NÃO reaproveita quando o pagamento entrou entre achar e recobrar (claim falha)', async () => {
    const prisma = prismaMock({ updateMany: jest.fn().mockResolvedValue({ count: 0 }) });
    const r = await chamar(makeService(prisma), prisma);

    expect(r).toBeNull();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('não reaproveita nada quando não há recusa recente', async () => {
    const prisma = prismaMock({ findFirst: jest.fn().mockResolvedValue(null) });
    expect(await chamar(makeService(prisma), prisma)).toBeNull();
  });

  it('a data da retentativa NÃO reescreve quando a cliente fez o pedido', async () => {
    const prisma = prismaMock();
    await chamar(makeService(prisma), prisma);
    expect(prisma.order.update.mock.calls[0][0].data).not.toHaveProperty('wcDateCreated');
  });

  it('sem CPF completo não tenta reaproveitar (identidade é o CPF)', async () => {
    const prisma = prismaMock();
    const r = await chamar(makeService(prisma), prisma, {
      customer: { name: 'Sem Doc', email: 'a@b.com', phone: '11999998888', cpf: '123' },
    });
    expect(r).toBeNull();
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it('kill-switch LOJA_RETRY_MESMO_PEDIDO=0 volta a criar pedido por tentativa', async () => {
    process.env.LOJA_RETRY_MESMO_PEDIDO = '0';
    const prisma = prismaMock();
    expect(await chamar(makeService(prisma), prisma)).toBeNull();
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it('tropeço no banco cai pro caminho de sempre em vez de derrubar a venda', async () => {
    const prisma = prismaMock({ update: jest.fn().mockRejectedValue(new Error('P2003 FK')) });
    const r = await chamar(makeService(prisma), prisma);

    expect(r).toBeNull();
    // e devolve o pedido pro estado em que estava, senão ele some da aba Carrinhos
    const reverte = prisma.order.updateMany.mock.calls.at(-1)[0];
    expect(reverte.data).toEqual({ status: 'payment_failed' });
  });

  it('o code da Pagar.me muda a cada tentativa — senão a busca do POST ambíguo pega a recusa velha', () => {
    const service: any = makeService(prismaMock());
    expect(service.codigoCobranca({ wcOrderNumber: 'LP-000195' })).toBe('LP-000195');
    expect(service.codigoCobranca({ wcOrderNumber: 'LP-000195', tentativa: 2 })).toBe('LP-000195-T2');
    expect(service.codigoCobranca({ wcOrderNumber: 'LP-000195', tentativa: 3 })).toBe('LP-000195-T3');
  });
});
