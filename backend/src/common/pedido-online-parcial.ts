import { ehItemSemEstoque } from './item-sem-estoque';
import { ratearTotalDaVenda } from './ratear-total-da-venda';

/**
 * PEDIDO ONLINE PARCIAL — só as peças ESCOLHIDAS viram pedido (16/11/2026).
 *
 * Ordem do dono: "às vezes é somente peças selecionadas que irão sair de
 * outra loja para entrega". A venda do PDV tem 5 peças; a cliente levou 3 na
 * sacola e 2 vêm de outra loja. O "Gerar pedido online" da tela de produtos
 * vendidos mandava a venda INTEIRA pro roteamento — e devolvia ao estoque da
 * vendedora as 3 que já estavam na sacola da cliente (a família do estorno
 * que devolvia a peça NOVA, 11/09).
 *
 * Esta régua decide O QUE entra no Order e QUANTO ele vale:
 *   - `itemIds` vazio = a venda inteira (o comportamento de sempre).
 *   - id que não é desta venda, ou que é FRETE/linha MANUAL = recusa (o
 *     chamador devolve 400). Recusa INTEIRA — nunca "gera o que deu".
 *   - escolheu todas as peças = não é parcial (mesmo caminho de sempre).
 *   - parcial: o pedido leva as peças escolhidas + o FRETE (frete é do envio,
 *     e o envio é este pedido), e o TOTAL é a soma dessas linhas já com a
 *     parte do desconto da venda que cabe a elas — o MESMO rateio do espelho
 *     de faturamento (`ratearTotalDaVenda`), em centavos fechados.
 *
 * Por que o total muda: `Order.totalAmount` vira valor declarado da etiqueta,
 * teto do crédito de peça faltante e "Total" da mensagem pra cliente. Com o
 * total da venda inteira, tudo isso sairia inflado num pedido de 2 peças — e
 * `checkoutInfo.discount` é o que a NF-e rateia entre as peças do pedido:
 * desconto inteiro sobre peças parciais abateria demais.
 */
export interface LinhaDaVenda {
  id?: string | null;
  sku?: string | null;
  ref?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  descricao?: string | null;
  qty?: number | null;
  total?: number | null;
  precoUnit?: number | null;
  promoTag?: string | null;
}

export type SelecaoDoPedido<T extends LinhaDaVenda> =
  | { ok: false; erro: string }
  | {
      ok: true;
      /** As linhas que entram no Order (frete e linha manual nunca). */
      pecas: T[];
      /** Parte da venda ficou de fora. */
      parcial: boolean;
      /** Peças da venda que NÃO entram (vazio quando não é parcial). */
      foraDoPedido: T[];
      /** Peças (somando quantidade) que entram / que a venda tem. */
      pecasNoPedido: number;
      pecasDaVenda: number;
      /** Total do pedido parcial (peças escolhidas + frete, já com o rateio do desconto). null = total da venda. */
      totalAmount: number | null;
      /** Parte do desconto da venda que cabe às linhas do pedido parcial. null = o desconto inteiro da venda. */
      discount: number | null;
    };

const round2 = (v: number) => Math.round(v * 100) / 100;
const quantidade = (it: LinhaDaVenda) => Math.max(1, Math.floor(Number(it?.qty) || 1));
const ehFrete = (it: LinhaDaVenda) =>
  String(it?.sku ?? '').trim().toUpperCase() === 'FRETE' || String(it?.ref ?? '').trim().toUpperCase() === 'FRETE';

/** REF · COR · TAM (o que está na etiqueta); cai pro nome, pro código, pro id. */
export function rotuloDaLinha(it: LinhaDaVenda): string {
  return (
    [it?.ref, it?.cor, it?.tamanho].filter(Boolean).join(' · ') ||
    String(it?.descricao ?? '').trim() ||
    String(it?.sku ?? '').trim() ||
    String(it?.id ?? '')
  );
}

export function selecionarPecasDoPedido<T extends LinhaDaVenda>(
  itens: readonly T[] | null | undefined,
  itemIds: readonly (string | null | undefined)[] | null | undefined,
  totalVenda: number | null | undefined,
): SelecaoDoPedido<T> {
  const linhas = Array.isArray(itens) ? itens : [];
  const todasAsPecas = linhas.filter((it) => !ehItemSemEstoque(it));
  const pecasDaVenda = todasAsPecas.reduce((s, it) => s + quantidade(it), 0);
  const ids = [...new Set((itemIds ?? []).map((v) => String(v ?? '').trim()).filter(Boolean))];

  const inteira = (): SelecaoDoPedido<T> => ({
    ok: true,
    pecas: todasAsPecas,
    parcial: false,
    foraDoPedido: [],
    pecasNoPedido: pecasDaVenda,
    pecasDaVenda,
    totalAmount: null,
    discount: null,
  });
  if (!ids.length) return inteira();

  const porId = new Map(linhas.map((it) => [String(it?.id ?? ''), it] as const));
  for (const id of ids) {
    const it = porId.get(id);
    if (!it) return { ok: false, erro: `Peça ${id} não é desta venda` };
    if (ehItemSemEstoque(it)) {
      return { ok: false, erro: `${rotuloDaLinha(it)} não é peça (frete ou linha manual) — não entra no pedido` };
    }
  }

  const escolhida = (it: LinhaDaVenda) => ids.includes(String(it?.id ?? ''));
  const pecas = todasAsPecas.filter(escolhida);
  if (pecas.length === todasAsPecas.length) return inteira();

  // Cada linha com a parte do desconto da venda que cabe a ela — a mesma
  // conta que fecha a soma das linhas com `PdvSale.total` no espelho.
  const bruto = linhas.map((it) => {
    const v = Number(it?.total);
    return Number.isFinite(v) ? v : null;
  });
  const total = totalVenda == null || !Number.isFinite(Number(totalVenda)) ? null : Number(totalVenda);
  const liquido = ratearTotalDaVenda(bruto, total);

  let totalAmount = 0;
  let discount = 0;
  linhas.forEach((it, i) => {
    if (!escolhida(it) && !ehFrete(it)) return;
    const b = bruto[i] ?? 0;
    const l = liquido[i] ?? b;
    totalAmount += l;
    discount += b - l;
  });

  return {
    ok: true,
    pecas,
    parcial: true,
    foraDoPedido: todasAsPecas.filter((it) => !escolhida(it)),
    pecasNoPedido: pecas.reduce((s, it) => s + quantidade(it), 0),
    pecasDaVenda,
    totalAmount: round2(Math.max(0, totalAmount)),
    discount: round2(Math.max(0, discount)),
  };
}
