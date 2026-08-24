import { BadRequestException } from '@nestjs/common';

/** O `select` do Prisma que alimenta `restanteCentsDaVenda`. */
export const SELECT_VENDA_COBRANCA = {
  id: true,
  status: true,
  entregaTipo: true,
  total: true,
  payments: { select: { valor: true } },
} as const;

const cents = (v: any) => Math.round((Number(v) || 0) * 100);

/** Quanto AINDA falta cobrar dessa venda, em centavos. */
export function restanteCentsDaVenda(venda: any): number {
  const pago = (venda?.payments || []).reduce((s: number, p: any) => s + cents(p?.valor), 0);
  return Math.max(0, cents(venda?.total) - pago);
}

/**
 * A COBRANÇA DA VENDA ONLINE TEM QUE COBRIR A VENDA INTEIRA (24/08/2026).
 *
 * O defeito das "DUAS VOLTAS": o campo "quanto cobrar" do PDV era preenchido
 * UMA vez, no clique da forma de pagamento, e nunca mais. Aplicar o FRETE
 * depois disso subia o total da venda no banco e o campo continuava no valor
 * velho — o PIX/link ia pra cliente SEM o frete. Ela pagava, a venda não
 * fechava (faltava o frete) e sobrava uma segunda cobrança só do frete.
 *
 * Medição de 24/08: 5 vendas da loja 13 em 40 minutos, todas com a linha FRETE
 * criada ANTES da cobrança e mesmo assim cobradas sem ela — um pagamento de
 * 289,60 e, 13 segundos depois, outro de 9,99.
 *
 * A raiz foi corrigida no front. Esta função é a MESMA regra no servidor, pelo
 * mesmo motivo da trava da forma de entrega: PC com bundle velho não pode
 * mandar QR curto pra cliente. Cobrança CURTA nunca é escolha da vendedora na
 * venda online — os dois caminhos que geram cobrança (PIX PagBank e link
 * Pagar.me) sempre mandam o restante inteiro.
 *
 * Só recusa valor MENOR que o restante. Maior passa: é o caso legítimo de
 * venda já quitada, em que o front cai no `total` como piso.
 */
export function conferirCobrancaCobreVendaOnline(venda: any, valorCobrado: number): void {
  // Não é venda de PDV (live, site): esta regra não vale.
  if (!venda) return;

  const restante = restanteCentsDaVenda(venda);
  if (restante <= 0) return;

  const cobrado = cents(valorCobrado);
  // 1 centavo de folga — fração de centavo já mordeu o caixa antes.
  if (cobrado >= restante - 1) return;

  const brl = (c: number) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;
  throw new BadRequestException(
    `Esta cobrança é de ${brl(cobrado)} e a venda está em ${brl(restante)} — faltam ` +
      `${brl(restante - cobrado)}. Normalmente é o FRETE que entrou depois que a tela ` +
      `calculou o valor. Recarregue o PDV (F5), confira o total e gere a cobrança de novo. ` +
      `NÃO mande o valor curto pra cliente: ela paga, a venda não fecha e sobra uma segunda ` +
      `cobrança só do frete.`,
  );
}
