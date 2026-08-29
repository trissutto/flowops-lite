import {
  EVENTOS_RH,
  chaveSemana,
  descontoFolha,
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

  // Os três destinos do mesmo número são EXCLUSIVOS. Dois marcados no mesmo
  // tipo fariam o `else if` de `efeitosDoDia` escolher em silêncio, e o efeito
  // dependeria da ordem em que os ifs foram escritos.
  it('abater, creditar e debitar são mutuamente exclusivos', () => {
    for (const t of EVENTOS_RH) {
      const ligados = [t.abonaJornada, t.contaComoTrabalhado, t.debitaBanco].filter(Boolean);
      expect({ codigo: t.codigo, ligados: ligados.length }).toEqual({
        codigo: t.codigo, ligados: ligados.length <= 1 ? ligados.length : 99,
      });
      expect(ligados.length).toBeLessThanOrEqual(1);
    }
  });

  it('quem mexe na jornada também justifica a ausência', () => {
    for (const t of EVENTOS_RH) {
      if (t.abonaJornada || t.contaComoTrabalhado || t.debitaBanco) {
        expect(t.justificaAusencia).toBe(true);
      }
    }
  });

  it('só falta injustificada e advertência NÃO justificam o dia', () => {
    const naoJustifica = EVENTOS_RH.filter((t) => !t.justificaAusencia).map((t) => t.codigo).sort();
    expect(naoJustifica).toEqual(['ADVERTENCIA', 'FALTA_INJUSTIFICADA']);
  });

  it('só a folga compensatória consome banco', () => {
    const debita = EVENTOS_RH.filter((t) => t.debitaBanco).map((t) => t.codigo);
    expect(debita).toEqual(['FOLGA_COMPENSATORIA']);
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
      minAbatidos: 0, minCreditados: 0, minDebitadoBanco: 0,
      tipos: [], abonado: false, faltaInjustificada: false,
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

describe('chaveSemana — a semana do DSR (segunda a domingo)', () => {
  it('todos os dias da mesma semana caem na mesma chave', () => {
    // 2026-08-24 é uma segunda-feira.
    for (const d of ['2026-08-24', '2026-08-26', '2026-08-30']) {
      expect(chaveSemana(d)).toBe('2026-08-24');
    }
  });

  it('a segunda seguinte abre semana nova', () => {
    expect(chaveSemana('2026-08-31')).toBe('2026-08-31');
  });

  it('domingo fecha a semana da segunda anterior, não abre a seguinte', () => {
    expect(chaveSemana('2026-08-30')).toBe('2026-08-24');
  });
});

describe('descontoFolha — o "faltou 1, perdeu 2"', () => {
  it('mês limpo não desconta nada', () => {
    expect(descontoFolha([])).toEqual({
      diasDescontados: 0, dsrPerdidos: 0, diasTotais: 0, semanas: [],
    });
  });

  it('uma falta custa o dia MAIS o DSR da semana', () => {
    const r = descontoFolha([{ data: '2026-08-25', tipo: 'FALTA_INJUSTIFICADA' }]);
    expect(r.diasDescontados).toBe(1);
    expect(r.dsrPerdidos).toBe(1);
    expect(r.diasTotais).toBe(2);
  });

  // O erro clássico de folha: cobrar um DSR por falta em vez de um por semana.
  it('duas faltas na MESMA semana perdem só UM DSR', () => {
    const r = descontoFolha([
      { data: '2026-08-25', tipo: 'FALTA_INJUSTIFICADA' },
      { data: '2026-08-26', tipo: 'FALTA_INJUSTIFICADA' },
    ]);
    expect(r.diasDescontados).toBe(2);
    expect(r.dsrPerdidos).toBe(1);
    expect(r.diasTotais).toBe(3);
  });

  it('faltas em semanas diferentes perdem um DSR cada', () => {
    const r = descontoFolha([
      { data: '2026-08-25', tipo: 'FALTA_INJUSTIFICADA' },
      { data: '2026-09-01', tipo: 'FALTA_INJUSTIFICADA' },
    ]);
    expect(r.dsrPerdidos).toBe(2);
    expect(r.diasTotais).toBe(4);
  });

  it('atestado NÃO desconta dia nem DSR', () => {
    const r = descontoFolha([
      { data: '2026-08-25', tipo: 'ATESTADO_MEDICO' },
      { data: '2026-08-26', tipo: 'ATESTADO_MEDICO' },
    ]);
    expect(r.diasTotais).toBe(0);
  });

  it('férias e treinamento não descontam', () => {
    const r = descontoFolha([
      { data: '2026-08-10', tipo: 'FERIAS' },
      { data: '2026-08-11', tipo: 'TREINAMENTO' },
      { data: '2026-08-12', tipo: 'NOJO' },
    ]);
    expect(r.diasTotais).toBe(0);
  });

  // Suspensão é o outro caso que desconta: ela não trabalha e não recebe.
  it('suspensão desconta dia e DSR igual à falta', () => {
    const r = descontoFolha([{ data: '2026-08-25', tipo: 'SUSPENSAO' }]);
    expect(r.diasTotais).toBe(2);
  });

  it('dois eventos no mesmo dia não descontam o dia em dobro', () => {
    const r = descontoFolha([
      { data: '2026-08-25', tipo: 'FALTA_INJUSTIFICADA' },
      { data: '2026-08-25', tipo: 'SUSPENSAO' },
    ]);
    expect(r.diasDescontados).toBe(1);
    expect(r.dsrPerdidos).toBe(1);
  });

  it('tipo desconhecido é ignorado, não vira desconto', () => {
    expect(descontoFolha([{ data: '2026-08-25', tipo: 'CHUTE' }]).diasTotais).toBe(0);
  });
});

describe('FOLGA de escala — o "FALTA que na verdade era folga"', () => {
  it('abona o dia inteiro sem descontar nada', () => {
    const t = tipoEvento('FOLGA')!;
    expect(t.abonaJornada).toBe(true);
    expect(t.descontaSalario).toBe(false);
    expect(t.descontaDSR).toBe(false);
    expect(t.contaArt130).toBe(false);
    expect(t.exigeDocumento).toBe(false);
    expect(minutosAbatidos({ tipo: 'FOLGA', diaInteiro: true }, JORNADA)).toBe(480);
  });

  // São coisas diferentes: FOLGA é escala, FOLGA_COMPENSATORIA é banco de horas.
  it('não se confunde com a folga compensatória', () => {
    expect(tipoEvento('FOLGA')!.admiteParcial).toBe(false);
    expect(tipoEvento('FOLGA_COMPENSATORIA')!.admiteParcial).toBe(true);
  });

  it('sai como abonado e não como falta', () => {
    const r = efeitosDoDia([{ tipo: 'FOLGA', diaInteiro: true }], JORNADA);
    expect(r.abonado).toBe(true);
    expect(r.faltaInjustificada).toBe(false);
    expect(r.minAbatidos).toBe(480);
  });
});

describe('FOLGA COMPENSATÓRIA — consome o banco (dono 29/08)', () => {
  // O erro que isto corrige: enquanto a folga abonava a jornada, o dia fechava
  // em zero. A funcionária acumulava hora extra, tirava a folga pra compensar,
  // e o saldo continuava igual — o banco só enchia.
  it('NÃO abona: o previsto fica de pé pro dia nascer negativo', () => {
    expect(tipoEvento('FOLGA_COMPENSATORIA')!.abonaJornada).toBe(false);
    expect(minutosAbatidos({ tipo: 'FOLGA_COMPENSATORIA', diaInteiro: true }, JORNADA)).toBe(0);
  });

  it('dia inteiro debita a jornada toda e não é falta', () => {
    const r = efeitosDoDia([{ tipo: 'FOLGA_COMPENSATORIA', diaInteiro: true }], JORNADA);
    expect(r.minAbatidos).toBe(0);        // previsto intacto → saldo −8h
    expect(r.minDebitadoBanco).toBe(480);
    expect(r.abonado).toBe(true);         // justificada: NÃO é falta
    expect(r.faltaInjustificada).toBe(false);
  });

  // Meia folga não precisa de conta própria: ela trabalha 4h de 8h previstas e
  // o saldo do dia dá −4h sozinho. O número só serve pra tela explicar.
  it('meia folga debita só as horas da janela', () => {
    const r = efeitosDoDia(
      [{ tipo: 'FOLGA_COMPENSATORIA', diaInteiro: false, horaInicio: '14:00', horaFim: '18:00' }],
      JORNADA,
    );
    expect(r.minDebitadoBanco).toBe(240);
    expect(r.minAbatidos).toBe(0);
  });

  it('não desconta salário nem DSR, e não conta pro art. 130', () => {
    const t = tipoEvento('FOLGA_COMPENSATORIA')!;
    expect(t.descontaSalario).toBe(false);
    expect(t.descontaDSR).toBe(false);
    expect(t.contaArt130).toBe(false);
    expect(descontoFolha([{ data: '2026-08-25', tipo: 'FOLGA_COMPENSATORIA' }]).diasTotais).toBe(0);
  });

  // Atestado de manhã abate 3h (previsto vira 5h); a folga da tarde só pode
  // consumir o que sobrou, senão o débito passaria da jornada do dia.
  it('débito respeita o previsto que sobrou do abate', () => {
    const r = efeitosDoDia(
      [
        { tipo: 'ATESTADO_MEDICO', diaInteiro: false, horaInicio: '09:00', horaFim: '12:00' },
        { tipo: 'FOLGA_COMPENSATORIA', diaInteiro: true },
      ],
      JORNADA,
    );
    expect(r.minAbatidos).toBe(180);
    expect(r.minDebitadoBanco).toBe(300);
  });

  it('em dia de folga do cadastro não há banco a consumir', () => {
    const r = efeitosDoDia([{ tipo: 'FOLGA_COMPENSATORIA', diaInteiro: true }], null);
    expect(r.minDebitadoBanco).toBe(0);
  });

  // FOLGA (escala) e FOLGA_COMPENSATORIA sao vizinhas na tela e opostas na conta.
  it('folga de ESCALA continua abonando — não mexe no banco', () => {
    const r = efeitosDoDia([{ tipo: 'FOLGA', diaInteiro: true }], JORNADA);
    expect(r.minAbatidos).toBe(480);
    expect(r.minDebitadoBanco).toBe(0);
  });
});
