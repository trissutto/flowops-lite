import { PecasExtraviadasService } from './pecas-extraviadas.service';

/**
 * A regra que este teste protege é a frase do dono:
 *   "não peça mais ela, mas não desapareça — senão vira festa".
 * Ou seja: sai do ROTEAMENTO, não sai do ESTOQUE.
 */
describe('PecasExtraviadasService', () => {
  const montar = (linhasAbertas: any[] = []) => {
    const create = jest.fn().mockResolvedValue({});
    const update = jest.fn().mockResolvedValue({});
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma: any = {
      pecaExtraviada: {
        findFirst: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(
            linhasAbertas.find((l) => l.storeCode === where.storeCode && l.sku === where.sku) ?? null,
          ),
        ),
        findMany: jest.fn().mockResolvedValue(linhasAbertas),
        create, update, updateMany,
      },
    };
    return { svc: new PecasExtraviadasService(prisma), prisma, create, update, updateMany };
  };

  beforeEach(() => { delete process.env.EXTRAVIADA_BLOQUEIA_ROTEAMENTO; });

  describe('marcar', () => {
    it('grava a peça que a loja não achou', async () => {
      const { svc, create } = montar();
      expect(await svc.marcar([{ storeCode: '15', sku: '8000000002433' }], { motivo: 'out_of_stock' })).toBe(1);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ storeCode: '15', sku: '8000000002433', qty: 1, motivo: 'out_of_stock' }),
        }),
      );
    });

    it('reportar de novo NÃO duplica linha', async () => {
      const { svc, create } = montar([{ id: 'x', storeCode: '15', sku: '8000000002433', qty: 1 }]);
      expect(await svc.marcar([{ storeCode: '15', sku: '8000000002433' }])).toBe(0);
      expect(create).not.toHaveBeenCalled();
    });

    it('mas sobe a quantidade se a loja disse que faltam mais', async () => {
      const { svc, update } = montar([{ id: 'x', storeCode: '15', sku: '5397594', qty: 1 }]);
      await svc.marcar([{ storeCode: '15', sku: '5397594', qty: 3 }]);
      expect(update).toHaveBeenCalledWith({ where: { id: 'x' }, data: { qty: 3 } });
    });

    it('normaliza SKU com zero à esquerda (mesma régua do roteamento)', async () => {
      const { svc, create } = montar();
      await svc.marcar([{ storeCode: '15', sku: '0005397594' }]);
      expect(create.mock.calls[0][0].data.sku).toBe('5397594');
    });

    it('ignora entrada sem loja ou sem sku', async () => {
      const { svc, create } = montar();
      expect(await svc.marcar([{ storeCode: '', sku: '123' }, { storeCode: '15', sku: '' }])).toBe(0);
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('mapaParaRoteamento', () => {
    it('devolve a chave loja::sku que o roteamento desconta', async () => {
      const { svc } = montar([
        { storeCode: '15', sku: '5397594', qty: 1 },
        { storeCode: '03', sku: '5397594', qty: 2 },
      ]);
      const m = await svc.mapaParaRoteamento(['5397594'], ['15', '03']);
      expect(m.get('15::5397594')).toBe(1);
      expect(m.get('03::5397594')).toBe(2);
    });

    it('soma quando a mesma loja tem mais de uma linha aberta', async () => {
      const { svc } = montar([
        { storeCode: '15', sku: '5397594', qty: 1 },
        { storeCode: '15', sku: '5397594', qty: 1 },
      ]);
      expect((await svc.mapaParaRoteamento(['5397594'], ['15'])).get('15::5397594')).toBe(2);
    });

    it('EXTRAVIADA_BLOQUEIA_ROTEAMENTO=0 devolve mapa vazio (marcação continua gravando)', async () => {
      process.env.EXTRAVIADA_BLOQUEIA_ROTEAMENTO = '0';
      const { svc, prisma } = montar([{ storeCode: '15', sku: '5397594', qty: 1 }]);
      expect((await svc.mapaParaRoteamento(['5397594'], ['15'])).size).toBe(0);
      expect(prisma.pecaExtraviada.findMany).not.toHaveBeenCalled();
    });

    it('sem sku ou sem loja não vai ao banco', async () => {
      const { svc, prisma } = montar();
      expect((await svc.mapaParaRoteamento([], ['15'])).size).toBe(0);
      expect((await svc.mapaParaRoteamento(['5397594'], [])).size).toBe(0);
      expect(prisma.pecaExtraviada.findMany).not.toHaveBeenCalled();
    });
  });

  describe('achei a peça', () => {
    it('não apaga a linha — carimba achadaEm (o histórico é o que denuncia arara bagunçada)', async () => {
      const { svc, updateMany } = montar();
      await svc.marcarAchada('linha-1', 'user-9');
      const arg = updateMany.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'linha-1', achadaEm: null });
      expect(arg.data.achadaEm).toBeInstanceOf(Date);
      expect(arg.data.achadaPor).toBe('user-9');
    });

    it('por loja+sku também normaliza o sku', async () => {
      const { svc, updateMany } = montar();
      await svc.marcarAchadaPorSku('15', '0005397594');
      expect(updateMany.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ storeCode: '15', sku: '5397594', achadaEm: null }),
      );
    });
  });
});
