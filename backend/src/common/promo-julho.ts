/**
 * PROMOÇÃO 50% — a regra, num lugar só.
 *
 * Ela decidia em DOIS arquivos: a tela de Classificação (que mostra o preço
 * promocional) e o PDV (que aplica o desconto na venda). Havia até um
 * comentário em cada um dizendo "se mudar lá, muda aqui" — o que é a definição
 * de regra que vai divergir. E divergência aqui é a pior possível: a tela
 * mostra 50% e o caixa cobra cheio, com a cliente na frente.
 *
 * Três portas de entrada, na ordem em que a operação pensa:
 *   1. BÁSICO nunca entra (linha que não liquida);
 *   2. cadastrado até 31/12/2023 → entra (liquidar o antigo);
 *   3. REF terminada em -INV / -VER → entra (coleção marcada, dono 10/07);
 *   4. LIBERADA NA MÃO na tela de Classificação → entra (dono 04/08), pra peça
 *      nova que se decide liquidar sem precisar mentir na data do catálogo.
 */

export const PROMO_PCT = 0.5;
export const PROMO_CUTOFF = '2023-12-31';
/** Sufixo de coleção na REF: -INV (inverno) / -VER (verão). */
export const PROMO_COLECAO_RE = /-(INV|VER)$/i;

export interface PromoEntrada {
  /** REF do produto (usada pelo sufixo de coleção). */
  ref?: string | null;
  /** Data de cadastro em 'YYYY-MM-DD' (ou vazio se desconhecida). */
  dataCadastro?: string | null;
  /** true = linha BÁSICA, que nunca entra na promo. */
  isBasico?: boolean;
  /** Exceção manual gravada em `product_classification.promo_liberada`. */
  promoLiberada?: boolean;
}

/** A peça entra na promoção de 50%? */
export function elegivelPromo(e: PromoEntrada): boolean {
  if (e.isBasico) return false;
  if (e.promoLiberada) return true;
  const data = String(e.dataCadastro || '').trim();
  if (data && data <= PROMO_CUTOFF) return true;
  return PROMO_COLECAO_RE.test(String(e.ref || '').trim());
}

/**
 * O desconto aplicado num preço — sem decidir elegibilidade.
 *
 * Existe separado porque o SITE desconta LINHA A LINHA (cada cor e cada
 * tamanho da peça têm o seu preço), enquanto o PDV desconta o item bipado.
 * O arredondamento tem que ser o mesmo nos dois, senão a vitrine mostra
 * R$ 39,95 e o caixa cobra R$ 39,96.
 */
export function aplicarDescontoPromo(preco: number): number {
  return Math.round(preco * (1 - PROMO_PCT) * 100) / 100;
}

/** Preço com o desconto, ou null quando a peça não entra. */
export function precoPromo(preco: number | null | undefined, e: PromoEntrada): number | null {
  if (preco == null || !elegivelPromo(e)) return null;
  return aplicarDescontoPromo(preco);
}
