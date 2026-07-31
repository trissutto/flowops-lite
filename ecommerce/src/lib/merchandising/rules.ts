/**
 * REGRAS DE BOOST — merchandising declarativo sobre o ranking da busca.
 *
 * Cada regra é um multiplicador sobre o score de relevância: relevância
 * decide QUEM aparece, merchandising decide quem aparece PRIMEIRO entre
 * iguais. Fator 1 = neutro; 1.25 = +25%. Regra desligada (`enabled: false`)
 * fica no array mas não pontua — dá pra ligar/desligar sem deletar.
 *
 * O shape é o `BoostRule` do contrato (src/lib/search/types.ts).
 * Documentação de negócio: docs/boost-rules.md e docs/merchandising.md.
 */

import type { BoostRule } from '@/lib/search/types';

export const DEFAULT_BOOST_RULES: BoostRule[] = [
  {
    // Novidade vende o site inteiro: quem entra pra ver o lançamento navega
    // o resto. É o maior fator porque estoque novo é o que gira.
    id: 'novidade',
    label: 'Novidade',
    factor: 1.25,
    enabled: true,
    when: { isNew: true },
  },
  {
    // Best-seller é prova social — sobe porque converte melhor, mas abaixo
    // de novidade pra vitrine não congelar nos mesmos campeões de sempre.
    id: 'best-seller',
    label: 'Mais vendido',
    factor: 1.2,
    enabled: true,
    when: { badge: 'best-seller' },
  },
  {
    // Promoção atrai clique, mas margem menor — empurrão moderado.
    id: 'promocao',
    label: 'Em promoção',
    factor: 1.15,
    enabled: true,
    when: { onSale: true },
  },
  {
    // Últimas peças: urgência real (estoque ≤ 3 vira badge no mapPeca).
    // Fator pequeno de propósito — peça acabando com grade quebrada não
    // pode dominar a primeira dobra da busca.
    id: 'ultimas-pecas',
    label: 'Últimas peças',
    factor: 1.1,
    enabled: true,
    when: { badge: 'ultimas-pecas' },
  },
];

/**
 * Fonte das regras ativas.
 *
 * HOJE: devolve as default hardcoded — suficiente pro lançamento.
 *
 * DEPOIS: este é o único ponto a trocar quando as regras virarem painel.
 * O desenho previsto:
 *   1. Backend FlowOps ganha `GET /api/loja/boost-rules` (tabela no Postgres,
 *      editada numa tela da retaguarda — mesmo padrão de descontos-senhas).
 *   2. Esta função busca da API com cache curto (SWR/unstable_cache) e cai
 *      pras DEFAULT em erro — merchandising fora do ar NUNCA quebra a busca.
 *   3. A assinatura pode virar `Promise<BoostRule[]>`; o motor já recebe as
 *      regras por parâmetro, então só o call-site da UI muda.
 */
export function loadBoostRules(): BoostRule[] {
  return DEFAULT_BOOST_RULES;
}
