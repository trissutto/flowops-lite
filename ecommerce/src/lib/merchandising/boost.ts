/**
 * APLICADOR DE BOOSTS — pega o score de relevância e aplica merchandising
 * (regras declarativas) + personalização (sinais locais da visitante).
 *
 * Devolve o score final E as razões ("boost Novidade ×1.25") — as razões
 * alimentam o painel de debug/merchandising, pra time de negócio enxergar
 * POR QUE um produto subiu. Ranking inexplicável é ranking inauditável.
 *
 * Regra de ouro da personalização: ela DESEMPATA, nunca DOMINA. O fator
 * combinado é travado em ≤ 1.3 — menor que um match de texto melhor e
 * comparável a um único boost de merchandising. Uma cliente que só olhou
 * calças AINDA acha o vestido que buscou pelo nome.
 */

import { normalize } from '@/lib/utils';
import type { Product } from '@/types';
import type { BoostRule, PersonalizationContext } from '@/lib/search/types';

export interface BoostOutcome {
  score: number;
  /** Razões humanas do que mexeu no score — vazio quando nada casou. */
  reasons: string[];
}

/** Teto do fator de personalização — contrato da sprint: nunca dominar. */
const PERSONALIZATION_CAP = 1.3;

/* ----------------------------------------------------------- MATCH DA REGRA */

/**
 * Todas as condições preenchidas em `when` precisam valer (semântica E).
 * Condição ausente = não restringe.
 */
function ruleMatches(product: Product, when: BoostRule['when']): boolean {
  // `when.badge` vem como string livre da regra — compara como texto.
  const badges: string[] = product.badges ?? [];

  if (when.badge !== undefined && !badges.includes(when.badge)) return false;
  if (when.isNew !== undefined && badges.includes('novo') !== when.isNew) return false;
  if (when.onSale !== undefined) {
    const onSale =
      badges.includes('promocao') ||
      (product.compareAtPrice !== undefined && product.compareAtPrice > product.price);
    if (onSale !== when.onSale) return false;
  }
  if (when.category !== undefined && normalize(product.category) !== normalize(when.category)) return false;
  if (when.collection !== undefined && normalize(product.collection ?? '') !== normalize(when.collection)) {
    return false;
  }
  if (when.fabric !== undefined && !normalize(product.fabric ?? '').includes(normalize(when.fabric))) return false;
  // O front não recebe contagem de estoque — só o badge 'ultimas-pecas' que o
  // mapPeca liga quando estoqueTotal ≤ 3. `maxStock` usa esse badge como
  // proxy até o BFF expor o número (ver docs/boost-rules.md).
  if (when.maxStock !== undefined && !badges.includes('ultimas-pecas')) return false;

  return true;
}

/* ----------------------------------------------------------- PERSONALIZAÇÃO */

function personalizationFactor(
  product: Product,
  ctx: PersonalizationContext,
): { factor: number; reasons: string[] } {
  let factor = 1;
  const reasons: string[] = [];

  // Categoria favorita pesa mais que tecido; posição na lista decai o peso
  // (1ª mais vista = +12%, 2ª = +9%…, piso de +2%).
  const catIdx = ctx.topCategories.findIndex((c) => normalize(c) === normalize(product.category));
  if (catIdx >= 0) {
    const bump = Math.max(0.12 - catIdx * 0.03, 0.02);
    factor *= 1 + bump;
    reasons.push(`personalização: categoria favorita (+${Math.round(bump * 100)}%)`);
  }

  const fabric = normalize(product.fabric ?? '');
  const fabIdx = fabric ? ctx.topFabrics.findIndex((f) => fabric.includes(normalize(f))) : -1;
  if (fabIdx >= 0) {
    const bump = Math.max(0.08 - fabIdx * 0.02, 0.02);
    factor *= 1 + bump;
    reasons.push(`personalização: tecido favorito (+${Math.round(bump * 100)}%)`);
  }

  // `nearStore` só faz sentido quando availability.stores vier populado do
  // BFF — hoje chega vazio, então o sinal existe mas ainda não pontua.
  if (ctx.nearStore && product.availability?.stores.includes(ctx.nearStore)) {
    factor *= 1.05;
    reasons.push('personalização: disponível na loja mais próxima (+5%)');
  }

  return { factor: Math.min(factor, PERSONALIZATION_CAP), reasons };
}

/* ---------------------------------------------------------------- APLICAÇÃO */

export function applyBoosts(
  score: number,
  product: Product,
  rules: BoostRule[],
  personalization?: PersonalizationContext,
): BoostOutcome {
  let final = score;
  const reasons: string[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!ruleMatches(product, rule.when)) continue;
    final *= rule.factor;
    reasons.push(`boost ${rule.label} ×${rule.factor}`);
  }

  if (personalization) {
    const p = personalizationFactor(product, personalization);
    if (p.factor > 1) {
      final *= p.factor;
      reasons.push(...p.reasons);
    }
  }

  return { score: final, reasons };
}
