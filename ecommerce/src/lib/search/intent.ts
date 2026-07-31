/**
 * INTERPRETADOR DE INTENÇÃO (heurístico) — frase natural → facetas.
 *
 * "Vestido pra casamento até 200 reais" vira
 * `{ category: 'vestidos', occasion: 'casamento', priceMax: 200 }` +
 * label humano ("vestidos para casamento até R$ 200").
 *
 * Implementa `IntentInterpreter` do contrato — a MESMA interface que a
 * futura versão com LLM (/api/search/intent) vai implementar. A heurística
 * nunca morre: ela é o fallback permanente quando a IA estiver fora do ar
 * ou lenta demais pro autocomplete (ver docs/ai-search.md).
 *
 * Mecânica: normaliza a frase, extrai teto de preço por regex, depois casa
 * FRASES do dicionário (mais longas primeiro, pra "azul marinho" ganhar de
 * "azul") removendo cada match da frase. O que sobra — menos ruído tipo
 * "quero"/"roupa" — é o residual que o motor usa como texto livre.
 */

import { normalize } from '@/lib/utils';
import type { Intent, IntentFacets, IntentInterpreter } from './types';
import {
  ATTRIBUTE_RULES,
  CATEGORY_SYNONYMS,
  COLOR_SYNONYMS,
  FABRIC_SYNONYMS,
  FIT_SYNONYMS,
  NOISE_WORDS,
  OCCASION_SYNONYMS,
  type AttributeRule,
  type SynonymGroup,
} from './synonyms';

/* ------------------------------------------------------------ PREPARAÇÃO */

type FacetKey = 'category' | 'occasion' | 'fabric' | 'color' | 'fit';

interface PhraseRule {
  /** Variante normalizada que dispara ("azul marinho"). */
  phrase: string;
  kind: FacetKey | 'attribute';
  group?: SynonymGroup;
  rule?: AttributeRule;
}

/** Achata todos os dicionários numa lista única, ordenada por tamanho
 *  decrescente — frase mais específica sempre casa primeiro. Montada uma
 *  vez no load do módulo (dicionário é estático). */
function buildPhraseRules(): PhraseRule[] {
  const rules: PhraseRule[] = [];
  const add = (kind: FacetKey, groups: SynonymGroup[]) => {
    for (const group of groups) {
      for (const variant of group.variants) {
        rules.push({ phrase: normalize(variant), kind, group });
      }
    }
  };

  // Atributos primeiro na ordem de empate — são o diferencial da busca.
  for (const rule of ATTRIBUTE_RULES) {
    for (const trigger of rule.triggers) {
      rules.push({ phrase: normalize(trigger), kind: 'attribute', rule });
    }
  }
  add('occasion', OCCASION_SYNONYMS);
  add('category', CATEGORY_SYNONYMS);
  add('fabric', FABRIC_SYNONYMS);
  add('color', COLOR_SYNONYMS);
  add('fit', FIT_SYNONYMS);

  // Mais palavras > mais caracteres > ordem de inserção (estável).
  return rules.sort((a, b) => {
    const words = b.phrase.split(' ').length - a.phrase.split(' ').length;
    return words !== 0 ? words : b.phrase.length - a.phrase.length;
  });
}

const PHRASE_RULES = buildPhraseRules();
const NOISE = new Set(NOISE_WORDS.map(normalize));

/** "ate 200 reais", "menos de 150", "no maximo r$ 300", "abaixo de 250". */
const PRICE_RE =
  /(?:ate|abaixo de|menos de|por menos de|no maximo|maximo)\s*(?:r\$\s*)?(\d{2,5})(?:\s*(?:reais|real|contos?))?/;

/* ----------------------------------------------------------- INTERPRETAÇÃO */

interface Extraction {
  facets: IntentFacets;
  /** Labels humanos por faceta — montam o label final. */
  labels: Partial<Record<FacetKey, string>>;
  attributeLabels: string[];
  residual: string;
}

