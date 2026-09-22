import { createHmac } from 'crypto';
import {
  PRAZO_PIX_DIAS,
  SENHA_MAX_TENTATIVAS,
  assinarSessaoEstorno,
  bloqueioDeSenha,
  fraseDoComprovante,
  lerRespostaPagarme,
  lerRespostaPagbank,
  lerSessaoEstorno,
  mascararCpf,
  mascararEmail,
  podeEstornar,
  rotuloDoMotivo,
  saldoEstornavelCents,
  validarValorEstorno,
} from './estornos';

/**
 * A RÉGUA DO ESTORNO — é dinheiro saindo da conta.
 *
 * Os dois erros que ninguém vê na hora: devolver MAIS do que entrou, e
 * carimbar "processado" um estorno que o gateway não confirmou. Ficam cobertos
 * aqui, junto com a trava de senha e o que o comprovante pode dizer.
 */
describe('estornos — valor e saldo', () => {
  it('saldo = pago − já estornado, nunca negativo', () => {
    expect(saldoEstornavelCents({ pagoCents: 50000, estornadoCents: 10000 })).toBe(40000);
    expect(saldoEstornavelCents({ pagoCents: 50000, estornadoCents: 50000 })).toBe(0);
    expect(saldoEstornavelCents({ pagoCents: 50000, estornadoCents: 60000 })).toBe(0);
  });

  it('INTEGRAL é o saldo que sobrou, não o valor original', () => {
    const r = validarValorEstorno({ valorCents: 0, saldoCents: 40000, tipo: 'integral' });
    expect(r).toEqual({ ok: true, valorCents: 40000 });
  });

  it('parcial dentro do saldo passa; acima do saldo é recusado com o valor na frase', () => {
    expect(validarValorEstorno({ valorCents: 15000, saldoCents: 40000, tipo: 'parcial' })).toEqual({
      ok: true,
      valorCents: 15000,
    });
    const r = validarValorEstorno({ valorCents: 45000, saldoCents: 40000, tipo: 'parcial' }) as any;
    expect(r.ok).toBe(false);
    expect(r.erro).toContain('R$ 450,00');
    expect(r.erro).toContain('R$ 400,00');
  });

  it('valor zerado, negativo ou sem saldo não vira estorno', () => {
    expect((validarValorEstorno({ valorCents: 0, saldoCents: 40000, tipo: 'parcial' }) as any).ok).toBe(false);
    expect((validarValorEstorno({ valorCents: -100, saldoCents: 40000, tipo: 'parcial' }) as any).ok).toBe(false);
    expect((validarValorEstorno({ valorCents: 100, saldoCents: 0, tipo: 'parcial' }) as any).ok).toBe(false);
    expect((validarValorEstorno({ valorCents: 0, saldoCents: 0, tipo: 'integral' }) as any).ok).toBe(false);
  });
});

describe('estornos — o pagamento aceita estorno?', () => {
  const agora = new Date('2026-09-22T12:00:00Z');
  const pago = { metodo: 'credit_card', status: 'paid', pagoEm: '2026-09-20T12:00:00Z', chargeId: 'CHAR_1' };

  it('cobrança paga com charge id pode', () => {
    expect(podeEstornar(pago, agora)).toEqual({ pode: true });
  });

  it('cobrança não paga não pode (regra do PagBank)', () => {
    const r = podeEstornar({ ...pago, status: 'pending' }, agora);
    expect(r.pode).toBe(false);
    expect(r.motivo).toContain('PAGA');
  });

  it('sem id da cobrança não dá pra pedir estorno nenhum', () => {
    const r = podeEstornar({ ...pago, chargeId: null }, agora);
    expect(r.pode).toBe(false);
    expect(r.motivo).toContain('id da cobrança');
  });

  it(`PIX fora dos ${PRAZO_PIX_DIAS} dias é recusado ANTES de ir ao gateway`, () => {
    const velho = { ...pago, metodo: 'pix', pagoEm: '2026-06-01T12:00:00Z' };
    const r = podeEstornar(velho, agora);
    expect(r.pode).toBe(false);
    expect(r.motivo).toContain('90 dias');
    // No prazo, passa.
    expect(podeEstornar({ ...velho, pagoEm: '2026-09-01T12:00:00Z' }, agora).pode).toBe(true);
  });

  it('cartão antigo continua podendo (o prazo de 90 dias é do PIX)', () => {
    expect(podeEstornar({ ...pago, pagoEm: '2026-01-01T12:00:00Z' }, agora).pode).toBe(true);
  });
});

