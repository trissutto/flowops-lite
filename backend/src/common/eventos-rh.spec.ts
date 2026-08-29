import {
  EVENTOS_RH,
  efeitosDoDia,
  minutosAbatidos,
  minutosPrevistos,
  paraMinutos,
  tipoEvento,
  tipoEventoValido,
} from './eventos-rh';

// Jornada padrão do comércio: 09:00–18:00 com 1h de almoço = 8h de jornada.
const JORNADA = { inicio: '09:00', fim: '18:00', almocoInicio: '12:00', almocoFim: '13:00' };

describe('eventos-rh — a lista fechada', () => {
  it('não tem código repetido (repetido silencia um dos tipos no Map)', () => {
    const codigos = EVENTOS_RH.map((t) => t.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
  });

  it('recusa código que não existe', () => {
    expect(tipoEventoValido('ATESTADO_MEDICO')).toBe(true);
    expect(tipoEventoValido('ATESTADO')).toBe(false);
    expect(tipoEventoValido('')).toBe(false);
    expect(tipoEventoValido(null)).toBe(false);
    expect(tipoEventoValido(undefined)).toBe(false);
  });

  it('só falta injustificada e suspensão descontam DSR', () => {
    const comDSR = EVENTOS_RH.filter((t) => t.descontaDSR).map((t) => t.codigo).sort();
    expect(comDSR).toEqual(['FALTA_INJUSTIFICADA', 'SUSPENSAO']);
  });

  it('só falta injustificada conta pro art. 130 — atestado NUNCA reduz férias', () => {
    const art130 = EVENTOS_RH.filter((t) => t.contaArt130).map((t) => t.codigo);
    expect(art130).toEqual(['FALTA_INJUSTIFICADA']);
    expect(tipoEvento('ATESTADO_MEDICO')!.contaArt130).toBe(false);
  });

  it('quem conta como trabalhado também abona — abonar é pré-requisito', () => {
    for (const t of EVENTOS_RH) {
      if (t.contaComoTrabalhado) expect(t.abonaJornada).toBe(true);
    }
  });
});

describe('paraMinutos / minutosPrevistos', () => {
  it('lê hora válida e recusa lixo', () => {
    expect(paraMinutos('09:00')).toBe(540);
    expect(paraMinutos('9:30')).toBe(570);
    expect(paraMinutos('00:00')).toBe(0);
    expect(paraMinutos('24:00')).toBeNull();
    expect(paraMinutos('12:60')).toBeNull();
    expect(paraMinutos('')).toBeNull();
    expect(paraMinutos(null)).toBeNull();
    expect(paraMinutos('manhã')).toBeNull();
  });

  it('jornada 09–18 com 1h de almoço são 8h', () => {
    expect(minutosPrevistos(JORNADA)).toBe(480);
  });

  it('sem almoço cadastrado, a jornada é cheia', () => {
    expect(minutosPrevistos({ inicio: '09:00', fim: '15:00' })).toBe(360);
  });

  it('janela invertida ou vazia não vira jornada negativa', () => {
    expect(minutosPrevistos({ inicio: '18:00', fim: '09:00' })).toBe(0);
    expect(minutosPrevistos(null)).toBe(0);
  });
});

describe('minutosAbatidos — ordem do dono: abate SÓ as horas do evento', () => {
  it('atestado de dia inteiro derruba a jornada toda', () => {
    const ev = { tipo: 'ATESTADO_MEDICO', diaInteiro: true };
    expect(minutosAbatidos(ev, JORNADA)).toBe(480);
  });

  // O caso que define a decisão nº 2. Atestado 08:00–12:00 numa jornada que
  // começa 09:00: a hora das 8 não é dela, então abate 3h, não 4h.
  it('atestado da manhã abate só a interseção com a jornada', () => {
    const ev = { tipo: 'ATESTADO_MEDICO', diaInteiro: false, horaInicio: '08:00', horaFim: '12:00' };
    expect(minutosAbatidos(ev, JORNADA)).toBe(180);
  });

  it('atestado da tarde inteira abate 5h (13:00→18:00)', () => {
    const ev = { tipo: 'ATESTADO_MEDICO', diaInteiro: false, horaInicio: '13:00', horaFim: '18:00' };
    expect(minutosAbatidos(ev, JORNADA)).toBe(300);
  });

  // O almoço não é jornada: um atestado que atravessa 12:00–13:00 não pode
  // abater essa hora, senão a funcionária ganha 1h de crédito do nada.
  it('atestado que atravessa o almoço NÃO abate a hora do almoço', () => {
    const ev = { tipo: 'ATESTADO_MEDICO', diaInteiro: false, horaInicio: '11:00', horaFim: '14:00' };
    expect(minutosAbatidos(ev, JORNADA)).toBe(120); // 11–12 + 13–14
  });

  it('atestado fora da jornada não abate nada', () => {
    const ev = { tipo: 'ATESTADO_MEDICO', diaInteiro: false, horaInicio: '19:00', horaFim: '21:00' };
    expect(minutosAbatidos(ev, JORNADA)).toBe(0);
  });

  it('atestado maior que a jornada abate no máximo a jornada', () => {
    const ev = { tipo: 'ATESTADO_MEDICO', diaInteiro: false, horaInicio: '00:00', horaFim: '23:00' };
    expect(minutosAbatidos(ev, JORNADA)).toBe(480);
  });

  // Campo em branco não pode virar zero em silêncio: quem lançou marcou o dia.
  it('parcial sem hora preenchida cai pra dia inteiro', () => {
    const ev = { tipo: 'ATESTADO_MEDICO', diaInteiro: false, horaInicio: null, horaFim: null };
    expect(minutosAbatidos(ev, JORNADA)).toBe(480);
  });

  it('hora invertida também cai pra dia inteiro em vez de abater negativo', () => {
    const ev = { tipo: 'ATESTADO_MEDICO', diaInteiro: false, horaInicio: '16:00', horaFim: '10:00' };
    expect(minutosAbatidos(ev, JORNADA)).toBe(480);
  });

  it('tipo que NÃO admite parcial ignora as horas e derruba o dia', () => {
    const ev = { tipo: 'FERIAS', diaInteiro: false, horaInicio: '09:00', horaFim: '10:00' };
    expect(minutosAbatidos(ev, JORNADA)).toBe(480);
  });

  it('falta injustificada não abona nada — o previsto fica de pé', () => {
    expect(minutosAbatidos({ tipo: 'FALTA_INJUSTIFICADA', diaInteiro: true }, JORNADA)).toBe(0);
  });

  it('advertência não mexe na jornada — ela trabalhou', () => {
    expect(minutosAbatidos({ tipo: 'ADVERTENCIA', diaInteiro: true }, JORNADA)).toBe(0);
  });

  it('em dia de folga não há o que abater', () => {
    expect(minutosAbatidos({ tipo: 'ATESTADO_MEDICO', diaInteiro: true }, null)).toBe(0);
  });

  it('tipo desconhecido nunca abate', () => {
    expect(minutosAbatidos({ tipo: 'CHUTE', diaInteiro: true }, JORNADA)).toBe(0);
  });
});

describe('efeitosDoDia — vários eventos no mesmo dia', () => {
  it('dia sem evento é neutro', () => {
    const r = efeitosDoDia([], JORNADA);
    expect(r).toEqual({
      minAbatidos: 0, minCreditados: 0, tipos: [], abonado: false, faltaInjustificada: false,
    });
    expect(efeitosDoDia(null, JORNADA).abonado).toBe(false);
  });

  it('atestado de manhã + saída antecipada à tarde somam', () => {
    const r = efeitosDoDia(
      [
        { tipo: 'ATESTADO_MEDICO', diaInteiro: false, horaInicio: '09:00', horaFim: '12:00' },
        { tipo: 'SAIDA_ANTECIPADA', diaInteiro: false, horaInicio: '16:00', horaFim: '18:00' },
      ],
      JORNADA,
    );
    expect(r.minAbatidos).toBe(300); // 3h + 2h
    expect(r.abonado).toBe(true);
    expect(r.tipos).toEqual(['ATESTADO_MEDICO', 'SAIDA_ANTECIPADA']);
  });

  // Sem teto, dois eventos sobrepostos criariam previsto negativo — e previsto
  // negativo vira hora extra de presente no banco de horas.
  it('eventos sobrepostos não abatem mais do que a jornada', () => {
    const r = efeitosDoDia(
      [
        { tipo: 'ATESTADO_MEDICO', diaInteiro: true },
        { tipo: 'FOLGA_COMPENSATORIA', diaInteiro: true },
      ],
      JORNADA,
    );
    expect(r.minAbatidos).toBe(480);
  });

  // Se treinamento abatesse o previsto E creditasse o trabalhado, o dia
  // fecharia previsto 0 / trabalhado 8h = +8h de HORA EXTRA. Credita e pronto.
  it('treinamento credita sem abater — dia de treinamento não paga hora extra', () => {
    const r = efeitosDoDia([{ tipo: 'TREINAMENTO', diaInteiro: true }], JORNADA);
    expect(r.minAbatidos).toBe(0);
    expect(r.minCreditados).toBe(480);
    expect(r.abonado).toBe(true);
  });

  it('atestado de manhã + treinamento à tarde fecham o dia em zero', () => {
    const r = efeitosDoDia(
      [
        { tipo: 'ATESTADO_MEDICO', diaInteiro: false, horaInicio: '09:00', horaFim: '12:00' },
        { tipo: 'TREINAMENTO', diaInteiro: false, horaInicio: '13:00', horaFim: '18:00' },
      ],
      JORNADA,
    );
    expect(r.minAbatidos).toBe(180);    // previsto vira 480-180 = 300
    expect(r.minCreditados).toBe(300);  // e o treinamento preenche exatamente isso
  });

  it('atestado abona mas NÃO credita hora trabalhada', () => {
    const r = efeitosDoDia([{ tipo: 'ATESTADO_MEDICO', diaInteiro: true }], JORNADA);
    expect(r.minAbatidos).toBe(480);
    expect(r.minCreditados).toBe(0);
  });

  it('falta injustificada marca a bandeira do art. 130 sem abonar', () => {
    const r = efeitosDoDia([{ tipo: 'FALTA_INJUSTIFICADA', diaInteiro: true }], JORNADA);
    expect(r.minAbatidos).toBe(0);
    expect(r.abonado).toBe(false);
    expect(r.faltaInjustificada).toBe(true);
  });

  it('crédito de treinamento também respeita o teto do dia', () => {
    const r = efeitosDoDia(
      [
        { tipo: 'TREINAMENTO', diaInteiro: true },
        { tipo: 'EVENTO_EMPRESA', diaInteiro: true },
      ],
      JORNADA,
    );
    expect(r.minAbatidos).toBe(0);
    expect(r.minCreditados).toBe(480); // 8h + 8h creditadas, teto de 8h
  });

  // Férias derrubam o dia inteiro: não sobra previsto pro treinamento preencher.
  it('crédito nunca ultrapassa o previsto que sobrou do abate', () => {
    const r = efeitosDoDia(
      [
        { tipo: 'FERIAS', diaInteiro: true },
        { tipo: 'TREINAMENTO', diaInteiro: true },
      ],
      JORNADA,
    );
    expect(r.minAbatidos).toBe(480);
    expect(r.minCreditados).toBe(0);
  });
});
