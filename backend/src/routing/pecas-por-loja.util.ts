import { ehItemSemEstoque } from '../common/item-sem-estoque';
import type { WhatsappItem } from './whatsapp-message.util';

/**
 * AS PEÇAS QUE CADA LOJA SEPARA — régua da mensagem de WhatsApp (25/09/2026).
 *
 * O aviso automático mandava o PEDIDO INTEIRO pra cada loja: ele filtrava as
 * linhas do pedido por SKU, e "peça é peça" (29/08) grava UMA LINHA POR PEÇA.
 * No LP-001687 (2× o mesmo vestido, 1 pra Piracicaba e 1 pra Praia Grande) as
 * duas lojas receberam as duas linhas e perguntaram se era pra separar as
 * duas. Ordem do dono: "mandar a peça que vai ser separada pra cada loja, ao
 * invés do pedido inteiro; o pedido inteiro só na retirada na loja".
 *
 * Fonte da verdade, nesta ordem:
 *   1. `pedidoInteiro` (retirada na própria loja) → todas as linhas vivas;
 *   2. linhas carimbadas com o `assignedStoreId` da loja — é o que o
 *      `confirmRoute` gravou, ou seja, o card que a loja vê;
 *   3. sem carimbo (preview, mock, pedido antigo): consome as linhas por SKU
 *      até a quantidade que a engine deu pra loja (`mergeItemsBySku` agrega
 *      por SKU, então a cota da loja é por SKU, não por linha).
 *
 * Peça cancelada e linha que não é peça (FRETE/MANUAL) nunca entram.
 */
export interface LinhaDoPedido {
  sku?: string | null;
  quantity?: number | null;
  productName?: string | null;
  ref?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  assignedStoreId?: string | null;
  cancelledAt?: Date | string | null;
  promoTag?: string | null;
}

export interface AtribuicaoDaLoja {
  storeId: string;
  /** `quantity` vem da engine; `qty` do "forçar loja"/swap (mesma leitura do demandasPorSku). */
  items?: Array<{ sku: string; quantity?: number | null; qty?: number | null }> | null;
}

export function pecasDaLoja(
  linhas: LinhaDoPedido[],
  atribuicao: AtribuicaoDaLoja,
  opts: { pedidoInteiro?: boolean } = {},
): WhatsappItem[] {
  const vivas = (linhas ?? []).filter((l) => !l.cancelledAt && !ehItemSemEstoque(l));
  if (opts.pedidoInteiro) return vivas.map(paraItem);

  const carimbadas = vivas.filter(
    (l) => !!l.assignedStoreId && l.assignedStoreId === atribuicao.storeId,
  );
  if (carimbadas.length > 0) return carimbadas.map(paraItem);

  const restante = new Map<string, number>();
  for (const it of atribuicao.items ?? []) {
    const sku = String(it?.sku ?? '').trim();
    const q = Number(it?.quantity ?? it?.qty ?? 0);
    if (!sku || !(q > 0)) continue;
    restante.set(sku, (restante.get(sku) ?? 0) + q);
  }
  const out: WhatsappItem[] = [];
  for (const l of vivas) {
    const sku = String(l.sku ?? '').trim();
    const falta = restante.get(sku) ?? 0;
    if (falta <= 0) continue;
    const q = Math.min(Math.max(1, Number(l.quantity ?? 1) || 1), falta);
    out.push({ ...paraItem(l), quantity: q });
    restante.set(sku, falta - q);
  }
  return out;
}

/** Soma de peças (não de linhas) — o cabeçalho "PEÇAS (N)" conta assim. */
export function totalDePecas(items: Array<{ quantity?: number | null }>): number {
  return (items ?? []).reduce((s, i) => s + Math.max(0, Number(i?.quantity ?? 0) || 0), 0);
}

function paraItem(l: LinhaDoPedido): WhatsappItem {
  return {
    sku: String(l.sku ?? '').trim(),
    quantity: Math.max(1, Number(l.quantity ?? 1) || 1),
    productName: String(l.productName ?? ''),
    variant: [l.cor, l.tamanho].filter(Boolean).join(' ') || undefined,
  };
}
