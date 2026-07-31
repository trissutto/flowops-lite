'use client';

import { useEffect } from 'react';
import { pushRecentlyViewed } from '@/lib/recommendations/recently-viewed';
import { registerView } from '@/lib/recommendations/personalization';
import type { Product } from '@/types';

/**
 * SINAIS DA PÁGINA DE PRODUTO — o "carbono" client-side de uma página que é
 * Server Component (ISR). A página renderiza no servidor pra SEO e cache;
 * este componente invisível registra, já no navegador da visitante:
 *
 *   - últimos vistos (localStorage) → alimenta o rail "Vistos por você";
 *   - contadores de categoria/tecido → alimentam a personalização da busca
 *     e das recomendações.
 *
 * useEffect com o id como dependência: o mesmo produto re-renderizado não
 * conta duas vezes, mas navegar pra outra peça conta — que é exatamente a
 * semântica de "vi essa peça".
 */
export function ProductPageSignals({ product }: { product: Product }) {
  useEffect(() => {
    pushRecentlyViewed(product);
    registerView(product.category || undefined, product.fabric);
    // O objeto `product` vem serializado do server e muda de referência a cada
    // render — a identidade real da visita é o id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  return null;
}
