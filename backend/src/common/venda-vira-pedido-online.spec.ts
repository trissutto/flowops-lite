import { vendaViraPedidoOnline } from './venda-vira-pedido-online';

const pag = (...methods: string[]) => methods.map((method) => ({ method }));

describe('vendaViraPedidoOnline', () => {
  it('venda 100% venda_online vira pedido (fluxo que já existia)', () => {
    expect(vendaViraPedidoOnline(pag('venda_online'), 'sedex')).toBe(true);
    expect(vendaViraPedidoOnline(pag('venda_online', 'venda_online'), null)).toBe(true);
  });

  it('venda_online sem entregaTipo vira pedido mesmo assim (ON-000105: cron fecha com entrega em branco)', () => {
    expect(vendaViraPedidoOnline(pag('venda_online'), null)).toBe(true);
    expect(vendaViraPedidoOnline(pag('venda_online'), '')).toBe(true);
  });

  it('TROCA ONLINE com diferença: vale_troca + venda_online vira pedido (caso loja 08, 25/08)', () => {
    expect(vendaViraPedidoOnline(pag('vale_troca', 'venda_online'), 'sedex')).toBe(true);
    // Mesmo sem entregaTipo gravado — o pagamento online já prova o fluxo.
    expect(vendaViraPedidoOnline(pag('vale_troca', 'venda_online'), null)).toBe(true);
  });

  it('mistura de balcão + venda_online vira pedido (a peça viaja do mesmo jeito)', () => {
    expect(vendaViraPedidoOnline(pag('pix', 'venda_online'), null)).toBe(true);
    expect(vendaViraPedidoOnline(pag('venda_online', 'dinheiro'), null)).toBe(true);
  });

  it('TROCA PAR online: 100% vale_troca só vira pedido com forma de envio escolhida', () => {
    expect(vendaViraPedidoOnline(pag('vale_troca'), 'sedex')).toBe(true);
    expect(vendaViraPedidoOnline(pag('vale_troca', 'vale_troca'), 'pac')).toBe(true);
  });

  it('troca par de BALCÃO (vale_troca sem entrega) fica no balcão', () => {
    expect(vendaViraPedidoOnline(pag('vale_troca'), null)).toBe(false);
    expect(vendaViraPedidoOnline(pag('vale_troca'), '  ')).toBe(false);
  });

  it('pagamento de balcão com entregaTipo pra trás NÃO vira pedido (sem card falso na fila)', () => {
    expect(vendaViraPedidoOnline(pag('pix'), 'sedex')).toBe(false);
    expect(vendaViraPedidoOnline(pag('dinheiro'), 'motoboy')).toBe(false);
    expect(vendaViraPedidoOnline(pag('credito', 'vale_troca'), 'sedex')).toBe(false);
  });

  it('venda sem pagamento nenhum nunca vira pedido (every vacuoso da régua antiga)', () => {
    expect(vendaViraPedidoOnline([], 'sedex')).toBe(false);
    expect(vendaViraPedidoOnline(null, 'sedex')).toBe(false);
    expect(vendaViraPedidoOnline(undefined, null)).toBe(false);
  });

  it('método é normalizado (caixa/espaço)', () => {
    expect(vendaViraPedidoOnline(pag(' Venda_Online '), null)).toBe(true);
    expect(vendaViraPedidoOnline([{ method: 'VALE_TROCA' }], 'sedex')).toBe(true);
    expect(vendaViraPedidoOnline([{ method: null }], 'sedex')).toBe(false);
  });
});
