import {
  MOTIVO_CONGELADO,
  cardsACongelar,
  estaCongelado,
  lojaReportouDeVerdade,
  motivoTravaDaLoja,
} from './pedido-congelado';

describe('pedido-congelado', () => {
  const cards = [
    { id: 'origem', status: 'separating', issueReason: null },
    { id: 'outra-nova', status: 'new', issueReason: null },
    { id: 'outra-separada', status: 'separated', issueReason: null },
    { id: 'outra-pronta', status: 'ready', issueReason: null },
    { id: 'ja-postou', status: 'shipped', issueReason: null },
    { id: 'ja-reportada', status: 'new', issueReason: 'out_of_stock' },
  ];

  it('reporte do card inteiro: congela o que ainda não saiu, menos a origem', () => {
    expect(cardsACongelar(cards, { origemId: 'origem', incluirOrigem: false })).toEqual([
      'outra-nova',
      'outra-separada',
      'outra-pronta',
    ]);
  });

  it('reporte por peça: a origem (que seguiria com o resto) congela junto', () => {
    expect(cardsACongelar(cards, { origemId: 'origem', incluirOrigem: true })).toEqual([
      'origem',
      'outra-nova',
      'outra-separada',
      'outra-pronta',
    ]);
  });

  it('caixa já postada segue viagem (ON-000600: parte já tinha saído)', () => {
    expect(cardsACongelar(cards, { origemId: 'origem', incluirOrigem: true })).not.toContain('ja-postou');
  });

  it('não sobrescreve o motivo verdadeiro de outra loja', () => {
    expect(cardsACongelar(cards, { origemId: 'origem', incluirOrigem: true })).not.toContain('ja-reportada');
  });

  it('congelado não conta como loja que negou (Recalcular não exclui)', () => {
    expect(lojaReportouDeVerdade(MOTIVO_CONGELADO)).toBe(false);
    expect(lojaReportouDeVerdade('out_of_stock')).toBe(true);
    expect(lojaReportouDeVerdade(null)).toBe(false);
    expect(estaCongelado(MOTIVO_CONGELADO)).toBe(true);
  });

  it('trava da loja: sem problema passa; congelado e reportado travam', () => {
    expect(motivoTravaDaLoja(null)).toBeNull();
    expect(motivoTravaDaLoja(MOTIVO_CONGELADO)).toMatch(/VOLTOU PRA MATRIZ/);
    expect(motivoTravaDaLoja('defective')).toMatch(/problema reportado/);
  });
});