function extract(raw: string): Extraction {
  const facets: IntentFacets = {};
  const labels: Extraction['labels'] = {};
  const attributeLabels: string[] = [];

  // Espaços nas pontas permitem casar frase com fronteira de palavra
  // usando includes simples (sem regex por frase — mais rápido e previsível).
  let working = ` ${normalize(raw).replace(/\s+/g, ' ')} `;

  const price = working.match(PRICE_RE);
  if (price) {
    facets.priceMax = Number(price[1]);
    working = working.replace(price[0], ' ');
  }

  for (const rule of PHRASE_RULES) {
    const needle = ` ${rule.phrase} `;
    if (!working.includes(needle)) continue;

    if (rule.kind === 'attribute' && rule.rule) {
      // Atributos ACUMULAM (a cliente pode querer "confortável e elegante").
      facets.attributes = [...(facets.attributes ?? []), ...rule.rule.attributes];
      if (rule.rule.occasion && !facets.occasion) {
        facets.occasion = rule.rule.occasion;
        // Ocasião implícita não repete no label — o label do atributo já diz.
      }
      if (!attributeLabels.includes(rule.rule.label)) attributeLabels.push(rule.rule.label);
    } else if (rule.group && rule.kind !== 'attribute') {
      // Facetas simples: primeira ocorrência vence (frase já veio ordenada
      // da mais específica pra menos — "azul marinho" antes de "azul").
      if (facets[rule.kind] === undefined) {
        facets[rule.kind] = rule.group.canonical;
        labels[rule.kind] = rule.group.label;
      }
    }
    working = working.split(needle).join(' ');
  }

  // Residual: o que sobrou menos ruído ("quero", "roupa", "pra"…).
  const residual = working
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !NOISE.has(w))
    .join(' ');

  if (facets.attributes) facets.attributes = [...new Set(facets.attributes)];

  return { facets, labels, attributeLabels, residual };
}

/* ------------------------------------------------------------------ LABEL */

function buildLabel({ facets, labels, attributeLabels }: Extraction): string | undefined {
  const parts: string[] = [];

  // Sujeito: categoria quando tem; senão "peças" (nunca frase sem sujeito).
  if (labels.category) parts.push(labels.category);
  else if (facets.occasion || facets.fabric || facets.color || facets.fit || attributeLabels.length) {
    parts.push('peças');
  }

  // "confortáveis", "que disfarçam a barriga"… vêm coladas no sujeito.
  const attrs = attributeLabels.filter((l) => l !== 'moda evangélica');
  if (attrs.length) parts.push(attrs.join(' e '));
  if (attributeLabels.includes('moda evangélica')) parts.push('moda evangélica');

  if (labels.fit) parts.push(`modelagem ${labels.fit}`);
  if (labels.fabric) parts.push(`em ${labels.fabric}`);
  if (labels.color) parts.push(`na cor ${labels.color}`);
  if (labels.occasion) parts.push(`para ${labels.occasion}`);
  if (facets.priceMax !== undefined) parts.push(`até R$ ${facets.priceMax}`);

  return parts.length ? parts.join(' ') : undefined;
}

/* -------------------------------------------------------------- CONFIANÇA */

function confidenceOf(extraction: Extraction): Intent['confidence'] {
  const { facets, residual } = extraction;
  const facetCount =
    (facets.category ? 1 : 0) +
    (facets.occasion ? 1 : 0) +
    (facets.fabric ? 1 : 0) +
    (facets.color ? 1 : 0) +
    (facets.fit ? 1 : 0) +
    (facets.priceMax !== undefined ? 1 : 0) +
    (facets.attributes?.length ? 1 : 0);

  // Entendeu tudo → alta. Entendeu parte (sobrou texto solto) → média.
  // Não entendeu nada → baixa (o motor ainda tenta texto livre + fuzzy).
  if (facetCount > 0 && residual === '') return 'alta';
  if (facetCount > 0) return 'media';
  return 'baixa';
}

/* -------------------------------------------------------------- INTERFACE */

export const heuristicInterpreter: IntentInterpreter = {
  interpret(term: string): Intent {
    const extraction = extract(term ?? '');
    return {
      residual: extraction.residual,
      facets: extraction.facets,
      label: buildLabel(extraction),
      confidence: confidenceOf(extraction),
    };
  },
};
