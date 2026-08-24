import { ehLojaCanal, semLojaCanal, SQL_SEM_LOJA_CANAL, LOJA_CANAL_CODES } from './loja-canal';

/**
 * A loja-canal (13/SITE) não cede peça — ordem do dono em 24/08/2026. O risco
 * desta régua é justamente errar o alvo: apagar a loja 03 por engano tira uma
 * loja de verdade do roteamento, e deixar passar `LJ13` mantém o fantasma.
 */
describe('loja-canal — quem não cede peça', () => {
  it('reconhece a loja-canal escrita de todo jeito que o espelho grava', () => {
    expect(ehLojaCanal('13')).toBe(true);
    expect(ehLojaCanal(' 13 ')).toBe(true);
    expect(ehLojaCanal('LJ13')).toBe(true);
    expect(ehLojaCanal('lj13')).toBe(true);
    expect(ehLojaCanal('013')).toBe(true);
  });

  it('NÃO confunde com loja de verdade — 03 e 01 continuam atendendo', () => {
    expect(ehLojaCanal('03')).toBe(false);
    expect(ehLojaCanal('3')).toBe(false);
    expect(ehLojaCanal('01')).toBe(false);
    expect(ehLojaCanal('130')).toBe(false);
    expect(ehLojaCanal('LJ03')).toBe(false);
  });

  it('vazio/nulo não é loja-canal (senão linha sem loja sumiria da conta)', () => {
    expect(ehLojaCanal('')).toBe(false);
    expect(ehLojaCanal(null)).toBe(false);
    expect(ehLojaCanal(undefined)).toBe(false);
  });

  it('tira a canal de uma lista de lojas candidatas', () => {
    const lojas = [{ code: '01' }, { code: '13' }, { code: '07' }];
    expect(semLojaCanal(lojas, (l) => l.code).map((l) => l.code)).toEqual(['01', '07']);
  });

  it('o trecho de SQL cita a canal e é um WHERE fechado', () => {
    expect(LOJA_CANAL_CODES).toContain('13');
    expect(SQL_SEM_LOJA_CANAL).toContain("'13'");
    expect(SQL_SEM_LOJA_CANAL.trim().startsWith('WHERE')).toBe(true);
  });
});
