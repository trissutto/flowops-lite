/**
 * FUSO HORÁRIO — Brasília (UTC−3), a única hora que interessa pro negócio.
 *
 * ── O PROBLEMA QUE ISTO RESOLVE ──
 *
 * O Railway roda o backend em UTC. A loja funciona em Brasília. Entre 21h00 e
 * 23h59, o servidor JÁ ESTÁ NO DIA SEGUINTE. Todo código que pergunta "que dia
 * é hoje?" pro relógio do servidor joga a venda das 21h30 no dia seguinte —
 * sem erro nenhum na tela, só com o número errado.
 *
 * Isso já causou, em 31/07/2026:
 *   · rejeição fiscal cStat 502 (chave de acesso com o mês de agosto numa nota
 *     emitida em julho — só quebra no último dia do mês, por isso demorou a
 *     aparecer);
 *   · a tela de faturamento virar para 01/08 às 21h e zerar quase todas as
 *     lojas;
 *   · uma venda real em Itu não aparecer no resumo do dia.
 *
 * ── COMO OS DADOS ESTÃO GRAVADOS (medido, não suposto) ──
 *
 * `pdv_sales.created_at` é `timestamp WITHOUT time zone` e guarda o relógio
 * **UTC**. Confirmado com um caso conhecido: venda feita às 22:53 de Brasília
 * está gravada como `2026-08-01 01:53`.
 *
 * Os horários NÃO estão errados — estão em UTC, de forma consistente desde
 * sempre. Não reescreva os timestamps: como nada se perdeu, arrumar a LEITURA
 * corrige o histórico inteiro de uma vez.
 *
 * ── A REGRA ──
 *
 * Nunca use `new Date().getMonth()`, `setHours(0,0,0,0)` nem
 * `toISOString().slice(0,10)` pra decidir a que DIA algo pertence. Use as
 * funções deste arquivo. Data crua serve só pra medir duração (agora − antes),
 * onde o fuso não importa.
 */

/** Brasília não tem horário de verão desde 2019. */
const OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * "Agora" em Brasília, como Date cujos campos UTC já são a hora local.
 *
 * Leia os campos com `getUTC*` — nunca com `getMonth()`/`getDate()`, que
 * dependem do fuso do processo e devolveriam o valor do servidor.
 */
export function agoraBrasilia(): Date {
  return new Date(Date.now() - OFFSET_MS);
}

/** A data de HOJE em Brasília, como 'YYYY-MM-DD'. */
export function hojeBrasilia(): string {
  return agoraBrasilia().toISOString().slice(0, 10);
}

/** Converte um instante gravado em UTC para o mesmo instante em Brasília. */
export function utcParaBrasilia(d: Date): Date {
  return new Date(d.getTime() - OFFSET_MS);
}

/** Converte uma hora de Brasília para o valor UTC correspondente — o formato
 *  em que as colunas de data do sistema estão gravadas. */
export function brasiliaParaUtc(d: Date): Date {
  return new Date(d.getTime() + OFFSET_MS);
}

/** O dia (YYYY-MM-DD) em Brasília a que um instante gravado em UTC pertence. */
export function diaBrasiliaDe(d: Date): string {
  return utcParaBrasilia(d).toISOString().slice(0, 10);
}

/**
 * Início do dia em Brasília, no formato UTC — pronto pra ir num filtro
 * `gte` do Prisma sobre coluna gravada em UTC.
 *
 * 00:00 de Brasília são 03:00 UTC. Filtrar por 00:00 UTC pegaria 21:00 do dia
 * ANTERIOR e perderia as três últimas horas do dia certo — foi exatamente o
 * que sumiu com a venda de Itu.
 */
export function inicioDoDiaUtc(diaIso: string): Date {
  return new Date(`${diaIso}T00:00:00.000Z`.replace('T00:00:00.000Z', 'T03:00:00.000Z'));
}

/** Fim do dia em Brasília (exclusivo), em UTC. Use com `lt`, não `lte`. */
export function fimDoDiaUtcExclusivo(diaIso: string): Date {
  const d = new Date(`${diaIso}T03:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * O intervalo UTC que corresponde ao período [de, ate] em dias de Brasília,
 * com `ate` incluso.
 *
 * É o formato que quase toda consulta de relatório precisa:
 *   `where: { createdAt: { gte: inicio, lt: fimExclusivo } }`
 */
export function periodoBrasiliaEmUtc(deIso: string, ateIso: string): { inicio: Date; fimExclusivo: Date } {
  return { inicio: inicioDoDiaUtc(deIso), fimExclusivo: fimDoDiaUtcExclusivo(ateIso) };
}

/** Primeiro dia do mês corrente em Brasília, como 'YYYY-MM-DD'. */
export function primeiroDiaDoMesBrasilia(): string {
  return hojeBrasilia().slice(0, 8) + '01';
}

/** Formata um instante UTC como data brasileira 'DD/MM/AAAA' pra exibição. */
export function formatarDataBr(d: Date): string {
  const b = utcParaBrasilia(d);
  return `${String(b.getUTCDate()).padStart(2, '0')}/${String(b.getUTCMonth() + 1).padStart(2, '0')}/${b.getUTCFullYear()}`;
}

/**
 * Fragmento SQL que devolve o DIA de Brasília de uma coluna gravada em UTC.
 * Para agrupamento em query crua: `GROUP BY ${diaBrasiliaSql('s.created_at')}`.
 *
 * A coluna é `timestamp without time zone` com valor UTC, então precisa dizer
 * ao Postgres que ela É UTC antes de converter — daí os dois `AT TIME ZONE`.
 */
export function diaBrasiliaSql(coluna: string): string {
  return `((${coluna} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date)`;
}
