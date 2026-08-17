import { decidirPromo } from './promo-site.service';

/**
 * A decisão de quem entra nos 50% no SITE. É a mesma do caixa — o que muda é
 * que aqui ela vale pra FAMÍLIA (a peça da vitrine), não pra REF bipada.
 */
describe('decidirPromo', () => {
  const base = { ref: '700979', basico: false, liberada: false, excluirBasico: true };

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

  it('coleção -INV/-VER entra quando é a REF DA PEÇA', () => {
    const r = decidirPromo({ ...base, ref: '900887-INV', dataCadastro: '2026-01-10' });
    expect(r.elegivel).toBe(true);
    expect(r.motivo).toContain('coleção');
  });

  /**
   * O bug de 17/08: a REF-BASE corta o sufixo, então `13050-INV` (vestido
   * VERMELHO de 2023) caía na família de `13050` (vestido VINHO de 2026,
   * R$ 339,90) e passava a coleção pra ele — o site anunciava R$ 169,95
   * enquanto o caixa cobrava os R$ 339,90, porque o PDV testa o sufixo na REF
   * bipada. A coleção é da REF, não da família.
   */
  it('coleção da REF IRMÃ não carimba a peça nova (13050 vs 13050-INV)', () => {
    const r = decidirPromo({ ...base, ref: '13050', dataCadastro: '2026-05-05' });
    expect(r.elegivel).toBe(false);
    expect(r.motivo).toContain('2026');
  });

  it('sem data no ERP, fica fora (não se anuncia metade do preço no escuro)', () => {
    const r = decidirPromo({ ...base, dataCadastro: null });
    expect(r.elegivel).toBe(false);
    expect(r.motivo).toContain('sem data');
  });

  it('a data que decide é a MAIS RECENTE da família — quem monta já manda a maior', () => {
    // A cor irmã cadastrada este ano tira a família inteira da promoção.
    expect(decidirPromo({ ...base, ref: 'VMS-223', dataCadastro: '2026-02-01' }).elegivel)
      .toBe(false);
    expect(decidirPromo({ ...base, ref: 'VMS-223', dataCadastro: '2023-02-01' }).elegivel)
      .toBe(true);
  });

  it('a peça de coleção com irmã nova continua entrando — a data não derruba o sufixo', () => {
    // Espelho do caso acima pelo outro lado: `13050-INV` segue a 50% mesmo com
    // a família datada em 2026 pela irmã `13050`.
    expect(decidirPromo({ ...base, ref: '13050-INV', dataCadastro: '2026-05-05' }).elegivel)
      .toBe(true);
  });
});
