/**
 * JORNADA DO DIA — o que o cadastro da funcionária diz sobre HOJE, e o que
 * isso muda na batida e na conta do espelho.
 *
 * Nasceu do sábado que CONTINUAVA descontando (dono, 26/09/2026): "os cálculos
 * têm que obedecer a jornada — o sábado está descontando a parte da tarde
 * mesmo cadastrado até as 13". Em 11/09 o cadastro tinha sido corrigido
 * (sábado 09:00–13:00 sem intervalo) e o PREVISTO caiu pra 4h — mas o
 * TRABALHADO continuou ZERO. As duas telas de ponto (PDV e celular) mandam
 * `tipo: 'auto'`, e o backend resolvia o tipo por uma sequência FIXA de quatro
 * batidas (entrada → saída almoço → volta → saída), sem olhar a jornada. No
 * sábado sem intervalo a saída das 13:00 nascia como "saída almoço"; o dia
 * ficava sem `saida`, o espelho exigia entrada+saída pra contar, e o dia
 * fechava −4h — as 4h da tarde que ela nunca deveu. A conferência de jornada
 * (`/retaguarda/rh/jornada`) pulava esses sábados como "sem batida", e a tela
 * do dia deixava a funcionária "no almoço" até a meia-noite.
 *
 * Três lados perguntam a mesma coisa e não podem divergir — por isso a régua
 * é uma só:
 *   · a BATIDA  (`proximaBatida`): quantos pontos o dia tem e qual é o próximo;
 *   · a CONTA   (`interpretarBatidas`): o que cada batida gravada significa à
 *     luz da jornada — inclusive as gravadas ANTES desta correção;
 *   · o PREVISTO (`minutosPrevistosDoTurno`): quanto o dia cobra.
 *
 * ── REGRAS ──
 *  1. Dia SEM intervalo cadastrado tem DUAS batidas: entrada e saída.
 *  2. Dia COM intervalo tem quatro. Dia sem cadastro, de folga ou com cadastro
 *     que não fecha (fim antes do início) também cai nas quatro: sem jornada
 *     não há o que obedecer, e o comportamento antigo é o menos surpreendente.
 *  3. Num dia sem intervalo, "saída almoço" gravada como ÚLTIMA batida do dia,
 *     sem `saida` depois, É a saída. É o rastro da sequência fixa nos sábados
 *     já batidos. Reinterpretar na LEITURA conserta o histórico sem reescrever
 *     registro de ponto — o carimbo do terminal fica intacto pra auditoria, a
 *     resposta carrega `tipoRegistrado` e a tela diz o que aconteceu.
 *  4. "Sem intervalo" = almoço ausente, com início igual ao fim (é como a
 *     grade da ficha representa), invertido, ou inteiro FORA da janela do
 *     turno. Almoço dentro da janela conta — o cadastro é a fonte, e erro de
 *     cadastro se enxerga na conferência, não se corrige em silêncio aqui.
 */

import { JanelaPrevista, minutosPrevistos, paraMinutos } from './eventos-rh';

export type TipoBatida = 'entrada' | 'saida_almoco' | 'volta_almoco' | 'saida';

export const TIPOS_BATIDA: readonly TipoBatida[] = [
  'entrada',
  'saida_almoco',
  'volta_almoco',
  'saida',
];

/** Dia com intervalo: os quatro pontos, na ordem em que a jornada acontece. */
export const SEQUENCIA_COM_INTERVALO: readonly TipoBatida[] = [
  'entrada',
  'saida_almoco',
  'volta_almoco',
  'saida',
];

/** Dia sem intervalo (sábado de meio período): entra e sai. */
export const SEQUENCIA_SEM_INTERVALO: readonly TipoBatida[] = ['entrada', 'saida'];

/** Chaves dos dias na ordem do `getDay()` (0 = domingo) — a mesma do JSON da ficha. */
export const DIAS_SEMANA = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'] as const;
export type DiaSemana = (typeof DIAS_SEMANA)[number];

