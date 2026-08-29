/**
 * FÉRIAS — período aquisitivo, período concessivo e a data limite pra conceder.
 *
 * ── COMO A CLT MONTA ISSO ──
 *
 * PERÍODO AQUISITIVO (art. 130): 12 meses de trabalho. Ao fim deles a
 * funcionária ADQUIRIU o direito a 30 dias de férias. O ciclo se repete: o
 * segundo aquisitivo vai de 12 a 24 meses de casa, e assim por diante.
 *
 * PERÍODO CONCESSIVO (art. 134): os 12 meses SEGUINTES ao aquisitivo. É a
 * janela em que o empregador tem que conceder.
 *
 * DOBRA (art. 137): concedeu depois disso, paga em dobro.
 *
 * ── POR QUE ESTE ARQUIVO FALA EM 11 MESES ──
 *
 * O dono pediu o limite considerando 11 meses de concessivo. A CLT diz 12 — e
 * as duas coisas convivem, porque são perguntas diferentes:
 *
 *   · a lei limita o FIM do gozo: as férias têm que ser usufruídas dentro do
 *     concessivo, não só começadas nele;
 *   · logo, umas férias de 30 dias precisam COMEÇAR até um mês antes do fim.
 *
 * Daí o RH trabalhar com 11 meses: é o último dia em que ainda dá pra INICIAR
 * 30 dias corridos sem estourar. Este módulo devolve os dois — `limiteInicio`
 * (o que interessa pra programar) e `fimConcessivo` (a linha da dobra).
 *
 * ── FALTAS (art. 130) — LIGADO EM 28/08/2026 ──
 *
 * O direito NÃO é sempre 30 dias: cada faixa de faltas injustificadas no
 * período aquisitivo derruba um degrau. Quem passa de 32 faltas perde as
 * férias inteiras. Enquanto o sistema não guardava o motivo do dia vazio, esta
 * conta era impossível e o módulo assumia 30 dias pra todo mundo.
 *
 * Agora a contagem vem de `rh-eventos` (`faltasInjustificadas`), que só conta
 * o tipo FALTA_INJUSTIFICADA — atestado, férias e treinamento não entram, que
 * é justamente o ponto de existir a régua de eventos.
 *
 * A falta é passada por FORA (`opts.faltasInjustificadas`) de propósito: este
 * arquivo é puro e testável, e quem tem banco é o service.
 *
 * ── O QUE ELE AINDA NÃO SABE ──
 *
 * Não trata afastamento pelo INSS acima de 6 meses (que zera o aquisitivo,
 * art. 133 IV), licença-maternidade, nem o fracionamento em até 3 períodos
 * (art. 134 §1º, com um deles ≥ 14 dias).
 */

/** Soma meses mantendo o dia; cai no último dia do mês quando ele não existe
 *  (admissão em 31/01 + 1 mês = 28/02, não 03/03). */
export function somarMeses(d: Date, meses: number): Date {
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  r.setUTCMonth(r.getUTCMonth() + meses);
  const ultimoDia = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(d.getUTCDate(), ultimoDia));
  return r;
}

/** Dias corridos entre duas datas (b − a), ignorando hora. */
export function diasEntre(a: Date, b: Date): number {
  const dia = 24 * 60 * 60 * 1000;
  const ua = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const ub = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((ub - ua) / dia);
}

export type SituacaoFerias =
  /** Ainda não completou 12 meses de casa — não adquiriu o direito. */
  | 'aquisitivo'
  /** Direito adquirido, dentro do prazo com folga. */
  | 'no_prazo'
  /** Faltam 90 dias ou menos pro limite de início. Hora de programar. */
  | 'proximo'
  /** Passou do limite de início: 30 dias corridos já não cabem no concessivo. */
  | 'vencendo'
  /** Passou do fim do concessivo — art. 137, férias em dobro. */
  | 'dobra';

export interface Ferias {
  /** Nº do ciclo: 1 = primeiras férias, 2 = segundas... */
  ciclo: number;
  inicioAquisitivo: Date;
  /** Fim do aquisitivo = data em que o direito nasce. */
  fimAquisitivo: Date;
  /** O concessivo começa junto, no dia seguinte ao direito nascer. */
  fimConcessivo: Date;
  /** Último dia pra INICIAR 30 dias sem estourar o concessivo. */
  limiteInicio: Date;
  /** Negativo = já passou. */
  diasAteLimite: number;
  situacao: SituacaoFerias;
  /** Quanto custaria conceder fora do prazo (art. 137): dobra. */
  emDobra: boolean;
  /** Faltas injustificadas contadas no aquisitivo deste ciclo. */
  faltasInjustificadas: number;
  /** Dias de férias a que ela tem direito depois do art. 130. */
  diasDireito: number;
  /** true quando as faltas já derrubaram o direito abaixo de 30 dias. */
  reduzidoPorFaltas: boolean;
}

