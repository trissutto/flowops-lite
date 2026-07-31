/**
 * PERSONALIZAÇÃO — sinais locais de interesse. SEM PII, SEM servidor.
 *
 * A cada peça vista, incrementamos contadores de categoria e tecido no
 * localStorage do aparelho. É só isso: nenhum nome, nenhum telefone, nenhum
 * id de pessoa sai daqui. O resultado (`PersonalizationContext`) é um resumo
 * agregado — "essa visitante olha mais vestidos e viscolycra" — que o motor
 * de recomendação e a busca usam pra ordenar melhor.
 *
 * QUANDO HOUVER LOGIN: este módulo passa a sincronizar os contadores com o
 * CRM do FlowOps (merge por soma, servidor manda). A INTERFACE NÃO MUDA —
 * `registerView` e `getPersonalizationContext` continuam sendo os únicos
 * pontos de contato; quem consome nunca sabe se o contexto veio do aparelho
 * ou do CRM. Esse é o contrato.
 *
 * Defensivo no padrão de `lib/tracking/identity.ts`: storage indisponível
 * (anônimo, cheio, bloqueado) → sinal se perde em silêncio e a loja segue.
 */

import { normalize } from '@/lib/utils';
import { getLoja } from '@/lib/tracking/identity';
import type { PersonalizationContext } from '@/lib/search/types';

const KEY = 'lurds_personal_signals';

/**
 * Mantém só os N termos mais fortes ao salvar. Sem isso o mapa cresceria
 * pra sempre (catálogo tem dezenas de categorias × tecidos) e o top 3 de
 * uma visitante antiga ficaria enterrado em cauda longa irrelevante.
 */
const MAX_KEYS = 20;

interface SignalCounters {
  categorias: Record<string, number>;
  tecidos: Record<string, number>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Storage à prova de bala
 * ──────────────────────────────────────────────────────────────────────────── */

function readCounters(): SignalCounters {
  const empty: SignalCounters = { categorias: {}, tecidos: {} };
  if (typeof window === 'undefined') return empty;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<SignalCounters> | null;
    return {
      categorias: sanitize(parsed?.categorias),
      tecidos: sanitize(parsed?.tecidos),
    };
  } catch {
    return empty;
  }
}

/** Registro corrompido não derruba nada: só entram pares string → número. */
function sanitize(map: unknown): Record<string, number> {
  if (!map || typeof map !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

function writeCounters(counters: SignalCounters): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(counters));
  } catch {
    /* storage indisponível — perde o sinal, nunca a navegação */
  }
}

/** Poda pra cauda não crescer sem limite (ver MAX_KEYS). */
function trim(map: Record<string, number>): Record<string, number> {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, MAX_KEYS));
}

function top(map: Record<string, number>, n: number): string[] {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key]) => key);
}

/* ────────────────────────────────────────────────────────────────────────────
 * API pública
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Registra que a visitante viu uma peça desta categoria/tecido.
 * Chamado na página de produto (via ProductPageSignals) — um view por render,
 * sem debounce: a própria navegação já limita a frequência.
 */
export function registerView(category?: string, fabric?: string): void {
  const cat = category ? normalize(category) : '';
  const fab = fabric ? normalize(fabric) : '';
  if (!cat && !fab) return; // nada a registrar — não toca no storage à toa

  const counters = readCounters();
  if (cat) counters.categorias[cat] = (counters.categorias[cat] ?? 0) + 1;
  if (fab) counters.tecidos[fab] = (counters.tecidos[fab] ?? 0) + 1;

  writeCounters({
    categorias: trim(counters.categorias),
    tecidos: trim(counters.tecidos),
  });
}

/**
 * Resumo agregado pro motor de busca/recomendação — top 3 de cada eixo.
 * `nearStore` reaproveita a loja já atribuída pelo tracking (por CEP),
 * porque estoque perto de casa é o sinal mais forte que temos sem login.
 */
export function getPersonalizationContext(): PersonalizationContext {
  const counters = readCounters();
  return {
    topCategories: top(counters.categorias, 3),
    topFabrics: top(counters.tecidos, 3),
    nearStore: getLoja() ?? undefined,
  };
}
