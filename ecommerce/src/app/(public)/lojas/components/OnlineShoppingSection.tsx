'use client';

import { ArrowRight } from 'lucide-react';
import { ProductCard } from '@/components/cards/ProductCard';
import { AppLink } from '@/components/ui/AppLink';
import { trackStoresOnlineCta, trackStoresProductClick } from '@/lib/tracking';
import { withCampaignParams } from '@/lib/campaign-links';
import type { Product } from '@/types';

export default function OnlineShoppingSection({
  products,
  campaignParams,
  storeUnit,
}: {
  products: Product[];
  campaignParams: URLSearchParams;
  storeUnit?: string;
}) {
  const novidadesHref = withCampaignParams('/novidades', campaignParams);

  return (
    <section className="border-y border-[var(--lj-line)] bg-white px-6 py-12 sm:py-16" aria-labelledby="comprar-online-titulo">
      <div className="mx-auto max-w-7xl">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[var(--lj-gold-strong)]">Loja online</p>
          <h2 id="comprar-online-titulo" className="lojas-serif mt-3 text-2xl font-medium sm:text-4xl">
            Prefere receber em casa?
          </h2>
          <p className="mt-3 text-sm font-light leading-relaxed text-[var(--lj-ink-soft)] sm:text-base">
            Os mesmos lançamentos das lojas também estão disponíveis online, com entrega para todo o Brasil.
          </p>
        </div>

        {products.length > 0 && (
          <div className="mt-7 grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-6 lg:gap-x-5">
            {products.map((product, index) => (
              <ProductCard
                key={product.id}
                product={product}
                index={index}
                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 17vw"
                progressiveImage
                href={withCampaignParams(`/produto/${product.slug}`, campaignParams)}
                onProductClick={() => trackStoresProductClick(product, index, storeUnit)}
              />
            ))}
          </div>
        )}

        <div className="mt-8 text-center">
          <AppLink
            href={novidadesHref}
            onClick={() => trackStoresOnlineCta('products_section', storeUnit)}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--lj-ink)] px-8 py-4 text-sm font-medium uppercase tracking-[0.15em] text-white transition-colors hover:bg-[var(--lj-gold-strong)]"
          >
            Ver todas as novidades <ArrowRight className="h-4 w-4" />
          </AppLink>
        </div>
      </div>
    </section>
  );
}
