/**
 * REGRA DO CARTÃO — o número que a tela e o texto institucional compartilham.
 *
 * Morava dentro de `components/checkout/CardForm.tsx`, que é `'use client'`.
 * A página de formas de pagamento é Server Component e precisa do mesmo
 * número: importar de lá arrastaria zod + react-hook-form pro bundle de uma
 * página que é só texto. Aqui é um módulo sem dependência, que os dois leem.
 */

/** Até quantas vezes o cartão parcela, SEM JUROS. Não há valor mínimo de parcela. */
export const MAX_PARCELAS = 12;
