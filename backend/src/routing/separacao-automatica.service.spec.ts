import { SeparacaoAutomaticaService } from './separacao-automatica.service';

/**
 * SEPARAÇÃO AUTOMÁTICA (teste do dono, 25/09/2026) — as portas.
 * Prisma/routing/whatsapp mockados; a engine de verdade é testada em
 * routing.engine.prioridade.spec.ts.
 */
function monta(opts: {
  chave?: '0' | '1' | null;
  order?: any;
  reportes?: number;
  preview?: any;
  confirmErro?: string;
  /** O que o confirmRoute devolve (ex.: `{ persisted: false, alreadyRouted: true }`). */
  confirmRetorno?: any;
  /** Linhas relidas do banco depois do confirmRoute (com `assignedStoreId`). */
  linhas?: any[];
}) {
  const historico: string[] = [];
  const enviados: Array<{ numero: string; texto: string }> = [];
  const prisma: any = {
    systemSetting: {
      findUnique: jest.fn(async () => (opts.chave === null ? null : { value: opts.chave ?? '1' })),
    },
    order: { findUnique: jest.fn(async () => opts.order ?? null) },
    orderItem: { findMany: jest.fn(async () => opts.linhas ?? opts.order?.items ?? []) },
    pickOrderItemReport: { count: jest.fn(async () => opts.reportes ?? 0) },
    orderHistory: {
      create: jest.fn(async ({ data }: any) => {
        historico.push(String(data.note));
        return data;
      }),
    },
  };
  const routing: any = {
    previewRoute: jest.fn(async () => opts.preview),
    confirmRoute: jest.fn(async () => {
      if (opts.confirmErro) throw new Error(opts.confirmErro);
      return opts.confirmRetorno;
    }),
  };
  const whatsapp: any = {
    sendText: jest.fn(async (numero: string, texto: string) => {
      enviados.push({ numero, texto });
      return { ok: true };
    }),
  };
  const svc = new SeparacaoAutomaticaService(prisma, routing, whatsapp);
  return { svc, prisma, routing, whatsapp, historico, enviados };
}

const pedidoSite = (extra: Record<string, any> = {}) => ({
  id: 'o1',
  wcOrderNumber: 'LP-009999',
  wcOrderId: 950009999,
  source: 'ecommerce',
  status: 'processing',
  paidAt: new Date('2026-09-25T13:00:00Z'),
  createdAt: new Date('2026-09-25T12:50:00Z'),
  totalAmount: 199.9,
  customerName: 'Cliente Teste',
  shippingAddress: JSON.stringify({ address_1: 'Rua X, 10', city: 'Campinas', state: 'SP', postcode: '13000000' }),
  shippingMethod: 'PAC',
  items: [{ sku: 'A', quantity: 1, productName: 'Blusa', cor: 'PRETO', tamanho: '48' }],
  pickOrders: [],
  ...extra,
});

const previewOk = (strategy = 'single-store') => ({
  success: true,
  strategy,
  assignments: [
    { storeId: 's03', storeCode: '03', storeName: 'VINHEDO', items: [{ sku: 'A', quantity: 1 }], whatsapp: '5519999990000' },
  ],
  missing: [],
});

