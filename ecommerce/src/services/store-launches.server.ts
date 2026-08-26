import 'server-only';

import { mapPecasDaVitrine, type PecaApi } from '@/services/products';
import type { Product } from '@/types';
import { selectStoreLaunches } from '@/app/(public)/lojas/[cidade]/store-launches';

const BASE_URL = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';

/**
 * Catálogo server-side da landing local. Não passa pelo BFF relativo porque
 * esta função roda durante o render no servidor da Vercel.
 */
export async function fetchStoreLaunches(limit = 6): Promise<Product[]> {
  if (!BASE_URL) {
    console.error('[lojas] FLOWOPS_API_URL não configurada — lançamentos indisponíveis');
    return [];
  }

  const params = new URLSearchParams({
    page: '1',
    perPage: String(limit),
    ordenar: 'novidades',
    novidade: '1',
  });

  try {
    const response = await fetch(`${BASE_URL}/public/loja/produtos?${params}`, {
      next: { revalidate: 60 },
    });
    if (!response.ok) {
      console.error('[lojas] falha ao carregar lançamentos', response.status);
      return [];
    }

    const data = (await response.json()) as { itens?: PecaApi[] };
    return selectStoreLaunches(mapPecasDaVitrine(data.itens ?? []), limit);
  } catch (error) {
    console.error('[lojas] lançamentos indisponíveis:', error);
    return [];
  }
}
