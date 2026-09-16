import { erroHttpEhDadoDoCartao, lerCartaoPagbank, resumirErrosPagbank } from './pagbank-cartao';

describe('lerCartaoPagbank', () => {
  const orderCom = (charge: any) => ({ id: 'ORDE_1', charges: [charge] });

  it('PAID vira paid com os dados do cartão', () => {
    const r = lerCartaoPagbank(
      orderCom({
        id: 'CHAR_1',
        status: 'PAID',
        payment_response: { code: '20000', message: 'SUCESSO', reference: '082632' },
        payment_method: { card: { brand: 'visa', last_digits: '1111', holder: { name: 'Jose da Silva' } } },
      }),
    );
    expect(r.classe).toBe('paid');
    expect(r.chargeId).toBe('CHAR_1');
    expect(r.codigo).toBe('20000');
    expect(r.referencia).toBe('082632');
    expect(r.bandeira).toBe('visa');
    expect(r.ultimos4).toBe('1111');
    expect(r.titular).toBe('Jose da Silva');
  });

  it('DECLINED e CANCELED são recusa; o resto fica pendente', () => {
    expect(lerCartaoPagbank(orderCom({ status: 'DECLINED' })).classe).toBe('recusa');
    expect(lerCartaoPagbank(orderCom({ status: 'canceled' })).classe).toBe('recusa');
    expect(lerCartaoPagbank(orderCom({ status: 'IN_ANALYSIS' })).classe).toBe('pending');
    expect(lerCartaoPagbank(orderCom({ status: 'AUTHORIZED' })).classe).toBe('pending');
    expect(lerCartaoPagbank(orderCom({ status: 'WAITING' })).classe).toBe('pending');
  });

  it('charge paga vence uma recusada anterior', () => {
    const r = lerCartaoPagbank({
      charges: [
        { id: 'CHAR_A', status: 'DECLINED' },
        { id: 'CHAR_B', status: 'PAID' },
      ],
    });
    expect(r.classe).toBe('paid');
    expect(r.chargeId).toBe('CHAR_B');
  });

  it('sem charge nenhuma é pendente e sem dados', () => {
    const r = lerCartaoPagbank({ id: 'ORDE_2' });
    expect(r.classe).toBe('pending');
    expect(r.chargeId).toBeNull();
    expect(r.bandeira).toBeNull();
  });
});

describe('erroHttpEhDadoDoCartao', () => {
  it('cartão criptografado/titular inválido é dado do cartão', () => {
    expect(
      erroHttpEhDadoDoCartao({
        error_messages: [{ code: '40002', description: 'invalid_parameter', parameter_name: 'charges[0].payment_method.card.encrypted' }],
      }),
    ).toBe(true);
    expect(
      erroHttpEhDadoDoCartao({
        error_messages: [{ code: '40002', description: 'invalid_parameter', parameter_name: 'charges[0].payment_method.holder.tax_id' }],
      }),
    ).toBe(true);
  });

  it('valor, token ou endereço é integração', () => {
    expect(erroHttpEhDadoDoCartao({ error_messages: [{ parameter_name: 'charges[0].amount.value' }] })).toBe(false);
    expect(erroHttpEhDadoDoCartao({ error_messages: [{ parameter_name: 'customer.phones[0].number' }] })).toBe(false);
    expect(erroHttpEhDadoDoCartao({})).toBe(false);
    expect(erroHttpEhDadoDoCartao(null)).toBe(false);
  });
});

describe('resumirErrosPagbank', () => {
  it('junta parâmetro, código e descrição', () => {
    expect(
      resumirErrosPagbank({
        error_messages: [
          { parameter_name: 'a', code: '1', description: 'x' },
          { code: '2', description: 'y' },
        ],
      }),
    ).toBe('a 1 x | 2 y');
  });
  it('sem lista cai no fallback', () => {
    expect(resumirErrosPagbank(null, 'timeout')).toBe('timeout');
  });
});
