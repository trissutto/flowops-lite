/**
 * CÓDIGO GÊMEO — a mesma peça cadastrada duas vezes (01/10/2026, ON-000550).
 *
 * O caso: o pedido pedia o código 539… e a peça da arara tinha a etiqueta
 * 5238927. As duas linhas do cadastro são a MESMA peça (mesma REF, mesma cor,
 * mesmo tamanho) — o cadastro foi feito duas vezes. O bipe só aceitava o código
 * exato do item e respondia "esse SKU NÃO está nesse pedido": a loja com a peça
 * certa na mão não conseguia separar.
 *
 * A régua: o código bipado vale por um item do pedido quando REF + COR +
 * TAMANHO do cadastro batem — os TRÊS preenchidos, e batendo com UM único SKU
 * do card. Qualquer dúvida (campo vazio, dois SKUs do card com a mesma chave)
 * devolve null e o bipe continua recusando: aceitar peça errada é pior que
 * recusar peça certa (pedido com a COR ERRADA, 25/09).
 */
export interface PecaDoCadastro {
  codigo: string;
  ref?: string | null;
  cor?: string | null;
  tamanho?: string | null;
}

const limpar = (v: string | null | undefined): string =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

/** REF|COR|TAMANHO normalizados — null se faltar qualquer um dos três. */
export function chaveDaPeca(p: PecaDoCadastro | null | undefined): string | null {
  if (!p) return null;
  const ref = limpar(p.ref);
  const cor = limpar(p.cor);
  const tam = limpar(p.tamanho);
  if (!ref || !cor || !tam) return null;
  return `${ref}|${cor}|${tam}`;
}

/**
 * SKU do pedido de que a peça bipada é gêmea, ou null.
 * `doPedido` = as linhas do cadastro dos SKUs do card (uma por SKU).
 */
export function acharGemeoNoPedido(
  bipada: PecaDoCadastro | null | undefined,
  doPedido: PecaDoCadastro[],
): string | null {
  const chave = chaveDaPeca(bipada);
  if (!chave) return null;
  const iguais = new Set<string>();
  for (const p of doPedido) {
    if (chaveDaPeca(p) === chave) iguais.add(String(p.codigo).trim());
  }
  return iguais.size === 1 ? Array.from(iguais)[0] : null;
}
