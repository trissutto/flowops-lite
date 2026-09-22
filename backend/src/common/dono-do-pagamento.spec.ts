import { centsDaBaixaNoGateway, donosDosPagamentos, reaisParaCents, situacaoDoDono } from './dono-do-pagamento';

/** Prisma de mentira: cada tabela devolve só as linhas cujo id foi pedido. */
function prismaFalso(tabelas: {
  pdvSale?: any[];
  livePdvCart?: any[];
  crediarioBaixa?: any[];
  order?: any[];
  pdvSalePayment?: any[];
  orderItemSwap?: any[];
}) {
  const chamadas: Record<string, number> = { pdvSale: 0, livePdvCart: 0, crediarioBaixa: 0, order: 0 };
  const tabela = (nome: 'pdvSale' | 'livePdvCart' | 'crediarioBaixa' | 'order') => ({
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
    pdvSalePayment: {
      findMany: jest.fn(async ({ where }: any) =>
        (tabelas.pdvSalePayment || []).filter((l) => where.saleId.in.includes(l.saleId)),
      ),
    },
    orderItemSwap: {
      findMany: jest.fn(async ({ where }: any) =>
        (tabelas.orderItemSwap || []).filter((l) => where.id.in.includes(l.id)),
      ),
    },
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

  describe('situacaoDoDono — vocabulário medido em produção (20/09)', () => {
    it('cancelado nas duas grafias da casa', () => {
      expect(situacaoDoDono('pdv', 'cancelled')).toBe('cancelado');
      expect(situacaoDoDono('site', 'cancelled')).toBe('cancelado');
      expect(situacaoDoDono('crediario', 'canceled')).toBe('cancelado');
      expect(situacaoDoDono('live', 'CANCELLED')).toBe('cancelado');
    });

    it('dono que nunca fechou: pagamento pago em cima dele é dinheiro que o sistema não viu', () => {
      expect(situacaoDoDono('pdv', 'open')).toBe('em_aberto');
      expect(situacaoDoDono('live', 'open')).toBe('em_aberto');
      expect(situacaoDoDono('crediario', 'pending')).toBe('em_aberto');
      for (const s of ['awaiting_payment', 'payment_failed', 'pending']) expect(situacaoDoDono('site', s)).toBe('em_aberto');
    });

    it('de pé', () => {
      expect(situacaoDoDono('pdv', 'finalized')).toBe('ok');
      expect(situacaoDoDono('crediario', 'paid')).toBe('ok');
      for (const s of ['paid', 'separating', 'shipped']) expect(situacaoDoDono('live', s)).toBe('ok');
      for (const s of ['processing', 'awaiting_stock', 'separating', 'shipped', 'delivered']) {
        expect(situacaoDoDono('site', s)).toBe('ok');
      }
    });

    it('status desconhecido ou vazio NÃO acusa — na dúvida, sem alarme', () => {
      expect(situacaoDoDono('site', 'status_que_ainda_nao_existe')).toBe('ok');
      expect(situacaoDoDono('pdv', null)).toBe('ok');
      expect(situacaoDoDono('pdv', undefined)).toBe('ok');
    });
  });

  describe('donosDosPagamentos', () => {
    const tabelas = {
      pdvSale: [{ id: 'venda-1', total: 689.6, status: 'finalized', customerName: 'Consumidor Final' }],
      livePdvCart: [{ id: 'live-1', totalCents: 15990, status: 'shipped', customerName: '@maria' }],
      crediarioBaixa: [
        {
          id: 'baixa-1', formaPagamento: 'pix', valorPix: null, totalPago: 790.57,
          status: 'paid', customerName: 'ALINI BORGES DE LIMA',
        },
      ],
      order: [{ id: 'pedido-1', totalAmount: 275.61, status: 'cancelled', customerName: 'Camila Rigolo' }],
      pdvSalePayment: [
        { id: 'pg-1', saleId: 'venda-1', method: 'pix', valor: 189.6, details: '{"pagbankOrderId":"ORDE_AAAAAAAA"}' },
        { id: 'pg-2', saleId: 'venda-1', method: 'dinheiro', valor: 500, details: null },
        { id: 'pg-9', saleId: 'outra-venda', method: 'pix', valor: 10, details: null },
      ],
    };

    it('reconhece os QUATRO donos — pedido do site e crediário inclusive — com o status de cada um', async () => {
      const donos = await donosDosPagamentos(prismaFalso(tabelas), ['venda-1', 'live-1', 'baixa-1', 'pedido-1']);
      expect(donos.get('venda-1')).toEqual({
        tipo: 'pdv', cents: 68960, clienteNome: 'Consumidor Final', status: 'finalized', situacao: 'ok',
        vendaComEntrega: false,
      });
      expect(donos.get('live-1')).toEqual({
        tipo: 'live', cents: 15990, clienteNome: '@maria', status: 'shipped', situacao: 'ok',
      });
      expect(donos.get('baixa-1')).toEqual({
        tipo: 'crediario', cents: 79057, clienteNome: 'ALINI BORGES DE LIMA', status: 'paid', situacao: 'ok',
      });
      expect(donos.get('pedido-1')).toEqual({
        tipo: 'site', cents: 27561, clienteNome: 'Camila Rigolo', status: 'cancelled', situacao: 'cancelado',
      });
    });

    it('comPagamentos: a venda do PDV vem com os SEUS pagamentos (é o que casa venda dividida)', async () => {
      const prisma = prismaFalso(tabelas);
      const donos = await donosDosPagamentos(prisma, ['venda-1', 'pedido-1'], { comPagamentos: true });
      expect(donos.get('venda-1')!.pagamentos).toEqual([
        { id: 'pg-1', method: 'pix', cents: 18960, details: '{"pagbankOrderId":"ORDE_AAAAAAAA"}' },
        { id: 'pg-2', method: 'dinheiro', cents: 50000, details: null },
      ]);
      expect(donos.get('pedido-1')!.pagamentos).toBeUndefined();
    });

    it('venda do PDV com ENTREGA é venda online — é o que separa do balcão na coluna Origem', async () => {
      const prisma = prismaFalso({
        pdvSale: [
          { id: 'balcao', total: 10, status: 'finalized', customerName: null, entregaTipo: null },
          { id: 'online', total: 10, status: 'finalized', customerName: null, entregaTipo: 'sedex' },
          { id: 'vazio', total: 10, status: 'finalized', customerName: null, entregaTipo: '  ' },
        ],
      });
      const donos = await donosDosPagamentos(prisma, ['balcao', 'online', 'vazio']);
      expect(donos.get('balcao')!.vendaComEntrega).toBe(false);
      expect(donos.get('online')!.vendaComEntrega).toBe(true);
      expect(donos.get('vazio')!.vendaComEntrega).toBe(false);
    });

    it('sem comPagamentos (lista da tela, pix-orfaos) nem consulta os pagamentos', async () => {
      const prisma = prismaFalso(tabelas);
      const donos = await donosDosPagamentos(prisma, ['venda-1']);
      expect(prisma.pdvSalePayment.findMany).not.toHaveBeenCalled();
      expect(donos.get('venda-1')!.pagamentos).toBeUndefined();
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

    it('diferença de TROCA de peça (troca:<id>) é dinheiro do pedido do site — não é órfã', async () => {
      const prisma = prismaFalso({
        orderItemSwap: [
          { id: 'swap-1', diffCents: 2990, status: 'pending', order: { customerName: 'Maria Souza' } },
          { id: 'swap-2', diffCents: 1500, status: 'settled', order: { customerName: 'Ana Lima' } },
        ],
      });
      const donos = await donosDosPagamentos(prisma, ['troca:swap-1', 'troca:swap-2', 'troca:sumiu']);
      // Pago no gateway com a troca ainda "pending" = o sistema não viu o dinheiro: alguém confere.
      expect(donos.get('troca:swap-1')).toEqual({
        tipo: 'site', cents: 2990, clienteNome: 'Maria Souza', status: 'pending', situacao: 'em_aberto',
      });
      expect(donos.get('troca:swap-2')).toEqual({
        tipo: 'site', cents: 1500, clienteNome: 'Ana Lima', status: 'settled', situacao: 'ok',
      });
      expect(donos.has('troca:sumiu')).toBe(false);
      expect(prisma.orderItemSwap.findMany.mock.calls[0][0].where.id.in).toEqual(['swap-1', 'swap-2', 'sumiu']);
    });

    it('lote sem cobrança de troca nem consulta a tabela de trocas', async () => {
      const prisma = prismaFalso(tabelas);
      await donosDosPagamentos(prisma, ['venda-1', 'pedido-1']);
      expect(prisma.orderItemSwap.findMany).not.toHaveBeenCalled();
    });

    it('erro do banco SOBE — consulta que falhou não pode virar "sem dono"', async () => {
      const prisma = prismaFalso(tabelas);
      prisma.order.findMany.mockRejectedValueOnce(new Error('conexão caiu'));
      await expect(donosDosPagamentos(prisma, ['pedido-1'])).rejects.toThrow('conexão caiu');
    });
  });
});
