import { antesDaAdmissao, chaveDataSo } from './vinculo-do-dia';

/**
 * O que este spec prende: a data-só do Prisma (meia-noite UTC) vira a chave
 * do PRÓPRIO dia — não do anterior, como daria o fuso de Brasília —, o dia da
 * admissão conta, e sem admissão não há corte.
 */
describe('chaveDataSo — a data-só do Prisma lida em UTC', () => {
  it('meia-noite UTC é o próprio dia (em Brasília seria 21h do dia anterior)', () => {
    expect(chaveDataSo(new Date('2026-11-06T00:00:00.000Z'))).toBe('2026-11-06');
  });

  it('string ISO devolve só a data; vazio/nulo/inválido devolve null', () => {
    expect(chaveDataSo('2026-11-06T00:00:00.000Z')).toBe('2026-11-06');
    expect(chaveDataSo('2026-11-06')).toBe('2026-11-06');
    expect(chaveDataSo(null)).toBeNull();
    expect(chaveDataSo(undefined)).toBeNull();
    expect(chaveDataSo('')).toBeNull();
    expect(chaveDataSo('06/11/2026')).toBeNull();
    expect(chaveDataSo(new Date('nada'))).toBeNull();
  });
});

describe('antesDaAdmissao — o dia que não cobra jornada', () => {
  it('véspera é antes; o dia da admissão e os seguintes contam', () => {
    expect(antesDaAdmissao('2026-11-05', '2026-11-06')).toBe(true);
    expect(antesDaAdmissao('2026-10-31', '2026-11-06')).toBe(true);
    expect(antesDaAdmissao('2026-11-06', '2026-11-06')).toBe(false);
    expect(antesDaAdmissao('2026-11-07', '2026-11-06')).toBe(false);
  });

  it('sem admissão na ficha não há corte', () => {
    expect(antesDaAdmissao('2026-11-05', null)).toBe(false);
    expect(antesDaAdmissao('2026-11-05', undefined)).toBe(false);
    expect(antesDaAdmissao('2026-11-05', '')).toBe(false);
  });
});
