import { PedidoEmailService, metodoDePagamento } from './pedido-email.service';

/**
 * O aviso de cancelamento (17/09) tem UMA decisão que não pode errar: dizer
 * "nada foi cobrado" pra quem pagou. Estes testes travam os dois textos.
 */
function servico(): PedidoEmailService {
  return new PedidoEmailService({} as any, { get: () => undefined } as any, {} as any, {} as any, {} as any);
}

describe('aviso de pedido cancelado', () => {
  it('pago por Pix: fala do estorno e do prazo do Pix, nunca "nada foi cobrado"', () => {
    const t = servico().textoCancelamento(' LP-001483', { pago: true, metodo: 'pix' });
    expect(t).toContain('LP-001483 foi cancelado');
    expect(t).toContain('estorno');
    expect(t).toContain('Pix');
    expect(t).not.toContain('Nada foi cobrado');
  });

  it('pago no cartão: fala da fatura', () => {
    const t = servico().textoCancelamento('', { pago: true, metodo: 'credit_card' });
    expect(t).toContain('fatura');
    expect(t).not.toContain('Nada foi cobrado');
  });

  it('pago sem método conhecido: frase genérica do mesmo meio de pagamento', () => {
    const t = servico().textoCancelamento('', { pago: true, metodo: null });
    expect(t).toContain('mesmo meio de pagamento');
  });

  it('não pago: diz que nada foi cobrado e não fala em estorno', () => {
    const t = servico().textoCancelamento(' LP-000001', { pago: false, motivo: 'pagamento não concluído' });
    expect(t).toContain('Nada foi cobrado');
    expect(t).toContain('Motivo: pagamento não concluído.');
    expect(t).not.toContain('estorno do valor');
  });

  it('motivo vazio não deixa "Motivo:" solto', () => {
    const t = servico().textoCancelamento('', { pago: false, motivo: '  ' });
    expect(t).not.toContain('Motivo:');
  });
});

describe('metodoDePagamento', () => {
  it('lê o method do JSON do checkout', () => {
    expect(metodoDePagamento(JSON.stringify({ method: 'PIX', installments: 1 }))).toBe('pix');
    expect(metodoDePagamento({ method: 'credit_card' })).toBe('credit_card');
  });
  it('JSON quebrado, vazio ou sem method vira null — nunca lança', () => {
    expect(metodoDePagamento('{nope')).toBeNull();
    expect(metodoDePagamento('')).toBeNull();
    expect(metodoDePagamento(null)).toBeNull();
    expect(metodoDePagamento(JSON.stringify({ tentativa: 2 }))).toBeNull();
  });
});
