/**
 * EVENTOS DE RH — por que o dia da funcionária ficou vazio.
 *
 * Régua única porque CINCO lados perguntam a mesma coisa e não podem divergir:
 * o espelho de ponto, o banco de horas, a régua de férias (art. 130), a fila
 * da loja e a folha. Antes disso não existia resposta nenhuma: o espelho
 * contava atestado, férias e dia de treinamento como FALTA, e o banco de horas
 * ainda punha o dia de atestado como saldo NEGATIVO — a funcionária pagava com
 * hora extra o dia em que estava doente.
 *
 * ── LISTA FECHADA ──
 * O `codigo` vai pro banco e NUNCA muda: mudar quebra o histórico já gravado, e
 * histórico de RH é prova em reclamação trabalhista. O `label` é da tela e pode
 * ser reescrito à vontade. Campo livre viraria "atestado", "atestado medico" e
 * "ATEST." — e aí não dá pra contar absenteísmo nem aplicar o art. 130.
 *
 * ── OS EFEITOS SÃO DO TIPO, NUNCA DIGITADOS ──
 * Ninguém marca "esse atestado desconta?" na tela. Quem responde é o TIPO. É a
 * mesma decisão de `motivos-desligamento.ts`: o dia em que dois eventos do
 * mesmo tipo tiverem efeito diferente, nenhum relatório fecha.
 *
 * ── DECISÕES DO DONO (28/08/2026) ──
 *  1. Quem lança é a SUPERVISÃO (matriz). Não há fluxo de pedir/aprovar — a
 *     supervisão lança e vale. Loja não lança, e a funcionária também não.
 *  2. ATESTADO ABATE SOMENTE AS HORAS DO ATESTADO. Atestado de 4h numa jornada
 *     de 8h derruba 4h do previsto — as outras 4h ela deve normalmente. Só
 *     atestado sem hora marcada (`diaInteiro`) derruba o dia todo. É por isso
 *     que `admiteParcial` existe e que `minutosAbatidos` faz interseção de
 *     janela em vez de zerar o dia.
 *  3. Férias convivem em DOIS lugares por ora — `Seller.dataInicioFerias/Fim`
 *     (legado) e o evento FERIAS. Ordem do dono: manter os dois até ajustar.
 *     Quando cair o legado, esta régua já é a fonte.
 *  4. eSocial: o código da Tabela 18 (evento S-2230) fica GRAVADO desde já,
 *     custo zero. Exportação de verdade fica pra depois.
 *
 * ── CORREÇÃO DO DONO (29/08/2026): FOLGA COMPENSATÓRIA DEBITA ──
 *
 * A primeira versão tratava folga compensatória como as outras justificativas:
 * abonava a jornada e o dia fechava em zero. Errado — assim o banco de horas
 * só ENCHIA. A funcionária acumulava hora extra, tirava a folga pra compensar
 * e o saldo continuava igual, porque o dia da folga não custava nada.
 *
 * Isso obrigou a separar duas perguntas que estavam grudadas num flag só:
 *   · `justificaAusencia` → o dia está EXPLICADO (não é falta)
 *   · `abonaJornada`      → o dia SAI da conta de horas
 * Quase tudo tem as duas. A folga compensatória tem só a primeira: é
 * justificada e mesmo assim pesa −8h, que é exatamente o consumo do banco.
 */

export type GrupoEventoRh =
  | 'ausencia'    // falta pura
  | 'saude'       // atestado, INSS, acidente
  | 'legal'       // art. 473 da CLT
  | 'programado'  // férias, folga, licenças
  | 'parcial'     // atraso, saída antecipada
  | 'disciplinar' // advertência, suspensão
  | 'presente';   // trabalhando, só que fora da loja

export interface TipoEventoRh {
  /** Vai pro banco. NUNCA muda. */
  codigo: string;
  /** Aparece na tela. Pode mudar. */
  label: string;
  grupo: GrupoEventoRh;

