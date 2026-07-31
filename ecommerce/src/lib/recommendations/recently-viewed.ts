/**
 * ÚLTIMOS VISTOS — memória local de navegação. Zero servidor, zero PII.
 *
 * Guardamos o MÍNIMO que o card do rail precisa (id, slug, nome, foto, preço):
 * não é cache de catálogo, é lembrete visual. Preço e estoque podem ficar
 * defasados entre a visita e o rail — aceitável, porque o clique leva pra
 * página do produto, que sempre mostra o dado fresco.
 *
 * Tudo aqui é defensivo, no mesmo padrão de `lib/tracking/identity.ts`:
 * navegação anônima, storage cheio e bloqueador fazem `localStorage` lançar
 * exceção — e recomendação NUNCA pode derrubar a loja. Na dúvida, devolve
 * vazio e segue.
 */

import type { Product } from '@/types';

const KEY = 'lurds_recently_viewed';

/** 12 = três fileiras de rail no desktop. Mais que isso é ruído, não memória. */
const MAX_ITEMS = 12;

export interface RecentlyViewedItem {
  id: string;
  slug: string;
  name: string;
  /** Primeira foto da peça — o suficiente pro card. */
  image: string;
  /** Em REAIS, como todo preço do projeto. */
  price: number;
  /** Epoch ms da visita — ordena e permite expirar no futuro. */
  at: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Storage à prova de bala
 * ──────────────────────────────────────────────────────────────────────────── */

function readAll(): RecentlyViewedItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Registro corrompido (versão antiga, edição manual) não pode quebrar o
    // rail: filtra item a item em vez de descartar tudo ou confiar cegamente.
    return parsed.filter(
      (item): item is RecentlyViewedItem =>
        !!item &&
        typeof item.id === 'string' &&
        typeof item.slug === 'string' &&
        typeof item.name === 'string' &&
        typeof item.image === 'string' &&
        typeof item.price === 'number',
    );
  } catch {
    return [];
  }
}

function writeAll(items: RecentlyViewedItem[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* storage indisponível — a memória vira efêmera, e tudo bem */
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * API pública
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Registra a visita a uma peça. Dedup por id com a mais recente na frente —
 * rever a mesma peça sobe ela pro topo em vez de duplicar.
 */
export function pushRecentlyViewed(product: Product): void {
  const image = product.images[0]?.src;
  // Sem foto não há card — não vale a vaga na lista.
  if (!image) return;

  const entry: RecentlyViewedItem = {
    id: product.id,
    slug: product.slug,
    name: product.name,
    image,
    price: product.price,
    at: Date.now(),
  };

  const rest = readAll().filter((item) => item.id !== entry.id);
  writeAll([entry, ...rest].slice(0, MAX_ITEMS));
}

/** Da mais recente pra mais antiga — a ordem em que o rail renderiza. */
export function getRecentlyViewed(): RecentlyViewedItem[] {
  return readAll();
}
