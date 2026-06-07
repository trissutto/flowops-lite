'use client';

import type { WcProduct } from '@/lib/api';

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Card de produto do catálogo. Clique abre o produto no site lurds.com.br
 * (delegação de checkout pro WC — não duplicamos carrinho no app).
 */
export default function ProductCard({ product, compact }: {
  product: WcProduct;
  compact?: boolean;
}) {
  return (
    <a
      href={product.permalink}
      target="_blank"
      rel="noopener"
      className="block group rounded-2xl overflow-hidden bg-ink-800 border border-ink-600 hover:border-gold/50 transition active:scale-[0.98] touch-tap"
    >
      <div className="relative aspect-[3/4] bg-ink overflow-hidden">
        {product.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.image}
            alt={product.name}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-cream/30 text-xs">
            Sem imagem
          </div>
        )}
        {product.onSale && (
          <div className="absolute top-2 left-2 bg-gold text-ink text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider">
            Promo
          </div>
        )}
      </div>
      <div className={compact ? 'p-2' : 'p-3'}>
        <h4 className={`text-white font-medium leading-tight line-clamp-2 ${compact ? 'text-xs' : 'text-sm'}`}>
          {product.name}
        </h4>
        <div className="mt-1.5 flex items-baseline gap-2">
          {product.onSale && product.regularPrice > product.price && (
            <span className="text-[10px] line-through text-cream/40">
              {brl(product.regularPrice)}
            </span>
          )}
          <span className={`font-black text-gold tabular-nums ${compact ? 'text-sm' : 'text-base'}`}>
            {brl(product.price)}
          </span>
        </div>
      </div>
    </a>
  );
}