  /**
   * O DIA ESTÁ EXPLICADO — não é falta, mesmo sem batida nenhuma.
   *
   * Separado de `abonaJornada` porque são perguntas diferentes, e juntá-las foi
   * um erro de desenho: "por que o dia ficou vazio" e "o dia sai da conta de
   * horas" não andam sempre juntos. A folga compensatória é o contraexemplo —
   * é justificadíssima E tem que pesar negativo no banco.
   */
  justificaAusencia: boolean;

  /**
   * Tira os minutos do PREVISTO do dia, deixando o saldo NEUTRO (zero).
   *
   * É o certo pra atestado, férias e licenças: a funcionária não deve essas
   * horas a ninguém. NÃO é o certo pra folga compensatória — ver `debitaBanco`.
   */
  abonaJornada: boolean;

  /**
   * O dia CONSOME saldo do banco de horas: o previsto FICA de pé e ela não
   * trabalha, então o saldo do dia nasce negativo e o total do mês cai na mesma
   * medida (`saldo = trabalhado − previsto`).
   *
   * Ordem do dono (29/08). Enquanto a folga compensatória abonava a jornada,
   * sair usando o banco não custava nada: a funcionária tirava o dia e o saldo
   * continuava igual — o banco só enchia, nunca esvaziava. A dedução não precisa
   * de conta própria; ela cai sozinha do momento em que se para de abonar.
   *
   * Meia folga funciona igual e de graça: ela trabalha 4h de uma jornada de 8h,
   * o saldo do dia dá −4h. Por isso `admiteParcial` continua valendo.
   */
  debitaBanco: boolean;

  /**
   * SOMA os minutos no TRABALHADO em vez de tirá-los do previsto — a
   * funcionária estava de fato trabalhando, só que fora da loja (treinamento,
   * evento da empresa).
   *
   * ⚠️ É um OU exclusivo com o abate, não um "além de". Abater E creditar o
   * mesmo dia deixaria previsto 0 e trabalhado 8h: saldo +8h, ou seja, um dia
   * de treinamento pagaria hora extra. Creditando só, previsto e trabalhado
   * empatam e o dia fecha em zero — que é o certo.
   */
  contaComoTrabalhado: boolean;

  /** A folha desconta o dia. */
  descontaSalario: boolean;

  /**
   * Faz perder o DSR da semana (Lei 605/49 art. 6º). Falta injustificada
   * desconta dia + DSR — o "faltou 1, perdeu 2". Ausência do art. 473 e falta
   * coberta por atestado mantêm o DSR inteiro.
   */
  descontaDSR: boolean;

  /**
   * Conta pra régua do art. 130: a partir de 6 faltas injustificadas no
   * período aquisitivo o direito a férias cai de 30 dias. É o dado que o
   * `ferias-clt.ts` avisa no cabeçalho que não tinha.
   */
  contaArt130: boolean;

  /** A tela obriga anexar o documento (atestado, certidão). */
  exigeDocumento: boolean;

  /** Aceita hora de início/fim. Quando false, o evento é sempre dia inteiro. */
  admiteParcial: boolean;

  /** Código da Tabela 18 do eSocial (S-2230). Null = não é afastamento eSocial. */
  esocial: string | null;

  /** Teto legal de dias por ocorrência (art. 473). Null = sem teto. */
  limiteDias?: number;

  nota?: string;
}

