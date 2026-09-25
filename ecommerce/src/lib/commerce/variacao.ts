/**
 * O CÓDIGO DA VARIAÇÃO — a identidade exata da peça que vai pra sacola.
 *
 * Por que existe (25/09/2026): a cliente comprou a Blusa VOGUE MARROM 52 e o
 * pedido chegou na loja como VOGUE PRETA 52 — separada e entregue errada. A
 * sacola carregava só a REF (`product.id`) + o nome da cor + o tamanho, e o
 * backend tinha que ADIVINHAR o código a partir disso. REF é o modelo; o que
 * distingue a peça na arara é o `codigo` do espelho, um por REF+COR+TAMANHO.
 * A grade por cor da PDP já traz esse código em `tamanhos[].sku` — faltava
 * ele viajar com a linha.
 *
 * Regra: cor escolhida + tamanho escolhido → o `sku` daquele tamanho DENTRO
 * daquela cor. Nunca procurar o tamanho fora da cor: o 52 existe em várias
 * cores, e foi exatamente esse atalho que trocou a cor da cliente.
 *
 * Devolve `undefined` quando não dá pra afirmar (sem cor com mais de uma cor
 * na peça, tamanho fora da grade daquela cor, grade sem código). Aí a linha
 * vai sem código e o backend decide — e ele recusa em vez de chutar.
 */
export interface CorComGrade {
  nome: string;
  tamanhos?: Array<{ label: string; sku?: string | null }>;
}

export function codigoDaVariacao(
  cores: ReadonlyArray<CorComGrade> | null | undefined,
  cor: string | null | undefined,
  tamanho: string | null | undefined,
): string | undefined {
  if (!cores?.length || !tamanho) return undefined;
  const daCor = cor
    ? cores.find((c) => c.nome === cor)
    : cores.length === 1
      ? cores[0]
      : undefined;
  if (!daCor) return undefined;
  const t = (daCor.tamanhos ?? []).find((x) => x.label === tamanho);
  const sku = t?.sku ? String(t.sku).trim() : '';
  return sku || undefined;
}