/** Um dia do JSON de `Seller.horarioTrabalho`. */
export interface TurnoCadastrado {
  dia: string;
  inicio?: string | null;
  fim?: string | null;
  almocoInicio?: string | null;
  almocoFim?: string | null;
  folga?: boolean;
}

/**
 * Lê o JSON do cadastro sem derrubar quem chama. Texto ilegível ou formato
 * inesperado vale como "sem cadastro" — quem precisa distinguir os dois casos
 * (o lote que corrige a loja inteira) faz o próprio parse.
 */
export function parseHorarioTrabalho(raw: unknown): TurnoCadastrado[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((t) => t && typeof t === 'object');
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => t && typeof t === 'object') : [];
  } catch {
    return [];
  }
}

export function turnoDoDia(
  turnos: TurnoCadastrado[] | null | undefined,
  dia: string,
): TurnoCadastrado | null {
  if (!Array.isArray(turnos)) return null;
  const chave = String(dia || '').toUpperCase();
  return turnos.find((t) => String(t?.dia || '').toUpperCase() === chave) ?? null;
}

/** 'YYYY-MM-DD' (dia civil, já no fuso da loja) → 'SAB'. Null no que não for data. */
export function diaSemanaDeChave(ymd: unknown): DiaSemana | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (isNaN(d.getTime())) return null;
  return DIAS_SEMANA[d.getUTCDay()];
}

/**
 * A janela do turno no formato da régua de eventos de RH (`efeitosDoDia`).
 * Folga e cadastro vazio → null, que lá vale "dia sem jornada".
 */
export function janelaDoTurno(turno: TurnoCadastrado | null | undefined): JanelaPrevista | null {
  if (!turno || turno.folga) return null;
  return {
    inicio: String(turno.inicio ?? ''),
    fim: String(turno.fim ?? ''),
    almocoInicio: turno.almocoInicio ?? null,
    almocoFim: turno.almocoFim ?? null,
  };
}

/** Quanto o dia cobra, em minutos, já sem o intervalo. Folga e cadastro vazio = 0. */
export function minutosPrevistosDoTurno(turno: TurnoCadastrado | null | undefined): number {
  return minutosPrevistos(janelaDoTurno(turno));
}

/**
 * O DIA TEM INTERVALO DE ALMOÇO?
 *
 * Só quando o almoço existe, é positivo e cai DENTRO da janela do turno. Início
 * igual ao fim é como a grade da ficha diz "sem intervalo"; nulo é como o lote
 * de correção da loja grava; almoço inteiro fora da janela é cadastro que não
 * descreve intervalo nenhum.
 */
export function temIntervalo(turno: TurnoCadastrado | null | undefined): boolean {
  if (!turno || turno.folga) return false;
  const ini = paraMinutos(turno.inicio);
  const fim = paraMinutos(turno.fim);
  if (ini === null || fim === null || fim <= ini) return false;
  const aIni = paraMinutos(turno.almocoInicio);
  const aFim = paraMinutos(turno.almocoFim);
  if (aIni === null || aFim === null || aFim <= aIni) return false;
  return Math.min(fim, aFim) - Math.max(ini, aIni) > 0;
}

/** Quais batidas o dia tem, na ordem. Sem jornada a obedecer → as quatro. */
export function sequenciaDoDia(turno: TurnoCadastrado | null | undefined): readonly TipoBatida[] {
  if (!turno || turno.folga) return SEQUENCIA_COM_INTERVALO;
  if (minutosPrevistosDoTurno(turno) <= 0) return SEQUENCIA_COM_INTERVALO;
  return temIntervalo(turno) ? SEQUENCIA_COM_INTERVALO : SEQUENCIA_SEM_INTERVALO;
}

/**
 * A PRÓXIMA BATIDA DO DIA — o que `tipo: 'auto'` vira.
 *
 * Primeiro tipo da sequência do dia que ainda não foi batido; null quando o
 * dia está completo. Batida de tipo que não pertence à sequência (o rastro de
 * um "saída almoço" num sábado sem intervalo) não conta pra nada aqui: num
 * dia de duas batidas, depois da entrada a próxima é a saída — sempre.
 */
