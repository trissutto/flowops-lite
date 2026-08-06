/**
 * DESCONTO DO PIX — a regra num lugar só.
 *
 * O site anunciava "no Pix por R$ X" no card, na PDP, na busca, e a badge
 * "5% off já aplicado" no checkout — e **ninguém aplicava nada**. A cliente
 * lia o preço com desconto e pagava o cheio. Achado em 06/08/2026 na varredura
 * do bloco A da lista de lançamento; o dono mandou aplicar de verdade.
 *
 * Quem manda é o SERVIDOR: o backend recalcula este mesmo desconto no
 * `reprecificar()` e o total cobrado é o dele. O que roda aqui é EXIBIÇÃO —
 * existe pra tela mostrar a mesma conta que a cobrança, e não pra decidir
 * dinheiro (o checkout inteiro segue essa regra: o client manda os fatos, o
 * server manda no valor).
 *
 * `NEXT_PUBLIC_PIX_DESCONTO_PCT` acompanha a `SITE_PIX_DESCONTO_PCT` do
 * backend. Os dois têm que andar juntos: se divergirem, a tela mostra um
 * número e a cobrança faz outro — e quem mostra a menor perde a venda na
 * conferência. Por isso o padrão é o mesmo (5) dos dois lados.
 */

export const PIX_DESCONTO_PCT = (() => {
  const raw = process.env.NEXT_PUBLIC_PIX_DESCONTO_PCT;
  const n = raw == null || raw === '' ? 5 : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : 5;
})();

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Desconto em reais sobre a base (subtotal JÁ descontado do cupom — dois
 * descontos não se somam sobre o valor cheio, senão 10% + 5% viraria 15%).
 * Devolve 0 fora do Pix.
 */
export function pixDiscount(base: number, method?: string | null): number {
  if (method !== 'pix' || PIX_DESCONTO_PCT <= 0) return 0;
  return round2((Math.max(0, base) * PIX_DESCONTO_PCT) / 100);
}
