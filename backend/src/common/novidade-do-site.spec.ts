import {
  chaveOrdemNovidade,
  decidirNovidade,
  fichaNovidade,
  instante,
  janelaNovidadeDias,
} from './novidade-do-site';

const DIA = 24 * 60 * 60 * 1000;
/** Um "agora" fixo — 27/11/2026 12:00 em Brasília. */
const AGORA = new Date('2026-11-27T15:00:00.000Z').getTime();
const diasAtras = (n: number) => new Date(AGORA - n * DIA);

describe('janelaNovidadeDias', () => {
  it('sem env = 60 (dono, 16/08)', () => {
    expect(janelaNovidadeDias(undefined)).toBe(60);
  });
  it('aceita o número do Railway', () => {
    expect(janelaNovidadeDias('30')).toBe(30);
    expect(janelaNovidadeDias('45.9')).toBe(45);
  });
  it('valor torto cai no padrão em vez de esvaziar a vitrine', () => {
    // `NOVIDADE_DIAS=` vazio virava janela de 1 dia na conta antiga; `abc` virava NaN.
    expect(janelaNovidadeDias('')).toBe(60);
    expect(janelaNovidadeDias('abc')).toBe(60);
    expect(janelaNovidadeDias('0')).toBe(60);
    expect(janelaNovidadeDias('-5')).toBe(60);
  });
});

describe('instante', () => {
  it('lê Date, ISO e epoch; vazio ou inválido vira null, nunca NaN', () => {
    expect(instante(new Date(AGORA))).toBe(AGORA);
    expect(instante(new Date(AGORA).toISOString())).toBe(AGORA);
    expect(instante(AGORA)).toBe(AGORA);
    expect(instante(null)).toBeNull();
    expect(instante(undefined)).toBeNull();
    expect(instante('')).toBeNull();
    expect(instante('não é data')).toBeNull();
  });
});

describe('decidirNovidade — a porta automática (como era desde 13/08)', () => {
  it('peça sem carimbo nenhum está fora e nunca entrou', () => {
    expect(decidirNovidade({}, AGORA, 60)).toEqual({ lancamento: false, motivo: null, entrouEm: null, ate: null });
  });

  it('publicada há 10 dias é novidade por idade, até completar a janela', () => {
    const d = decidirNovidade({ publicadoEm: diasAtras(10) }, AGORA, 60);
    expect(d.lancamento).toBe(true);
    expect(d.motivo).toBe('idade');
    expect(d.entrouEm).toBe(diasAtras(10).getTime());
    expect(d.ate).toBe(diasAtras(10).getTime() + 60 * DIA);
  });

  it('publicada há 100 dias envelheceu e saiu sozinha', () => {
    const d = decidirNovidade({ publicadoEm: diasAtras(100) }, AGORA, 60);
    expect(d.lancamento).toBe(false);
    expect(d.motivo).toBeNull();
    // Continua sabendo QUANDO entrou — é a chave da ordem, mesmo fora.
    expect(d.entrouEm).toBe(diasAtras(100).getTime());
    expect(d.ate).toBeNull();
  });

  it('a janela do env manda: 30 dias tira quem 60 deixava', () => {
    expect(decidirNovidade({ publicadoEm: diasAtras(45) }, AGORA, 60).lancamento).toBe(true);
    expect(decidirNovidade({ publicadoEm: diasAtras(45) }, AGORA, 30).lancamento).toBe(false);
  });
});

describe('decidirNovidade — a porta manual (dono, 27/11)', () => {
  it('cadastro de 2024 marcada hoje ENTRA, como se tivesse chegado hoje', () => {
    const d = decidirNovidade({ publicadoEm: '2024-03-10T12:00:00.000Z', novidadeEm: new Date(AGORA) }, AGORA, 60);
    expect(d.lancamento).toBe(true);
    expect(d.motivo).toBe('manual');
    expect(d.entrouEm).toBe(AGORA);
    expect(d.ate).toBe(AGORA + 60 * DIA);
  });

  it('a marcação na mão também envelhece — não vira a tag eterna do WooCommerce', () => {
    const d = decidirNovidade({ publicadoEm: '2024-03-10T12:00:00.000Z', novidadeEm: diasAtras(61) }, AGORA, 60);
    expect(d.lancamento).toBe(false);
    expect(d.motivo).toBeNull();
    expect(d.entrouEm).toBe(diasAtras(61).getTime());
  });

  it('no último dia da janela ainda está dentro', () => {
    expect(decidirNovidade({ novidadeEm: diasAtras(60) }, AGORA, 60).lancamento).toBe(true);
  });

  it('marcada há 30 dias e publicada há 5: a porta mais recente decide', () => {
    const d = decidirNovidade({ publicadoEm: diasAtras(5), novidadeEm: diasAtras(30) }, AGORA, 60);
    expect(d.motivo).toBe('idade');
    expect(d.entrouEm).toBe(diasAtras(5).getTime());
    expect(d.ate).toBe(diasAtras(5).getTime() + 60 * DIA);
  });

  it('marcação vencida numa peça recém-publicada não tira a peça: a idade segura', () => {
    const d = decidirNovidade({ publicadoEm: diasAtras(3), novidadeEm: diasAtras(90) }, AGORA, 60);
    expect(d.lancamento).toBe(true);
    expect(d.motivo).toBe('idade');
  });
});

