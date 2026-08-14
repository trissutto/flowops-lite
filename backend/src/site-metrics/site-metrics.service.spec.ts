import { sanitizarDadosEvento } from './site-metrics.service';

describe('sanitizarDadosEvento', () => {
  it('mantém apenas campos diagnósticos permitidos', () => {
    expect(sanitizarDadosEvento('checkout_error', {
      method: 'card', reason: 'api_rejected', email: 'cliente@exemplo.com', cardToken: 'segredo',
    })).toEqual({ method: 'card', reason: 'api_rejected' });
  });

  it('descarta dados de eventos sem contrato diagnóstico', () => {
    expect(sanitizarDadosEvento('page_view', { email: 'cliente@exemplo.com' })).toBeUndefined();
  });

  it('limita valores para evitar payload e cardinalidade sem controle', () => {
    expect(sanitizarDadosEvento('add_to_cart_blocked', { reason: 'x'.repeat(200) }))
      .toEqual({ reason: 'x'.repeat(80) });
  });

  it('registra só seção e nome do campo inválido, nunca o valor', () => {
    expect(sanitizarDadosEvento('checkout_validation_error', {
      section: 'identification', field: 'cpf', value: '123.456.789-00',
    })).toEqual({ section: 'identification', field: 'cpf' });
  });
});
