/**
 * Qual serviço dos Correios a cliente PAGOU no pedido — PAC ou SEDEX.
 *
 * Por que existe: a etiqueta escolhia o serviço por REGRA DE UF
 * (`uf === 'SP' ? 'SEDEX' : 'PAC'`). Isso ignorava o checkout: cliente de fora
 * de São Paulo que escolhia SEDEX e PAGAVA por ele recebia uma pré-postagem
 * PAC — mais lenta que o prometido e com o dinheiro do expresso já no caixa.
 *
 * A ordem de leitura vai do dado mais confiável pro mais frágil:
 *
 *  1. `checkoutInfo.shipping.id` do site novo — 'correios-sedex' / 'correios-pac'.
 *     É o id da opção que a cliente clicou, gravado no fechamento do pedido.
 *     ⚠️ NÃO dá pra usar o `kind`: o SEDEX promocional de SP é gravado como
 *     kind 'correios' (pra o cupom de frete grátis alcançar ele) — kind
 *     'expressa' só aparece no SEDEX de cotação.
 *  2. O título do método (`Order.shippingMethod`) — é o que sobra dos pedidos do
 *     WooCommerce e dos pedidos antigos do site. "PROMOCIONAL" sem serviço no
 *     nome é a tabela da casa: SP = SEDEX, resto = PAC (mesma regra que a
 *     `classifyShipping` do front usa pro badge).
 *  3. Nada legível → regra de UF, que é o comportamento histórico.
 *
 * Retirada em loja não chega aqui (a pré-postagem nem é gerada), mas o texto é
 * reconhecido pra não cair como "sedex/pac desconhecido".
 */
export type ServicoCorreios = 'PAC' | 'SEDEX';

function normalizar(s: unknown): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Regra histórica da casa, usada só quando o pedido não diz o que foi pago. */
export function servicoPorUf(uf?: string | null): ServicoCorreios {
  return String(uf || '').trim().toUpperCase() === 'SP' ? 'SEDEX' : 'PAC';
}

export interface ServicoEscolhido {
  servico: ServicoCorreios;
  /** De onde saiu: 'checkout' | 'titulo' | 'promocional-uf' | 'fallback-uf'. */
  origem: 'checkout' | 'titulo' | 'promocional-uf' | 'fallback-uf';
}

/**
 * @param order  Order do site/live (precisa de `checkoutInfo` e `shippingMethod`)
 * @param uf     UF do DESTINO já normalizada pelo CEP (não a do endereço cru)
 */
export function servicoPagoDoPedido(
  order: { checkoutInfo?: string | null; shippingMethod?: string | null } | null | undefined,
  uf?: string | null,
): ServicoEscolhido {
  // 1) Site novo: o id da opção clicada no checkout
  try {
    const info = order?.checkoutInfo ? JSON.parse(String(order.checkoutInfo)) : null;
    const id = normalizar(info?.shipping?.id);
    if (id.includes('sedex')) return { servico: 'SEDEX', origem: 'checkout' };
    if (id.includes('pac')) return { servico: 'PAC', origem: 'checkout' };
  } catch { /* checkoutInfo corrompido → cai pro título */ }

  // 2) Título do método (WooCommerce e pedidos antigos)
  const titulo = normalizar(order?.shippingMethod);
  if (titulo) {
    if (titulo.includes('sedex')) return { servico: 'SEDEX', origem: 'titulo' };
    if (/\bpac\b/.test(titulo)) return { servico: 'PAC', origem: 'titulo' };
    if (titulo.includes('promocional') || titulo.includes('promo ')) {
      return { servico: servicoPorUf(uf), origem: 'promocional-uf' };
    }
  }

  // 3) Sem informação — regra de UF
  return { servico: servicoPorUf(uf), origem: 'fallback-uf' };
}