describe('estornos — leitura da resposta do gateway', () => {
  it('PagBank: CANCELED = integral processado', () => {
    const r = lerRespostaPagbank({ status: 'CANCELED', amount: { summary: { total: 50000, paid: 50000, refunded: 50000 } } }, 50000);
    expect(r.status).toBe('processado');
    expect(r.estornadoTotalCents).toBe(50000);
  });

  it('PagBank: parcial mantém PAID e confirma pelo refunded acumulado', () => {
    const r = lerRespostaPagbank(
      { status: 'PAID', amount: { summary: { total: 50000, paid: 50000, refunded: 25000 } } },
      15000,
      10000,
    );
    expect(r.status).toBe('processado');
    expect(r.estornadoTotalCents).toBe(25000);
  });

  it('PagBank: PAID sem o refunded esperado fica EM PROCESSAMENTO (nunca "processado")', () => {
    const r = lerRespostaPagbank({ status: 'PAID', amount: { summary: { total: 50000, paid: 50000, refunded: 0 } } }, 20000);
    expect(r.status).toBe('processando');
  });

  it('PagBank: resposta sem refunded nenhum também fica em processamento', () => {
    expect(lerRespostaPagbank({ status: 'PAID' }, 20000).status).toBe('processando');
  });

  it('PagBank: DECLINED é recusa, com a frase do gateway', () => {
    const r = lerRespostaPagbank({ status: 'DECLINED', payment_response: { message: 'Saldo insuficiente na conta' } }, 20000);
    expect(r.status).toBe('recusado');
    expect(r.mensagem).toBe('Saldo insuficiente na conta');
  });

  it('Pagar.me: cartão devolvido na hora', () => {
    const r = lerRespostaPagarme({ status: 'canceled', canceled_amount: 50000, last_transaction: { status: 'refunded' } }, 50000);
    expect(r.status).toBe('processado');
    expect(r.estornadoTotalCents).toBe(50000);
  });

  it('Pagar.me: pending_refund (PIX) fica em processamento', () => {
    const r = lerRespostaPagarme({ status: 'paid', canceled_amount: 0, last_transaction: { status: 'pending_refund' } }, 10000);
    expect(r.status).toBe('processando');
  });

  it('Pagar.me: parcial confirmado pelo canceled_amount acumulado', () => {
    const r = lerRespostaPagarme({ status: 'paid', canceled_amount: 30000, last_transaction: { status: 'captured' } }, 10000, 20000);
    expect(r.status).toBe('processado');
  });

  it('Pagar.me: refund_error é recusa', () => {
    expect(lerRespostaPagarme({ status: 'paid', last_transaction: { status: 'refund_error' } }, 10000).status).toBe('recusado');
  });
});

describe('estornos — senha e bloqueio', () => {
  const agora = new Date('2026-09-22T12:00:00Z');
  const erroEm = (minAtras: number) => ({ em: new Date(agora.getTime() - minAtras * 60_000) });

  it(`solta com menos de ${SENHA_MAX_TENTATIVAS} erros na janela`, () => {
    const r = bloqueioDeSenha([erroEm(1), erroEm(2), erroEm(3), erroEm(4)], agora);
    expect(r.bloqueado).toBe(false);
    expect(r.tentativas).toBe(4);
  });

  it('bloqueia no 5º erro e diz quanto falta', () => {
    const r = bloqueioDeSenha([erroEm(1), erroEm(2), erroEm(3), erroEm(4), erroEm(5)], agora);
    expect(r.bloqueado).toBe(true);
    expect(r.faltamMs).toBeGreaterThan(9 * 60_000);
    expect(r.faltamMs).toBeLessThanOrEqual(10 * 60_000);
  });

  it('erro velho (fora da janela de 15 min) não conta', () => {
    const r = bloqueioDeSenha([erroEm(20), erroEm(30), erroEm(40), erroEm(50), erroEm(60)], agora);
    expect(r.bloqueado).toBe(false);
    expect(r.tentativas).toBe(0);
  });
});

describe('estornos — bilhete da sessão (senha da entrada vale 15 min)', () => {
  const hmac = (segredo: string, texto: string) => createHmac('sha256', segredo).update(texto).digest('hex');
  const segredo = 'segredo-de-teste';
  const agora = Date.now();

  it('ida e volta', () => {
    const t = assinarSessaoEstorno({ userId: 'u1', nivel: 'MASTER', expEm: agora + 60_000 }, segredo, hmac);
    expect(lerSessaoEstorno(t, segredo, hmac, agora)).toEqual({ userId: 'u1', nivel: 'MASTER' });
  });

  it('bilhete vencido não abre', () => {
    const t = assinarSessaoEstorno({ userId: 'u1', nivel: 'MASTER', expEm: agora - 1 }, segredo, hmac);
    expect(lerSessaoEstorno(t, segredo, hmac, agora)).toBeNull();
  });

  it('assinatura trocada, corpo adulterado ou segredo diferente não abrem', () => {
    const t = assinarSessaoEstorno({ userId: 'u1', nivel: 'MASTER', expEm: agora + 60_000 }, segredo, hmac);
    expect(lerSessaoEstorno(`${t}x`, segredo, hmac, agora)).toBeNull();
    expect(lerSessaoEstorno(t, 'outro-segredo', hmac, agora)).toBeNull();
    const [, ass] = t.split('.');
    const forjado = `${Buffer.from('u2.SUPREMA.' + (agora + 60_000)).toString('base64url')}.${ass}`;
    expect(lerSessaoEstorno(forjado, segredo, hmac, agora)).toBeNull();
    expect(lerSessaoEstorno(undefined, segredo, hmac, agora)).toBeNull();
  });
});

describe('estornos — comprovante e máscaras', () => {
  it('o comprovante nunca diz "processado" com o gateway pendente', () => {
    expect(fraseDoComprovante('processado')).toEqual({ titulo: 'ESTORNO PROCESSADO', podeEmitir: true });
    expect(fraseDoComprovante('processando')).toEqual({ titulo: 'ESTORNO EM PROCESSAMENTO', podeEmitir: true });
    expect(fraseDoComprovante('recusado').podeEmitir).toBe(false);
    expect(fraseDoComprovante('erro').podeEmitir).toBe(false);
  });

  it('CPF e e-mail saem mascarados no PDF', () => {
    expect(mascararCpf('12345678909')).toBe('***.456.789-**');
    expect(mascararCpf('123')).toBe('—');
    expect(mascararEmail('maria@gmail.com')).toBe('ma***@gmail.com');
    expect(mascararEmail('')).toBe('—');
  });

  it('motivo vira rótulo legível', () => {
    expect(rotuloDoMotivo('devolucao_produto')).toBe('Devolução de produto');
    expect(rotuloDoMotivo('bagunca')).toBe('bagunca');
  });
});
