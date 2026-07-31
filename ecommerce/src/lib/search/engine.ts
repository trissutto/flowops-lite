/**
 * MOTOR DE BUSCA — indexação + ranking, 100% síncrono e em memória.
 *
 * Duas funções públicas:
 *   `createSearchIndex(products)` — achata cada produto num SearchDoc
 *     normalizado (uma vez, no load do catálogo).
 *   `rankSearch(docs, query)`   — interpreta o termo, pontua, aplica
 *     merchandising/personalização e GARANTE resultado não-vazio.
 *
 * Escada de score do texto (maior = mais confiável):
 *   nome exato > SKU exato > começa-com > contém no nome > contém no doc >
 *   fuzzy (bigramas — pega typo tipo "vestdio") — e facetas somam por fora.
 *
 * ZERO RESULTS NUNCA: quando a combinação estrita não acha nada, o motor
 * relaxa em camadas — solta a faceta menos confiável primeiro (atributos →
 * modelagem → cor → tecido → ocasião → preço), depois fica só na categoria,
 * depois só no texto, e no limite ranqueia o catálogo inteiro por fuzzy +
 * boosts. Aí marca `relaxed: true` e sugere termos do vocabulário — a UI
 * mostra "não achamos X, veja parecidos" em vez de uma página morta.
 */

import { normalize } from '@/lib/utils';
import type { Product } from '@/types';
import { applyBoosts } from '@/lib/merchandising/boost';
import { loadBoostRules } from '@/lib/merchandising/rules';
import { heuristicInterpreter } from './intent';
import { FALLBACK_SUGGESTIONS, SEARCH_VOCABULARY } from './synonyms';
import type {
  BoostRule,
  Intent,
  IntentFacets,
  ScoredResult,
  SearchDoc,
  SearchOutcome,
  SearchQuery,
} from './types';

/* ------------------------------------------------------------------- ÍNDICE */

export function createSearchIndex(products: Product[]): SearchDoc[] {
  return products.map((product) => {
    const name = normalize(product.name);
    const sku = normalize(product.sku ?? product.id);
    const category = normalize(product.category);
    const fabric = normalize(product.fabric ?? '');
    const colors = (product.colors ?? []).map((c) => normalize(c.name));
    const occasions = (product.occasions ?? []).map(normalize);
    const collection = normalize(product.collection ?? '');
    const fit = normalize(product.fit ?? '');

    return {
      product,
      name,
      sku,
      category,
      fabric,
      colors,
      occasions,
      collection,
      fit,
      // Texto agregado pra busca livre — inclui subcategoria e badges pra
      // "promocao"/"novo" digitados também acharem alguma coisa.
      haystack: [
        name,
        sku,
        category,
        normalize(product.subcategory ?? ''),
        fabric,
        fit,
        collection,
        colors.join(' '),
        occasions.join(' '),
        (product.badges ?? []).join(' '),
      ]
        .filter(Boolean)
        .join(' '),
    };
  });
}

/* ------------------------------------------------------------------- FUZZY */

/** Bigramas de caracteres — "vestido" → {ve, es, st, ti, id, do}. */
function bigrams(value: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i < value.length - 1; i++) grams.add(value.slice(i, i + 2));
  return grams;
}

/** Coeficiente de Dice (0..1) — barato e bom o suficiente pra typo curto. */
function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return (2 * shared) / (ga.size + gb.size);
}

/** Melhor similaridade do termo contra o nome inteiro E cada palavra dele. */
function fuzzyAgainstName(term: string, doc: SearchDoc): number {
  let best = dice(term, doc.name);
  for (const word of doc.name.split(' ')) best = Math.max(best, dice(term, word));
  return best;
}

/** Abaixo disso o "parecido" vira chute — não pontua no caminho normal. */
const FUZZY_THRESHOLD = 0.4;
/** Termo muito curto gera bigrama demais em comum — fuzzy só a partir de 4. */
const FUZZY_MIN_LENGTH = 4;

/* ----------------------------------------------------------------- SCORING */

interface PartialScore {
  score: number;
  reasons: string[];
}

