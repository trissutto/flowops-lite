import {
  statusDoPedidoPagarme,
  linkCheckoutAindaDePe,
  corteFailedRechecavel,
  FOLGA_POS_VENCIMENTO_MS,
} from './cobranca-link-viva';

describe('statusDoPedidoPagarme — o pedido inteiro decide', () => {
  const charge = (status: string, created_at?: string) => ({ status, created_at });

  it('pedido sem cobrança nenhuma é pendente (checkout recém-criado)', () => {
    expect(statusDoPedidoPagarme({ status: 'pending', charges: [] })).toBe('pending');
    expect(statusDoPedidoPagarme({})).toBe('pending');
  });

  /**
   * O CASO DE 10/09: cartão recusado de manhã, pago à noite. A Pagar.me
   * devolve as cobranças na ordem de criação, então `charges[0]` é a recusada
   * — ler só ela gravava `failed` num pedido PAGO.
   */
  it('recusada de manhã + paga à noite = PAGO', () => {
    const order = {
      status: 'paid',
      charges: [
        charge('failed', '2026-09-09T13:10:00Z'),
        charge('paid', '2026-09-09T23:40:00Z'),
      ],
    };
    expect(statusDoPedidoPagarme(order)).toBe('paid');
  });

  it('paga em qualquer posição do array ganha', () => {
    expect(statusDoPedidoPagarme({ charges: [charge('paid'), charge('failed')] })).toBe('paid');
    expect(statusDoPedidoPagarme({ charges: [charge('canceled'), charge('overpaid')] })).toBe('paid');
  });

  it('pedido pago sem cobrança na resposta ainda é pago', () => {
    expect(statusDoPedidoPagarme({ status: 'paid', charges: [] })).toBe('paid');
  });

  it('cobrança ainda viva ao lado de uma recusada = pendente', () => {
    const order = { charges: [charge('failed'), charge('pending')] };
    expect(statusDoPedidoPagarme(order)).toBe('pending');
  });

  // A reversão do antifraude (aprovou, reprovou depois — caso 01/08) continua
  // valendo: sem nenhuma cobrança paga, vale a terminal mais nova.
  it('todas terminais: manda a MAIS NOVA', () => {
    const order = {
      charges: [
        charge('canceled', '2026-09-09T10:00:00Z'),
        charge('failed', '2026-09-09T20:00:00Z'),
      ],
    };
    expect(statusDoPedidoPagarme(order)).toBe('failed');

    const inverso = {
      charges: [
        charge('failed', '2026-09-09T10:00:00Z'),
        charge('canceled', '2026-09-09T20:00:00Z'),
      ],
    };
    expect(statusDoPedidoPagarme(inverso)).toBe('canceled');
  });

  it('sem created_at cai na última do array', () => {
    expect(statusDoPedidoPagarme({ charges: [charge('canceled'), charge('failed')] })).toBe('failed');
  });
});

describe('linkCheckoutAindaDePe — recusar não é vencer', () => {
  const agora = Date.parse('2026-09-10T02:00:00Z');
  const emHoras = (h: number) => new Date(agora + h * 3600_000);

  it('tentativa recusada com link no prazo AINDA aceita pagamento', () => {
    expect(linkCheckoutAindaDePe({ status: 'failed', expiresAt: emHoras(40) }, agora)).toBe(true);
  });

  it('pendente no prazo é o caminho de sempre', () => {
    expect(linkCheckoutAindaDePe({ status: 'pending', expiresAt: emHoras(40) }, agora)).toBe(true);
  });

  it('pago e cancelado não aceitam mais nada', () => {
    expect(linkCheckoutAindaDePe({ status: 'paid', expiresAt: emHoras(40) }, agora)).toBe(false);
    expect(linkCheckoutAindaDePe({ status: 'canceled', expiresAt: emHoras(40) }, agora)).toBe(false);
  });

  it('vencido há pouco ainda vale a folga; vencido de vez, não', () => {
    expect(linkCheckoutAindaDePe({ status: 'failed', expiresAt: emHoras(-5) }, agora)).toBe(true);
    expect(linkCheckoutAindaDePe({ status: 'pending', expiresAt: emHoras(-7) }, agora)).toBe(false);
  });

  it('aceita data em texto (o que vem do JSON do gateway)', () => {
    expect(linkCheckoutAindaDePe({ status: 'failed', expiresAt: emHoras(10).toISOString() }, agora)).toBe(true);
  });

  // Cobrança PIX antiga não tem prazo gravado: não inventa caso novo.
  it('sem expiresAt: pendente continua sendo perguntado, failed não', () => {
    expect(linkCheckoutAindaDePe({ status: 'pending', expiresAt: null }, agora)).toBe(true);
    expect(linkCheckoutAindaDePe({ status: 'failed', expiresAt: null }, agora)).toBe(false);
    expect(linkCheckoutAindaDePe({ status: 'failed', expiresAt: 'não é data' }, agora)).toBe(false);
  });

  // A página da cliente chama com folga ZERO: mandar alguém pro checkout já
  // vencido é o 404 sem saída (caso Moema 15/08).
  it('folga zero: vencido é vencido pra quem abre o link', () => {
    expect(linkCheckoutAindaDePe({ status: 'failed', expiresAt: emHoras(-1) }, agora, 0)).toBe(false);
    expect(linkCheckoutAindaDePe({ status: 'pending', expiresAt: emHoras(-1) }, agora, 0)).toBe(false);
    expect(linkCheckoutAindaDePe({ status: 'failed', expiresAt: emHoras(1) }, agora, 0)).toBe(true);
  });

  it('corte do cron é a folga pra trás', () => {
    expect(corteFailedRechecavel(agora).getTime()).toBe(agora - FOLGA_POS_VENCIMENTO_MS);
  });
});
