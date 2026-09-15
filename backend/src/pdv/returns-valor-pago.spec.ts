import { ReturnsService } from './returns.service';
import { precoComDesconto, totalDoItemComDesconto } from '../common/promo-por-termo';

/**
 * DEVOLUÇÃO DE PEÇA VENDIDA NA CAMPANHA DEVOLVE O QUE FOI PAGO (15/09/2026).
 *
 * O crédito sai de `item.total / item.qty` da venda original — o valor que a
 * cliente pagou, com o desconto de inverno já dentro. Recalcular pelo preço
 * cheio (ou pela régua de hoje) daria crédito a mais numa peça comprada com
 * 30% — e a régua muda (termo novo, peça tirada), a venda antiga não.
 */
describe('devolução — usa o valor efetivamente pago', () => {
  function montar(items: any[]) {
    const criadas: any[] = [];
    const prisma: any = {
      pdvSale: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sale-1', status: 'finalized', paymentMethod: 'pix', storeCode: '05', storeName: 'Loja 05', items,
        }),
      },
      pdvReturn: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(async ({ data }: any) => {
          criadas.push(data);
          return { id: 'ret-1', ...data, items: data.items.create };
        }),
      },
    };
    const erp: any = { increaseStockAsync: jest.fn().mockResolvedValue({ success: true }) };
    const cash: any = { getCurrentSession: jest.fn().mockResolvedValue(null) };
    const cashback: any = { estornarDevolucao: jest.fn().mockResolvedValue(undefined) };
    return { svc: new ReturnsService(prisma, erp, cash, cashback), criadas };
  }

  it('peça de inverno (30%) e blusa cheia: o crédito soma o PAGO de cada uma', async () => {
    const casaco = totalDoItemComDesconto(199.9, 2, 30); // 2 casacos na campanha
    const { svc, criadas } = montar([
      { id: 'i1', sku: '7002', ref: 'CAS-10', descricao: 'CASACO PLUSH', qty: 2, precoUnit: 199.9, desconto: casaco.desconto, total: casaco.total, promoTag: 'PROMO 30% · inverno' },
      { id: 'i2', sku: '7001', ref: 'BLV-10', descricao: 'BLUSA VISCOLYCRA', qty: 1, precoUnit: 119.9, desconto: 0, total: 119.9, promoTag: 'Sem promo' },
    ]);

    await svc.createReturn({
      originalSaleId: 'sale-1', storeCode: '05', storeName: 'Loja 05', modo: 'credito',
      items: [{ originalItemId: 'i1', qty: 1 }, { originalItemId: 'i2', qty: 1 }],
    });

    const ret = criadas[0];
    const casacoDevolvido = ret.items.create.find((i: any) => i.originalItemId === 'i1');
    expect(casacoDevolvido.precoUnit).toBe(precoComDesconto(199.9, 30)); // 139,93 — nunca 199,90
    expect(ret.items.create.find((i: any) => i.originalItemId === 'i2').precoUnit).toBe(119.9);
    expect(ret.valorTotal).toBe(Math.round((precoComDesconto(199.9, 30) + 119.9) * 100) / 100);
  });

  it('peça posta na campanha pela vendedora (⬆️) devolve o preço com desconto', async () => {
    const pago = totalDoItemComDesconto(119.9, 1, 30);
    const { svc, criadas } = montar([
      { id: 'i1', sku: '7001', ref: 'BLV-10', descricao: 'BLUSA', qty: 1, precoUnit: 119.9, desconto: pago.desconto, total: pago.total, promoTag: 'PROMO 30% · inverno · na mão', forcarPromo: true },
    ]);
    await svc.createReturn({
      originalSaleId: 'sale-1', storeCode: '05', storeName: 'Loja 05', modo: 'credito',
      items: [{ originalItemId: 'i1', qty: 1 }],
    });
    expect(criadas[0].valorTotal).toBe(pago.total);
  });
});
