export interface CartStockNotice {
  text: string;
  tone: 'danger' | 'gold';
  bloqueia?: boolean;
  maxQuantity?: number;
}

/** Atualiza o estado do aviso quando a cliente reduz a quantidade sem nova rede. */
export function currentCartStockNotice(
  quantity: number,
  notice?: CartStockNotice,
): CartStockNotice | undefined {
  if (!notice) return undefined;
  if (notice.bloqueia && notice.maxQuantity && quantity <= notice.maxQuantity) {
    return {
      tone: 'gold',
      maxQuantity: notice.maxQuantity,
      text: `Limite disponível neste tamanho: ${notice.maxQuantity}.`,
    };
  }
  return notice;
}

export function cartStockBlocksCheckout(quantity: number, notice?: CartStockNotice): boolean {
  return currentCartStockNotice(quantity, notice)?.bloqueia === true;
}

/** O mínimo que a reconferência precisa saber sobre uma linha da sacola. */
export interface LinhaConferivel {
  productId: string;
  size: string;
  quantity: number;
}

/** A grade que o catálogo devolveu pra aquela REF. */
export interface GradeDaPeca {
  tamanhos?: Array<{ label: string; disponivel: boolean; estoque?: number | null }>;
}

/**
 * O AVISO DE ESTOQUE DE UMA LINHA — a regra, sem rede e sem React.
 *
 * Morava dentro do efeito da página da sacola. Precisou sair porque o
 * MINI-CART (o drawer que o botão do topo abre, e que é a sacola que a maioria
 * das clientes vê) não reconferia nada: a peça podia ter esgotado enquanto ela
 * navegava e o drawer seguia mostrando quantidade normal, até o checkout
 * recusar. Duas telas com duas verdades sobre o mesmo estoque é como se perde
 * a confiança no total.
 *
 * `null` = nada a dizer. Miss no catálogo também devolve `null`: não achar a
 * peça na busca NÃO significa que esgotou, e inventar alarme é pior que
 * silêncio — o checkout é quem trava a venda de verdade.
 */
export function avisoDaLinha(linha: LinhaConferivel, peca: GradeDaPeca | null): CartStockNotice | null {
  if (!peca) return null;
  const tamanho = (peca.tamanhos ?? []).find((t) => t.label === linha.size);
  if (!tamanho) return null;

  if (!tamanho.disponivel) {
    return {
      tone: 'danger',
      bloqueia: true,
      maxQuantity: 0,
      text: `Esgotou no tamanho ${linha.size} — remova ou troque o tamanho.`,
    };
  }
  if (tamanho.estoque === 1) {
    return { tone: 'gold', maxQuantity: 1, text: 'Última peça neste tamanho — garanta a sua.' };
  }
  if (typeof tamanho.estoque === 'number' && linha.quantity > tamanho.estoque) {
    return {
      tone: 'danger',
      bloqueia: true,
      maxQuantity: tamanho.estoque,
      text: `Restam só ${tamanho.estoque} neste tamanho — diminua a quantidade para continuar.`,
    };
  }
  return null;
}
