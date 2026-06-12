'use client';

import Link from 'next/link';
import type { WcProduct } from '@/lib/api';

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Card de produto do catálogo. Clique abre o produto no site lurds.com.br
 * (delegação de checkout pro WC — não duplicamos carrinho no app).
 *
 * NOTA iOS: Safari implementa lazy-load AGRESSIVAMENTE — imagens não carregam
 * até o usuário rolar bem perto. Solução:
 *   - decoding="async" + fetchPriority="high" garante carregamento paralelo
 *   - SEM loading="lazy" (deixa o browser decidir)
 *   - width/height explícitos evitam reflow
 */
export default function ProductCard({ product, compact, priority }: {
  product: WcProduct;
  compact?: boolean;
  /** Se true, imagem carrega com prioridade alta (use nos primeiros itens visíveis). */
  priority?: boolean;
}) {
  return (
    <Link
      href={`/produto/${product.slug}`}
      className="block group rounded-2xl overflow-hidden bg-ink-800 border border-ink-600 hover:border-gold/50 transition active:scale-[0.98] touch-tap"
    >
      <div className="relative aspect-[3/4] bg-ink overflow-hidden">
        {product.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.image}
            alt={product.name}
            width={300}
            height={400}
            decoding="async"
            // @ts-ignore — fetchpriority é válido mas TS ainda não tem
            fetchpriority={priority ? 'high' : 'auto'}
            referrerPolicy="no-referrer-when-downgrade"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            onError={(e) => {
              // Fallback: esconde img quebrada (não fica com X de erro)
              (e.target as HTMLImageElement).style.display = 'none';
            }}
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
    </Link>
  );
}
