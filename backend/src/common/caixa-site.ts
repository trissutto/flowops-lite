/**
 * A CAIXA QUE O SITE COTA — uma regra só, dois consumidores.
 *
 * Números do dono (04/08): 250 g/peça, 28 × 40 cm, e a ALTURA por faixa
 * (1–2 peças = 3 cm · 3–5 = 6 · 6+ = 10). Roupa comprime, não empilha como
 * tijolo.
 *
 * Mora aqui desde 13/08 porque o `FreteService` cotava com esta caixa e o
 * simulador de `/retaguarda/correios` cotava com OUTRA (20×20×10, 500 g, os
 * defaults do `CorreiosService`). Conferir um preço estranho do checkout na
 * tela dava um número diferente — e a conferência não servia pra nada.
 */
export interface CaixaSite {
  pecas: number;
  pesoGramas: number;
  largura: number;
  comprimento: number;
  altura: number;
}

export function caixaDoSite(pecas: number): CaixaSite {
  const n = Math.min(50, Math.max(1, Number(pecas) || 1));
  return {
    pecas: n,
    pesoGramas: 250 * n,
    largura: 28,
    comprimento: 40,
    altura: n <= 2 ? 3 : n <= 5 ? 6 : 10,
  };
}