describe('chaveOrdemNovidade — a ordem da vitrine', () => {
  it('marcada hoje vem na frente da publicada ontem', () => {
    const marcadaHoje = { publicadoEm: '2024-03-10T12:00:00.000Z', novidadeEm: new Date(AGORA) };
    const publicadaOntem = { publicadoEm: diasAtras(1) };
    expect(chaveOrdemNovidade(marcadaHoje)).toBeGreaterThan(chaveOrdemNovidade(publicadaOntem));
  });

  it('sem carimbo nenhum = 0, vai pro fim', () => {
    expect(chaveOrdemNovidade({})).toBe(0);
    expect(chaveOrdemNovidade({ publicadoEm: 'lixo' })).toBe(0);
  });

  it('a ordem desc pela chave bate com a decisão', () => {
    const lista = [
      { ref: 'VELHA', publicadoEm: diasAtras(400) },
      { ref: 'ONTEM', publicadoEm: diasAtras(1) },
      { ref: 'MARCADA', publicadoEm: diasAtras(400), novidadeEm: diasAtras(0) },
      { ref: 'SEMANA', publicadoEm: diasAtras(7) },
    ];
    lista.sort((a, b) => chaveOrdemNovidade(b) - chaveOrdemNovidade(a));
    expect(lista.map((p) => p.ref)).toEqual(['MARCADA', 'ONTEM', 'SEMANA', 'VELHA']);
  });
});

describe('fichaNovidade — o que a retaguarda mostra', () => {
  it('marcação viva: checkbox marcado, quem marcou e até quando', () => {
    const f = fichaNovidade(
      { publicadoEm: '2024-03-10T12:00:00.000Z', novidadeEm: diasAtras(2), novidadePor: 'thiago' },
      AGORA,
      60,
    );
    expect(f.noAr).toBe(true);
    expect(f.motivo).toBe('manual');
    expect(f.manual).toBe(true);
    expect(f.manualPor).toBe('thiago');
    expect(f.manualVencidaEm).toBeNull();
    expect(f.porIdade).toBe(false);
    expect(f.ate).toBe(new Date(diasAtras(2).getTime() + 60 * DIA).toISOString());
    expect(f.janelaDias).toBe(60);
  });

  it('marcação vencida: checkbox desmarcado, e a ficha conta quando venceu', () => {
    const f = fichaNovidade({ publicadoEm: '2024-03-10T12:00:00.000Z', novidadeEm: diasAtras(70), novidadePor: 'thiago' }, AGORA, 60);
    expect(f.noAr).toBe(false);
    expect(f.manual).toBe(false);
    expect(f.manualPor).toBe('thiago');
    expect(f.manualVencidaEm).toBe(new Date(diasAtras(70).getTime() + 60 * DIA).toISOString());
  });

  it('peça nova sem marcação: está no ar por idade, checkbox desmarcado', () => {
    const f = fichaNovidade({ publicadoEm: diasAtras(10) }, AGORA, 60);
    expect(f.noAr).toBe(true);
    expect(f.motivo).toBe('idade');
    expect(f.manual).toBe(false);
    expect(f.porIdade).toBe(true);
    expect(f.manualEm).toBeNull();
    expect(f.manualPor).toBeNull();
  });

  it('nada de nada: fora, sem datas', () => {
    const f = fichaNovidade({}, AGORA, 60);
    expect(f).toMatchObject({ noAr: false, motivo: null, manual: false, porIdade: false, ate: null, publicadoEm: null });
  });
});
