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
});
