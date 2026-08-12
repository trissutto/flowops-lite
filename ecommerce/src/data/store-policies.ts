/**
 * Regras institucionais exibidas em mais de uma jornada.
 *
 * ⚠️ PRAZO DE TROCA: 7 DIAS (corrigido em 12/08/2026).
 *
 * O site prometia 30 dias em SEIS lugares — card, PDP, guia de tamanhos,
 * rodapé, política e esta constante — enquanto o portal que recebe o pedido
 * trabalha com 7 (`TrocasService.getPrazoDias`: default 7, sem
 * `troca.prazoDias` gravado em produção). A cliente voltava no dia 20 com a
 * promessa do site na mão e o sistema dizia não.
 *
 * Quem escrever prazo em tela nova: leia DAQUI. Cinco cópias do mesmo número
 * é como o 30 sobreviveu à mudança de política.
 */
export const STORE_POLICIES = {
  sizeRange: '44 ao 60',
  returnWindowDays: 7,
  exchangeWindowDays: 7,
  storeCount: 14,
  freeShippingFallback: 'Frete grátis: consulte o valor vigente',
} as const;

export const RETURN_EXCHANGE_SUMMARY =
  `${STORE_POLICIES.returnWindowDays} dias para desistir da compra ou trocar tamanho, cor ou peça.`;
