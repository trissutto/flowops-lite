import { PdvService } from './pdv.service';

/**
 * O CAIXA APLICANDO A PROMOÇÃO DOS ANTIGOS (dono, 23/10/2026): cadastro até
 * 31/12/2023, MODA, R$ 49,90 até 149,90 e R$ 99,90 acima. Só no PDV.
 */
describe('PdvService — promoção dos antigos', () => {
  const item = (id: string, sku: string, precoUnit: number, over: any = {}) => ({
    id, sku, ref: `REF-${sku}`, descricao: 'BLUSA', precoUnit, qty: 1, desconto: 0, promoTag: null, forcarPromo: false, ...over,
  });

  const cadastro = [
    { codigo: '8001', ref: 'REF-8001', dataAlt: new Date('2021-03-10T00:00:00.000Z') },
    { codigo: '8002', ref: 'REF-8002', dataAlt: new Date('2023-12-31T00:00:00.000Z') },
    { codigo: '8003', ref: 'REF-8003', dataAlt: new Date('2024-01-02T00:00:00.000Z') },
    { codigo: '8004', ref: 'BASICA-1', dataAlt: new Date('2020-01-01T00:00:00.000Z') },
    { codigo: '8005', ref: 'REF-8005', dataAlt: new Date('2019-06-01T00:00:00.000Z') },
  ];

  function montar(itens: any[]) {
    const updates: any[] = [];
    const prisma: any = {
      pdvSale: {
        findUnique: jest.fn().mockResolvedValue({ id: 's1', status: 'open', storeCode: '05', activePromotion: 'ANTIGOS' }),
        update: jest.fn().mockResolvedValue({}),
      },
      pdvSaleItem: {
        findMany: jest.fn().mockResolvedValue(itens),
        update: jest.fn(async (a: any) => { updates.push({ id: a.where.id, ...a.data }); return {}; }),
      },
      product: { findMany: jest.fn().mockResolvedValue(cadastro) },
    };
    const promoCampanha: any = { basicos: jest.fn().mockResolvedValue(new Set(['BASICA-1'])) };
    const svc = new PdvService(prisma, {} as any, {} as any, {} as any, {} as any, promoCampanha, {} as any, {} as any, {} as any, {} as any) as any;
    return { svc, updates, prisma };
  }

  it('antiga até 149,90 sai a 49,90; acima de 149,91 sai a 99,90 (vezes a quantidade)', async () => {
    const { svc, updates } = montar([item('i1', '8001', 129.9, { qty: 2 }), item('i2', '8002', 189.9)]);
    await svc.applyAutoDiscounts('s1');
    expect(updates.find((u) => u.id === 'i1')).toMatchObject({ total: 99.8, desconto: 160, promoTag: 'PROMO R$ 49,90 · antigos' });
    expect(updates.find((u) => u.id === 'i2')).toMatchObject({ total: 99.9, desconto: 90, promoTag: 'PROMO R$ 99,90 · antigos' });
  });

  it('cadastro de 2024, BÁSICO e peça que já custa menos saem cheios, com etiqueta que diz por quê', async () => {
    const { svc, updates } = montar([item('i3', '8003', 129.9), item('i4', '8004', 129.9), item('i5', '8005', 39.9), item('i6', '9999', 99.9)]);
    await svc.applyAutoDiscounts('s1');
    expect(updates.find((u) => u.id === 'i3')).toMatchObject({ desconto: 0, total: 129.9, promoTag: 'Sem promo · cadastro 2024+' });
    expect(updates.find((u) => u.id === 'i4')).toMatchObject({ desconto: 0, promoTag: 'Básico · sem promo' });
    expect(updates.find((u) => u.id === 'i5')).toMatchObject({ desconto: 0, total: 39.9, promoTag: 'Sem promo · já custa menos' });
    expect(updates.find((u) => u.id === 'i6')).toMatchObject({ desconto: 0, promoTag: 'Sem promo · sem data' });
  });

  it('a vendedora põe a nova na mão (⬆️)', async () => {
    const { svc, updates } = montar([item('i3', '8003', 129.9, { forcarPromo: true })]);
    await svc.applyAutoDiscounts('s1');
    expect(updates[0]).toMatchObject({ total: 49.9, promoTag: 'PROMO R$ 49,90 · antigos · na mão' });
  });

  it('desconto MANUAL, fora da promo e MARCADO com desconto não são tocados', async () => {
    const { svc, updates } = montar([
      item('i7', '8001', 129.9, { desconto: 10, promoTag: 'MANUAL' }),
      item('i8', '8001', 129.9, { promoTag: 'SEM_PROMO' }),
      item('i9', '8001', 129.9, { desconto: 30, promoTag: 'MARCADO' }),
    ]);
    await svc.applyAutoDiscounts('s1');
    expect(updates).toHaveLength(0);
  });

  it('setPromotion aceita ANTIGOS', async () => {
    const { svc, prisma } = montar([]);
    jest.spyOn(svc, 'recalcTotals').mockResolvedValue(undefined);
    jest.spyOn(svc, 'getSale').mockResolvedValue({ id: 's1' });
    await svc.setPromotion({ saleId: 's1', promotion: 'ANTIGOS' });
    expect(prisma.pdvSale.update).toHaveBeenCalledWith(expect.objectContaining({ data: { activePromotion: 'ANTIGOS' } }));
  });
});
