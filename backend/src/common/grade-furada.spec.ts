import { veredictoDaGrade, maxTamanhosZerados } from './grade-furada';

const t = (label: string, estoque: number) => ({ label, estoque });
const grade = (...est: number[]) =>
  est.map((e, i) => t(String(46 + i * 2), e));

describe('grade furada — mais de 2 numerações zeradas tira a cor do site', () => {
  afterEach(() => {
    delete process.env.SITE_GRADE_FURADA;
    delete process.env.SITE_MAX_TAM_ZERADOS;
  });

  it('grade cheia fica', () => {
    expect(veredictoDaGrade(grade(5, 3, 8, 2, 9, 4, 1, 7)).furada).toBe(false);
  });

  it('2 buracos ainda fica — o limite é "MAIS do que 2"', () => {
    expect(veredictoDaGrade(grade(5, 0, 8, 0, 9, 4, 1, 7)).furada).toBe(false);
  });

  it('3 buracos sai, e diz QUAIS números faltam', () => {
    // Caso real da vitrine em 13/09: BEATLES, 37 peças, sem 52/54/56.
    const v = veredictoDaGrade([
      t('46', 7), t('48', 15), t('50', 1), t('52', 0), t('54', 0), t('56', 0), t('58', 10), t('60', 4),
    ]);
    expect(v.furada).toBe(true);
    expect(v.faltando).toEqual(['52', '54', '56']);
  });

  it('cor de grade CURTA não é grade furada — 3 números é a grade dela', () => {
    // Comparar com a grade da casa (46-60) tiraria do ar toda coleção pequena.
    expect(veredictoDaGrade([t('46', 4), t('48', 2), t('50', 9)]).furada).toBe(false);
  });

  it('cor zerada INTEIRA não é desta régua — ela já sai por esgotamento', () => {
    const v = veredictoDaGrade(grade(0, 0, 0, 0));
    expect(v.furada).toBe(false);
    expect(v.faltando).toHaveLength(4);
  });

  it('estoque negativo do espelho conta como zerado', () => {
    // wincred_estoque tem 150 linhas negativas — `> 0` é o teste, não `!== 0`.
    expect(veredictoDaGrade(grade(5, -1, -2, -3, 9)).furada).toBe(true);
  });

  it('SITE_GRADE_FURADA=0 desliga sem deploy', () => {
    process.env.SITE_GRADE_FURADA = '0';
    expect(veredictoDaGrade(grade(5, 0, 0, 0, 0, 9)).furada).toBe(false);
  });

  it('SITE_MAX_TAM_ZERADOS aperta ou afrouxa o limite', () => {
    process.env.SITE_MAX_TAM_ZERADOS = '0';
    expect(maxTamanhosZerados()).toBe(0);
    expect(veredictoDaGrade(grade(5, 0, 9)).furada).toBe(true);
    process.env.SITE_MAX_TAM_ZERADOS = '4';
    expect(veredictoDaGrade(grade(5, 0, 0, 0, 9)).furada).toBe(false);
  });

  it('valor inválido no Railway cai no default 2, não em NaN', () => {
    process.env.SITE_MAX_TAM_ZERADOS = 'dois';
    expect(maxTamanhosZerados()).toBe(2);
  });

  it('sem grade nenhuma não decide nada', () => {
    expect(veredictoDaGrade([]).furada).toBe(false);
    expect(veredictoDaGrade(undefined).furada).toBe(false);
  });
});
