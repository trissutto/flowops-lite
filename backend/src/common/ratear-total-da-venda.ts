/**
 * FECHA A SOMA DAS LINHAS COM O TOTAL DA VENDA.
 *
 * O PDV tem dois descontos: o do ITEM (já embutido em `PdvSaleItem.total`) e o
 * da VENDA INTEIRA (`PdvService.setSaleDiscount`), que só existe em
 * `PdvSale.desconto` e sai do `PdvSale.total` — não mora em item nenhum.
 *
 * Quem espelha a venda linha a linha (`GigaMirrorService.espelharCaixaMovDoFlow`
 * → `giga_caixa_mov`) somava os itens e ficava ACIMA do que entrou no caixa:
 * setembro/2026 teve R$ 8.670,07 de diferença na rede. Esta função distribui o
 * desconto da venda entre as peças, proporcional ao valor de cada uma, em
 * centavos fechados — a soma devolvida é exatamente o total da venda.
 *
 * Regras:
 *  - `totalVenda` nulo/inválido → devolve como veio (é o caso do MARCADO, que
 *    não é venda e não tem total a fechar).
 *  - Só REDUZ. Soma dos itens MENOR que o total não é desconto — é dado que
 *    esta função não sabe explicar, então não inventa receita em cima da peça.
 *  - O rateio cai só nas linhas POSITIVAS: item negativo é ajuste/troca
 *    lançado dentro da venda e já está no valor certo.
 *  - Desconto maior que a soma das positivas (total ficaria negativo) → não
 *    mexe.
 *  - A sobra do arredondamento vai pra linha de maior valor.
 */
export function ratearTotalDaVenda(
  itens: Array<number | null>,
  totalVenda: number | null,
): Array<number | null> {
  if (totalVenda == null || !Number.isFinite(totalVenda)) return itens;

  const cents = itens.map((v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100)));
  const soma = cents.reduce<number>((s, c) => s + (c ?? 0), 0);
  const diferenca = soma - Math.round(totalVenda * 100);
  if (diferenca <= 0) return itens;

  const somaPositivas = cents.reduce<number>((s, c) => s + (c != null && c > 0 ? c : 0), 0);
  if (somaPositivas <= 0 || diferenca > somaPositivas) return itens;

  const saida = [...cents];
  let distribuido = 0;
  let maior = -1;
  for (let i = 0; i < cents.length; i++) {
    const c = cents[i];
    if (c == null || c <= 0) continue;
    const parte = Math.floor((diferenca * c) / somaPositivas);
    saida[i] = c - parte;
    distribuido += parte;
    if (maior < 0 || c > (cents[maior] as number)) maior = i;
  }
  // Sobra do floor (sempre menor que o nº de linhas, em centavos).
  if (maior >= 0) saida[maior] = (saida[maior] as number) - (diferenca - distribuido);

  return saida.map((c) => (c == null ? null : c / 100));
}
