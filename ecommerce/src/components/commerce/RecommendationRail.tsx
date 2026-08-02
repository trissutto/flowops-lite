'use client';

import { useEffect, useRef, useState } from 'react';
import { Section, type SectionTone } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { LuxuryCarousel } from '@/components/ui/LuxuryCarousel';
import { CAROUSEL_PRODUCT_SIZES, ProductCard } from '@/components/cards/ProductCard';
import { ProductCardSkeleton } from '@/components/ui/Skeleton';
import { getRecommendations } from '@/lib/recommendations/engine';
import { trackSelectItem, trackViewItemList } from '@/lib/tracking';
import type { RecommendationKind } from '@/lib/search/types';
import type { Product } from '@/types';

/**
 * RECOMMENDATION RAIL — a vitrine de recomendação do site inteiro.
 *
 * A página só diz O QUE quer ("complete-seu-look" a partir desta peça) e o
 * texto editorial; COMO os produtos são escolhidos é problema do motor
 * (`lib/recommendations/engine`). Trocar a heurística por dado real de
 * pedidos não toca em nenhuma página.
 *
 * Comportamento de carregamento, na ordem:
 *   1. buscando  → título + skeletons (mesma silhueta do card, sem salto);
 *   2. vazio     → NADA. Nem título, nem espaço — rail sem produto não
 *                  existe. É isso que deixa a página segura pra empilhar
 *                  rails sem medo de seção fantasma;
 *   3. com peças → carrossel padrão da marca.
 *
 * Tracking: `view_item_list` UMA vez quando os produtos chegam (list_name =
 * kind) e `select_item` no clique que navega pro produto — clique no coração
 * de favoritar não conta, senão a taxa de clique do rail vira mentira.
 */

interface RecommendationRailProps {
  kind: RecommendationKind;
  /** Peça de referência — obrigatória pros kinds que partem de um produto. */
  seed?: Product;
  title: string;
  eyebrow?: string;
  description?: string;
  cta?: { label: string; href: string };
  tone?: SectionTone;
  limit?: number;
}

export function RecommendationRail({
  kind,
  seed,
  title,
  eyebrow,
  description,
  cta,
  tone = 'default',
  limit = 8,
}: RecommendationRailProps) {
  // null = ainda buscando; [] = buscou e não há o que mostrar.
  const [products, setProducts] = useState<Product[] | null>(null);
  const viewTracked = useRef(false);

  useEffect(() => {
    let alive = true;
    viewTracked.current = false;
    getRecommendations({ kind, seed, limit }).then((result) => {
      // Guarda contra resposta atrasada de um seed anterior (navegação SPA).
      if (alive) setProducts(result);
    });
    return () => {
      alive = false;
    };
    // seed é objeto novo a cada render do server — o id é a identidade real.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, seed?.id, limit]);

  // view_item_list só quando há produto de verdade na tela, e só uma vez.
  useEffect(() => {
    if (!products || products.length === 0 || viewTracked.current) return;
    viewTracked.current = true;
    trackViewItemList(products, kind);
  }, [products, kind]);

  // Vazio confirmado: o rail não existe (nem título, nem espaço).
  if (products && products.length === 0) return null;

  const tituloId = `rail-${kind}-titulo`;

  /** Só o clique que navega conta como seleção — favoritar não é escolher. */
  const aoClicar = (product: Product, index: number) => (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('a')) {
      trackSelectItem(product, kind, index);
    }
  };

  return (
    <Section tone={tone} width="wide" aria-labelledby={tituloId}>
      <SectionTitle id={tituloId} eyebrow={eyebrow} title={title} description={description} cta={cta} align="left" />

      <div className="mt-14">
        {products === null ? (
          <div
            role="status"
            aria-live="polite"
            aria-label="Carregando recomendações"
            className="grid grid-cols-2 gap-x-4 gap-y-10 lg:grid-cols-4 lg:gap-x-6"
          >
            {Array.from({ length: 4 }, (_, i) => (
              <ProductCardSkeleton key={i} />
            ))}
          </div>
        ) : (
          <LuxuryCarousel ariaLabel={title} perView={{ base: 1.35, sm: 2, lg: 3, xl: 4 }} gap="md" arrows>
            {products.map((product, index) => (
              <div key={product.id} onClickCapture={aoClicar(product, index)}>
                <ProductCard product={product} index={index} sizes={CAROUSEL_PRODUCT_SIZES} />
              </div>
            ))}
          </LuxuryCarousel>
        )}
      </div>
    </Section>
  );
}
