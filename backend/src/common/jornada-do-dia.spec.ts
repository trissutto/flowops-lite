import {
  SEQUENCIA_COM_INTERVALO,
  SEQUENCIA_SEM_INTERVALO,
  diaSemanaDeChave,
  interpretarBatidas,
  minutosPrevistosDoTurno,
  parseHorarioTrabalho,
  proximaBatida,
  sequenciaDoDia,
  temIntervalo,
  turnoDoDia,
} from './jornada-do-dia';

/**
 * JORNADA DO DIA — o sábado que continuava descontando (dono, 26/09/2026).
 *
 * Cadastro certo (09:00–13:00 sem intervalo) e mesmo assim −4h todo sábado:
 * a batida `auto` seguia a sequência fixa de quatro pontos e gravava a saída
 * das 13:00 como "saída almoço". Estes testes prendem as três pontas da
 * régua — a próxima batida, a leitura do que já foi gravado e o previsto.
 */

const SEMANA = { inicio: '09:00', fim: '18:00', almocoInicio: '12:00', almocoFim: '13:00', folga: false };
/** Como o lote `/ponto/jornada/dia` grava o sábado sem intervalo. */
const SABADO_NULO = { dia: 'SAB', inicio: '09:00', fim: '13:00', almocoInicio: null, almocoFim: null, folga: false };
/** Como a grade da ficha grava o mesmo sábado (início do almoço = fim). */
const SABADO_IGUAL = { dia: 'SAB', inicio: '09:00', fim: '13:00', almocoInicio: '13:00', almocoFim: '13:00', folga: false };
/** Cadastro antigo: fim corrigido pra 13:00 mas o almoço de 12–13 ficou. */
const SABADO_ALMOCO_DENTRO = { dia: 'SAB', inicio: '09:00', fim: '13:00', almocoInicio: '12:00', almocoFim: '13:00', folga: false };
const SEGUNDA = { dia: 'SEG', ...SEMANA };

/** Batida no fuso BR (UTC−3) de um dia YYYY-MM-DD. */
const bat = (tipo: string, dia: string, hhmm: string, extra: any = {}) => ({
  id: `${tipo}-${hhmm}`,
  tipo,
  timestamp: new Date(`${dia}T${hhmm}:00-03:00`),
  ...extra,
});

describe('temIntervalo — o que conta como intervalo de almoço', () => {
  it('semana normal tem; sábado com almoço nulo ou início = fim não tem', () => {
    expect(temIntervalo(SEGUNDA)).toBe(true);
    expect(temIntervalo(SABADO_NULO)).toBe(false);
    expect(temIntervalo(SABADO_IGUAL)).toBe(false);
  });

  it('almoço inteiro fora da janela do turno não é intervalo', () => {
    expect(
      temIntervalo({ dia: 'SAB', inicio: '09:00', fim: '13:00', almocoInicio: '14:00', almocoFim: '15:00' }),
    ).toBe(false);
  });

  it('almoço DENTRO da janela conta — o cadastro é a fonte, mesmo estranho', () => {
    expect(temIntervalo(SABADO_ALMOCO_DENTRO)).toBe(true);
  });

  it('folga, vazio e turno invertido não têm intervalo', () => {
    expect(temIntervalo({ dia: 'DOM', folga: true })).toBe(false);
    expect(temIntervalo(null)).toBe(false);
    expect(temIntervalo({ dia: 'SAB', inicio: '13:00', fim: '09:00', almocoInicio: '10:00', almocoFim: '11:00' })).toBe(false);
  });
});