describe('SeparacaoAutomaticaService — portas', () => {
  const envAntes = process.env.SEPARACAO_AUTOMATICA;
  afterEach(() => {
    if (envAntes === undefined) delete process.env.SEPARACAO_AUTOMATICA;
    else process.env.SEPARACAO_AUTOMATICA = envAntes;
  });

  it('chave desligada (ou ausente) → não olha o pedido', async () => {
    for (const chave of ['0', null] as const) {
      const m = monta({ chave, order: pedidoSite(), preview: previewOk() });
      await expect(m.svc.tentar('o1')).resolves.toEqual({ aplicado: false, motivo: 'desligada' });
      expect(m.prisma.order.findUnique).not.toHaveBeenCalled();
    }
  });

  it('kill-switch por env vence a chave do banco', async () => {
    process.env.SEPARACAO_AUTOMATICA = '0';
    const m = monta({ chave: '1', order: pedidoSite(), preview: previewOk() });
    await expect(m.svc.tentar('o1')).resolves.toEqual({ aplicado: false, motivo: 'desligada' });
  });

  it('pedido pago do site, 1 loja → confirma com a TAG, anota o histórico e avisa a loja no WhatsApp', async () => {
    const m = monta({ order: pedidoSite(), preview: previewOk() });
    const r = await m.svc.tentar('o1', 'pagamento-site');
    expect(r).toEqual({ aplicado: true, motivo: 'single-store' });
    const [orderId, preview] = m.routing.confirmRoute.mock.calls[0];
    expect(orderId).toBe('o1');
    expect(preview.automatico).toMatchObject({ origem: 'pagamento-site', versao: 1 });
    expect(m.historico.some((n) => n.startsWith('🤖 SEPARAÇÃO AUTOMÁTICA'))).toBe(true);
    expect(m.historico.join(' ')).toContain('VINHEDO (03)');
    expect(m.enviados).toHaveLength(1);
    expect(m.enviados[0].numero).toBe('5519999990000');
    expect(m.enviados[0].texto).toContain('LP-009999');
    expect(m.enviados[0].texto).toContain('Separação automática');
  });

  it('pedido dividido (multi-store) e retirada com a peça na loja (pickup-lock) também fecham sozinhos', async () => {
    for (const s of ['multi-store', 'pickup-lock']) {
      const m = monta({ order: pedidoSite(), preview: previewOk(s) });
      await expect(m.svc.tentar('o1')).resolves.toEqual({ aplicado: true, motivo: s });
    }
  });

  it('retirada SEM a peça na loja (pickup-transfer) fica pra gente, com a razão no histórico', async () => {
    const m = monta({ order: pedidoSite(), preview: previewOk('pickup-transfer') });
    const r = await m.svc.tentar('o1');
    expect(r.aplicado).toBe(false);
    expect(m.routing.confirmRoute).not.toHaveBeenCalled();
    expect(m.historico[0]).toMatch(/NÃO aplicada.*retirada/i);
  });

  it('ruptura na rede fica pra gente e diz quais SKUs faltaram', async () => {
    const m = monta({
      order: pedidoSite(),
      preview: { success: false, strategy: 'insufficient-stock', assignments: [], missing: [{ sku: 'A', quantity: 1 }] },
    });
    const r = await m.svc.tentar('o1');
    expect(r.aplicado).toBe(false);
    expect(m.historico[0]).toMatch(/sem estoque na rede \(A\)/);
  });

  it('REGRA 4: pedido já reportado por loja nunca vai pela máquina', async () => {
    const m = monta({ order: pedidoSite(), reportes: 1, preview: previewOk() });
    const r = await m.svc.tentar('o1');
    expect(r).toEqual({ aplicado: false, motivo: 'reportado' });
    expect(m.routing.previewRoute).not.toHaveBeenCalled();
    expect(m.historico[0]).toMatch(/NÃO aplicada: reportado/);
  });

  it('não é pedido do site (venda online do PDV, live) → pula em silêncio', async () => {
    for (const source of ['pdv_online', 'live', 'site']) {
      const m = monta({ order: pedidoSite({ source }), preview: previewOk() });
      const r = await m.svc.tentar('o1');
      expect(r).toEqual({ aplicado: false, motivo: 'origem-nao-e-site' });
      expect(m.historico).toHaveLength(0);
    }
  });

  it('já tem card / não pago / status fechado → pula sem tocar em nada', async () => {
    const casos = [
      { order: pedidoSite({ pickOrders: [{ id: 'p1', status: 'separating' }] }), motivo: 'ja-tem-card' },
      { order: pedidoSite({ paidAt: null }), motivo: 'nao-pago' },
      { order: pedidoSite({ status: 'cancelled' }), motivo: 'status-cancelled' },
    ];
    for (const c of casos) {
      const m = monta({ order: c.order, preview: previewOk() });
      await expect(m.svc.tentar('o1')).resolves.toEqual({ aplicado: false, motivo: c.motivo });
      expect(m.routing.confirmRoute).not.toHaveBeenCalled();
    }
  });

  it('confirmRoute recusou (pagamento sem prova, troca pendente…) → razão no histórico, sem WhatsApp', async () => {
    const m = monta({ order: pedidoSite(), preview: previewOk(), confirmErro: 'Pedido sem prova de pagamento' });
    const r = await m.svc.tentar('o1');
    expect(r.aplicado).toBe(false);
    expect(m.historico[0]).toContain('Pedido sem prova de pagamento');
    expect(m.enviados).toHaveLength(0);
  });

  it('disparar() nunca lança, mesmo com o banco fora', async () => {
    const m = monta({ order: pedidoSite(), preview: previewOk() });
    m.prisma.systemSetting.findUnique = jest.fn(async () => {
      throw new Error('banco fora');
    });
    expect(() => m.svc.disparar('o1', 'teste')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  // ── A MENSAGEM: cada loja recebe SÓ o que ela separa (dono, 25/09 — LP-001687) ──
  const vestido = (extra: Record<string, any> = {}) => ({
    sku: '5410644',
    quantity: 1,
    productName: 'Vestido Manga Curta — VMM-225 · PRETO · 56',
    cor: 'PRETO',
    tamanho: '56',
    ...extra,
  });
  const previewDividido = () => ({
    success: true,
    strategy: 'multi-store',
    assignments: [
      { storeId: 'pira', storeCode: '02', storeName: 'PIRACICABA', items: [{ sku: '5410644', quantity: 1 }], whatsapp: '5519900000002' },
      { storeId: 'pg', storeCode: '07', storeName: 'PRAIA GRANDE', items: [{ sku: '5410644', quantity: 1 }], whatsapp: '5513900000007' },
    ],
    missing: [],
  });

  it('LP-001687: mesmo SKU dividido em 2 lojas → cada loja recebe UMA peça, não o pedido inteiro', async () => {
    const order = pedidoSite({ wcOrderNumber: 'LP-001687', items: [vestido(), vestido()] });
    const m = monta({
      order,
      preview: previewDividido(),
      linhas: [vestido({ id: 'l1', assignedStoreId: 'pira' }), vestido({ id: 'l2', assignedStoreId: 'pg' })],
    });
    await expect(m.svc.tentar('o1')).resolves.toEqual({ aplicado: true, motivo: 'multi-store' });
    expect(m.enviados).toHaveLength(2);
    for (const e of m.enviados) {
      expect(e.texto.match(/SKU 5410644/g)).toHaveLength(1);
      expect(e.texto).toContain('(1 peça)');
      expect(e.texto).toContain('outra loja');
      expect(e.texto).not.toContain('2 peças');
    }
  });

  it('sem o carimbo do banco (releitura falhou) ainda divide pela cota da engine, nunca pelo SKU', async () => {
    const order = pedidoSite({ items: [vestido(), vestido()] });
    const m = monta({ order, preview: previewDividido() });
    m.prisma.orderItem.findMany = jest.fn(async () => {
      throw new Error('banco fora');
    });
    await m.svc.tentar('o1');
    expect(m.enviados).toHaveLength(2);
    for (const e of m.enviados) expect(e.texto.match(/SKU 5410644/g)).toHaveLength(1);
  });

  it('retirada na loja (pickup-lock): a loja recebe o PEDIDO INTEIRO, sem endereço e sem pedir rastreio', async () => {
    const blusa = { sku: 'B', quantity: 1, productName: 'Blusa', cor: 'AZUL', tamanho: '50' };
    const order = pedidoSite({
      isPickup: true,
      pickupStoreCode: '03',
      shippingMethod: 'Retirada em loja (Vinhedo)',
      items: [vestido(), blusa],
    });
    const preview = previewOk('pickup-lock');
    preview.assignments[0].items = [{ sku: '5410644', quantity: 1 }, { sku: 'B', quantity: 1 }];
    const m = monta({
      order,
      preview,
      linhas: [vestido({ assignedStoreId: 's03' }), { ...blusa, assignedStoreId: 's03' }],
    });
    await expect(m.svc.tentar('o1')).resolves.toEqual({ aplicado: true, motivo: 'pickup-lock' });
    expect(m.enviados).toHaveLength(1);
    const t = m.enviados[0].texto;
    expect(t).toContain('RETIRADA NA LOJA');
    expect(t).toContain('SKU 5410644');
    expect(t).toContain('SKU B');
    expect(t).toContain('(2 peças)');
    expect(t).not.toContain('rastreio');
    expect(t).not.toContain('Rua X');
  });

  it('confirmRoute não persistiu (gatilho duplicado, card já ativo) → sem WhatsApp e sem nota de "enviado"', async () => {
    const m = monta({ order: pedidoSite(), preview: previewOk(), confirmRetorno: { persisted: false, alreadyRouted: true } });
    await expect(m.svc.tentar('o1')).resolves.toEqual({ aplicado: false, motivo: 'ja-tem-card' });
    expect(m.enviados).toHaveLength(0);
    expect(m.historico.some((n) => n.startsWith('🤖 SEPARAÇÃO AUTOMÁTICA'))).toBe(false);
  });
});
