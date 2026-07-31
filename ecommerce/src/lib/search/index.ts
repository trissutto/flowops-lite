/**
 * PONTO DE ENTRADA DA BUSCA.
 *
 * Componente importa daqui — nunca de `engine`/`intent`/`synonyms` direto.
 * O dia em que o motor virar chamada de API ou a intenção virar LLM, só
 * este barrel (e nada da UI) sabe.
 */

// Camada 1 — índice · Camada 2 — motor
export { createSearchIndex, rankSearch } from './engine';

// Camada 3 — intenção (implementação heurística do IntentInterpreter)
export { heuristicInterpreter } from './intent';

// Vocabulário (dados) — a UI usa pra chips de sugestão e autocomplete
export {
  ATTRIBUTE_RULES,
  CATEGORY_SYNONYMS,
  COLOR_SYNONYMS,
  FABRIC_SYNONYMS,
  FALLBACK_SUGGESTIONS,
  FIT_SYNONYMS,
  NOISE_WORDS,
  OCCASION_SYNONYMS,
  SEARCH_VOCABULARY,
  type AttributeRule,
  type SynonymGroup,
} from './synonyms';

// Contrato inteiro (tipos) — re-exportado pra UI não importar de types direto
export type {
  BoostRule,
  Intent,
  IntentFacets,
  IntentInterpreter,
  PersonalizationContext,
  RecommendationKind,
  RecommendationRequest,
  ScoredResult,
  SearchDoc,
  SearchOutcome,
  SearchQuery,
} from './types';
