/**
 * O CASAMENTO DE TEXTO DA BUSCA DO SITE — sem acento e tolerante a plural.
 *
 * ── O QUE ISTO CONSERTA (medido em 31/08/2026) ──
 *
 * No primeiro dia em que a busca passou a gravar quantos resultados devolveu,
 * **um terço voltou vazia**: 25 de 75 medidas. Duas causas moravam na
 * comparação de texto, que era `trim().toUpperCase()` e `includes`:
 *
 *   - **ACENTO** — quem digita "sutia" não achava "Sutiã Sem Bojo". Ninguém
 *     digita acento na pressa, e menos ainda no celular (52% do tráfego).
 *   - **PLURAL** — "regatas" devolvia 0 e "regata", 37. "Vestidos curtos",
 *     idem. Como todos os termos precisam casar, UM plural zera a busca
 *     inteira.
 *
 * ── O CORTE DO "S" É CONSERVADOR DE PROPÓSITO ──
 *
 * Só entra como SEGUNDA chance (o casamento exato tenta primeiro) e só em
 * termo com mais de 3 letras. Sem o piso, "as" e "os" casariam com metade do
 * catálogo — e busca que acha tudo é tão inútil quanto busca que não acha nada.
 *
 * Não tenta ser stemmer: "camisões" continua não achando "camisão". Plural em
 * "-s" cobre a esmagadora maioria do que a cliente digita, e cada regra a mais
 * é uma chance a mais de casar o que não devia.
 */

/** Tira acento e caixa — a forma em que os dois lados são comparados. */
export function normalizarBusca(v: unknown): string {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toUpperCase();
}

/** Um termo casa no alvo? (alvo e termo já normalizados por `normalizarBusca`) */
export function termoCasa(alvo: string, termo: string): boolean {
  if (!termo) return true;
  if (alvo.includes(termo)) return true;
  return termo.length > 3 && termo.endsWith('S') && alvo.includes(termo.slice(0, -1));
}

/**
 * TODOS os termos precisam casar — é o `every` de sempre, agora com acento e
 * plural resolvidos. Texto vazio não filtra nada.
 */
export function casaBusca(alvoBruto: string, buscaBruta: string): boolean {
  const termos = normalizarBusca(buscaBruta).split(/\s+/).filter(Boolean);
  if (!termos.length) return true;
  const alvo = normalizarBusca(alvoBruto);
  return termos.every((t) => termoCasa(alvo, t));
}
