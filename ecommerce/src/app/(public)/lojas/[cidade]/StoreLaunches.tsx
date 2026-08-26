'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { ProductCard, HOME_GRID_SIZES } from '@/components/cards/ProductCard';
import { trackStoresProductClick, trackViewItemList } from '@/lib/tracking';
import type { Product } from '@/types';
import type { Store } from '../lib';
import { StoreLaunchWhatsApp } from './StoreCtas';
import { storeLaunchProductHref } from './store-launches';

const LIST_NAME = 'Lojas — novidades';

export default function StoreLaunches({ products, store }: { products: Product[]; store: Store }) {
  useEffect(() => {
    if (products.length > 0) trackViewItemList(products, LIST_NAME);
  }, [products]);

  return (
    <section id="lancamentos" className="scroll-mt-24 border-t border-[var(--lj-line)] pt-10" aria-labelledby="lancamentos-titulo">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--lj-gold-strong)]">
        Acabou de chegar
      </p>
      <h2 id="lancamentos-titulo" className="lojas-serif mt-2 text-[1.75rem] font-semibold leading-tight text-[var(--lj-ink)]">
        Novidades para inspirar seu próximo look
      </h2>
      <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-[var(--lj-ink-soft)]">
        Conheça os lançamentos da Lurd&apos;s e fale com a equipe de {store.unit} para consultar a disponibilidade na loja.
      </p>

      {products.length > 0 ? (
        <>
          <div className="mt-7 grid grid-cols-2 gap-x-4 gap-y-9 sm:grid-cols-3 sm:gap-x-5 lg:gap-y-12">
            {products.map((product, index) => (
              <div key={`${product.id}-${product.vitrineCor?.nome ?? 'principal'}`} className="min-w-0">
                <ProductCard
                  product={product}
                  index={index}
                  compact
                  sizes={HOME_GRID_SIZES}
                  href={storeLaunchProductHref(product)}
                  onProductClick={() => trackStoresProductClick(product, index, store.unit)}
                />
              </div>
            ))}
          </div>
          <p className="mt-5 text-center text-[12px] leading-relaxed text-[var(--lj-ink-soft)]">
            Consulte cores, tamanhos e disponibilidade na loja de {store.unit}.
          </p>
        </>
      ) : (
        <div className="mt-6 rounded-2xl border border-[var(--lj-line)] bg-white p-6">
          <p className="text-[15px] leading-relaxed text-[var(--lj-ink-soft)]">
            Veja todas as peças que acabaram de chegar no nosso catálogo online.
          </p>
          <Link
            href="/novidades"
            className="mt-4 inline-flex rounded-full bg-[var(--lj-ink)] px-6 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-white transition hover:brightness-125"
          >
            Ver novidades
          </Link>
        </div>
      )}

      <div className="mt-9 rounded-2xl bg-[var(--lj-ink)] px-6 py-7 text-white sm:px-8">
        <p className="lojas-serif text-[1.45rem] font-semibold">Gostou de algum look?</p>
        <p className="mt-2 text-[14px] leading-relaxed text-white/75">
          Fale com a equipe de {store.unit} para saber quais novidades estão disponíveis na loja.
        </p>
        <StoreLaunchWhatsApp store={store} />
      </div>
    </section>
  );
}
