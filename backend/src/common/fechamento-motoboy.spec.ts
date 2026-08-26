import { fechaMotoboySemSeparacao } from './fechamento-motoboy';

const base = {
  kind: 'motoboy',
  outraLojaAtende: false,
  pecasNaMao: null as boolean | null,
  lojaTemTudo: true,
};

describe('fechaMotoboySemSeparacao', () => {
  it('ON-000164: peça na mão fecha MESMO com o espelho dizendo que falta', () => {
    expect(
      fechaMotoboySemSeparacao({ ...base, pecasNaMao: true, lojaTemTudo: false }),
    ).toBe(true);
  });

  it('"não estão aqui" abre separação MESMO com o espelho dizendo que tem', () => {
    expect(
      fechaMotoboySemSeparacao({ ...base, pecasNaMao: false, lojaTemTudo: true }),
    ).toBe(false);
  });

  it('sem resposta, quem decide é o estoque (comportamento até 26/08)', () => {
    expect(fechaMotoboySemSeparacao({ ...base, pecasNaMao: null, lojaTemTudo: true })).toBe(true);
    expect(fechaMotoboySemSeparacao({ ...base, pecasNaMao: null, lojaTemTudo: false })).toBe(false);
  });

  it('outra loja manda a moto: nunca fecha na vendedora, nem com "está aqui"', () => {
    expect(
      fechaMotoboySemSeparacao({ ...base, outraLojaAtende: true, pecasNaMao: true }),
    ).toBe(false);
  });

  it('SEDEX/PAC/RETIRADA nunca fecham sem card — o card é a ferramenta do trabalho', () => {
    for (const kind of ['sedex', 'pac', 'retirada']) {
      expect(
        fechaMotoboySemSeparacao({ ...base, kind, pecasNaMao: true, lojaTemTudo: true }),
      ).toBe(false);
    }
  });
});
