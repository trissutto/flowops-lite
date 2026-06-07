'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Search, Loader2 } from 'lucide-react';
import BottomNav from '@/components/BottomNav';
import ProductCard from '@/components/ProductCard';
import { getCategories, getProducts, type WcCategory, type WcProduct } from '@/lib/api';

/**
 * /catalogo — produtos do site lurds.com.br via API WC.
 *
 * IMPORTANTE: useSearchParams() precisa estar dentro de <Suspense> pra
 * Next.js 14 conseguir pré-renderizar (export estático). Por isso o
 * componente é dividido em wrapper + content.
 */
export default function CatalogoPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-gold" />
        </div>
      }
    >
      <CatalogoContent />
    </Suspense>
  );
}

function CatalogoContent() {
  const params = useSearchParams();
  const initialCat = params.get('cat') || '';
  const onlyPromo = params.get('campanha') === 'inverno' || params.get('promo') === '1';

  const [categories, setCategories] = useState<WcCategory[]>([]);
  const [products, setProducts] = useState<WcProduct[]>([]);
  const [selectedCat, setSelectedCat] = useState(initialCat);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loadingCats, setLoadingCats] = useState(true);
  const [loadingProds, setLoadingProds] = useState(true);

  // Categorias 1x ao montar
  useEffect(() => {
    getCategories()
      .then((r) => setCategories(r.categories))
      .catch(() => setCategories([]))
      .finally(() => setLoadingCats(false));
  }, []);

  // Debounce busca 300ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Produtos sempre que filtros mudam
  useEffect(() => {
    setLoadingProds(true);
    getProducts({
      category: selectedCat || undefined,
      search: debouncedSearch || undefined,
      onSale: onlyPromo,
      perPage: 24,
    })
      .then((r) => setProducts(r.products))
      .catch(() => setProducts([]))
      .finally(() => setLoadingProds(false));
  }, [selectedCat, debouncedSearch, onlyPromo]);

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold flex-1">
          {onlyPromo ? '🔥 Promoções' : 'Catálogo'}
        </h1>
      </header>

      {/* Busca */}
      <div className="mt-4 px-5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-cream/40" />
          <input
            type="search"
            placeholder="Buscar peça, cor, tamanho..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-dark pl-9"
          />
        </div>
      </div>

      {/* Chips de categoria — horizontal scroll */}
      <div className="mt-4">
        {loadingCats ? (
          <div className="px-5 text-xs text-cream/40">Carregando categorias…</div>
        ) : (
          <div className="flex gap-2 overflow-x-auto no-scrollbar px-5">
            <CategoryChip active={!selectedCat} onClick={() => setSelectedCat('')}>
              Todas
            </CategoryChip>
            {categories.map((c) => (
              <CategoryChip
                key={c.id}
                active={selectedCat === c.slug}
                onClick={() => setSelectedCat(c.slug)}
              >
                {c.name}{' '}
                <span className="opacity-50 text-[10px] ml-0.5">({c.count})</span>
              </CategoryChip>
            ))}
          </div>
        )}
      </div>

      {/* Grid de produtos */}
      <section className="mt-5 px-4">
        {loadingProds ? (
          <div className="text-center py-16 text-cream/50">
            <Loader2 className="w-8 h-8 animate-spin mx-auto" />
            <p className="text-sm mt-2">Carregando produtos…</p>
          </div>
        ) : products.length === 0 ? (
          <div className="text-center py-16 px-8">
            <div className="text-5xl mb-3">👗</div>
            <h2 className="font-serif text-lg font-bold">Nada encontrado</h2>
            <p className="text-sm text-cream/60 mt-2">
              Tenta outra categoria ou busca.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {products.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        )}
      </section>

      <div className="h-20" />
      <BottomNav />
    </div>
  );
}

function CategoryChip({
  active, onClick, children,
}: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-wider transition touch-tap whitespace-nowrap ${
        active
          ? 'bg-gold text-ink shadow-gold'
          : 'bg-ink-800 text-cream/70 border border-ink-600 hover:border-gold/40'
      }`}
    >
      {children}
    </button>
  );
}
