import { PdvService } from './pdv.service';
import { CAMPANHA_PADRAO, criarRegra, precoComDesconto } from '../common/promo-por-termo';

/**
 * O CAIXA APLICANDO A CAMPANHA POR TERMO (inverno 30%, 15/09/2026).
 *
 * O que não pode escapar:
 *   - o item de inverno sai com o MESMO centavo que o site cobra;
 *   - desconto manual, "fora da promo" desta venda e marcado com desconto
 *     continuam intocados;
 *   - a família tirada na mão sai cheia, com etiqueta que diz por quê;
 *   - venda aberta com a campanha antiga (50%) perde o desconto no recálculo;
 *   - o "não é inverno" da vendedora grava a exceção da FAMÍLIA com a loja e
 *     não desfaz a inclusão que a matriz fez na mão.
 */
describe('PdvService — campanha por termo', () => {
  const casaco = { id: 'i1', sku: '8001', ref: 'CAS-10', descricao: 'CASACO LONGO', precoUnit: 99.95, qty: 1, desconto: 0, promoTag: null };
  const vestido = { id: 'i2', sku: '8002', ref: 'VST-20', descricao: 'VESTIDO MIDI', precoUnit: 150, qty: 2, desconto: 0, promoTag: null };
  const manual = { id: 'i3', sku: '8003', ref: 'JAQ-30', descricao: 'JAQUETA JEANS', precoUnit: 200, qty: 1, desconto: 20, promoTag: 'MANUAL' };
  const marcado = { id: 'i4', sku: '8004', ref: 'CAS-40', descricao: 'CASACO CURTO', precoUnit: 80, qty: 1, desconto: 40, promoTag: 'MARCADO' };

  const catalogo = new Map<string, any>([
    ['8001', { codigo: '8001', ref: 'CAS-10', descricao: 'CASACO LONGO PLUS', descricaoPdv: null, grupo: 'CASACOS', preco: 99.95 }],
    ['8002', { codigo: '8002', ref: 'VST-20', descricao: 'VESTIDO MIDI', descricaoPdv: null, grupo: 'VESTIDOS', preco: 150 }],
  ]);

  function montar(opts: { activePromotion: string | null; itens: any[]; excecoes?: any[] }) {
    const updates: any[] = [];
    const saleUpdates: any[] = [];
    const prisma: any = {
      pdvSale: {
        findUnique: jest.fn().mockResolvedValue({ id: 's1', status: 'open', storeCode: '05', activePromotion: opts.activePromotion }),
        update: jest.fn(async (a: any) => { saleUpdates.push(a); return {}; }),
      },
      pdvSaleItem: {
        findMany: jest.fn().mockResolvedValue(opts.itens),
        update: jest.fn(async (a: any) => { updates.push({ id: a.where.id, ...a.data }); return {}; }),
      },
    };
    const regra = criarRegra(CAMPANHA_PADRAO, opts.excecoes ?? []);
    const promoCampanha: any = {
      regra: jest.fn().mockResolvedValue(regra),
      linhasPorCodigo: jest.fn().mockResolvedValue(catalogo),
      decidirCodigo: jest.fn(async (cod: string) => {
        const linha = catalogo.get(cod);
        return linha ? { regra, linha, decisao: regra.decidir(linha) } : null;
      }),
      gravarExcecao: jest.fn(async (i: any) => ({ campanha: 'inverno', excecao: { chave: 'CAS-10', decisao: i.decisao, storeCode: i.storeCode, usuario: i.usuario } })),
    };
    const catalog: any = {
      getPdvProductInfo: jest.fn(async (cod: string) => {
        const l = catalogo.get(cod);
        return l ? { sku: l.codigo, ref: l.ref, descricao: l.descricao, preco: l.preco, cor: null, tamanho: null } : null;
      }),
    };
    const svc = new PdvService(prisma, {} as any, catalog, {} as any, {} as any, promoCampanha, {} as any, {} as any, {} as any, {} as any) as any;
    jest.spyOn(svc, 'recalcTotals').mockResolvedValue(undefined);
    jest.spyOn(svc, 'getSale').mockResolvedValue({ id: 's1' });
    return { svc, updates, saleUpdates, promoCampanha };
  }

  it('casaco sai com 30% no MESMO centavo do site; vestido sai cheio', async () => {
    const { svc, updates } = montar({ activePromotion: 'POR_TERMO', itens: [casaco, vestido] });
    await svc.applyAutoDiscounts('s1');
    const c = updates.find((u) => u.id === 'i1');
    expect(c.total).toBe(precoComDesconto(99.95, 30)); // 69,97 — o preço da vitrine
    expect(c.promoTag).toBe('PROMO 30% · inverno');
    expect(Math.round((c.total + c.desconto) * 100) / 100).toBe(99.95);
    const v = updates.find((u) => u.id === 'i2');
    expect(v.desconto).toBe(0);
    expect(v.total).toBe(300);
    expect(v.promoTag).toBe('Sem promo');
  });

  it('desconto MANUAL e MARCADO com desconto não são tocados', async () => {
    const { svc, updates } = montar({ activePromotion: 'POR_TERMO', itens: [manual, marcado] });
    await svc.applyAutoDiscounts('s1');
    expect(updates).toHaveLength(0);
  });

  it('família tirada na mão sai cheia com a etiqueta "tirada"', async () => {
    const { svc, updates } = montar({
      activePromotion: 'POR_TERMO', itens: [casaco], excecoes: [{ chave: 'CAS-10', decisao: 'fora' }],
    });
    await svc.applyAutoDiscounts('s1');
    expect(updates[0].desconto).toBe(0);
    expect(updates[0].promoTag).toBe('Sem promo · tirada');
  });

  it('venda aberta com o 50% antigo (YEAR_BASED) perde o desconto e o seletor zera', async () => {
    const velho = { ...casaco, desconto: 49.98, total: 49.97, promoTag: 'PROMO 50% · 2022' };
    const { svc, updates, saleUpdates } = montar({ activePromotion: 'YEAR_BASED', itens: [velho] });
    await svc.applyAutoDiscounts('s1');
    expect(updates[0]).toMatchObject({ desconto: 0, total: 99.95, promoTag: null });
    expect(saleUpdates[0].data.activePromotion).toBeNull();
  });

  it('campanha "Nenhuma" limpa a etiqueta "Sem promo" que o motor tinha escrito', async () => {
    const { svc, updates } = montar({ activePromotion: null, itens: [{ ...vestido, promoTag: 'Sem promo' }] });
    await svc.applyAutoDiscounts('s1');
    expect(updates[0].promoTag).toBeNull();
  });

  it('"não é inverno" grava a exceção da família com a loja e recalcula a venda', async () => {
    const { svc, promoCampanha } = montar({ activePromotion: 'POR_TERMO', itens: [casaco] });
    const apply = jest.spyOn(svc, 'applyAutoDiscounts');
    const r = await svc.tirarDaCampanha({ codigo: '8001', motivo: 'é de meia estação', saleId: 's1', usuario: 'Loja 05', storeCode: '05' });
    expect(promoCampanha.gravarExcecao).toHaveBeenCalledWith(
      expect.objectContaining({ codigo: '8001', decisao: 'fora', origem: 'pdv', storeCode: '05', motivo: 'é de meia estação' }),
    );
    expect(apply).toHaveBeenCalledWith('s1');
    expect(r.ok).toBe(true);
    expect(r.jaEstavaFora).toBe(false);
  });

  it('peça que nem estava na campanha não grava nada', async () => {
    const { svc, promoCampanha } = montar({ activePromotion: 'POR_TERMO', itens: [vestido] });
    const r = await svc.tirarDaCampanha({ codigo: '8002', usuario: 'Loja 05', storeCode: '05' });
    expect(r.jaEstavaFora).toBe(true);
    expect(promoCampanha.gravarExcecao).not.toHaveBeenCalled();
  });

  it('não desfaz a inclusão que a matriz fez na mão', async () => {
    const { svc, promoCampanha } = montar({
      activePromotion: 'POR_TERMO', itens: [vestido], excecoes: [{ chave: 'VST-20', decisao: 'dentro' }],
    });
    await expect(svc.tirarDaCampanha({ codigo: '8002', storeCode: '05' })).rejects.toThrow(/matriz/);
    expect(promoCampanha.gravarExcecao).not.toHaveBeenCalled();
  });

  it('a consulta diz o termo que casou e deixa a loja tirar só o que entrou por termo', async () => {
    const { svc } = montar({ activePromotion: 'POR_TERMO', itens: [] });
    const c = await svc.consultarPromocao('8001');
    expect(c.entra).toBe(true);
    expect(c.termo).toBe('CASACO');
    expect(c.podeTirar).toBe(true);
    expect(c.precoPromo).toBe(precoComDesconto(99.95, 30));
    const v = await svc.consultarPromocao('8002');
    expect(v.entra).toBe(false);
    expect(v.podeTirar).toBe(false);
  });
});