describe('sequenciaDoDia / proximaBatida — quantos pontos o dia tem', () => {
  it('sábado sem intervalo tem DUAS batidas: depois da entrada vem a SAÍDA', () => {
    expect(sequenciaDoDia(SABADO_NULO)).toBe(SEQUENCIA_SEM_INTERVALO);
    expect(proximaBatida(SABADO_NULO, [])).toBe('entrada');
    expect(proximaBatida(SABADO_NULO, ['entrada'])).toBe('saida');
    expect(proximaBatida(SABADO_IGUAL, ['entrada'])).toBe('saida');
    expect(proximaBatida(SABADO_NULO, ['entrada', 'saida'])).toBeNull();
  });

  it('semana com almoço continua nas quatro, na ordem de sempre', () => {
    expect(sequenciaDoDia(SEGUNDA)).toBe(SEQUENCIA_COM_INTERVALO);
    expect(proximaBatida(SEGUNDA, ['entrada'])).toBe('saida_almoco');
    expect(proximaBatida(SEGUNDA, ['entrada', 'saida_almoco', 'volta_almoco'])).toBe('saida');
  });

  it('sem cadastro, folga ou turno que não fecha → quatro (não há jornada a obedecer)', () => {
    expect(sequenciaDoDia(null)).toBe(SEQUENCIA_COM_INTERVALO);
    expect(sequenciaDoDia({ dia: 'DOM', folga: true })).toBe(SEQUENCIA_COM_INTERVALO);
    expect(sequenciaDoDia({ dia: 'SAB', inicio: '13:00', fim: '09:00' })).toBe(SEQUENCIA_COM_INTERVALO);
    expect(sequenciaDoDia({ dia: 'SAB', folga: false })).toBe(SEQUENCIA_COM_INTERVALO);
  });

  it('o rastro de um "saída almoço" no sábado não trava a saída', () => {
    // Sábado batido ANTES da correção: entrada + "saída almoço". Se ela bater
    // de novo, o que falta é a saída — não uma "volta do almoço".
    expect(proximaBatida(SABADO_NULO, ['entrada', 'saida_almoco'])).toBe('saida');
  });
});

describe('interpretarBatidas — o que as batidas gravadas significam', () => {
  const SAB = '2026-09-26';

  it('sábado sem intervalo: "saída almoço" das 13:00 é a saída — 4h, não zero', () => {
    const r = interpretarBatidas([bat('entrada', SAB, '09:00'), bat('saida_almoco', SAB, '13:00')], SABADO_NULO);
    expect(r.semIntervalo).toBe(true);
    expect(r.reinterpretada).toBe(true);
    expect(r.minTrabalhado).toBe(240);
    expect(r.saida?.toISOString()).toBe(new Date(`${SAB}T13:00:00-03:00`).toISOString());
    expect(r.saidaAlmoco).toBeNull();
    // A tela precisa saber o que o terminal gravou de fato.
    expect(r.batidas[1].tipo).toBe('saida');
    expect(r.batidas[1].tipoRegistrado).toBe('saida_almoco');
    expect(r.batidas[1].id).toBe('saida_almoco-13:00');
  });

  it('mesmo par numa SEGUNDA (com intervalo) continua dia incompleto — zero', () => {
    const SEG = '2026-09-21';
    const r = interpretarBatidas([bat('entrada', SEG, '09:00'), bat('saida_almoco', SEG, '13:00')], SEGUNDA);
    expect(r.semIntervalo).toBe(false);
    expect(r.reinterpretada).toBe(false);
    expect(r.minTrabalhado).toBe(0);
    expect(r.saida).toBeNull();
  });

  it('sábado com pausa real no meio: a ÚLTIMA vira saída e a pausa é descontada', () => {
    const r = interpretarBatidas(
      [
        bat('entrada', SAB, '09:00'),
        bat('saida_almoco', SAB, '10:30'),
        bat('volta_almoco', SAB, '11:00'),
        bat('saida_almoco', SAB, '13:00'),
      ],
      SABADO_NULO,
    );
    expect(r.reinterpretada).toBe(true);
    expect(r.minTrabalhado).toBe(210); // 4h − 30min
    expect(r.saidaAlmoco?.toISOString()).toBe(new Date(`${SAB}T10:30:00-03:00`).toISOString());
  });

  it('sábado já com saída de verdade não muda nada', () => {
    const r = interpretarBatidas([bat('entrada', SAB, '09:00'), bat('saida', SAB, '13:00')], SABADO_NULO);
    expect(r.reinterpretada).toBe(false);
    expect(r.minTrabalhado).toBe(240);
    expect(r.batidas.map((b) => b.tipo)).toEqual(['entrada', 'saida']);
  });

  it('só "saída almoço" no dia (sem entrada) vira saída mas não conta hora', () => {
    const r = interpretarBatidas([bat('saida_almoco', SAB, '13:00')], SABADO_NULO);
    expect(r.saida).not.toBeNull();
    expect(r.minTrabalhado).toBe(0);
  });

  it('dia inteiro com quatro batidas desconta o almoço (semana normal)', () => {
    const SEG = '2026-09-21';
    const r = interpretarBatidas(
      [
        bat('entrada', SEG, '09:00'),
        bat('saida_almoco', SEG, '12:00'),
        bat('volta_almoco', SEG, '13:00'),
        bat('saida', SEG, '18:00'),
      ],
      SEGUNDA,
    );
    expect(r.minTrabalhado).toBe(480);
  });

  it('ordena por horário mesmo que o banco devolva fora de ordem', () => {
    const r = interpretarBatidas([bat('saida_almoco', SAB, '13:00'), bat('entrada', SAB, '09:00')], SABADO_NULO);
    expect(r.batidas.map((b) => b.tipo)).toEqual(['entrada', 'saida']);
    expect(r.minTrabalhado).toBe(240);
  });

  it('sem batida nenhuma: dia vazio, sem reinterpretação', () => {
    const r = interpretarBatidas([], SABADO_NULO);
    expect(r.minTrabalhado).toBe(0);
    expect(r.entrada).toBeNull();
    expect(r.reinterpretada).toBe(false);
  });
});

