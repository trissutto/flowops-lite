'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, ShoppingBag, ShoppingCart, Loader2, AlertCircle, Sparkles,
  Minus, Plus, Heart, ChevronLeft, ChevronRight, CheckCircle2, X,
} from 'lucide-react';
import { getProductBySlug, getRelatedProducts, type WcProductDetail, type WcVariation, type RelatedProduct } from '@/lib/api';
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
  const [showAddedModal, setShowAddedModal] = useState(false);

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

    // Modal "Continuar comprando ou Finalizar?"
    setShowAddedModal(true);
    setAdding(false);
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

        {/* Parcelamento — conversão killer */}
        <div className="mt-1.5 text-xs text-cream/70">
          ou <strong className="text-cream">12x de {brl(effectivePrice / 12)}</strong> sem juros
        </div>

        {/* PIX desconto — gatilho de urgência */}
        <div className="mt-1 text-xs text-emerald-400">
          💚 <strong>{brl(effectivePrice * 0.95)}</strong> no PIX (5% off)
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

      {/* Modal "Continuar comprando ou Finalizar?" — pós adicionar ao carrinho */}
      {showAddedModal && product && (
        <AddedToCartModal
          productId={product.id}
          productName={product.name}
          productImage={matchedVariation?.image || product.images[0]?.src || null}
          quantity={quantity}
          price={effectivePrice * quantity}
          onContinue={() => {
            setShowAddedModal(false);
            router.push('/catalogo');
          }}
          onCheckout={() => {
            setShowAddedModal(false);
            router.push('/carrinho');
          }}
          onClose={() => setShowAddedModal(false)}
        />
      )}
    </div>
  );
}

/* ════════════════ MODAL: ADICIONADO AO CARRINHO + CROSS-SELL ════════════════ */
function AddedToCartModal({
  productId, productName, productImage, quantity, price,
  onContinue, onCheckout, onClose,
}: {
  productId: number;
  productName: string;
  productImage: string | null;
  quantity: number;
  price: number;
  onContinue: () => void;
  onCheckout: () => void;
  onClose: () => void;
}) {
  const brl = (n: number) =>
    n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const { addItem } = useCart();
  const [related, setRelated] = useState<RelatedProduct[]>([]);
  const [loadingRelated, setLoadingRelated] = useState(true);
  const [addedIds, setAddedIds] = useState<Set<number>>(new Set());

  // Carrega cross-sell ao abrir
  useEffect(() => {
    setLoadingRelated(true);
    getRelatedProducts(productId, 6)
      .then((r) => setRelated(r.products || []))
      .catch(() => setRelated([]))
      .finally(() => setLoadingRelated(false));
  }, [productId]);

  // Quick-add: simple variation (sem atributos) direto ao carrinho
  const handleQuickAdd = (p: RelatedProduct) => {
    addItem({
      productId: p.id,
      variationId: undefined,
      slug: p.slug,
      name: p.name,
      price: p.price,
      image: p.image || undefined,
      quantity: 1,
      attributes: {},
    });
    setAddedIds((prev) => new Set(prev).add(p.id));
  };

  return (
    <div
      className="fixed inset-0 z-[200] bg-ink/90 backdrop-blur-sm flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md mx-0 sm:mx-4 bg-ink-800 sm:border sm:border-gold/30 rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl animate-slide-up max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
      >
        <button
          aria-label="Fechar"
          onClick={onClose}
          className="absolute top-3 right-3 p-2 rounded-full bg-ink-700 z-10"
        >
          <X className="w-4 h-4 text-cream" />
        </button>

        {/* Check verde com animação */}
        <div className="flex justify-center mb-3">
          <div className="w-16 h-16 rounded-full bg-emerald-500/20 border-2 border-emerald-400 flex items-center justify-center animate-pulse">
            <CheckCircle2 className="w-9 h-9 text-emerald-400" />
          </div>
        </div>

        <h3 className="font-serif text-xl font-black text-gold text-center mb-1">
          Adicionado ao carrinho!
        </h3>

        {/* Mini-card do produto */}
        <div className="mt-4 bg-ink-900 rounded-2xl p-3 flex gap-3 items-center">
          <div className="w-14 h-16 bg-ink-700 rounded-lg overflow-hidden shrink-0">
            {productImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={productImage} alt={productName} className="w-full h-full object-cover" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-white line-clamp-2 leading-tight">
              {productName}
            </div>
            <div className="text-xs text-cream/60 mt-0.5">
              {quantity}× · <span className="text-gold font-bold">{brl(price)}</span>
            </div>
          </div>
        </div>

        {/* ──────── CROSS-SELL: "Combina com isso" ────────
            Estratégia: pega prioridade max do cliente — JÁ disse "sim" pra peça.
            Mostra 4 produtos com botão "+" pra adicionar sem sair do modal. */}
        {(loadingRelated || related.length > 0) && (
          <div className="mt-5">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4 text-gold" />
              <h4 className="text-sm font-black text-cream uppercase tracking-wider">
                Combina com isso
              </h4>
            </div>

            {loadingRelated ? (
              <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="shrink-0 w-28 h-40 rounded-xl bg-ink-700/50 shimmer" />
                ))}
              </div>
            ) : (
              <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 -mx-1 px-1 snap-x snap-mandatory">
                {related.slice(0, 4).map((p) => {
                  const isAdded = addedIds.has(p.id);
                  return (
                    <div
                      key={p.id}
                      className="snap-start shrink-0 w-28 bg-ink-900 rounded-xl overflow-hidden border border-ink-600 relative"
                    >
                      {/* Imagem clicável → vai pra página do produto */}
                      <Link href={`/produto/${p.slug}`} className="block">
                        <div className="aspect-[3/4] bg-ink-700">
                          {p.image && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={p.image} alt={p.name} className="w-full h-full object-cover" />
                          )}
                        </div>
                      </Link>
                      <div className="p-1.5">
                        <div className="text-[10px] font-bold text-cream line-clamp-2 leading-tight min-h-[1.8rem]">
                          {p.name}
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-1">
                          <span className="text-[11px] font-black text-gold tabular-nums">
                            {brl(p.price)}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!isAdded) handleQuickAdd(p);
                            }}
                            disabled={isAdded}
                            aria-label={isAdded ? 'Já adicionado' : 'Adicionar ao carrinho'}
                            className={`w-6 h-6 rounded-full flex items-center justify-center transition active:scale-90 ${
                              isAdded
                                ? 'bg-emerald-500 text-white'
                                : 'bg-gold text-ink hover:scale-110'
                            }`}
                          >
                            {isAdded ? <CheckCircle2 className="w-4 h-4" /> : <Plus className="w-3.5 h-3.5" strokeWidth={3} />}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* CTAs grandes */}
        <div className="mt-5 space-y-2">
          <button
            onClick={onCheckout}
            className="btn-gold-lg w-full"
          >
            <ShoppingCart className="w-5 h-5" />
            Finalizar compra
          </button>
          <button
            onClick={onContinue}
            className="w-full py-3.5 rounded-2xl bg-ink-700 hover:bg-ink-600 text-cream font-bold text-sm border border-ink-600"
          >
            Continuar comprando
          </button>
        </div>
      </div>
    </div>
  );
}
