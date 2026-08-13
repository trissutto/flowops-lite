import { FitEngineService, GRADE_PLUS } from './fit-engine.service';

/**
 * Personas de calibração do LURDS FIT AI.
 *
 * Os alvos vêm das fontes da recalibração de 13/08/2026 (tabelas plus
 * nacionais + âncoras antropométricas SizeUK/NHANES/SOON). O motor antigo
 * (IMC→tamanho) mandava 1,62m/90kg pro 54 e 117kg pro 60 — era o "muito
 * desregulado". Se alguém mexer nos coeficientes, estas personas seguram.
 */
describe('FitEngineService — calibração', () => {
  const engine = new FitEngineService();
  const corpoBase = { preferencia: 'normal' as const };

  const recomendar = (
    alturaCm: number,
    pesoKg: number,
    extra: Record<string, unknown> = {},
    peca: Record<string, unknown> = {},
  ) => engine.recomendar({ alturaCm, pesoKg, ...corpoBase, ...extra } as any, peca as any);

  describe('base pelo corpo (sem habitual, peça neutra)', () => {
    const casos: Array<[number, number, string[]]> = [
      // [altura, peso, tamanhos aceitáveis pelo mercado plus]
      [160, 75, ['46']],                  // entrada da grade
      [162, 82, ['46', '48']],
      [162, 90, ['46', '48']],            // motor antigo dizia 54
      [170, 100, ['48', '50']],
      [165, 105, ['50', '52']],
      [163, 117, ['52', '54', '56']],     // âncora SOON: quadril ~134 → 54; antigo dizia 60
      [168, 130, ['54', '56', '58']],
      [158, 140, ['58', '60']],
    ];

    it.each(casos)('%i cm / %i kg → um de %p', (altura, peso, esperados) => {
      const r = recomendar(altura, peso);
      expect(esperados).toContain(r.tamanho);
    });
  });

  it('peso maior nunca diminui o tamanho (monotonia)', () => {
    let anterior = -1;
    for (let peso = 60; peso <= 160; peso += 5) {
      const r = recomendar(162, peso);
      const idx = GRADE_PLUS.indexOf(r.tamanho);
      expect(idx).toBeGreaterThanOrEqual(anterior);
      anterior = idx;
    }
  });

  it('mesmo peso: mais baixa veste número igual ou maior', () => {
    const baixa = GRADE_PLUS.indexOf(recomendar(155, 95).tamanho);
    const alta = GRADE_PLUS.indexOf(recomendar(178, 95).tamanho);
    expect(baixa).toBeGreaterThanOrEqual(alta);
  });

  it('extremos nunca saem da grade', () => {
    expect(recomendar(150, 250).tamanho).toBe('60');
    expect(recomendar(190, 45).tamanho).toBe('46');
  });

  describe('âncora do tamanho habitual', () => {
    it('habitual coerente com o corpo é confirmado', () => {
      const r = recomendar(163, 117, { tamanhoHabitual: '54' });
      expect(r.tamanho).toBe('54');
    });

    it('habitual puxa o resultado pra perto do que ela declara', () => {
      const sem = recomendar(162, 90);
      const com = recomendar(162, 90, { tamanhoHabitual: '52' });
      const dSem = Math.abs(GRADE_PLUS.indexOf(sem.tamanho) - GRADE_PLUS.indexOf('52'));
      const dCom = Math.abs(GRADE_PLUS.indexOf(com.tamanho) - GRADE_PLUS.indexOf('52'));
      expect(dCom).toBeLessThanOrEqual(dSem);
      expect(['50', '52']).toContain(com.tamanho);
    });
  });

  describe('proporção do corpo por categoria', () => {
    it('quadril G sobe o número da calça', () => {
      const m = recomendar(165, 95, { quadril: 'M' }, { categoria: 'calca' });
      const g = recomendar(165, 95, { quadril: 'G' }, { categoria: 'calca' });
      expect(GRADE_PLUS.indexOf(g.tamanho)).toBeGreaterThanOrEqual(GRADE_PLUS.indexOf(m.tamanho));
    });

    it('busto P desce o número da blusa', () => {
      const m = recomendar(165, 95, { busto: 'M' }, { categoria: 'blusa' });
      const p = recomendar(165, 95, { busto: 'P' }, { categoria: 'blusa' });
      expect(GRADE_PLUS.indexOf(p.tamanho)).toBeLessThanOrEqual(GRADE_PLUS.indexOf(m.tamanho));
    });

    it('vestido fecha no maior eixo: corpo pera não veste menos que o quadril pede', () => {
      const neutro = recomendar(165, 100, {}, { categoria: 'vestido' });
      const pera = recomendar(165, 100, { formatoCorpo: 'pera', quadril: 'G' }, { categoria: 'vestido' });
      expect(GRADE_PLUS.indexOf(pera.tamanho)).toBeGreaterThanOrEqual(GRADE_PLUS.indexOf(neutro.tamanho));
    });
  });

  describe('a peça e a preferência', () => {
    it('modelagem pequena sobe um número', () => {
      const neutra = recomendar(163, 117, { tamanhoHabitual: '54' });
      const pequena = recomendar(163, 117, { tamanhoHabitual: '54' }, { modelagem: 'pequena' });
      expect(GRADE_PLUS.indexOf(pequena.tamanho)).toBeGreaterThan(GRADE_PLUS.indexOf(neutra.tamanho));
    });

    it('preferência soltinha nunca devolve menos que a justa', () => {
      const justa = recomendar(165, 105, { preferencia: 'justa' });
      const solta = recomendar(165, 105, { preferencia: 'soltinha' });
      expect(GRADE_PLUS.indexOf(solta.tamanho)).toBeGreaterThanOrEqual(GRADE_PLUS.indexOf(justa.tamanho));
    });
  });

  describe('estoque', () => {
    it('só recomenda o que existe e avisa na confiança', () => {
      const livre = recomendar(163, 117, { tamanhoHabitual: '54' });
      const restrito = recomendar(163, 117, { tamanhoHabitual: '54' }, { tamanhosDisponiveis: ['46', '48'] });
      expect(restrito.tamanho).toBe('48');
      expect(restrito.confianca).toBeLessThan(livre.confianca);
    });
  });

  describe('aprendizado das trocas', () => {
    it('viés de troca com amostra move o resultado', () => {
      const sem = recomendar(163, 117, { tamanhoHabitual: '54' });
      const com = engine.recomendar(
        { alturaCm: 163, pesoKg: 117, preferencia: 'normal', tamanhoHabitual: '54' } as any,
        {} as any,
        { viesRef: 1, amostrasRef: 20 },
      );
      expect(GRADE_PLUS.indexOf(com.tamanho)).toBeGreaterThan(GRADE_PLUS.indexOf(sem.tamanho));
    });
  });

  it('passosEntre traduz troca em passos', () => {
    expect(engine.passosEntre('54', '56')).toBe(1);
    expect(engine.passosEntre('56', '52')).toBe(-2);
    expect(engine.passosEntre('54', 'XG')).toBeNull();
  });
});
