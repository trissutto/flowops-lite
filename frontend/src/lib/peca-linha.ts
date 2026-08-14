/**
 * A PEÇA EM DUAS LINHAS — formato único da casa (card da LIVE, fila da loja,
 * pedido, cupom de separação):
 *
 *   BMM-100 · MARINHO 60        ← refCorTam()
 *   Blusa Manga Curta           ← nomeSemVariacao()
 *
 * O item do pedido guarda o nome com cor e tamanho grudados
 * ("Blusa Manga Curta · MARINHO · 60") porque é assim que a NF-e descreve a
 * peça. Com a linha de cima mostrando cor e tamanho, repetir embaixo faz a
 * vendedora ler o mesmo número duas vezes e duvidar de qual vale.
 */

interface PecaLike {
  ref?: string | null;
  cor?: string | null;
  tamanho?: string | null;
}

/** "BMM-100 · MARINHO 60". Vazio sem REF (pedido antigo, live, WooCommerce). */
export function refCorTam(peca: PecaLike): string {
  if (!peca.ref) return '';
  return [peca.ref, [peca.cor, peca.tamanho].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
}

/**
 * O nome sem o que já está na linha de cima. Tira só do FIM e só o que bate
 * exatamente com a cor ou o tamanho — nome de peça que por acaso contenha a
 * palavra ("Blusa Preto e Branco") continua inteiro.
 */
export function nomeSemVariacao(nome?: string | null, cor?: string | null, tamanho?: string | null): string {
  const cru = String(nome || '');
  const partes = cru.split(' · ').map((p) => p.trim()).filter(Boolean);
  const naLinhaDeCima = new Set(
    [cor, tamanho].filter(Boolean).map((v) => String(v).trim().toUpperCase()),
  );
  while (partes.length > 1 && naLinhaDeCima.has(partes[partes.length - 1].toUpperCase())) partes.pop();
  return partes.join(' · ') || cru;
}
