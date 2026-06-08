'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, ShoppingBag, Loader2, AlertCircle, Sparkles,
  Minus, Plus, Heart, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { getProductBySlug, type WcProductDetail, type WcVariation } from '@/lib/api';
import { useCart } from '@/contexts/CartContext';

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function ProdutoPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const { addItem, itemCount } = useCart();

  const [product, setProduct] = useState<WcProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // UI state
  const [galleryIdx, setGalleryIdx] = useState(0);
  const [selectedAttrs, setSelectedAttrs] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);
  const [adding, setAdding] = useState(false);
  const [justAdded, setJustAdded] = useState(false);

  useEffect(() => {
    if (!params?.slug) return;
    setLoading(true);
    getProductBySlug(params.slug)
      .then(setProduct)
      .catch((e) => setErr(e?.message || 'Produto não encontrado'))
      .finally(() => setLoading(false));
  }, [params?.slug]);

  // Acha a variação que casa com os atributos selecionados
  const matchedVariation = useMemo<WcVariation | null>(() => {
    if (!product || product.type !== 'variable') return null;
    const needed = product.attributes.filter((a) => a.variation).length;
    const selectedCount = Object.keys(selectedAttrs).length;
    if (selectedCount < needed) return null;

    return product.variations.find((v) =>
      v.attributes.every((va) => selectedAttrs[va.name] === va.option),
    ) || null;
  }, [product, selectedAttrs]);

  // Preço efetivo (variação > produto)
  const effectivePrice = matchedVariation
    ? matchedVariation.price
    : product?.price || 0;
  const effectiveRegular = matchedVariation
    ? matchedVariation.regularPrice
    : product?.regularPrice || 0;
  const onSale = matchedVariation
    ? matchedVariation.onSale
    : product?.onSale || false;
  const inStock = matchedVariation
    ? matchedVariation.stockStatus === 'instock'
    : product?.stockStatus === 'instock';

  const cashbackBrl = effectivePrice * 0.10;

  const canAdd =
    product &&
    inStock &&
    (product.type === 'simple' || matchedVariation !== null) &&
    !adding;

  const handleAdd = async () => {
    if (!product || !canAdd) return;
    setAdding(true);

    addItem({
      productId: product.id,
      variationId: matchedVariation?.id ?? null,
      slug: product.slug,
      name: product.name,
      image: matchedVariation?.image || product.images[0]?.src || null,
      price: effectivePrice,
      regularPrice: effectiveRegular,
      quantity,
      attributes: selectedAttrs,
    });

    setJustAdded(true);
    setTimeout(() => {
      setJustAdded(false);
      setAdding(false);
    }, 1200);
  };

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gold" />
      </div>
    );
  }

  if (err || !product) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center px-6 text-center">
        <AlertCircle className="w-12 h-12 text-gold/40" />
        <h2 className="font-serif text-xl font-bold mt-4">Produto não encontrado</h2>
        <Link href="/catalogo" className="btn-gold mt-4">Ver catálogo</Link>
      </div>
    );
  }

  return (
    <div className="pb-32">
      {/* Header flutuante */}
      <header className="sticky top-0 z-30 flex items-center justify-between p-4 bg-ink/95 backdrop-blur-md">
        <button
          onClick={() => router.back()}
          className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition"
        >
          <ArrowLeft className="w-5 h-5 text-gold" />
        </button>
        <Link href="/carrinho" className="relative p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ShoppingBag className="w-5 h-5 text-gold" />
          {itemCount > 0 && (
            <span className="absolute -top-1 -right-1 bg-gold text-ink text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
              {itemCount}
            </span>
          )}
        </Link>
      </header>

      {/* Galeria */}
      <section className="relative bg-ink-800 aspect-square">
        {product.images.length > 0 ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={product.images[galleryIdx]?.src}
              alt={product.images[galleryIdx]?.alt}
              className="w-full h-full object-cover"
              decoding="async"
            />
            {product.images.length > 1 && (
              <>
                <button
                  onClick={() => setGalleryIdx((i) => (i > 0 ? i - 1 : product.images.length - 1))}
                  className="absolute left-2 top-1/2 -translate-y-1/2 p-2 bg-ink/80 rounded-full text-gold"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <button
                  onClick={() => setGalleryIdx((i) => (i < product.images.length - 1 ? i + 1 : 0))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-ink/80 rounded-full text-gold"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
                <div className="absolute bottom-3 left-0 right-0 flex justify-center gap-1.5">
                  {product.images.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => setGalleryIdx(i)}
                      className={`w-1.5 h-1.5 rounded-full transition ${
                        i === galleryIdx ? 'bg-gold w-4' : 'bg-cream/40'
                      }`}
                    />
                  ))}
                </div>
              </>
            )}
            {onSale && (
              <div className="absolute top-3 left-3 bg-gold text-ink text-xs font-black px-3 py-1 rounded-full uppercase tracking-wider">
                Promo
              </div>
            )}
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-cream/30">
            Sem imagem
          </div>
        )}
      </section>

      {/* Info do produto */}
      <section className="px-5 mt-5">
        {product.categories[0] && (
          <div className="text-[10px] uppercase tracking-widest text-gold/80 font-bold mb-1">
            {product.categories[0].name}
          </div>
        )}
        <h1 className="font-serif text-2xl font-bold leading-tight">
          {product.name}
        </h1>

        {/* Preço */}
        <div className="mt-4 flex items-baseline gap-3">
          {onSale && effectiveRegular > effectivePrice && (
            <span className="text-sm line-through text-cream/40">
              {brl(effectiveRegular)}
            </span>
          )}
          <span className="font-serif text-3xl font-black text-gold tabular-nums">
            {brl(effectivePrice)}
          </span>
        </div>

        {/* Cashback */}
        <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-900/20 px-3 py-1.5 rounded-full inline-flex">
          <Sparkles className="w-3.5 h-3.5" />
          <span>Ganhe <strong>{brl(cashbackBrl)}</strong> em cashback</span>
        </div>
      </section>

      {/* Atributos / Variações */}
      {product.attributes.filter((a) => a.variation).length > 0 && (
        <section className="px-5 mt-6 space-y-4">
          {product.attributes
            .filter((a) => a.variation)
            .map((attr) => (
              <div key={attr.id}>
                <div className="text-[11px] font-bold uppercase tracking-wider text-cream/60 mb-2">
                  {attr.name}: {selectedAttrs[attr.name] && (
                    <span className="text-gold">{selectedAttrs[attr.name]}</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {attr.options.map((opt) => {
                    const isSelected = selectedAttrs[attr.name] === opt;
                    return (
                      <button
                        key={opt}
                        onClick={() => setSelectedAttrs({ ...selectedAttrs, [attr.name]: opt })}
                        className={`px-4 py-2 rounded-full text-sm font-bold border-2 transition ${
                          isSelected
                            ? 'bg-gold text-ink border-gold shadow-gold'
                            : 'bg-ink-800 text-cream border-ink-600 hover:border-gold/50'
                        }`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
        </section>
      )}

      {/* Quantidade */}
      <section className="px-5 mt-6">
        <div className="text-[11px] font-bold uppercase tracking-wider text-cream/60 mb-2">
          Quantidade
        </div>
        <div className="inline-flex items-center bg-ink-800 border border-ink-600 rounded-full">
          <button
            onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            className="p-3 text-gold disabled:opacity-30"
            disabled={quantity <= 1}
          >
            <Minus className="w-4 h-4" />
          </button>
          <span className="px-4 font-bold tabular-nums min-w-[40px] text-center">{quantity}</span>
          <button
            onClick={() => setQuantity((q) => q + 1)}
            className="p-3 text-gold"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </section>

      {/* Descrição */}
      {product.shortDescription && (
        <section className="px-5 mt-7">
          <div className="text-[11px] font-bold uppercase tracking-wider text-cream/60 mb-2">
            Detalhes
          </div>
          <div
            className="text-sm text-cream/80 leading-relaxed prose-app"
            dangerouslySetInnerHTML={{ __html: product.shortDescription }}
          />
        </section>
      )}

      {product.description && product.description !== product.shortDescription && (
        <section className="px-5 mt-5">
          <details className="card-dark">
            <summary className="cursor-pointer font-bold text-sm">
              Descrição completa
            </summary>
            <div
              className="mt-3 text-sm text-cream/70 leading-relaxed"
              dangerouslySetInnerHTML={{ __html: product.description }}
            />
          </details>
        </section>
      )}

      {/* Bottom bar fixa — Adicionar */}
      <div
        className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-app p-4 bg-ink/95 backdrop-blur-md border-t border-ink-600"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      >
        {!inStock ? (
          <div className="text-center py-3 text-rose-300 font-bold uppercase text-sm">
            Esgotado
          </div>
        ) : (
          <button
            onClick={handleAdd}
            disabled={!canAdd}
            className={`w-full btn-gold-lg ${justAdded ? '!bg-emerald-500' : ''} transition`}
          >
            {justAdded ? (
              <>✓ Adicionado!</>
            ) : adding ? (
              <><Loader2 className="w-5 h-5 animate-spin" /> Adicionando...</>
            ) : product.type === 'variable' && !matchedVariation ? (
              'Escolha tamanho e cor'
            ) : (
              <>
                <ShoppingBag className="w-5 h-5" />
                Adicionar — {brl(effectivePrice * quantity)}
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
