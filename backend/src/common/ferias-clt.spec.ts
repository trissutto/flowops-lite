import { calcularFerias, diasDeFeriasPorFaltas } from './ferias-clt';

describe('art. 130 — faltas injustificadas derrubam o direito a férias', () => {
  it('a escada da lei, degrau por degrau', () => {
    expect(diasDeFeriasPorFaltas(0)).toBe(30);
    expect(diasDeFeriasPorFaltas(5)).toBe(30);
    // A 6ª falta derruba 6 dias de uma vez — é escada, não proporção.
    expect(diasDeFeriasPorFaltas(6)).toBe(24);
    expect(diasDeFeriasPorFaltas(14)).toBe(24);
    expect(diasDeFeriasPorFaltas(15)).toBe(18);
    expect(diasDeFeriasPorFaltas(23)).toBe(18);
    expect(diasDeFeriasPorFaltas(24)).toBe(12);
    expect(diasDeFeriasPorFaltas(32)).toBe(12);
    expect(diasDeFeriasPorFaltas(33)).toBe(0);
    expect(diasDeFeriasPorFaltas(99)).toBe(0);
  });

  it('entrada suja não vira direito estranho', () => {
    expect(diasDeFeriasPorFaltas(-3)).toBe(30);
    expect(diasDeFeriasPorFaltas(NaN)).toBe(30);
    expect(diasDeFeriasPorFaltas(5.9)).toBe(30); // 5 faltas e meia não existe
  });

  // Sem o parâmetro, o resultado é o de antes de 28/08/2026: 30 dias cheios.
  it('sem faltas informadas o direito segue 30 dias', () => {
    const f = calcularFerias(new Date('2020-01-15T00:00:00Z'), {
      hoje: new Date('2026-08-28T00:00:00Z'),
    });
    expect(f.diasDireito).toBe(30);
    expect(f.faltasInjustificadas).toBe(0);
    expect(f.reduzidoPorFaltas).toBe(false);
  });

  it('com 7 faltas o direito cai pra 24 e a tela sabe avisar', () => {
    const f = calcularFerias(new Date('2020-01-15T00:00:00Z'), {
      hoje: new Date('2026-08-28T00:00:00Z'),
      faltasInjustificadas: 7,
    });
    expect(f.diasDireito).toBe(24);
    expect(f.reduzidoPorFaltas).toBe(true);
  });

  it('faltas NÃO mexem no prazo de conceder — só no tamanho do direito', () => {
    const base = { hoje: new Date('2026-08-28T00:00:00Z') };
    const semFalta = calcularFerias(new Date('2020-01-15T00:00:00Z'), base);
    const comFalta = calcularFerias(new Date('2020-01-15T00:00:00Z'), {
      ...base,
      faltasInjustificadas: 20,
    });
    expect(comFalta.limiteInicio).toEqual(semFalta.limiteInicio);
    expect(comFalta.situacao).toBe(semFalta.situacao);
    expect(comFalta.diasDireito).toBe(18);
  });
});