export function proximaBatida(
  turno: TurnoCadastrado | null | undefined,
  tiposBatidos: Iterable<string>,
): TipoBatida | null {
  const batidos = new Set(tiposBatidos);
  return sequenciaDoDia(turno).find((t) => !batidos.has(t)) ?? null;
}

export interface BatidaMinima {
  tipo: string;
  timestamp: Date | string;
}

export interface DiaInterpretado<B extends BatidaMinima> {
  /** As batidas em ordem de horário, com o tipo já interpretado e o registrado ao lado. */
  batidas: Array<B & { tipo: string; tipoRegistrado: string }>;
  entrada: Date | null;
  saidaAlmoco: Date | null;
  voltaAlmoco: Date | null;
  saida: Date | null;
  minTrabalhado: number;
  /** O dia é de duas batidas (jornada sem intervalo). */
  semIntervalo: boolean;
  /** Alguma batida mudou de tipo na leitura — a tela precisa dizer isso. */
  reinterpretada: boolean;
}

/**
 * O QUE AS BATIDAS DO DIA SIGNIFICAM, à luz da jornada.
 *
 * Regra 3 do cabeçalho: num dia sem intervalo, "saída almoço" como última
 * batida e sem `saida` depois é a saída. Vale também quando houve um intervalo
 * de verdade no meio (entrada, saída almoço, volta, "saída almoço"): a última
 * vira saída e o par do meio continua sendo descontado. Dia com intervalo
 * cadastrado não muda nada — ali "saída almoço" sem volta é dia incompleto,
 * e é assim que a supervisão precisa ver.
 *
 * Os horários de cada coluna são a PRIMEIRA batida de cada tipo (repetição vai
 * pra lista de "repetidas" da tela, como sempre foi).
 */
export function interpretarBatidas<B extends BatidaMinima>(
  batidas: readonly B[],
  turno: TurnoCadastrado | null | undefined,
): DiaInterpretado<B> {
  const ordenadas = [...batidas]
    .map((b) => ({ ...b, tipoRegistrado: b.tipo }))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const semIntervalo = sequenciaDoDia(turno) === SEQUENCIA_SEM_INTERVALO;
  let reinterpretada = false;
  if (semIntervalo && !ordenadas.some((b) => b.tipo === 'saida')) {
    const ultima = ordenadas[ordenadas.length - 1];
    if (ultima && ultima.tipo === 'saida_almoco') {
      ultima.tipo = 'saida';
      reinterpretada = true;
    }
  }

  const primeira = (tipo: TipoBatida): Date | null => {
    const b = ordenadas.find((x) => x.tipo === tipo);
    return b ? new Date(b.timestamp) : null;
  };
  const entrada = primeira('entrada');
  const saidaAlmoco = primeira('saida_almoco');
  const voltaAlmoco = primeira('volta_almoco');
  const saida = primeira('saida');

  return {
    batidas: ordenadas,
    entrada,
    saidaAlmoco,
    voltaAlmoco,
    saida,
    minTrabalhado: minutosTrabalhados({ entrada, saidaAlmoco, voltaAlmoco, saida }),
    semIntervalo,
    reinterpretada,
  };
}

/**
 * Minutos trabalhados: da entrada à saída, menos o intervalo quando os DOIS
 * lados dele foram batidos. Sem par entrada+saída o dia não conta — é
 * "registro incompleto", que a supervisão corrige no espelho.
 */
export function minutosTrabalhados(slots: {
  entrada: Date | null;
  saidaAlmoco: Date | null;
  voltaAlmoco: Date | null;
  saida: Date | null;
}): number {
  if (!slots.entrada || !slots.saida) return 0;
  let min = (slots.saida.getTime() - slots.entrada.getTime()) / 60000;
  if (slots.saidaAlmoco && slots.voltaAlmoco) {
    min -= (slots.voltaAlmoco.getTime() - slots.saidaAlmoco.getTime()) / 60000;
  }
  return Math.max(0, Math.round(min));
}