/** Escada de relevância do TEXTO (residual da intenção). */
function termScore(term: string, doc: SearchDoc): PartialScore {
  if (!term) return { score: 0, reasons: [] };

  if (doc.name === term) return { score: 100, reasons: ['nome exato'] };
  if (doc.sku === term) return { score: 95, reasons: ['SKU exato'] };
  if (doc.name.startsWith(term)) return { score: 60, reasons: ['nome começa com o termo'] };
  if (doc.name.split(' ').some((w) => w.startsWith(term))) {
    return { score: 55, reasons: ['palavra do nome começa com o termo'] };
  }
  if (doc.name.includes(term)) return { score: 40, reasons: ['nome contém o termo'] };

  // Multi-palavra: cada palavra achada no doc soma proporcionalmente —
  // "vestido midi festa" com 2 de 3 palavras ainda pontua.
  const words = term.split(' ').filter((w) => w.length > 1);
  if (words.length > 1) {
    const hits = words.filter((w) => doc.haystack.includes(w)).length;
    if (hits > 0) {
      return { score: Math.round(30 * (hits / words.length)), reasons: [`${hits}/${words.length} palavras no produto`] };
    }
  }
  if (doc.haystack.includes(term)) return { score: 25, reasons: ['termo presente no produto'] };

  if (term.length >= FUZZY_MIN_LENGTH) {
    const sim = fuzzyAgainstName(term, doc);
    if (sim >= FUZZY_THRESHOLD) {
      return { score: Math.round(20 * sim), reasons: [`aproximado (${Math.round(sim * 100)}%)`] };
    }
  }
  return { score: 0, reasons: [] };
}

/** Um atributo de caimento casa contra modelagem, tecido ou o doc inteiro. */
function attributeHits(attributes: string[], doc: SearchDoc): string[] {
  return attributes.filter((attr) => {
    const a = normalize(attr);
    return doc.fit.includes(a) || doc.fabric.includes(a) || doc.haystack.includes(a);
  });
}

/**
 * Pontua as facetas com semântica ESTRITA: toda faceta presente precisa
 * casar (atributos: pelo menos um da lista). Devolve null quando o doc não
 * atende — é isso que a escada de relaxamento vai afrouxando.
 */
function facetScore(facets: IntentFacets, doc: SearchDoc): PartialScore | null {
  let score = 0;
  const reasons: string[] = [];

  if (facets.category !== undefined) {
    const c = normalize(facets.category);
    if (doc.category !== c && !doc.category.includes(c)) return null;
    score += 30;
    reasons.push(`categoria ${facets.category}`);
  }
  if (facets.priceMax !== undefined) {
    if (doc.product.price > facets.priceMax) return null;
    score += 10;
    reasons.push(`até R$ ${facets.priceMax}`);
  }
  if (facets.occasion !== undefined) {
    const o = normalize(facets.occasion);
    if (!doc.occasions.some((x) => x.includes(o) || o.includes(x)) && !doc.haystack.includes(o)) return null;
    score += 20;
    reasons.push(`ocasião ${facets.occasion}`);
  }
  if (facets.fabric !== undefined) {
    const f = normalize(facets.fabric);
    if (!doc.fabric.includes(f) && !doc.haystack.includes(f)) return null;
    score += 15;
    reasons.push(`tecido ${facets.fabric}`);
  }
  if (facets.color !== undefined) {
    const c = normalize(facets.color);
    if (!doc.colors.some((x) => x.includes(c) || c.includes(x))) return null;
    score += 15;
    reasons.push(`cor ${facets.color}`);
  }
  if (facets.fit !== undefined) {
    const f = normalize(facets.fit);
    if (!doc.fit.includes(f) && !doc.haystack.includes(f)) return null;
    score += 12;
    reasons.push(`modelagem ${facets.fit}`);
  }
  if (facets.attributes?.length) {
    const hits = attributeHits(facets.attributes, doc);
    if (hits.length === 0) return null;
    score += Math.min(hits.length, 3) * 8; // teto: 3 atributos pontuam
    reasons.push(`caimento: ${hits.slice(0, 3).join(', ')}`);
  }

  return { score, reasons };
}

/* ------------------------------------------------------------- RELAXAMENTO */

/**
 * Escada de relaxamento: cada degrau remove a faceta MENOS confiável que
 * ainda restou. Atributos saem primeiro (são interpretação, não fato);
 * categoria por último (é o que a cliente mais explicitou). O degrau final
 * é `{}` — busca puramente textual.
 */
function relaxationLadder(facets: IntentFacets): IntentFacets[] {
  const dropOrder: (keyof IntentFacets)[] = ['attributes', 'fit', 'color', 'fabric', 'occasion', 'priceMax', 'category'];
  const ladder: IntentFacets[] = [facets];
  let current: IntentFacets = { ...facets };

  for (const key of dropOrder) {
    if (current[key] === undefined) continue;
    current = { ...current };
    delete current[key];
    ladder.push({ ...current });
  }
  // Garante o degrau vazio mesmo quando não havia faceta nenhuma.
  if (Object.keys(ladder[ladder.length - 1]).length > 0) ladder.push({});
  return ladder;
}