export const EVENTOS_RH: TipoEventoRh[] = [
  // ── AUSÊNCIA NÃO ABONADA ────────────────────────────────────────
  {
    codigo: 'FALTA_INJUSTIFICADA',
    label: 'Falta injustificada',
    grupo: 'ausencia',
    justificaAusencia: false,
    abonaJornada: false,       // o buraco no dia é dela mesmo
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: true,
    descontaDSR: true,
    contaArt130: true,
    exigeDocumento: false,
    admiteParcial: false,
    esocial: null,
    nota: 'Desconta o dia E o DSR da semana. Conta pro art. 130.',
  },

  // ── SAÚDE ───────────────────────────────────────────────────────
  {
    codigo: 'ATESTADO_MEDICO',
    label: 'Atestado médico',
    grupo: 'saude',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: true,
    admiteParcial: true,       // ordem do dono: abate SÓ as horas do atestado
    esocial: null,             // até 15 dias não vira S-2230
    nota: 'Até 15 dias, pago pela empresa. Passou disso, use AFASTAMENTO_INSS.',
  },
  {
    codigo: 'AFASTAMENTO_INSS',
    label: 'Afastamento INSS (doença)',
    grupo: 'saude',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: true,
    admiteParcial: false,
    esocial: '03',
    nota: 'Doença não ocupacional acima de 15 dias. Acima de 6 meses zera o aquisitivo (art. 133 IV).',
  },
  {
    codigo: 'ACIDENTE_TRABALHO',
    label: 'Acidente de trabalho',
    grupo: 'saude',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: true,
    admiteParcial: false,
    esocial: '01',
  },

  // ── ART. 473 DA CLT — falta sem prejuízo do salário ──────────────
  {
    codigo: 'NOJO',
    label: 'Falecimento na família',
    grupo: 'legal',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: false,
    admiteParcial: false,
    esocial: null,
    limiteDias: 2,
    nota: 'Art. 473 I — 2 dias consecutivos.',
  },
  {
    codigo: 'GALA',
    label: 'Casamento',
    grupo: 'legal',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: false,
    admiteParcial: false,
    esocial: null,
    limiteDias: 3,
    nota: 'Art. 473 II — 3 dias consecutivos.',
  },
  {
    codigo: 'DOACAO_SANGUE',
    label: 'Doação de sangue',
    grupo: 'legal',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: true,
    admiteParcial: false,
    esocial: null,
    limiteDias: 1,
    nota: 'Art. 473 IV — 1 dia a cada 12 meses.',
  },
  {
    codigo: 'ALISTAMENTO_ELEITORAL',
    label: 'Alistamento / título de eleitor',
    grupo: 'legal',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: false,
    admiteParcial: false,
    esocial: null,
    limiteDias: 2,
    nota: 'Art. 473 V — até 2 dias.',
  },
  {
    codigo: 'VESTIBULAR',
    label: 'Prova de vestibular / concurso',
    grupo: 'legal',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: true,
    admiteParcial: true,
    esocial: null,
    nota: 'Art. 473 VII — nos dias de prova, com comprovante.',
  },
  {
    codigo: 'CONSULTA_FILHO',
    label: 'Acompanhar filho ao médico',
    grupo: 'legal',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: true,
    admiteParcial: true,
    esocial: null,
    limiteDias: 1,
    nota: 'Art. 473 XI — 1 dia por ano, filho de até 6 anos.',
  },
  {
    codigo: 'PRE_NATAL',
    label: 'Consulta pré-natal',
    grupo: 'legal',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: true,
    admiteParcial: true,
    esocial: null,
    nota: 'Art. 473 X — até 6 consultas/exames no período.',
  },

  // ── PROGRAMADO ──────────────────────────────────────────────────
  {
    codigo: 'FERIAS',
    label: 'Férias',
    grupo: 'programado',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: false,
    admiteParcial: false,
    esocial: '15',
    nota: 'Convive com Seller.dataInicioFerias/Fim até o dono mandar aposentar o legado.',
  },
  {
    // FOLGA DE ESCALA — o dia não era pra ser trabalhado, ponto.
    //
    // Diferente da FOLGA_COMPENSATORIA, que é troca de banco de horas. Esta
    // existe porque o `horarioTrabalho` do cadastro é uma semana FIXA, e a
    // escala real do varejo gira: o sábado que o cadastro diz que ela trabalha
    // é o sábado em que ela folgou. Sem este tipo, corrigir isso obrigava a
    // mexer no cadastro da funcionária — e mexer no cadastro reescreve o
    // passado inteiro dela, não só aquele dia.
    codigo: 'FOLGA',
    label: 'Folga (escala)',
    grupo: 'programado',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: false,
    admiteParcial: false,
    esocial: null,
    nota: 'O dia não era de trabalho. Use pra corrigir FALTA que na verdade era folga.',
  },
  {
    codigo: 'FOLGA_COMPENSATORIA',
    label: 'Folga compensatória (banco de horas)',
    grupo: 'programado',
    justificaAusencia: true,
    // NÃO abona (ordem do dono, 29/08). Abonando, o previsto sumia e o dia
    // fechava em zero: a funcionária tirava a folga e o banco continuava
    // cheio — só enchia, nunca esvaziava. Deixando o previsto de pé, o dia
    // nasce com saldo negativo e o total do mês cai na mesma medida.
    abonaJornada: false,
    contaComoTrabalhado: false,
    debitaBanco: true,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: false,
    admiteParcial: true,
    esocial: null,
    nota: 'CONSOME o banco: o dia entra negativo e o saldo do mês cai. Não é falta.',
  },
  {
    codigo: 'LICENCA_MATERNIDADE',
    label: 'Licença-maternidade',
    grupo: 'programado',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: true,
    admiteParcial: false,
    esocial: '17',
  },
  {
    codigo: 'LICENCA_PATERNIDADE',
    label: 'Licença-paternidade',
    grupo: 'programado',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: false,
    admiteParcial: false,
    esocial: null,
    limiteDias: 5,
    nota: 'Art. 473 III — 5 dias (20 no Empresa Cidadã).',
  },

  // ── PARCIAL ─────────────────────────────────────────────────────
  {
    codigo: 'ATRASO_JUSTIFICADO',
    label: 'Atraso justificado',
    grupo: 'parcial',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: false,
    admiteParcial: true,
    esocial: null,
    nota: 'Lançar com hora de início e fim — abate só a janela perdida.',
  },
  {
    codigo: 'SAIDA_ANTECIPADA',
    label: 'Saída antecipada autorizada',
    grupo: 'parcial',
    justificaAusencia: true,
    abonaJornada: true,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: false,
    admiteParcial: true,
    esocial: null,
  },

  // ── DISCIPLINAR ─────────────────────────────────────────────────
  {
    codigo: 'ADVERTENCIA',
    label: 'Advertência',
    grupo: 'disciplinar',
    justificaAusencia: false,
    abonaJornada: false,
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: false,
    admiteParcial: false,
    esocial: null,
    nota: 'NÃO é ausência — ela trabalhou. Fica no prontuário como registro.',
  },
  {
    codigo: 'SUSPENSAO',
    label: 'Suspensão disciplinar',
    grupo: 'disciplinar',
    justificaAusencia: true,
    abonaJornada: true,        // ela está suspensa: não deve essas horas
    contaComoTrabalhado: false,
    debitaBanco: false,
    descontaSalario: true,     // mas também não recebe por elas
    descontaDSR: true,
    contaArt130: false,
    exigeDocumento: false,
    admiteParcial: false,
    esocial: null,
    limiteDias: 30,
    nota: 'Suspensão acima de 30 dias é rescisão (art. 474).',
  },

  // ── PRESENTE, SÓ QUE FORA DA LOJA ───────────────────────────────
  {
    codigo: 'TREINAMENTO',
    label: 'Treinamento',
    grupo: 'presente',
    justificaAusencia: true,
    abonaJornada: false,        // não sai da conta: ela CUMPRIU a jornada
    contaComoTrabalhado: true,  // ela estava trabalhando
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: false,
    admiteParcial: true,
    esocial: null,
    nota: 'Sem isto, dia de treinamento aparecia como FALTA na tela da loja.',
  },
  {
    codigo: 'EVENTO_EMPRESA',
    label: 'Evento da empresa',
    grupo: 'presente',
    justificaAusencia: true,
    abonaJornada: false,
    contaComoTrabalhado: true,
    debitaBanco: false,
    descontaSalario: false,
    descontaDSR: false,
    contaArt130: false,
    exigeDocumento: false,
    admiteParcial: true,
    esocial: null,
    nota: 'Live, inventário, mutirão, feira — trabalhou fora da loja dela.',
  },
];