/**
 * ART. 130 — quantos dias de férias sobram depois das faltas injustificadas.
 *
 * A escada é a da lei, e é escada mesmo: a 6ª falta derruba 6 dias de uma vez.
 *
 *   até 5 faltas ...... 30 dias
 *   de  6 a 14 ........ 24 dias
 *   de 15 a 23 ........ 18 dias
 *   de 24 a 32 ........ 12 dias
 *   acima de 32 ....... 0 dias (perde as férias)
 */
export function diasDeFeriasPorFaltas(faltas: number): number {
  const f = Number.isFinite(faltas) && faltas > 0 ? Math.floor(faltas) : 0;
  if (f <= 5) return 30;
  if (f <= 14) return 24;
  if (f <= 23) return 18;
  if (f <= 32) return 12;
  return 0;
}

export interface OpcoesFerias {
  /** Meses do concessivo pra efeito de LIMITE DE INÍCIO. Default 11. */
  mesesConcessivoInicio?: number;
  /** Meses do concessivo pela letra da lei. Default 12. */
  mesesConcessivoLegal?: number;
  /** Dias de férias que precisam caber. Default 30. */
  diasFerias?: number;
  /** "Hoje" — injetável pra teste e pra fuso. */
  hoje?: Date;
  /**
   * Faltas injustificadas DENTRO do aquisitivo vigente (art. 130). Vem de fora
   * porque este módulo é puro; quem conta é `RhEventosService`. Omitido = 0,
   * que devolve os 30 dias cheios — o comportamento de antes de 28/08/2026.
   */
  faltasInjustificadas?: number;
}

/**
 * Calcula o ciclo de férias VIGENTE de uma funcionária.
 *
 * Vigente = o ciclo mais antigo ainda não concedido. Como o sistema não guarda
 * histórico de férias gozadas, assume-se que os anteriores foram resolvidos e
 * olha-se o aquisitivo mais recente que já fechou. Quando houver histórico,
 * trocar `ciclo` pelo primeiro em aberto de verdade.
 */
export function calcularFerias(admissao: Date, opts: OpcoesFerias = {}): Ferias {
  const mesesInicio = opts.mesesConcessivoInicio ?? 11;
  const mesesLegal = opts.mesesConcessivoLegal ?? 12;
  const hoje = opts.hoje ?? new Date();

  // Quantos aquisitivos JÁ fecharam. 0 = ainda no primeiro ano de casa.
  let fechados = 0;
  while (somarMeses(admissao, 12 * (fechados + 1)) <= hoje) fechados++;

  // Ciclo vigente: o último fechado. Se nenhum fechou, mostra o primeiro (que
  // está em curso) pra tela poder dizer "adquire o direito em tal data".
  const ciclo = Math.max(1, fechados);
  const inicioAquisitivo = somarMeses(admissao, 12 * (ciclo - 1));
  const fimAquisitivo = somarMeses(admissao, 12 * ciclo);
  const fimConcessivo = somarMeses(fimAquisitivo, mesesLegal);
  const limiteInicio = somarMeses(fimAquisitivo, mesesInicio);
  const diasAteLimite = diasEntre(hoje, limiteInicio);

  // Comparação por DIA, não por instante. Comparando timestamps, quem tem o
  // limite HOJE aparecia como vencida às 00:01 — e o último dia do prazo ainda
  // é prazo: férias que começam hoje cabem.
  const diasAteFimConcessivo = diasEntre(hoje, fimConcessivo);

  let situacao: SituacaoFerias;
  if (fechados === 0) situacao = 'aquisitivo';
  else if (diasAteFimConcessivo < 0) situacao = 'dobra';
  else if (diasAteLimite < 0) situacao = 'vencendo';
  else if (diasAteLimite <= 90) situacao = 'proximo';
  else situacao = 'no_prazo';

  const faltasInjustificadas = Math.max(0, Math.floor(opts.faltasInjustificadas ?? 0));
  const diasDireito = diasDeFeriasPorFaltas(faltasInjustificadas);

  return {
    ciclo,
    inicioAquisitivo,
    fimAquisitivo,
    fimConcessivo,
    limiteInicio,
    diasAteLimite,
    situacao,
    emDobra: situacao === 'dobra',
    faltasInjustificadas,
    diasDireito,
    reduzidoPorFaltas: diasDireito < 30,
  };
}

/** Rótulo pra tela — o texto que a gerente lê e entende sem saber o artigo. */
export function rotuloSituacao(s: SituacaoFerias): string {
  switch (s) {
    case 'aquisitivo': return 'Ainda adquirindo o direito';
    case 'no_prazo':   return 'No prazo';
    case 'proximo':    return 'Programar agora';
    case 'vencendo':   return '30 dias já não cabem no prazo';
    case 'dobra':      return 'VENCIDA — pagamento em dobro';
  }
}
