/**
 * QUANDO UMA PARCELA DE CREDIÁRIO ESTÁ EM ABERTO — um lugar só.
 *
 * Esta regra estava copiada em 8 pontos de 3 arquivos. Copiada, ela conseguiu
 * ficar errada nos 8 ao mesmo tempo, e o erro valia R$ 2.910.515,44.
 *
 * ── A REGRA ──
 *
 *   PAGA    ⇔  PAGO = 'S'
 *           ⇔  OU tem data de pagamento, sem um 'N' explícito por cima
 *   ABERTA  ⇔  PAGO = 'N' explícito
 *           ⇔  OU (não é 'S' E não tem data)
 *
 * ── DE ONDE VEM ──
 *
 * O Giga tem 11.001 parcelas com PAGO nulo e PAGAMENTO preenchido. Elas foram
 * baixadas por um caminho que gravou a data e não gravou a flag.
 *
 * Em 31/07 li isso como dívida viva, apoiado no aviso de `erp.service.ts:2429`
 * ("se PAGO ficar nulo a baixa não aparece na UI do WinCred"). Em 01/08 o dono
 * conferiu na tela: na FICHA DA CLIENTE elas aparecem como PAGAS.
 *
 * Os dois fatos são verdadeiros e falam de telas diferentes — o aviso é sobre
 * o RELATÓRIO DE RECEBIDOS, que filtra por PAGO='S'. Quem manda no saldo da
 * cliente é a ficha. Daí a data ter a palavra final.
 *
 * Consequência que vale registrar: existe dinheiro recebido que nunca apareceu
 * no relatório de recebidos. Quem for fechar caixa retroativo precisa saber.
 *
 * ── O 'N' EXPLÍCITO ──
 *
 * 17 parcelas (R$ 1.595,90) têm 'N' E data. Ficam ABERTAS: um 'N' escrito é
 * uma afirmação de alguém, e afirmação vence data solta. Se aparecer cliente
 * reclamando de parcela paga, é a primeira faixa a conferir.
 */

/** Sinônimos de "não pago" gravados pelo Giga ao longo dos anos. */
export const PAGO_NEGADO = ['N', 'NAO', 'NÃO'];
/** Sinônimos de "pago". */
export const PAGO_CONFIRMADO = ['S', 'SIM', 'Y'];

/**
 * Condição SQL (MySQL, Giga) pra "parcela EM ABERTO".
 *
 * @param colPago  nome detectado da coluna de flag, ou null se não existe
 * @param colData  nome detectado da coluna de data de pagamento, ou null
 * @returns condição pronta pra entrar num WHERE. `'1=1'` quando não há coluna
 *          nenhuma pra decidir — sem critério é melhor trazer tudo e deixar a
 *          camada de cima filtrar do que devolver vazio fingindo que não há
 *          dívida.
 */
export function sqlParcelaAberta(colPago?: string | null, colData?: string | null): string {
  // O '0000-00-00 00:00:00' vem de instalação onde PAGAMENTO é DATETIME. No
  // Giga da Lurd's é DATE, mas um dos 8 sites originais checava as duas formas
  // e não custa manter — perder isso silenciosamente traria parcela paga.
  const semData = colData
    ? `(\`${colData}\` IS NULL OR \`${colData}\` = '0000-00-00' OR \`${colData}\` = '0000-00-00 00:00:00')`
    : null;

  if (colPago) {
    const lista = (xs: string[]) => xs.map((x) => `'${x}'`).join(',');
    const negado = `UPPER(COALESCE(\`${colPago}\`,'')) IN (${lista(PAGO_NEGADO)})`;
    const confirmado = `UPPER(COALESCE(\`${colPago}\`,'')) IN (${lista(PAGO_CONFIRMADO)})`;
    // Sem coluna de data, "não confirmado" é o melhor que dá pra afirmar.
    if (!semData) return `(NOT ${confirmado})`;
    return `(${negado} OR (NOT ${confirmado} AND ${semData}))`;
  }

  if (semData) return semData;
  return '1=1';
}

/** A mesma regra pra uma linha já lida. */
export function parcelaAberta(flagPago: unknown, dataPagamento: unknown): boolean {
  const flag = flagPago == null ? null : String(flagPago).trim().toUpperCase();
  if (flag && PAGO_NEGADO.includes(flag)) return true;
  if (flag && PAGO_CONFIRMADO.includes(flag)) return false;
  const d = dataPagamento == null ? '' : String(dataPagamento).trim();
  return !d || d === '0000-00-00';
}