const POR_CODIGO = new Map(EVENTOS_RH.map((t) => [t.codigo, t]));

export function tipoEventoValido(codigo: unknown): boolean {
  return !!codigo && POR_CODIGO.has(String(codigo));
}

export function tipoEvento(codigo: unknown): TipoEventoRh | null {
  return POR_CODIGO.get(String(codigo)) ?? null;
}

export function rotuloEvento(codigo: unknown): string | null {
  return POR_CODIGO.get(String(codigo))?.label ?? null;
}

// ── JANELA DO DIA ────────────────────────────────────────────────

/** Turno cadastrado em `Seller.horarioTrabalho` (uma entrada do JSON). */
export interface JanelaPrevista {
  inicio: string;                 // "09:00"
  fim: string;                    // "18:00"
  almocoInicio?: string | null;   // "12:00"
  almocoFim?: string | null;      // "13:00"
}

/** Evento reduzido ao que a conta do dia precisa saber. */
export interface EventoDoDia {
  /** Só pra tela poder REMOVER o evento do dia. A conta não usa. */
  id?: string;
  tipo: string;
  diaInteiro: boolean;
  horaInicio?: string | null;
  horaFim?: string | null;
}

/** "HH:MM" → minutos desde a meia-noite. Devolve null no que não for hora. */
export function paraMinutos(hhmm: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutos de sobreposição entre [a1,a2) e [b1,b2). Nunca negativo. */
function interseccao(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

/** Minutos de jornada da janela cadastrada, já sem o almoço. */
export function minutosPrevistos(janela: JanelaPrevista | null | undefined): number {
  if (!janela) return 0;
  const ini = paraMinutos(janela.inicio);
  const fim = paraMinutos(janela.fim);
  if (ini === null || fim === null || fim <= ini) return 0;
  let total = fim - ini;
  const aIni = paraMinutos(janela.almocoInicio);
  const aFim = paraMinutos(janela.almocoFim);
  if (aIni !== null && aFim !== null && aFim > aIni) {
    total -= interseccao(ini, fim, aIni, aFim);
  }
  return Math.max(0, total);
}

/**
 * QUANTOS MINUTOS DE JORNADA ESTE EVENTO DERRUBA NESTE DIA.
 *
 * A decisão nº 2 do dono mora aqui: **abate somente os horários do evento**.
 * Atestado das 8h às 12h numa jornada 09:00–18:00 com almoço 12:00–13:00 abate
 * 3h (09:00→12:00) — não o dia inteiro, e não as 4h do papel, porque uma hora
 * do atestado cai antes de ela entrar.
 *
 * Dia inteiro (ou tipo que não admite parcial) derruba a jornada toda.
 * Evento sem hora preenchida também vale como dia inteiro: quem lança marcou
 * "dia todo" e não deve virar zero por causa de um campo em branco.
 */
export function minutosAbatidos(
  evento: EventoDoDia,
  janela: JanelaPrevista | null | undefined,
): number {
  const tipo = tipoEvento(evento.tipo);
  if (!tipo?.abonaJornada) return 0;
  return minutosDaJanela(evento, janela);
}

/**
 * QUANTOS MINUTOS DE JORNADA ESTE EVENTO COBRE NESTE DIA — só a geometria.
 *
 * A conta da interseção é a mesma pros três efeitos possíveis (abater, creditar
 * e debitar do banco); o que muda é quem recebe o número. Ficou separada dos
 * flags pra folga compensatória poder dizer "quanto de banco isso consome" sem
 * precisar abonar nada.
 */
export function minutosDaJanela(
  evento: EventoDoDia,
  janela: JanelaPrevista | null | undefined,
): number {
  const tipo = tipoEvento(evento.tipo);
  if (!tipo) return 0;

  const previsto = minutosPrevistos(janela);
  if (previsto <= 0) return 0;

  const evIni = paraMinutos(evento.horaInicio);
  const evFim = paraMinutos(evento.horaFim);
  const parcial =
    !evento.diaInteiro &&
    tipo.admiteParcial &&
    evIni !== null &&
    evFim !== null &&
    evFim > evIni;

  if (!parcial) return previsto;

  const jIni = paraMinutos(janela!.inicio)!;
  const jFim = paraMinutos(janela!.fim)!;
  let abate = interseccao(jIni, jFim, evIni!, evFim!);

  // O almoço não é jornada — não pode ser abatido duas vezes.
  const aIni = paraMinutos(janela!.almocoInicio);
  const aFim = paraMinutos(janela!.almocoFim);
  if (aIni !== null && aFim !== null && aFim > aIni) {
    abate -= interseccao(Math.max(jIni, evIni!), Math.min(jFim, evFim!), aIni, aFim);
  }

  return Math.max(0, Math.min(previsto, Math.round(abate)));
}

export interface EfeitoDoDia {
  /** Minutos tirados do PREVISTO (atestado, férias, folga de escala). */
  minAbatidos: number;
  /** Minutos somados no TRABALHADO (treinamento/evento). Nunca abatidos junto. */
  minCreditados: number;
  /**
   * Minutos de folga compensatória no dia — quanto do BANCO isto consome.
   *
   * Informativo: o débito já acontece sozinho, porque estes minutos ficam no
   * previsto e ninguém os trabalha. Serve pra tela poder dizer "usou 8h do
   * banco" em vez de deixar o saldo negativo parecendo falta.
   */
  minDebitadoBanco: number;
  /** Códigos dos eventos que pesaram no dia, na ordem em que vieram. */
  tipos: string[];
  /** O dia está EXPLICADO — não pode ser chamado de falta. */
  abonado: boolean;
  /** Alguma falta injustificada caiu neste dia (art. 130 / DSR). */
  faltaInjustificada: boolean;
}

/**
 * Consolida TODOS os eventos que caem no mesmo dia.
 *
 * Dois eventos no mesmo dia acontecem de verdade (atestado de manhã + saída
 * antecipada à tarde). Somar sem teto criaria previsto negativo e daria hora
 * extra de presente — por isso o total é limitado à jornada do dia.
 *
 * Abate e crédito são caminhos SEPARADOS, e o crédito só ocupa o que sobrou do
 * previsto: atestado de manhã (3h) + treinamento à tarde (5h) numa jornada de
 * 8h fecha em previsto 5h / creditado 5h — saldo zero, sem hora extra fantasma.
 */
export function efeitosDoDia(
  eventos: EventoDoDia[] | null | undefined,
  janela: JanelaPrevista | null | undefined,
): EfeitoDoDia {
  const vazio: EfeitoDoDia = {
    minAbatidos: 0,
    minCreditados: 0,
    minDebitadoBanco: 0,
    tipos: [],
    abonado: false,
    faltaInjustificada: false,
  };
  if (!eventos?.length) return vazio;

  const previsto = minutosPrevistos(janela);
  let abatidos = 0;
  let creditados = 0;
  let debitados = 0;
  const tipos: string[] = [];
  let abonado = false;
  let falta = false;

  for (const ev of eventos) {
    const t = tipoEvento(ev.tipo);
    if (!t) continue;
    tipos.push(t.codigo);
    if (t.contaArt130) falta = true;
    // O dia estar EXPLICADO não depende de mexer na jornada: folga
    // compensatória justifica a ausência E deixa o previsto de pé.
    if (t.justificaAusencia) abonado = true;

    const m = minutosDaJanela(ev, janela);
    // Três destinos possíveis pro mesmo número, e só um vale por evento:
    //  · abater   → o dia sai da conta (atestado, férias, folga de escala)
    //  · creditar → contou como trabalhado (treinamento)
    //  · debitar  → consome banco; NÃO mexe na jornada, o negativo é o efeito
    if (t.abonaJornada) abatidos += m;
    else if (t.contaComoTrabalhado) creditados += m;
    else if (t.debitaBanco) debitados += m;
  }

  // Teto: o dia não abate mais jornada do que tem, e o crédito só preenche o
  // que sobrou depois do abate. Sem isso, previsto ficaria negativo — e
  // previsto negativo vira hora extra de presente no banco de horas.
  if (previsto > 0) {
    abatidos = Math.min(abatidos, previsto);
    creditados = Math.min(creditados, previsto - abatidos);
    // O débito também não passa do que restou de jornada: meia folga
    // compensatória em cima de meio atestado consome só as horas que sobraram.
    debitados = Math.min(debitados, previsto - abatidos);
  }

  return {
    minAbatidos: abatidos,
    minCreditados: creditados,
    minDebitadoBanco: debitados,
    tipos,
    abonado,
    faltaInjustificada: falta,
  };
}

// ── FOLHA: O QUE DESCONTA ────────────────────────────────────────

/**
 * Chave da SEMANA de um dia "YYYY-MM-DD", segunda a domingo.
 *
 * A semana existe aqui por causa do DSR: a Lei 605/49 tira o descanso
 * REMUNERADO da semana em que houve falta injustificada — uma vez por semana,
 * não uma por falta. Faltar segunda e terça da mesma semana custa 2 dias + 1
 * DSR, não 2 + 2. Contar por falta seria descontar a mais da funcionária.
 */
export function chaveSemana(data: string): string {
  const d = new Date(`${String(data).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return String(data);
  // getUTCDay: 0=DOM. Segunda vira o dia 0 da semana.
  const desdeSegunda = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - desdeSegunda);
  return d.toISOString().slice(0, 10);
}

export interface DescontoFolha {
  /** Dias de trabalho a descontar do salário. */
  diasDescontados: number;
  /** DSRs perdidos — no máximo um por semana atingida. */
  dsrPerdidos: number;
  /** Total de dias a descontar (dias + DSR). É o número que vai pra folha. */
  diasTotais: number;
  /** Semanas atingidas, pra tela poder mostrar o porquê do DSR. */
  semanas: string[];
}

/**
 * O QUE ESTE MÊS DESCONTA.
 *
 * Recebe a lista já expandida de (dia, tipo) e devolve os dias de desconto.
 * Puro de propósito: a régua do "faltou 1, perdeu 2" precisa ser conferível
 * sem banco, porque erro aqui sai do bolso da funcionária.
 *
 * Dia repetido não conta duas vezes: dois eventos que descontam no mesmo dia
 * (o que não deveria acontecer, mas acontece) descontariam o dia em dobro.
 */
export function descontoFolha(dias: Array<{ data: string; tipo: string }>): DescontoFolha {
  const diasComDesconto = new Set<string>();
  const semanas = new Set<string>();

  for (const d of dias ?? []) {
    const t = tipoEvento(d.tipo);
    if (!t) continue;
    const chave = String(d.data).slice(0, 10);
    if (t.descontaSalario) diasComDesconto.add(chave);
    if (t.descontaDSR) semanas.add(chaveSemana(chave));
  }

  const diasDescontados = diasComDesconto.size;
  const dsrPerdidos = semanas.size;
  return {
    diasDescontados,
    dsrPerdidos,
    diasTotais: diasDescontados + dsrPerdidos,
    semanas: [...semanas].sort(),
  };
}
