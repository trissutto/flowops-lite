import { pedidoOnlineEmAndamento, situacaoPedidoOnline } from './situacao-pedido-online';

describe('situacaoPedidoOnline', () => {
  test('sem separação nenhuma = está na matriz (o estado que mais trava)', () => {
    const s = situacaoPedidoOnline({ orderStatus: 'processing', picks: [] });
    expect(s.chave).toBe('matriz');
    expect(s.detalhe).toContain('Não mande peça por conta');
  });

  test('card criado mas parado = aguardando a loja, com o nome dela', () => {
    const s = situacaoPedidoOnline({
      orderStatus: 'separating',
      picks: [{ status: 'new', storeName: 'SANTOS' }],
    });
    expect(s.chave).toBe('aguardando');
    expect(s.detalhe).toContain('SANTOS');
  });

  test('separando e pronto p/ postar', () => {
    expect(situacaoPedidoOnline({ picks: [{ status: 'separating', storeName: 'SANTOS' }] }).chave)
      .toBe('separando');
    expect(situacaoPedidoOnline({ picks: [{ status: 'separated', storeName: 'SANTOS' }] }).chave)
      .toBe('pronto');
  });

  test('retirada troca o rótulo — não é postar, é a cliente buscar', () => {
    const s = situacaoPedidoOnline({
      picks: [{ status: 'ready', storeName: 'ITANHAÉM' }],
      isPickup: true,
    });
    expect(s.rotulo).toBe('Pronto p/ retirada');
    expect(s.detalhe).toContain('retirar na ITANHAÉM');
  });

  test('pedido em 2 lojas segue a MENOS adiantada — o pacote só sai com tudo', () => {
    const s = situacaoPedidoOnline({
      picks: [
        { status: 'shipped', storeName: 'SANTOS' },
        { status: 'separating', storeName: 'PIRACICABA' },
      ],
    });
    expect(s.chave).toBe('separando');
    expect(s.detalhe).toContain('PIRACICABA');
    expect(s.detalhe).toContain('2 lojas');
  });

  test('enviado mostra o rastreio pra vendedora repassar', () => {
    const s = situacaoPedidoOnline({
      picks: [{ status: 'shipped', storeName: 'SANTOS' }],
      trackingCode: 'AA123456789BR',
    });
    expect(s.chave).toBe('enviado');
    expect(s.detalhe).toContain('AA123456789BR');
  });

  test('entregue e cancelado vêm do pedido, não da separação', () => {
    expect(situacaoPedidoOnline({ orderStatus: 'delivered', picks: [{ status: 'shipped' }] }).chave)
      .toBe('entregue');
    expect(situacaoPedidoOnline({ orderStatus: 'cancelled', picks: [{ status: 'new' }] }).chave)
      .toBe('cancelado');
  });

  test('em andamento = tudo que ainda pode dar errado', () => {
    expect(pedidoOnlineEmAndamento('matriz')).toBe(true);
    expect(pedidoOnlineEmAndamento('enviado')).toBe(true);
    expect(pedidoOnlineEmAndamento('entregue')).toBe(false);
    expect(pedidoOnlineEmAndamento('cancelado')).toBe(false);
  });
});