/** Um degrau da escada: filtra e pontua o catálogo com um conjunto de facetas. */
function runPass(docs: SearchDoc[], term: string, facets: IntentFacets): ScoredResult[] {
  const hasFacets = Object.keys(facets).length > 0;
  const results: ScoredResult[] = [];

  for (const doc of docs) {
    const fs = facetScore(facets, doc);
    if (fs === null) continue; // não atende as facetas do degrau

    const ts = termScore(term, doc);
    // Sem faceta nenhuma, o texto é o único sinal — precisa pontuar.
    if (!hasFacets && ts.score === 0) continue;

    const score = fs.score + ts.score;
    if (score <= 0) continue;
    results.push({ doc, score, reasons: [...ts.reasons, ...fs.reasons] });
  }
  return results;
}

/* -------------------------------------------------------------- SUGESTÕES */

/** Termos do vocabulário mais parecidos com o que a cliente digitou. */
function suggestionsFor(term: string): string[] {
  if (!term) return FALLBACK_SUGGESTIONS.slice(0, 4);
  const ranked = SEARCH_VOCABULARY.map((v) => ({ v, sim: dice(normalize(term), normalize(v)) }))
    .sort((a, b) => b.sim - a.sim)
    .filter((x) => x.sim >= 0.25)
    .slice(0, 4)
    .map((x) => x.v);
  return ranked.length ? ranked : FALLBACK_SUGGESTIONS.slice(0, 4);
}

/* ----------------------------------------------------------------- RANKING */

const DEFAULT_LIMIT = 24;

/**
 * Ordena aplicando merchandising + personalização por cima da relevância.
 * Empate quebra por nome — ranking precisa ser estável entre renders.
 */
function finalize(
  results: ScoredResult[],
  limit: number,
  rules: BoostRule[],
  query: SearchQuery,
): ScoredResult[] {
  return results
    .map((r) => {
      const boosted = applyBoosts(r.score, r.doc.product, rules, query.personalization);
      return { ...r, score: boosted.score, reasons: [...r.reasons, ...boosted.reasons] };
    })
    .sort((a, b) => b.score - a.score || a.doc.name.localeCompare(b.doc.name))
    .slice(0, limit);
}

/**
 * `rules` é opcional de propósito: a UI normal usa as regras carregadas
 * (`loadBoostRules`), o painel de merchandising injeta variações pra
 * pré-visualizar o efeito de uma regra antes de publicar.
 */
export function rankSearch(docs: SearchDoc[], query: SearchQuery, rules: BoostRule[] = loadBoostRules()): SearchOutcome {
  const limit = query.limit ?? DEFAULT_LIMIT;

  // A intenção roda SEMPRE — é ela que separa "vestido casamento" em
  // faceta + residual. Facetas explícitas da query (filtro da UI) têm
  // precedência sobre as interpretadas, chave a chave.
  const intent: Intent = heuristicInterpreter.interpret(query.term);
  const facets: IntentFacets = { ...intent.facets, ...(query.facets ?? {}) };
  const term = normalize(intent.residual);

  // Busca "vazia" (sem termo e sem faceta): vitrine ranqueada só por
  // merchandising — melhor que devolver nada pro overlay recém-aberto.
  if (!term && Object.keys(facets).length === 0) {
    const all = docs.map((doc) => ({ doc, score: 1, reasons: ['catálogo'] }));
    return { results: finalize(all, limit, rules, query), intent, relaxed: false, suggestions: [] };
  }

  // Sobe a escada: primeiro degrau que devolver algo, ganha.
  const ladder = relaxationLadder(facets);
  for (let step = 0; step < ladder.length; step++) {
    const results = runPass(docs, term, ladder[step]);
    if (results.length > 0) {
      const relaxed = step > 0;
      return {
        results: finalize(results, limit, rules, query),
        intent,
        relaxed,
        suggestions: relaxed ? suggestionsFor(query.term) : [],
      };
    }
  }

  // Último recurso: nada casou nem no texto livre — ranqueia o catálogo
  // inteiro por proximidade fuzzy (mesmo baixa) + boosts. Nunca vazio.
  const desperate = docs.map((doc) => ({
    doc,
    score: 1 + fuzzyAgainstName(term, doc) * 10,
    reasons: ['relaxado: catálogo por aproximação'],
  }));
  return {
    results: finalize(desperate, limit, rules, query),
    intent,
    relaxed: true,
    suggestions: suggestionsFor(query.term),
  };
}
