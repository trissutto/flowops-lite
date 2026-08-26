/**
 * A TRAVA DO ON-000017 (26/08/2026).
 *
 * Venda online de Suzano paga em 18/08, cancelada em 22/08 12:28 com a nota
 * `Pedido CANCELADO pelo Flow` — sem autor e sem porquê. 18 cancelamentos em
 * 60 dias, todos anônimos.
 */
import {
  ehCancelamento,
  normalizarMotivo,
  faltaMotivo,
  textoMotivoObrigatorio,
  assinaturaDoCancelamento,
  MOTIVO_MIN,
  MOTIVO_MAX,
} from './motivo-cancelamento';

describe('ehCancelamento — só os status que matam o pedido', () => {
  it.each(['cancelled', 'canceled', 'refunded', 'CANCELLED', ' Refunded '])(
    '"%s" exige motivo',
    (s) => expect(ehCancelamento(s)).toBe(true),
  );

  it.each(['processing', 'separacao', 'completed', 'pending', '', null, undefined])(
    '"%s" segue livre',
    (s) => expect(ehCancelamento(s as any)).toBe(false),
  );
});

describe('normalizarMotivo — o primeiro texto que presta', () => {
  it('pega o campo próprio antes da nota', () => {
    expect(normalizarMotivo('cliente desistiu', 'nota qualquer')).toBe('cliente desistiu');
  });

  it('cai pra nota quando o campo próprio está vazio', () => {
    expect(normalizarMotivo('  ', 'sem estoque na rede')).toBe('sem estoque na rede');
  });

  it('recusa texto curto demais (ok, ., x)', () => {
    expect(normalizarMotivo('ok')).toBeNull();
    expect(normalizarMotivo('.')).toBeNull();
    expect(normalizarMotivo(' x ')).toBeNull();
  });

  it('aceita exatamente o mínimo', () => {
    expect(normalizarMotivo('x'.repeat(MOTIVO_MIN))).toHaveLength(MOTIVO_MIN);
  });

  it('corta no teto — nota gigante não polui o histórico', () => {
    expect(normalizarMotivo('a'.repeat(MOTIVO_MAX + 50))).toHaveLength(MOTIVO_MAX);
  });

  it('sem candidato nenhum = null', () => {
    expect(normalizarMotivo(null, undefined, '')).toBeNull();
  });
});

describe('faltaMotivo — a porta que o ON-000017 atravessou', () => {
  it('cancelar sem nada = RECUSA', () => {
    expect(faltaMotivo('cancelled', null, null)).toBe(true);
  });

  it('cancelar com motivo digitado = passa', () => {
    expect(faltaMotivo('cancelled', 'ruptura: ninguém na rede tem a SMILE 54')).toBe(false);
  });

  it('cancelar com o motivo vindo da nota = passa', () => {
    expect(faltaMotivo('cancelled', null, 'cliente pediu pra cancelar')).toBe(false);
  });

  it('mudar pra concluído sem motivo continua livre', () => {
    expect(faltaMotivo('completed', null, null)).toBe(false);
  });

  it('PATCH que nem mexe em status continua livre', () => {
    expect(faltaMotivo(undefined, null, null)).toBe(false);
  });
});

describe('texto e assinatura', () => {
  it('o texto da recusa diz o que fazer', () => {
    expect(textoMotivoObrigatorio('cancelled')).toContain('Motivo do cancelamento');
    expect(textoMotivoObrigatorio('refunded')).toContain('reembolsar');
  });

  it('assinatura carrega motivo e autor', () => {
    expect(assinaturaDoCancelamento('sem estoque', 'Karine')).toBe(
      ' · motivo: sem estoque · por Karine',
    );
  });

  it('sem autor, admite que não sabe quem foi', () => {
    expect(assinaturaDoCancelamento('sem estoque', null)).toBe(
      ' · motivo: sem estoque · por usuário não identificado',
    );
  });
});
