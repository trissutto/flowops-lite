import { pedidoPago, pedidoCancelado, pedidoNaoPago, comPedidoPago } from './pedido-pago';

describe('pedidoPago — a régua da receita', () => {
  it('cartão RECUSADO do site novo NÃO é receita (era o furo de 24,7%)', () => {
    const o = { status: 'payment_failed', source: 'ecommerce', paidAt: null };
    expect(pedidoPago(o)).toBe(false);
    expect(pedidoNaoPago(o)).toBe(true);   // aparece na coluna "não pagos"
    expect(pedidoCancelado(o)).toBe(false); // mas NÃO é cancelamento
  });

  it('PIX/link gerado e nunca pago NÃO é receita', () => {
    expect(pedidoPago({ status: 'awaiting_payment', source: 'ecommerce', paidAt: null })).toBe(false);
  });

  it('pedido do site novo com carimbo É receita', () => {
    expect(pedidoPago({ status: 'separating', source: 'ecommerce', paidAt: new Date() })).toBe(true);
  });

  it('site novo SEM carimbo não passa, mesmo com status de trilho andado', () => {
    // Rede de segurança do degrau 2: hoje isso não existe na base, mas se um
    // pedido pular pra separating sem pagar, ele não entra no faturamento.
    expect(pedidoPago({ status: 'separating', source: 'ecommerce', paidAt: null })).toBe(false);
  });

  it('WooCommerce (0% de paidAt em 22.397 pedidos) continua contando pelo status', () => {
    expect(pedidoPago({ status: 'delivered', source: 'site', paidAt: null })).toBe(true);
    expect(pedidoPago({ status: 'shipped', source: 'site', paidAt: null })).toBe(true);
    // ...mas o que nasceu e nunca andou, não.
    expect(pedidoPago({ status: 'pending', source: 'site', paidAt: null })).toBe(false);
  });

  it('live (0% de paidAt) idem — enviado/entregue é pago', () => {
    expect(pedidoPago({ status: 'shipped', source: 'live', paidAt: null })).toBe(true);
  });

  it('cancelado é cancelado mesmo tendo sido pago antes (estorno)', () => {
    const o = { status: 'cancelled', source: 'ecommerce', paidAt: new Date() };
    expect(pedidoPago(o)).toBe(false);
    expect(pedidoCancelado(o)).toBe(true);
    expect(pedidoNaoPago(o)).toBe(false); // não é "nunca pagou", é estorno
  });

  it('status vazio/nulo não vira receita por omissão', () => {
    expect(pedidoPago({ status: '', source: 'site' })).toBe(false);
    expect(pedidoPago(null)).toBe(false);
  });

  it('comPedidoPago preserva o filtro de quem chamou (não sobrescreve OR)', () => {
    const w = comPedidoPago({ OR: [{ wcDateCreated: { gte: new Date() } }] });
    expect(w.AND).toHaveLength(3);
    expect(w.AND[0]).toEqual({ OR: [{ wcDateCreated: expect.anything() }] });
    expect(w.AND[1].status.notIn).toContain('payment_failed');
  });
});