describe('minutosPrevistosDoTurno — quanto o dia cobra', () => {
  it('sábado 09:00–13:00 sem intervalo cobra 4h, dos dois jeitos de gravar', () => {
    expect(minutosPrevistosDoTurno(SABADO_NULO)).toBe(240);
    expect(minutosPrevistosDoTurno(SABADO_IGUAL)).toBe(240);
  });

  it('semana normal cobra 8h; folga e vazio cobram zero', () => {
    expect(minutosPrevistosDoTurno(SEGUNDA)).toBe(480);
    expect(minutosPrevistosDoTurno({ dia: 'DOM', folga: true })).toBe(0);
    expect(minutosPrevistosDoTurno(null)).toBe(0);
  });

  it('almoço fora da janela não desconta — só o pedaço que cai dentro', () => {
    expect(
      minutosPrevistosDoTurno({ dia: 'SAB', inicio: '09:00', fim: '13:00', almocoInicio: '14:00', almocoFim: '15:00' }),
    ).toBe(240);
    expect(
      minutosPrevistosDoTurno({ dia: 'SAB', inicio: '09:00', fim: '13:00', almocoInicio: '12:30', almocoFim: '13:30' }),
    ).toBe(210);
  });
});

describe('parseHorarioTrabalho / turnoDoDia / diaSemanaDeChave', () => {
  it('lê o JSON da ficha e acha o dia pela chave', () => {
    const turnos = parseHorarioTrabalho(JSON.stringify([SEGUNDA, SABADO_NULO, { dia: 'DOM', folga: true }]));
    expect(turnos).toHaveLength(3);
    expect(turnoDoDia(turnos, 'SAB')).toEqual(SABADO_NULO);
    expect(turnoDoDia(turnos, 'sab')).toEqual(SABADO_NULO);
    expect(turnoDoDia(turnos, 'QUA')).toBeNull();
  });

  it('lixo vira "sem cadastro", nunca exceção', () => {
    expect(parseHorarioTrabalho(null)).toEqual([]);
    expect(parseHorarioTrabalho('{quebrado')).toEqual([]);
    expect(parseHorarioTrabalho('{"dia":"SEG"}')).toEqual([]);
    expect(parseHorarioTrabalho(42)).toEqual([]);
    expect(parseHorarioTrabalho([SEGUNDA, null, 'x'])).toEqual([SEGUNDA]);
  });

  it('26/09/2026 é sábado; 27 é domingo; texto que não é data é null', () => {
    expect(diaSemanaDeChave('2026-09-26')).toBe('SAB');
    expect(diaSemanaDeChave('2026-09-27')).toBe('DOM');
    expect(diaSemanaDeChave('hoje')).toBeNull();
    expect(diaSemanaDeChave(undefined)).toBeNull();
  });
});
