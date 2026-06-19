/**
 * date-br.ts — limites de "dia" no fuso America/Sao_Paulo (UTC-3).
 *
 * POR QUE EXISTE: o servidor (Railway) roda em UTC. Usar
 * `new Date().setHours(0,0,0,0)` zera a meia-noite NO FUSO DO SERVIDOR (UTC),
 * que equivale a 21:00 em São Paulo. Resultado: vendas entre 21:00 e 23:59
 * (horário BR) caíam no DIA SEGUINTE em qualquer agrupamento por dia.
 *
 * O Brasil não tem mais horário de verão desde 2019 → o offset é fixo -03:00.
 * A data (YYYY-MM-DD) é sempre resolvida via Intl com timeZone explícito, então
 * mesmo que o servidor mude de fuso, o "dia BR" continua correto.
 *
 * DOIS CASOS DE USO (não confundir):
 *  1. "Hoje agora" → startOfDayBR()/endOfDayBR() (sem argumento). Resolve a data
 *     BR do instante atual e devolve os limites como instantes UTC.
 *  2. Data ESCOLHIDA no front, que chega como 'YYYY-MM-DD' ou como
 *     `new Date('YYYY-MM-DD')` (= meia-noite UTC) → use *FromYmd / dayBoundsFromUtcDate.
 *     NÃO passe esse Date pra startOfDayBR(date): meia-noite UTC vira o dia
 *     ANTERIOR em SP, reintroduzindo o bug.
 */

const TZ = 'America/Sao_Paulo';

/** YYYY-MM-DD do instante `d` no fuso de São Paulo. */
export function ymdBR(d: Date = new Date()): string {
  // 'en-CA' formata nativamente como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Início do dia BR a partir de uma data 'YYYY-MM-DD' (escolhida no front). */
export function startOfDayBRFromYmd(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000-03:00`);
}

/** Fim do dia BR a partir de uma data 'YYYY-MM-DD' (escolhida no front). */
export function endOfDayBRFromYmd(ymd: string): Date {
  return new Date(`${ymd}T23:59:59.999-03:00`);
}

/** Início (00:00:00.000 BR) do dia BR do instante `d` (default: agora). */
export function startOfDayBR(d: Date = new Date()): Date {
  return startOfDayBRFromYmd(ymdBR(d));
}

/** Fim (23:59:59.999 BR) do dia BR do instante `d` (default: agora). */
export function endOfDayBR(d: Date = new Date()): Date {
  return endOfDayBRFromYmd(ymdBR(d));
}

/** Início do dia BR seguinte ao instante `d` (default: agora). Equivale ao
 *  antigo `tomorrow.setDate(getDate()+1)` porém no fuso BR. */
export function startOfNextDayBR(d: Date = new Date()): Date {
  const start = startOfDayBR(d);
  // +24h cai dentro do dia seguinte (sem DST no BR) → re-normaliza pro 00:00 BR.
  return startOfDayBR(new Date(start.getTime() + 24 * 60 * 60 * 1000));
}

/**
 * Limites do dia BR quando a data vem como `new Date('YYYY-MM-DD')` (meia-noite
 * UTC) representando a data escolhida no front. Lê o YMD EM UTC (= a data que o
 * usuário escolheu) e monta os limites BR a partir dele.
 */
export function dayBoundsFromUtcDate(d: Date): { start: Date; end: Date } {
  const ymd = d.toISOString().slice(0, 10);
  return { start: startOfDayBRFromYmd(ymd), end: endOfDayBRFromYmd(ymd) };
}
