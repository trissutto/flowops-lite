import { BadRequestException } from '@nestjs/common';
import { PdvService } from './pdv.service';
import { CAMPANHA_PADRAO, criarRegra, precoComDesconto } from '../common/promo-por-termo';

/**
 * A LINHA DA VENDA NA CAMPANHA — o botão de um clique do PDV (dono,
 * 15/09/2026, 2ª rodada):
 *
 *   - 🚫 tira SÓ aquela linha (preço normal), sem modal, sem mexer na campanha;
 *   - ⬆️ põe SÓ aquela linha (o % da campanha), sem mexer no cadastro;
 *   - peça protegida (tirada pela matriz, bermuda, uniforme 22 de Abril,
 *     campanha desligada) não ganha desconto nem com o clique;
 *   - item com preço próprio (manual, marcado, frete) não entra por cima;
 *   - a política de acúmulo continua: campanha ativa bloqueia desconto avulso,
 *     e a outra campanha (4 leva 3) não soma com o % de inverno.
 */
describe('PdvService — a linha da venda na campanha por termo', () => {
  const blusa = { id: 'b1', sku: '7001', ref: 'BLV-10', descricao: 'BLUSA VISCOLYCRA', precoUnit: 119.9, qty: 1, desconto: 0, promoTag: null, forcarPromo: false };
  const casaco = { id: 'c1', sku: '7002', ref: 'CAS-10', descricao: 'CASACO PLUSH', precoUnit: 199.9, qty: 1, desconto: 0, promoTag: null, forcarPromo: false };
  const bermuda = { id: 'e1', sku: '7003', ref: 'BER-10', descricao: 'BERMUDA MOLETOM MENINO', precoUnit: 69.9, qty: 1, desconto: 0, promoTag: null, forcarPromo: false };
  const calca = { id: 'm1', sku: '7004', ref: 'CAL-10', descricao: 'CALCA MOLETOM', precoUnit: 179.9, qty: 1, desconto: 0, promoTag: null, forcarPromo: false };

  const catalogo = new Map<string, any>(
    [blusa, casaco, bermuda, calca].map((i) => [
      i.sku,
      { codigo: i.sku, ref: i.ref, descricao: i.descricao, descricaoPdv: null, grupo: null, preco: i.precoUnit },
    ]),
  );

  function montar(opts: { activePromotion: string | null; itens: any[]; excecoes?: any[]; ativa?: boolean; basicos?: string[] }) {
    const itens = new Map<string, any>(opts.itens.map((i) => [i.id, { ...i, saleId: 's1' }]));
    const prisma: any = {
      pdvSale: {
        findUnique: jest.fn().mockResolvedValue({ id: 's1', status: 'open', storeCode: '05', activePromotion: opts.activePromotion }),
        update: jest.fn().mockResolvedValue({}),
      },
      pdvSaleItem: {
        findUnique: jest.fn(async ({ where }: any) => itens.get(where.id) ?? null),
        findMany: jest.fn(async () => [...itens.values()]),
        update: jest.fn(async ({ where, data }: any) => {
          const it = { ...itens.get(where.id), ...data };
          itens.set(where.id, it);
          return it;
        }),
      },
    };
    const regra = criarRegra(
      { ...CAMPANHA_PADRAO, ativa: opts.ativa !== false },
      opts.excecoes ?? [],
      null,
      new Set(opts.basicos ?? []),
    );
    const promoCampanha: any = {
      regra: jest.fn().mockResolvedValue(regra),
      linhasPorCodigo: jest.fn().mockResolvedValue(catalogo),
      gravarExcecao: jest.fn(),
    };
    const svc = new PdvService(prisma, {} as any, {} as any, {} as any, {} as any, promoCampanha, {} as any, {} as any, {} as any, {} as any) as any;
    jest.spyOn(svc, 'recalcTotals').mockResolvedValue(undefined);
    jest.spyOn(svc, 'getSale').mockResolvedValue({ id: 's1' });
    return { svc, itens, promoCampanha, prisma };
  }

  it('produto FORA da promoção + clique ⬆️ → entra só nesta linha, com o % da campanha', async () => {
    const { svc, itens, promoCampanha } = montar({ activePromotion: 'POR_TERMO', itens: [blusa, casaco] });
    await svc.updateItem({ saleId: 's1', itemId: 'b1', forcePromo: true });
    const b = itens.get('b1');
    expect(b.total).toBe(precoComDesconto(119.9, 30));
    expect(b.promoTag).toBe('PROMO 30% · inverno · na mão');
    expect(b.forcarPromo).toBe(true);
    // Nada vai pra campanha: nenhuma exceção de família gravada.
    expect(promoCampanha.gravarExcecao).not.toHaveBeenCalled();
  });

  it('o clique não vaza pra outra venda: a mesma blusa numa venda nova sai cheia', async () => {
    const { svc, itens } = montar({ activePromotion: 'POR_TERMO', itens: [blusa] });
    await svc.applyAutoDiscounts('s1');
    expect(itens.get('b1')).toMatchObject({ desconto: 0, total: 119.9, promoTag: 'Sem promo' });
  });

  it('produto NA promoção + clique 🚫 → preço normal nesta linha; a outra peça de inverno segue com desconto', async () => {
    const { svc, itens, promoCampanha } = montar({ activePromotion: 'POR_TERMO', itens: [casaco, calca] });
    await svc.applyAutoDiscounts('s1');
    expect(itens.get('c1').total).toBe(precoComDesconto(199.9, 30));
    await svc.updateItem({ saleId: 's1', itemId: 'c1', excludePromo: true });
    expect(itens.get('c1')).toMatchObject({ desconto: 0, total: 199.9, promoTag: 'SEM_PROMO', forcarPromo: false });
    expect(itens.get('m1').total).toBe(precoComDesconto(179.9, 30));
    expect(promoCampanha.gravarExcecao).not.toHaveBeenCalled();
  });

  it('tirada com 🚫 e posta de volta com ⬆️: volta o mesmo desconto', async () => {
    const { svc, itens } = montar({ activePromotion: 'POR_TERMO', itens: [casaco] });
    await svc.updateItem({ saleId: 's1', itemId: 'c1', excludePromo: true });
    await svc.updateItem({ saleId: 's1', itemId: 'c1', forcePromo: true });
    // O casaco entra pela regra: a etiqueta é a da campanha, sem "na mão".
    expect(itens.get('c1')).toMatchObject({ total: precoComDesconto(199.9, 30), promoTag: 'PROMO 30% · inverno' });
  });

  it('⬆️ em BERMUDA (palavra que exclui) não dá desconto', async () => {
    const { svc, itens } = montar({ activePromotion: 'POR_TERMO', itens: [bermuda] });
    await svc.updateItem({ saleId: 's1', itemId: 'e1', forcePromo: true });
    expect(itens.get('e1')).toMatchObject({ desconto: 0, total: 69.9, promoTag: 'Sem promo · excluída' });
  });

  it('⬆️ em peça que a matriz TIROU da campanha não dá desconto (exclusão manual ganha)', async () => {
    const { svc, itens } = montar({
      activePromotion: 'POR_TERMO', itens: [casaco], excecoes: [{ chave: 'CAS-10', decisao: 'fora' }],
    });
    await svc.updateItem({ saleId: 's1', itemId: 'c1', forcePromo: true });
    expect(itens.get('c1')).toMatchObject({ desconto: 0, promoTag: 'Sem promo · tirada' });
  });

  it('⬆️ com a campanha desligada na retaguarda não dá desconto', async () => {
    const { svc, itens } = montar({ activePromotion: 'POR_TERMO', itens: [blusa], ativa: false });
    await svc.updateItem({ saleId: 's1', itemId: 'b1', forcePromo: true });
    expect(itens.get('b1')).toMatchObject({ desconto: 0, promoTag: 'Sem promo · campanha desligada' });
  });

  it('calça de moletom da linha BÁSICA sai cheia com "Básico · sem promo" — e o ⬆️ põe só nesta venda', async () => {
    const { svc, itens } = montar({ activePromotion: 'POR_TERMO', itens: [calca], basicos: ['CAL-10'] });
    await svc.applyAutoDiscounts('s1');
    expect(itens.get('m1')).toMatchObject({ desconto: 0, total: 179.9, promoTag: 'Básico · sem promo' });
    await svc.updateItem({ saleId: 's1', itemId: 'm1', forcePromo: true });
    expect(itens.get('m1')).toMatchObject({ total: precoComDesconto(179.9, 30), promoTag: 'PROMO 30% · inverno · na mão' });
  });

  it('produto NÃO elegível incluído pela matriz entra (sem precisar do clique)', async () => {
    const { svc, itens } = montar({
      activePromotion: 'POR_TERMO', itens: [blusa], excecoes: [{ chave: 'BLV-10', decisao: 'dentro' }],
    });
    await svc.applyAutoDiscounts('s1');
    expect(itens.get('b1')).toMatchObject({ total: precoComDesconto(119.9, 30), promoTag: 'PROMO 30% · inverno' });
  });

  it('produto elegível tirado pela matriz NÃO entra', async () => {
    const { svc, itens } = montar({
      activePromotion: 'POR_TERMO', itens: [calca], excecoes: [{ chave: 'CAL-10', decisao: 'fora' }],
    });
    await svc.applyAutoDiscounts('s1');
    expect(itens.get('m1')).toMatchObject({ desconto: 0, total: 179.9, promoTag: 'Sem promo · tirada' });
  });

  it('⬆️ recusado em item com preço próprio (manual, marcado, frete, item digitado)', async () => {
    const manual = { ...blusa, id: 'x1', promoTag: 'MANUAL', desconto: 10 };
    const marcado = { ...blusa, id: 'x2', promoTag: 'MARCADO', desconto: 0 };
    const frete = { ...blusa, id: 'x3', sku: 'FRETE', ref: 'FRETE', promoTag: 'FRETE', descricao: 'FRETE - ENVIO' };
    const digitado = { ...blusa, id: 'x4', sku: 'MANUAL-1', ref: 'MANUAL', promoTag: 'MANUAL' };
    const { svc, prisma } = montar({ activePromotion: 'POR_TERMO', itens: [manual, marcado, frete, digitado] });
    for (const id of ['x1', 'x2', 'x3', 'x4']) {
      await expect(svc.updateItem({ saleId: 's1', itemId: id, forcePromo: true })).rejects.toThrow(BadRequestException);
    }
    expect(prisma.pdvSaleItem.update).not.toHaveBeenCalled();
  });

  it('acúmulo: com a campanha ativa, desconto avulso no item continua bloqueado', async () => {
    const { svc } = montar({ activePromotion: 'POR_TERMO', itens: [casaco] });
    await expect(svc.updateItem({ saleId: 's1', itemId: 'c1', desconto: 10 })).rejects.toThrow(/Promoção ativa/);
  });

  it('acúmulo: no 4 leva 3 o clique de inverno não soma — só a peça mais barata sai de graça', async () => {
    const forcada = { ...casaco, forcarPromo: true };
    const { svc, itens } = montar({
      activePromotion: 'FOUR_FOR_THREE',
      itens: [forcada, { ...calca }, { ...blusa }, { ...bermuda }],
    });
    await svc.applyAutoDiscounts('s1');
    expect(itens.get('c1')).toMatchObject({ desconto: 0, total: 199.9 });
    expect(itens.get('e1')).toMatchObject({ desconto: 69.9, promoTag: '4 LEVA 3 · 1 grátis' });
    expect(itens.get('b1').desconto).toBe(0);
  });

  it('quantidade 2: o desconto é por unidade e total + desconto = bruto', async () => {
    const { svc, itens } = montar({ activePromotion: 'POR_TERMO', itens: [{ ...blusa, qty: 2 }] });
    await svc.updateItem({ saleId: 's1', itemId: 'b1', forcePromo: true });
    const b = itens.get('b1');
    expect(b.total).toBe(Math.round(precoComDesconto(119.9, 30) * 2 * 100) / 100);
    expect(Math.round((b.total + b.desconto) * 100) / 100).toBe(239.8);
  });

  it('venda com casaco, blusa e calça: o desconto é POR ITEM, nunca no carrinho inteiro', async () => {
    const { svc, itens, prisma } = montar({ activePromotion: 'POR_TERMO', itens: [casaco, blusa, calca] });
    await svc.applyAutoDiscounts('s1');
    expect(itens.get('c1').total).toBe(precoComDesconto(199.9, 30));
    expect(itens.get('b1')).toMatchObject({ desconto: 0, total: 119.9 });
    expect(itens.get('m1').total).toBe(precoComDesconto(179.9, 30));
    // Nada de desconto na venda: o motor só escreve nos itens.
    expect(prisma.pdvSale.update).not.toHaveBeenCalled();
  });
});
