/**
 * VÍNCULO DO DIA — o dia que o espelho de ponto NÃO cobra.
 *
 * Pedido do dono (14/11/2026): "não gerar falta, nem saldo devedor em datas
 * anteriores à admissão da funcionária. Zerar o ponto em datas anteriores à
 * admissão". O espelho cobrava a jornada do mês INTEIRO: funcionária admitida
 * dia 06 entrava no mês com quatro FALTAS e −29h antes de pisar na loja.
 * Medido em produção em 14/11: 17 funcionárias ativas com admissão depois do
 * cadastro no sistema somavam 173 faltas e 1.272h de "dívida" antes da
 * admissão — e nenhuma delas tinha batida antes da data da ficha.
 *
 * A régua é uma comparação de DATA, não de instante. `Seller.dataAdmissao` é
 * `@db.Date` e o Prisma a devolve como MEIA-NOITE UTC: lida no fuso de
 * Brasília (como `dateKeyBrasil` faz com as batidas) viraria 21h do dia
 * ANTERIOR, e a admissão de dia 06 passaria a valer dia 05. Por isso a chave
 * sai de `toISOString()`, nunca do fuso da loja.
 *
 * O dia da admissão CONTA — é o primeiro dia de trabalho. Sem data na ficha
 * não há corte: o espelho cobra o mês inteiro e a tela avisa pra preencher.
 */

/** 'YYYY-MM-DD' de um campo data-só (`@db.Date`), lido em UTC de propósito. */
export function chaveDataSo(v: Date | string | null | undefined): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
    return m ? m[1] : null;
  }
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) return null;
  return v.toISOString().slice(0, 10);
}

/**
 * O dia (chave 'YYYY-MM-DD') é ANTERIOR à admissão? Sem admissão na ficha,
 * nunca — não se zera jornada por falta de cadastro.
 */
export function antesDaAdmissao(
  diaChave: string,
  admissaoChave: string | null | undefined,
): boolean {
  if (!admissaoChave || !diaChave) return false;
  return diaChave < admissaoChave;
}
