/**
 * CONTRATO DO SEARCH ENGINE — Sprint 008.
 *
 * Três camadas, cada uma substituível sem tocar nas outras:
 *   1. ÍNDICE   — SearchDoc: o produto achatado pra busca.
 *   2. MOTOR    — SearchEngine: recebe query, devolve ScoredResult[].
 *   3. INTENÇÃO — IntentInterpreter: frase em linguagem natural → facetas.
 *
 * A implementação de hoje é heurística e roda no client (catálogo cabe em
 * memória). Quando a IA entrar, ela implementa `IntentInterpreter` — o motor
 * e a UI não mudam. Quando o catálogo crescer, o motor vira chamada de API —
 * a UI não muda. Esse é o desenho inteiro.
 */

import type { Product } from '@/types';

/* ------------------------------------------------------------------- ÍNDICE */

/** Produto achatado e normalizado pra ranquear rápido. */
export interface SearchDoc {
  product: Product;
  /** Campos já normalizados (minúsculo, sem acento) na indexação. */
  name: string;
  sku: string;
  category: string;
  fabric: string;
  colors: string[];
  occasions: string[];
  collection: string;
  fit: string;
  /** Texto agregado pra busca livre. */
  haystack: string;
}

/* -------------------------------------------------------------------- MOTOR */

export interface ScoredResult {
  doc: SearchDoc;
  score: number;
  /** Por que subiu — alimenta o painel de merchandising/debug. */
  reasons: string[];
}

export interface SearchQuery {
  term: string;
  limit?: number;
  /** Facetas resolvidas pela interpretação de intenção (ou por filtro da UI). */
  facets?: IntentFacets;
  /** Contexto de personalização (opcional — sem ele o resultado é neutro). */
  personalization?: PersonalizationContext;
}

export interface SearchOutcome {
  results: ScoredResult[];
  /** O que a intenção entendeu (a UI mostra "Buscando por: …"). */
  intent?: Intent;
  /** True quando o motor relaxou a busca pra não devolver vazio. */
  relaxed: boolean;
  suggestions: string[];
}

/* ----------------------------------------------------------------- INTENÇÃO */

export interface IntentFacets {
  category?: string;
  occasion?: string;
  fabric?: string;
  color?: string;
  fit?: string;
  priceMax?: number;
  /** Atributos de caimento ("esconde barriga" → soltinho/acinturado…). */
  attributes?: string[];
}

export interface Intent {
  /** Termo residual depois de extrair as facetas. */
  residual: string;
  facets: IntentFacets;
  /** Rótulo humano do que foi entendido ("vestidos para casamento"). */
  label?: string;
  confidence: 'alta' | 'media' | 'baixa';
}

/**
 * Interpretador de intenção. A implementação heurística resolve o vocabulário
 * conhecido; a futura (LLM via /api/search/intent) implementa esta MESMA
 * interface — é o slot da IA prometido pela sprint.
 */
export interface IntentInterpreter {
  interpret(term: string): Intent;
}

/* ----------------------------------------------------------- MERCHANDISING */

/** Regra de boost configurável — ver docs/boost-rules.md. */
export interface BoostRule {
  id: string;
  label: string;
  /** Multiplicador aplicado ao score quando `when` casa (1 = neutro). */
  factor: number;
  enabled: boolean;
  when: {
    badge?: string;
    category?: string;
    collection?: string;
    fabric?: string;
    /** Estoque baixo (ultimas-pecas) etc. */
    maxStock?: number;
    isNew?: boolean;
    onSale?: boolean;
  };
}

/* --------------------------------------------------------- PERSONALIZAÇÃO */

/** O que sabemos da visitante SEM login — só sinais locais, nada de PII. */
export interface PersonalizationContext {
  /** Categorias mais vistas (da mais pra menos frequente). */
  topCategories: string[];
  topFabrics: string[];
  /** Slug da loja mais próxima (por CEP salvo) — prioriza estoque local. */
  nearStore?: string;
}

/* ------------------------------------------------------------ RECOMENDAÇÃO */

export type RecommendationKind =
  | 'voce-tambem-pode-gostar'  // similares ao produto atual
  | 'complete-seu-look'        // categorias complementares
  | 'quem-viu-tambem-comprou'  // heurística até existir dado de pedido
  | 'ultimos-vistos'
  | 'favoritos';

export interface RecommendationRequest {
  kind: RecommendationKind;
  /** Produto de referência (página de produto / carrinho). */
  seed?: Product;
  /** Vários seeds (carrinho inteiro). */
  seeds?: Product[];
  limit?: number;
  personalization?: PersonalizationContext;
}
