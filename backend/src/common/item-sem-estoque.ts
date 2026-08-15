/**
 * ITEM QUE NÃO É PEÇA — linha de venda que não existe no estoque de loja
 * nenhuma e portanto NUNCA pode ser roteada/separada.
 *
 * Hoje são duas famílias:
 *   - FRETE   → `ref='FRETE'`/`sku='FRETE'`, a linha de frete à parte da venda
 *               online (PdvService.setFrete).
 *   - MANUAL  → `sku='MANUAL-<timestamp>'`/`ref='MANUAL'`, linha avulsa
 *               (vale presente, ajuste). Produto real com desconto manual tem
 *               sku/ref de catálogo e NÃO cai aqui — a regra é a mesma do
 *               `isStockEligibleItem` do PDV.
 *
 * ⚠️ POR QUE EXISTE (14/08): o primeiro pedido online (ON-000001) copiou os
 * itens da venda inteiros pro Order. O FRETE virou OrderItem, o roteamento
 * procurou estoque do SKU "FRETE" em 14 lojas, não achou — e o pedido nasceu
 * em **"Ruptura: 1 SKU(s) sem estoque em nenhuma loja ativa"** com a matriz
 * achando que faltava peça. Faltava frete, que não é peça.
 */
export function ehItemSemEstoque(it: {
  sku?: string | null;
  ref?: string | null;
  promoTag?: string | null;
}): boolean {
  const sku = String(it?.sku ?? '').trim().toUpperCase();
  const ref = String(it?.ref ?? '').trim().toUpperCase();
  if (!sku) return true;
  if (sku === 'FRETE' || ref === 'FRETE') return true;
  if (sku.startsWith('MANUAL-') || ref === 'MANUAL') return true;
  return false;
}
