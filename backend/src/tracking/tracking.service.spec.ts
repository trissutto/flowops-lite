import { TrackingService } from './tracking.service';

/**
 * O risco real deste serviço não é a rede — é a NORMALIZAÇÃO:
 *   - os dois provedores devolvem os eventos em ordem OPOSTA;
 *   - "saiu para entrega" e "não entregue" não são entrega;
 *   - a data vem sem fuso e o servidor roda em UTC.
 * Um erro em qualquer um dos três mostra a peça no lugar errado ou encurta o
 * prazo de troca da cliente. Por isso o teste é do parser, sem rede.
 */
describe('TrackingService — normalização', () => {
  const svc = new TrackingService({} as any, {} as any, {} as any) as any;

  /** Como o SRO devolve: mais NOVO primeiro. */
  const doSro = [
    {
      codigo: 'BDE', tipo: '01', dtHrCriado: '2026-08-13T12:44:49',
      descricao: 'Objeto entregue ao destinatário',
      unidade: { tipo: 'Unidade de Distribuição', endereco: { cidade: 'CAMPINAS', uf: 'SP' } },
    },
    {
      codigo: 'OEC', tipo: '01', dtHrCriado: '2026-08-13T10:18:48',
      descricao: 'Objeto saiu para entrega ao destinatário',
      unidade: { endereco: { cidade: 'CAMPINAS', uf: 'SP' } },
    },
    {
      codigo: 'PO', tipo: '01', dtHrCriado: '2026-08-12T12:14:57',
      descricao: 'Objeto postado',
      unidade: { endereco: { cidade: 'INDAIATUBA', uf: 'SP' } },
    },
  ];

  /** Como o Mais Envios devolve: mais ANTIGO primeiro. */
  const doMaisEnvios = [
    {
      codigo: 'FC', tipo: '82', dtHrCriado: '2026-08-18T12:33:51',
      descricao: 'Etiqueta emitida', detalhe: 'Aguardando postagem pelo remetente',
      unidade: { tipo: 'INTERFACE DO SISTEMA', endereco: { uf: 'BR' } },
    },
    {
      codigo: 'PO', tipo: '01', dtHrCriado: '2026-08-18T15:26:03',
      descricao: 'Objeto postado',
      unidade: { endereco: { cidade: 'PIRACICABA', uf: 'SP' } },
    },
  ];

  test('o evento mais novo vem primeiro, venha o array na ordem que vier', () => {
    const a = svc.montar('AA123456789BR', 'correios', 'correios', { eventos: doSro });
    const b = svc.montar('BB123456789BR', 'correios', 'maisenvios', { eventos: doMaisEnvios });
    expect(a.events[0].description).toBe('Objeto entregue ao destinatário');
    expect(a.lastStatus).toBe('Objeto entregue ao destinatário');
    // Se a ordem fosse assumida, aqui apareceria "Etiqueta emitida".
    expect(b.events[0].description).toBe('Objeto postado');
    expect(b.lastStatus).toBe('Objeto postado');
  });

  test('"saiu para entrega" NÃO é entrega', () => {
    const so = svc.montar('CC123456789BR', 'correios', 'correios', { eventos: [doSro[1], doSro[2]] });
    expect(so.delivered).toBe(false);
    expect(so.deliveredAt).toBeNull();
  });

  test('"não entregue" (carteiro não atendido) NÃO é entrega', () => {
    const r = svc.montar('DD123456789BR', 'correios', 'correios', {
      eventos: [{ dtHrCriado: '2026-08-13T12:00:00', descricao: 'Objeto não entregue - carteiro não atendido' }],
    });
    expect(r.delivered).toBe(false);
  });

  test('entrega carimba a data no fuso de Brasília (o servidor roda em UTC)', () => {
    const r = svc.montar('EE123456789BR', 'correios', 'correios', { eventos: doSro });
    expect(r.delivered).toBe(true);
    // 13/08 12:44:49 em Brasília = 15:44:49Z. Sem o -03:00 daria 12:44Z e a
    // tela mostraria a entrega 3h antes de ter acontecido.
    expect(r.deliveredAt).toBe('2026-08-13T15:44:49.000Z');
    expect(r.events[0].date).toBe('13/08/2026');
    expect(r.events[0].time).toBe('12:44');
  });

  test('local sai como CIDADE/UF, e cai pro nome da unidade quando não há cidade', () => {
    const r = svc.montar('FF123456789BR', 'correios', 'maisenvios', { eventos: doMaisEnvios });
    expect(r.events[0].location).toBe('PIRACICABA/SP');
    expect(r.events[1].location).toBe('INTERFACE DO SISTEMA/BR');
  });

  test('código do objeto: o campo é texto livre na mão da loja', () => {
    expect(TrackingService.ehCodigoValido('AD811933800BR')).toBe(true);
    expect(TrackingService.ehCodigoValido('ad811933800br')).toBe(true);
    expect(TrackingService.ehCodigoValido('Cliente retirou !')).toBe(false);
    expect(TrackingService.ehCodigoValido('')).toBe(false);
    expect(TrackingService.ehCodigoValido(null)).toBe(false);
  });

  test('previsão de entrega também respeita o fuso', () => {
    const r = svc.montar('GG123456789BR', 'correios', 'correios', {
      eventos: doSro,
      previsao: '2026-08-19T23:59:59',
    });
    expect(r.estimatedAt).toBe('2026-08-20T02:59:59.000Z');
  });
});
