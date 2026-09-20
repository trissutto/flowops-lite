import { centsDaBaixaNoGateway, donosDosPagamentos, reaisParaCents } from './dono-do-pagamento';

/** Prisma de mentira: cada tabela devolve só as linhas cujo id foi pedido. */
function prismaFalso(tabelas: {
  pdvSale?: any[];
  livePdvCart?: any[];
  crediarioBaixa?: any[];
  order?: any[];
}) {
  const chamadas: Record<string, number> = { pdvSale: 0, livePdvCart: 0, crediarioBaixa: 0, order: 0 };
  const tabela = (nome: keyof typeof tabelas) => ({
    findMany: jest.fn(async ({ where }: any) => {
      chamadas[nome]++;
      const ids: string[] = where.id.in;
      return (tabelas[nome] || []).filter((l) => ids.includes(l.id));
    }),
  });
  return {
    chamadas,
    pdvSale: tabela('pdvSale'),
    livePdvCart: tabela('livePdvCart'),
    crediarioBaixa: tabela('crediarioBaixa'),
    order: tabela('order'),
  };
}

describe('dono do pagamento', () => {
  describe('reaisParaCents', () => {
    it('arredonda o float do banco pro centavo', () => {
      expect(reaisParaCents(275.61)).toBe(27561);
      expect(reaisParaCents(85.89)).toBe(8589);
      expect(reaisParaCents('790.57')).toBe(79057);
    });

    it('lixo vira null, nunca zero', () => {
      expect(reaisParaCents(null)).toBeNull();
      expect(reaisParaCents(undefined)).toBeNull();
      expect(reaisParaCents('')).toBeNull();
      expect(reaisParaCents('abc')).toBeNull();
    });
  });

  describe('centsDaBaixaNoGateway', () => {
    it('baixa só no PIX: o gateway recebeu o total pago', () => {
      expect(centsDaBaixaNoGateway({ formaPagamento: 'pix', totalPago: 317, valorPix: null })).toBe(31700);
    });

    it('baixa MISTA: o gateway recebeu só a parte do PIX', () => {
      // R$ 300 no total, R$ 100 em dinheiro no caixa e R$ 200 no QR.
      expect(centsDaBaixaNoGateway({ formaPagamento: 'misto', totalPago: 300, valorPix: 200 })).toBe(20000);
    });

    it('mista sem valorPix gravado cai no total (não inventa zero)', () => {
      expect(centsDaBaixaNoGateway({ formaPagamento: 'misto', totalPago: 300, valorPix: null })).toBe(30000);
      expect(centsDaBaixaNoGateway({ formaPagamento: 'misto', totalPago: 300, valorPix: 0 })).toBe(30000);
    });
  });

  describe('donosDosPagamentos', () => {
    const tabelas = {
      pdvSale: [{ id: 'venda-1', total: 689.6, customerName: 'Consumidor Final' }],
      livePdvCart: [{ id: 'live-1', totalCents: 15990, customerName: '@maria' }],
      crediarioBaixa: [
        { id: 'baixa-1', formaPagamento: 'pix', valorPix: null, totalPago: 790.57, customerName: 'ALINI BORGES DE LIMA' },
      ],
      order: [{ id: 'pedido-1', totalAmount: 275.61, customerName: 'Camila Rigolo' }],
    };

    it('reconhece os QUATRO donos — pedido do site e crediário inclusive', async () => {
      const donos = await donosDosPagamentos(prismaFalso(tabelas), ['venda-1', 'live-1', 'baixa-1', 'pedido-1']);
      expect(donos.get('venda-1')).toEqual({ tipo: 'pdv', cents: 68960, clienteNome: 'Consumidor Final' });
      expect(donos.get('live-1')).toEqual({ tipo: 'live', cents: 15990, clienteNome: '@maria' });
      expect(donos.get('baixa-1')).toEqual({ tipo: 'crediario', cents: 79057, clienteNome: 'ALINI BORGES DE LIMA' });
      expect(donos.get('pedido-1')).toEqual({ tipo: 'site', cents: 27561, clienteNome: 'Camila Rigolo' });
    });

    it('quem não está em tabela nenhuma fica FORA do mapa — é o órfão de verdade', async () => {
      const donos = await donosDosPagamentos(prismaFalso(tabelas), ['pedido-1', 'fantasma']);
      expect(donos.has('pedido-1')).toBe(true);
      expect(donos.has('fantasma')).toBe(false);
    });

    it('ignora ref vazia/nula e repete id sem repetir consulta', async () => {
      const prisma = prismaFalso(tabelas);
      const donos = await donosDosPagamentos(prisma, [null, undefined, '', '  ', 'venda-1', 'venda-1']);
      expect(donos.size).toBe(1);
      expect(prisma.pdvSale.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.pdvSale.findMany.mock.calls[0][0].where.id.in).toEqual(['venda-1']);
    });

    it('sem nenhuma ref não vai ao banco', async () => {
      const prisma = prismaFalso(tabelas);
      const donos = await donosDosPagamentos(prisma, [null, '']);
      expect(donos.size).toBe(0);
      expect(prisma.order.findMany).not.toHaveBeenCalled();
    });

    it('consulta em LOTE: 2.500 refs viram 3 idas por tabela, não 2.500', async () => {
      const prisma = prismaFalso(tabelas);
      const refs = Array.from({ length: 2500 }, (_, i) => `ref-${i}`);
      await donosDosPagamentos(prisma, refs);
      expect(prisma.chamadas).toEqual({ pdvSale: 3, livePdvCart: 3, crediarioBaixa: 3, order: 3 });
    });

    it('erro do banco SOBE — consulta que falhou não pode virar "sem dono"', async () => {
      const prisma = prismaFalso(tabelas);
      prisma.order.findMany.mockRejectedValueOnce(new Error('conexão caiu'));
      await expect(donosDosPagamentos(prisma, ['pedido-1'])).rejects.toThrow('conexão caiu');
    });
  });
});
