import { decidirPromo } from './promo-site.service';

/**
 * A decisão de quem entra nos 50% no SITE. É a mesma do caixa — o que muda é
 * que aqui ela vale pra FAMÍLIA (a peça da vitrine), não pra REF bipada.
 */
describe('decidirPromo', () => {
  const base = { refs: ['700979'], basico: false, liberada: false, excluirBasico: true };

  it('peça cadastrada até 2023 entra', () => {
    const r = decidirPromo({ ...base, dataCadastro: '2022-03-10' });
    expect(r.elegivel).toBe(true);
    expect(r.motivo).toContain('2022');
  });

  it('peça de 2024 em diante fica fora', () => {
    expect(decidirPromo({ ...base, dataCadastro: '2024-01-01' }).elegivel).toBe(false);
  });

  it('BÁSICO não entra nem com data velha', () => {
    const r = decidirPromo({ ...base, dataCadastro: '2019-05-01', basico: true });
    expect(r.elegivel).toBe(false);
    expect(r.motivo).toContain('BÁSICO');
  });

  it('BÁSICO entra quando a matriz desliga o filtro (mesmo switch do PDV)', () => {
    const r = decidirPromo({
      ...base, dataCadastro: '2019-05-01', basico: true, excluirBasico: false,
    });
    expect(r.elegivel).toBe(true);
  });

  it('liberada na mão entra mesmo sendo cadastro novo', () => {
    const r = decidirPromo({ ...base, dataCadastro: '2026-08-01', liberada: true });
    expect(r.elegivel).toBe(true);
    expect(r.motivo).toContain('liberada');
  });

  it('BÁSICO vence a liberação manual — a ordem é a do caixa', () => {
    const r = decidirPromo({
      ...base, dataCadastro: '2026-08-01', liberada: true, basico: true,
    });
    expect(r.elegivel).toBe(false);
  });

  it('coleção -INV/-VER entra por qualquer REF da família', () => {
    const r = decidirPromo({
      ...base, refs: ['900887', '900887-INV'], dataCadastro: '2026-01-10',
    });
    expect(r.elegivel).toBe(true);
    expect(r.motivo).toContain('coleção');
  });

  it('sem data no ERP, fica fora (não se anuncia metade do preço no escuro)', () => {
    const r = decidirPromo({ ...base, dataCadastro: null });
    expect(r.elegivel).toBe(false);
    expect(r.motivo).toContain('sem data');
  });

  it('a data que decide é a MAIS RECENTE da família — quem monta já manda a maior', () => {
    // A cor irmã cadastrada este ano tira a família inteira da promoção.
    expect(decidirPromo({ ...base, refs: ['VMS-223', 'VMS-223 MA'], dataCadastro: '2026-02-01' }).elegivel)
      .toBe(false);
    expect(decidirPromo({ ...base, refs: ['VMS-223', 'VMS-223 MA'], dataCadastro: '2023-02-01' }).elegivel)
      .toBe(true);
  });
});
