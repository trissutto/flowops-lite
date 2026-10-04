import { PickOrdersService } from './pick-orders.service';

/**
 * NOTA AUTOMÁTICA DE RETIRADA E MOTOBOY (04/10/2026) — `emitirNotaSemEnvio`.
 *
 * Ordem do dono: a nota da venda online sai pelo CNPJ da conta que cobrou o
 * link, e retirada/motoboy (que ficavam sem documento fiscal nenhum) passam a
 * ganhar nota sozinhos. Estes testes travam o que NÃO pode acontecer:
 *
 *  - emitir nota de venda que não foi paga na conta do gateway (franquia na
 *    maquininha dela — quem recebeu foi ela);
 *  - emitir duas vezes, ou por cima de cupom já autorizado;
 *  - inventar endereço pra retirada que não tem;
 *  - martelar a SEFAZ com a mesma rejeição a cada ciclo.
 */
describe('emitirNotaSemEnvio — nota de retirada/motoboy pela conta que cobrou', () => {
  const TO = '20104813';
  const ENVS = ['NFE_ENVIO_ENABLED', 'NFE_NOTA_SEM_ENVIO', 'NFE_SEGUE_CONTA_DO_LINK', 'PAGBANK_TITULAR_RAIZ', 'PAGBANK_TITULAR_RAIZ_POR_LOJA'];

  const LIMEIRA = { id: 'store-11', code: '11', name: 'LIMEIRA' };
  const CAMPINAS = { id: 'store-07', code: '07', name: 'CAMPINAS' };

  const peca = (sku: string, preco: number, assignedStoreId: string | null, extra: any = {}) => ({
    sku, productName: `PEÇA ${sku}`, quantity: 1, unitPrice: preco, baseUnitPrice: preco, assignedStoreId, cancelledAt: null, ...extra,
  });

  const pedido = (over: any = {}) => ({
    id: 'order-1',
    wcOrderNumber: 'ON-000999',
    source: 'pdv_online',
    status: 'shipped',
    isPickup: false,
    shippingMethod: 'MOTOBOY',
    sellerStoreCode: '11',
    customerName: 'CLIENTE TESTE',
    customerCpf: '11144477735',
    shippingCep: '13480000',
    shippingAddress: JSON.stringify({ address_1: 'RUA A, 10', city: 'Limeira', state: 'SP' }),
    totalAmount: 259.8,
    checkoutInfo: JSON.stringify({ pdvSaleId: 'sale-1', shipping: { kind: 'motoboy', price: 15 }, discount: 0 }),
    items: [peca('A', 129.9, LIMEIRA.id), peca('B', 129.9, LIMEIRA.id)],
    pickOrders: [] as any[],
    ...over,
  });

  const makeSvc = (opts: {
    order: any;
    pagoNoPagbank?: boolean;
    marcador?: boolean;
    docExistente?: boolean;
    nfceStatus?: string | null;
    enderecoCrm?: any;
    emissao?: any;
  }) => {
    const historico: string[] = [];
    const svc = Object.create(PickOrdersService.prototype) as any;
    svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    svc.correios = { buscarCep: jest.fn().mockResolvedValue({ uf: 'SP', cidade: 'Limeira', bairro: 'Centro', logradouro: 'Rua A', ibge: '3526902' }) };
    svc.nfe = {
      emitVendaForEnvio:
        opts.emissao instanceof Error
          ? jest.fn().mockRejectedValue(opts.emissao)
          : jest.fn().mockResolvedValue(
              opts.emissao ?? {
                ok: true,
                doc: { id: 'doc-1', numero: 2801, chave: '3526'.padEnd(44, '0'), tpAmb: '1', serie: '1', valorTotalCents: 27480 },
                emitente: { cnpj: '20104813000139', razaoSocial: 'T. O. RISSUTTO LTDA' },
              },
            ),
    };
    svc.prisma = {
      order: { findUnique: jest.fn().mockResolvedValue(opts.order) },
      orderHistory: {
        findFirst: jest.fn().mockResolvedValue(opts.marcador ? { id: 'h1' } : null),
        create: jest.fn().mockImplementation(async ({ data }: any) => { historico.push(data.note); return data; }),
      },
      nfeDoc: { findFirst: jest.fn().mockResolvedValue(opts.docExistente ? { id: 'doc-0' } : null) },
      pdvSale: {
        findUnique: jest.fn().mockResolvedValue({ status: 'finalized', isTraining: false, nfceStatus: opts.nfceStatus ?? 'skipped', storeCode: '11' }),
      },
      store: { findFirst: jest.fn().mockResolvedValue(LIMEIRA), findUnique: jest.fn().mockResolvedValue(LIMEIRA) },
      pickOrder: {
        count: jest.fn().mockResolvedValue((opts.order?.pickOrders || []).length),
        findFirst: jest.fn().mockResolvedValue((opts.order?.pickOrders || [])[0] ?? null),
      },
      pagbankPayment: { findFirst: jest.fn().mockResolvedValue(opts.pagoNoPagbank === false ? null : { storeCode: '11' }) },
      customer: { findFirst: jest.fn().mockResolvedValue(opts.enderecoCrm ? { addresses: [opts.enderecoCrm] } : null) },
    };
    return { svc, historico, emitir: svc.nfe.emitVendaForEnvio as jest.Mock };
  };

  beforeEach(() => {
    ENVS.forEach((e) => delete process.env[e]);
    process.env.NFE_ENVIO_ENABLED = '1';
  });
  afterAll(() => ENVS.forEach((e) => delete process.env[e]));

  test('MOTOBOY fechado na vendedora (sem card), pago no link: nota pela T.O., amarrada à VENDA', async () => {
    const { svc, historico, emitir } = makeSvc({ order: pedido() });
    const r = await svc.emitirNotaSemEnvio('order-1');
    expect(r.resultado).toBe('emitida');
    expect(emitir).toHaveBeenCalledTimes(1);
    const arg = emitir.mock.calls[0][0];
    expect(arg.saleId).toBe('sale-1'); // sem card → `venda:<saleId>`
    expect(arg.storeCode).toBe('11'); // parte da loja de onde a peça saiu…
    expect(arg.emitirPorRaiz).toBe(TO); // …mas quem assina é a empresa da conta
    expect(arg.items).toHaveLength(2);
    expect(arg.vFrete).toBe(15);
    expect(arg.dest.codMun).toBe('3526902');
    expect(historico).toHaveLength(1);
    expect(historico[0]).toMatch(/^\[nota-auto\] NF-e 2801 emitida por T\. O\. RISSUTTO LTDA/);
  });

  test('venda paga FORA do gateway (franquia na maquininha dela): não emite e não deixa marca', async () => {
    const { svc, historico, emitir } = makeSvc({ order: pedido(), pagoNoPagbank: false });
    const r = await svc.emitirNotaSemEnvio('order-1');
    expect(r.resultado).toBe('pulada');
    expect(emitir).not.toHaveBeenCalled();
    expect(historico).toHaveLength(0);
  });

  test('RETIRADA no card RECEPTOR (peças vieram de outra loja): fatura o pedido INTEIRO, menos a peça cancelada', async () => {
    const card = { id: 'pick-rec', storeId: LIMEIRA.id, isTransfer: false, status: 'shipped', trackingCode: null, store: LIMEIRA };
    const feeder = { id: 'pick-feed', storeId: CAMPINAS.id, isTransfer: true, status: 'shipped', trackingCode: null, store: CAMPINAS };
    const order = pedido({
      isPickup: true,
      shippingMethod: 'RETIRADA NA LOJA — LIMEIRA',
      status: 'delivered',
      checkoutInfo: JSON.stringify({ pdvSaleId: 'sale-1', shipping: { kind: 'pickup', price: 0 } }),
      items: [peca('A', 100, CAMPINAS.id), peca('B', 50, CAMPINAS.id), peca('C', 70, null, { cancelledAt: new Date() })],
      pickOrders: [feeder, card],
    });
    const { svc, emitir } = makeSvc({ order });
    const r = await svc.emitirNotaSemEnvio('order-1');
    expect(r.resultado).toBe('emitida');
    const arg = emitir.mock.calls[0][0];
    expect(arg.pickOrderId).toBe('pick-rec'); // nota no card da cliente…
    expect(arg.saleId).toBeUndefined(); // …não na venda
    expect(arg.items.map((i: any) => i.sku)).toEqual(['A', 'B']);
    expect(arg.emitirPorRaiz).toBe(TO);
  });

  test('RETIRADA sem endereço no pedido nem no cadastro: fica PENDENTE com o motivo, sem inventar endereço', async () => {
    const order = pedido({ isPickup: true, shippingMethod: 'RETIRADA NA LOJA — LIMEIRA', shippingCep: null, shippingAddress: '{}' });
    const { svc, historico, emitir } = makeSvc({ order });
    const r = await svc.emitirNotaSemEnvio('order-1');
    expect(r.resultado).toBe('pendente');
    expect(emitir).not.toHaveBeenCalled();
    expect(historico[0]).toMatch(/^\[nota-auto\] NF-e NÃO emitida \(retirada\): a cliente não tem endereço/);
    expect(historico[0]).toMatch(/PDV → Notas → botão "NF-e"/);
  });

  test('RETIRADA sem endereço no pedido mas com endereço no CRM: emite com o do cadastro', async () => {
    const order = pedido({ isPickup: true, shippingMethod: 'RETIRADA NA LOJA — LIMEIRA', shippingCep: null, shippingAddress: '{}' });
    const { svc, emitir } = makeSvc({
      order,
      enderecoCrm: { cep: '13480-123', street: 'RUA DO CADASTRO', number: '55', district: 'Vila', city: 'Limeira', state: 'sp' },
    });
    const r = await svc.emitirNotaSemEnvio('order-1');
    expect(r.resultado).toBe('emitida');
    const dest = emitir.mock.calls[0][0].dest;
    expect(dest.cep).toBe('13480123');
    expect(dest.endereco).toBe('RUA DO CADASTRO');
    expect(dest.numero).toBe('55');
  });

  test('UMA tentativa por pedido: com o marcador no histórico, não tenta de novo', async () => {
    const { svc, emitir } = makeSvc({ order: pedido(), marcador: true });
    expect((await svc.emitirNotaSemEnvio('order-1')).resultado).toBe('pulada');
    expect(emitir).not.toHaveBeenCalled();
  });

  test('NUNCA OS DOIS: venda com cupom (NFC-e) autorizado não ganha nota', async () => {
    const { svc, emitir } = makeSvc({ order: pedido(), nfceStatus: 'authorized' });
    expect((await svc.emitirNotaSemEnvio('order-1')).resultado).toBe('pulada');
    expect(emitir).not.toHaveBeenCalled();
  });

  test('já existe NF-e (ou tentativa) pra venda: não emite outra', async () => {
    const { svc, emitir } = makeSvc({ order: pedido(), docExistente: true });
    expect((await svc.emitirNotaSemEnvio('order-1')).resultado).toBe('pulada');
    expect(emitir).not.toHaveBeenCalled();
  });

  test('SEFAZ rejeitou: registra o motivo e PARA (não queima número a cada ciclo)', async () => {
    const { svc, historico } = makeSvc({ order: pedido(), emissao: { ok: false, cStat: '778', xMotivo: 'NCM inexistente', doc: { id: 'doc-2' } } });
    const r = await svc.emitirNotaSemEnvio('order-1');
    expect(r.resultado).toBe('rejeitada');
    expect(historico[0]).toMatch(/a SEFAZ rejeitou \(778: NCM inexistente\)/);
  });

  test('erro de rede: NÃO deixa marca — o próximo ciclo tenta de novo', async () => {
    const { svc, historico } = makeSvc({ order: pedido(), emissao: new Error('connect ETIMEDOUT 200.1.2.3:443') });
    const r = await svc.emitirNotaSemEnvio('order-1');
    expect(r.resultado).toBe('tentar-depois');
    expect(historico).toHaveLength(0);
  });

  test('pedido de Correios não entra aqui — a nota dele é a do Gerar envio', async () => {
    const order = pedido({ shippingMethod: 'SEDEX', checkoutInfo: JSON.stringify({ pdvSaleId: 'sale-1', shipping: { kind: 'correios', price: 20 } }) });
    const { svc, emitir } = makeSvc({ order });
    expect((await svc.emitirNotaSemEnvio('order-1')).resultado).toBe('pulada');
    expect(emitir).not.toHaveBeenCalled();
  });

  test('card da cliente ainda aberto: espera a peça sair', async () => {
    const card = { id: 'pick-1', storeId: LIMEIRA.id, isTransfer: false, status: 'separated', trackingCode: null, store: LIMEIRA };
    const { svc, emitir } = makeSvc({ order: pedido({ pickOrders: [card] }) });
    expect((await svc.emitirNotaSemEnvio('order-1')).resultado).toBe('pulada');
    expect(emitir).not.toHaveBeenCalled();
  });

  test('kill-switch NFE_NOTA_SEM_ENVIO=0 desliga', async () => {
    process.env.NFE_NOTA_SEM_ENVIO = '0';
    const { svc, emitir } = makeSvc({ order: pedido() });
    expect((await svc.emitirNotaSemEnvio('order-1')).resultado).toBe('pulada');
    expect(emitir).not.toHaveBeenCalled();
  });
});
