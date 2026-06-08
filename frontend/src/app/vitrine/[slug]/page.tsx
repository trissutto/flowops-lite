'use client';

/**
 * /vitrine/[slug] — Página de DETALHE do produto (PDP).
 *
 * Conversão moda plus size: galeria grande (1ª impressão é visual), seletor
 * de tamanho CLARO (maior objeção do público — medo de não servir), preço
 * em destaque com % de desconto, parcelamento visível, CTA WhatsApp forte,
 * trust bar (troca grátis, frete, etc), descrição, e grade de relacionados
 * pra reter quem não converte no 1º produto.
 *
 * Fetch:
 *   - GET /public/vitrine/:slug → detalhe com images[], variations[], attributes[]
 *   - GET /public/vitrine/:slug/related → 8 produtos da mesma categoria
 *
 * Seletor de tamanho: lê de attributes[] o atributo com nome que case com
 * 'tamanho' / 'size'. Se variações existirem, mostra stock por variação
 * e bloqueia tamanho sem estoque.
 *
 * Imagens: thumbnails à esquerda (desktop) / carrossel horizontal (mobile).
 * Clique em thumb troca a imagem principal (state local activeImg).
 *
 * CTA "COMPRAR AGORA" abre WhatsApp pré-preenchido com nome+tamanho+link.
 * Número configurável via NEXT_PUBLIC_WHATSAPP_NUMBER (fallback 55...).
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ShoppingBag, Heart, ChevronLeft, ChevronRight, Star, Truck, Shield,
  Undo2, MessageCircle, Check, ZoomIn, Sparkles, Flame,
} from 'lucide-react';

function useApiBase(): string {
  const [base, setBase] = useState('http://localhost:3001');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const envUrl = process.env.NEXT_PUBLIC_API_URL;
    const host = window.location.hostname;
    const hostIsLocalhost = host === 'localhost' || host === '127.0.0.1';
    const envIsLocalhost = envUrl?.includes('localhost') || envUrl?.includes('127.0.0.1');
    if (envUrl && !envIsLocalhost) setBase(envUrl);
    else if (!hostIsLocalhost) setBase(`${window.location.protocol}//${host}:3001`);
    else setBase(envUrl || 'http://localhost:3001');
  }, []);
  return base;
}

type ProductImage = { src: string; alt?: string };
type Attribute = { name: string; options: string[] };
type Variation = {
  id: number;
  sku: string | null;
  price: number | null;
  regularPrice: number | null;
  salePrice: number | null;
  stockQuantity: number | null;
  stockStatus: string;
  attributes: { name: string; option: string }[];
  image?: ProductImage | null;
};

type ProductDetail = {
  id: number;
  name: string;
  slug: string;
  sku: string | null;
  type: string;
  permalink: string;
  price: number | null;
  regularPrice: number | null;
  salePrice: number | null;
  stockStatus: string;
  stockQuantity: number | null;
  totalSales: number;
  image: string | null;
  images: ProductImage[];
  attributes: Attribute[];
  variations: Variation[];
  description: string;
  shortDescription: string;
  categories: string[];
  dateModified: string;
};

type RelatedProduct = {
  id: number;
  name: string;
  slug: string;
  price: number | null;
  regularPrice: number | null;
  salePrice: number | null;
  image: string | null;
  totalSales: number;
};

const fmt = (n: number | null) =>
  n == null ? '' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Encontra o atributo de TAMANHO (tolerante a variações de nome)
function findSizeAttr(attrs: Attribute[]): Attribute | null {
  const m = attrs.find((a) =>
    /tamanho|size|talla/i.test(a.name),
  );
  return m ?? null;
}

// Verifica se um tamanho tem estoque (olha as variações)
function sizeHasStock(variations: Variation[], sizeAttrName: string, size: string): boolean {
  const vars = variations.filter((v) =>
    v.attributes.some(
      (a) => a.name.toLowerCase() === sizeAttrName.toLowerCase() && a.option === size,
    ),
  );
  if (vars.length === 0) return true; // sem variação cadastrada = assume ok
  return vars.some((v) => v.stockStatus === 'instock' && (v.stockQuantity ?? 1) > 0);
}

// Número do WhatsApp (configurável, fallback genérico)
function getWhatsAppNumber(): string {
  if (typeof window === 'undefined') return '5500000000000';
  return process.env.NEXT_PUBLIC_WHATSAPP_NUMBER || '5500000000000';
}

export default function ProductDetailPage() {
  const params = useParams();
  const slug = (params?.slug ?? '') as string;
  const apiBase = useApiBase();

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [related, setRelated] = useState<RelatedProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeImgIdx, setActiveImgIdx] = useState(0);
  const [selectedSize, setSelectedSize] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [zoomOpen, setZoomOpen] = useState(false);

  useEffect(() => {
    if (!apiBase || !slug) return;
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const [detRes, relRes] = await Promise.all([
          fetch(`${apiBase}/api/public/vitrine/${slug}`).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          }),
          fetch(`${apiBase}/api/public/vitrine/${slug}/related`)
            .then((r) => (r.ok ? r.json() : [])),
        ]);
        if (!alive) return;
        setProduct(detRes);
        setRelated(Array.isArray(relRes) ? relRes : []);
        setActiveImgIdx(0);
        setSelectedSize(null);
      } catch (e: any) {
        if (alive) setError(e?.message === 'HTTP 404' ? 'Produto não encontrado' : 'Erro ao carregar');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [apiBase, slug]);

  const sizeAttr = useMemo(
    () => (product ? findSizeAttr(product.attributes) : null),
    [product],
  );

  // Preço exibido — se tem tamanho selecionado e variação, usa da variação
  const currentPrice = useMemo(() => {
    if (!product) return { price: null, regular: null, sale: null };
    if (selectedSize && product.variations.length > 0) {
      const v = product.variations.find((x) =>
        x.attributes.some(
          (a) => sizeAttr && a.name.toLowerCase() === sizeAttr.name.toLowerCase() && a.option === selectedSize,
        ),
      );
      if (v) {
        return {
          price: v.price ?? product.price,
          regular: v.regularPrice ?? product.regularPrice,
          sale: v.salePrice ?? product.salePrice,
        };
      }
    }
    return {
      price: product.price,
      regular: product.regularPrice,
      sale: product.salePrice,
    };
  }, [product, selectedSize, sizeAttr]);

  const discountPct = useMemo(() => {
    const { regular, sale } = currentPrice;
    if (!regular || !sale || regular <= sale) return 0;
    return Math.round(((regular - sale) / regular) * 100);
  }, [currentPrice]);

  // Monta link WhatsApp
  function whatsappCTA() {
    if (!product) return '#';
    const num = getWhatsAppNumber();
    const size = selectedSize ? ` · Tamanho: ${selectedSize}` : '';
    const qty = quantity > 1 ? ` · Qtd: ${quantity}` : '';
    const url = typeof window !== 'undefined' ? window.location.href : '';
    const text = `Oi! Tenho interesse em: *${product.name}*${size}${qty}\n${url}`;
    return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
  }

  function handleBuy() {
    // Se tem tamanho como atributo e não selecionou, força selecionar
    if (sizeAttr && !selectedSize) {
      const el = document.getElementById('size-picker');
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.classList.add('ring-2', 'ring-pink-500', 'ring-offset-2');
      setTimeout(() => el?.classList.remove('ring-2', 'ring-pink-500', 'ring-offset-2'), 1500);
      return;
    }
    window.open(whatsappCTA(), '_blank', 'noopener,noreferrer');
  }

  // ------- RENDER -------
  if (loading) {
    return (
      <div className="min-h-screen bg-white">
        <TopMiniHeader />
        <div className="max-w-6xl mx-auto px-4 py-8 grid lg:grid-cols-2 gap-8 animate-pulse">
          <div className="aspect-[3/4] bg-slate-200 rounded-xl" />
          <div className="space-y-4">
            <div className="h-6 bg-slate-200 rounded w-3/4" />
            <div className="h-4 bg-slate-200 rounded w-1/4" />
            <div className="h-12 bg-slate-200 rounded w-1/2" />
            <div className="h-24 bg-slate-200 rounded" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="min-h-screen bg-white">
        <TopMiniHeader />
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <h1 className="text-2xl font-bold text-slate-800 mb-3">
            {error === 'Produto não encontrado' ? 'Produto não encontrado' : 'Ops, deu ruim'}
          </h1>
          <p className="text-slate-500 mb-6">
            {error === 'Produto não encontrado'
              ? 'Esse produto pode ter saído do ar ou o link está errado.'
              : 'Não conseguimos carregar esse produto agora. Tente de novo em alguns instantes.'}
          </p>
          <Link
            href="/vitrine"
            className="inline-flex items-center gap-2 px-6 py-3 bg-pink-600 text-white rounded-full font-semibold hover:bg-pink-700 transition"
          >
            <ChevronLeft className="w-4 h-4" /> Voltar pra vitrine
          </Link>
        </div>
      </div>
    );
  }

  const images = product.images.length > 0
    ? product.images
    : product.image
      ? [{ src: product.image }]
      : [];

  const mainImg = images[activeImgIdx]?.src ?? product.image ?? '';

  return (
    <div className="min-h-screen bg-white">
      <TopMiniHeader />

      {/* Breadcrumb */}
      <div className="border-b border-slate-100 bg-slate-50/50">
        <div className="max-w-6xl mx-auto px-4 py-2.5 text-xs text-slate-500 flex items-center gap-1.5 overflow-x-auto whitespace-nowrap">
          <Link href="/vitrine" className="hover:text-pink-600 transition">Home</Link>
          <ChevronRight className="w-3 h-3 shrink-0" />
          {product.categories[0] && (
            <>
              <span className="hover:text-pink-600 transition">{product.categories[0]}</span>
              <ChevronRight className="w-3 h-3 shrink-0" />
            </>
          )}
          <span className="text-slate-800 font-medium truncate">{product.name}</span>
        </div>
      </div>

      {/* Galeria + Info */}
      <div className="max-w-6xl mx-auto px-4 py-6 lg:py-10 grid lg:grid-cols-2 gap-6 lg:gap-10">
        {/* Galeria */}
        <div className="flex flex-col-reverse lg:flex-row gap-3">
          {/* Thumbs (coluna desktop, linha mobile) */}
          {images.length > 1 && (
            <div className="flex lg:flex-col gap-2 overflow-x-auto lg:overflow-y-auto lg:max-h-[600px] scrollbar-thin">
              {images.map((img, i) => (
                <button
                  key={i}
                  onClick={() => setActiveImgIdx(i)}
                  className={`w-16 h-20 lg:w-20 lg:h-24 shrink-0 rounded-lg overflow-hidden border-2 transition ${
                    i === activeImgIdx ? 'border-pink-500 ring-1 ring-pink-200' : 'border-slate-200 hover:border-slate-400'
                  }`}
                >
                  {img.src ? (
                    <img src={img.src} alt={img.alt ?? ''} className="w-full h-full object-cover" />
                  ) : null}
                </button>
              ))}
            </div>
          )}

          {/* Imagem principal */}
          <div className="flex-1 relative group">
            <div className="relative aspect-[3/4] bg-slate-100 rounded-xl overflow-hidden">
              {mainImg ? (
                <img
                  src={mainImg}
                  alt={product.name}
                  className="w-full h-full object-cover cursor-zoom-in"
                  onClick={() => setZoomOpen(true)}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-slate-400">Sem imagem</div>
              )}

              {/* Badges topo */}
              <div className="absolute top-3 left-3 flex flex-col gap-1.5">
                {discountPct > 0 && (
                  <span className="px-2.5 py-1 bg-red-600 text-white rounded-full text-xs font-bold shadow">
                    -{discountPct}%
                  </span>
                )}
                {product.totalSales > 50 && (
                  <span className="px-2.5 py-1 bg-amber-500 text-white rounded-full text-xs font-bold shadow flex items-center gap-1">
                    <Flame className="w-3 h-3" /> MAIS VENDIDO
                  </span>
                )}
              </div>

              {/* Setas galeria */}
              {images.length > 1 && (
                <>
                  <button
                    onClick={() => setActiveImgIdx((i) => (i - 1 + images.length) % images.length)}
                    className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 bg-white/90 hover:bg-white rounded-full shadow flex items-center justify-center transition"
                    aria-label="Imagem anterior"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <button
                    onClick={() => setActiveImgIdx((i) => (i + 1) % images.length)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 bg-white/90 hover:bg-white rounded-full shadow flex items-center justify-center transition"
                    aria-label="Próxima imagem"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </>
              )}

              {/* Zoom hint */}
              <button
                onClick={() => setZoomOpen(true)}
                className="absolute bottom-3 right-3 w-9 h-9 bg-white/90 hover:bg-white rounded-full shadow flex items-center justify-center transition opacity-0 group-hover:opacity-100"
                aria-label="Ampliar"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Info */}
        <div className="flex flex-col">
          {product.categories[0] && (
            <div className="text-xs uppercase tracking-wider text-pink-600 font-semibold mb-2">
              {product.categories[0]}
            </div>
          )}
          <h1 className="text-2xl lg:text-3xl font-bold text-slate-900 leading-tight mb-2">
            {product.name}
          </h1>

          {/* SKU + Reviews fake (social proof) */}
          <div className="flex items-center gap-3 text-sm text-slate-500 mb-4">
            {product.sku && <span>REF: {product.sku}</span>}
            <span className="flex items-center gap-1">
              {[1,2,3,4,5].map((i) => (
                <Star key={i} className="w-4 h-4 fill-amber-400 text-amber-400" />
              ))}
              <span className="text-slate-600 ml-1">4.9</span>
            </span>
          </div>

          {/* Preço */}
          <div className="mb-5">
            {currentPrice.regular && currentPrice.sale && currentPrice.regular > currentPrice.sale && (
              <div className="text-slate-400 line-through text-sm">{fmt(currentPrice.regular)}</div>
            )}
            <div className="flex items-baseline gap-3">
              <div className="text-3xl lg:text-4xl font-black text-pink-600">
                {fmt(currentPrice.price)}
              </div>
              {discountPct > 0 && (
                <div className="text-sm font-bold text-red-600">-{discountPct}% OFF</div>
              )}
            </div>
            {currentPrice.price && (
              <div className="text-sm text-slate-600 mt-1">
                ou <strong>12x de {fmt(currentPrice.price / 12)}</strong> sem juros no cartão
              </div>
            )}
            {currentPrice.price && (
              <div className="text-sm text-emerald-700 font-medium mt-1">
                💳 PIX: <strong>{fmt(currentPrice.price * 0.9)}</strong> com 10% OFF
              </div>
            )}
          </div>

          {/* Short description */}
          {product.shortDescription && (
            <div
              className="prose prose-sm text-slate-700 mb-5 max-w-none"
              dangerouslySetInnerHTML={{ __html: product.shortDescription }}
            />
          )}

          {/* Seletor de tamanho */}
          {sizeAttr && (
            <div id="size-picker" className="mb-5 p-4 border border-slate-200 rounded-xl transition">
              <div className="flex items-center justify-between mb-3">
                <label className="text-sm font-bold text-slate-800">
                  Tamanho: {selectedSize && <span className="text-pink-600">{selectedSize}</span>}
                </label>
                <button className="text-xs text-pink-600 hover:underline font-medium">
                  Guia de medidas
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {sizeAttr.options.map((sz) => {
                  const hasStock = sizeHasStock(product.variations, sizeAttr.name, sz);
                  const active = selectedSize === sz;
                  return (
                    <button
                      key={sz}
                      disabled={!hasStock}
                      onClick={() => setSelectedSize(sz)}
                      className={`min-w-[52px] px-3 py-2.5 text-sm font-semibold rounded-lg border-2 transition relative ${
                        active
                          ? 'bg-pink-600 text-white border-pink-600 shadow-md'
                          : hasStock
                            ? 'bg-white text-slate-800 border-slate-300 hover:border-pink-400 hover:bg-pink-50'
                            : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed line-through'
                      }`}
                    >
                      {sz}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Quantidade + CTA */}
          <div className="flex items-stretch gap-3 mb-5">
            <div className="flex items-center border-2 border-slate-300 rounded-xl overflow-hidden">
              <button
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                className="w-10 h-full text-lg font-bold hover:bg-slate-100 transition"
              >−</button>
              <span className="w-10 text-center font-bold">{quantity}</span>
              <button
                onClick={() => setQuantity((q) => q + 1)}
                className="w-10 h-full text-lg font-bold hover:bg-slate-100 transition"
              >+</button>
            </div>
            <button
              onClick={handleBuy}
              className="flex-1 bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-700 hover:to-rose-700 text-white font-black uppercase tracking-wider py-3.5 rounded-xl shadow-lg hover:shadow-xl transition flex items-center justify-center gap-2 text-sm"
            >
              <ShoppingBag className="w-5 h-5" />
              COMPRAR AGORA
            </button>
            <button
              className="w-12 shrink-0 border-2 border-slate-300 rounded-xl hover:border-pink-400 hover:bg-pink-50 transition flex items-center justify-center"
              aria-label="Favoritar"
            >
              <Heart className="w-5 h-5 text-slate-600" />
            </button>
          </div>

          {/* WhatsApp CTA secundária */}
          <a
            href={whatsappCTA()}
            target="_blank"
            rel="noopener noreferrer"
            className="mb-5 flex items-center justify-center gap-2 py-3 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-xl transition text-sm"
          >
            <MessageCircle className="w-4 h-4" />
            Tirar dúvidas no WhatsApp
          </a>

          {/* Trust icons */}
          <div className="grid grid-cols-2 gap-3 py-4 border-t border-slate-200">
            <TrustItem icon={Truck} title="Frete Grátis" sub="Acima de R$ 299" />
            <TrustItem icon={Undo2} title="Troca Grátis" sub="30 dias pra trocar" />
            <TrustItem icon={Shield} title="Compra Segura" sub="SSL + Site protegido" />
            <TrustItem icon={Check} title="Pagamento Fácil" sub="PIX, cartão, boleto" />
          </div>

          {/* Description full */}
          {product.description && (
            <div className="mt-6 pt-6 border-t border-slate-200">
              <h2 className="text-lg font-bold text-slate-800 mb-3">Descrição</h2>
              <div
                className="prose prose-sm text-slate-700 max-w-none"
                dangerouslySetInnerHTML={{ __html: product.description }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Relacionados */}
      {related.length > 0 && (
        <section className="bg-slate-50 border-t border-slate-200 py-10 lg:py-14">
          <div className="max-w-6xl mx-auto px-4">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl lg:text-2xl font-black text-slate-900 flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-pink-600" />
                Você também pode amar
              </h2>
              <Link href="/vitrine" className="text-sm font-semibold text-pink-600 hover:underline flex items-center gap-1">
                Ver tudo <ChevronRight className="w-4 h-4" />
              </Link>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 lg:gap-4">
              {related.slice(0, 8).map((r) => (
                <MiniCard key={r.id} p={r} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Zoom modal */}
      {zoomOpen && mainImg && (
        <div
          className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4 cursor-zoom-out"
          onClick={() => setZoomOpen(false)}
        >
          <img src={mainImg} alt={product.name} className="max-w-full max-h-full object-contain" />
          <button
            onClick={() => setZoomOpen(false)}
            className="absolute top-4 right-4 w-10 h-10 bg-white/20 hover:bg-white/30 rounded-full flex items-center justify-center text-white text-xl"
          >×</button>
        </div>
      )}

      {/* Bottom bar mobile (sticky CTA) */}
      <div className="lg:hidden sticky bottom-0 bg-white border-t border-slate-200 shadow-2xl p-3 flex items-center gap-2 z-30">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-slate-500 truncate">{product.name}</div>
          <div className="text-pink-600 font-bold text-sm">{fmt(currentPrice.price)}</div>
        </div>
        <button
          onClick={handleBuy}
          className="bg-gradient-to-r from-pink-600 to-rose-600 text-white font-bold px-5 py-3 rounded-xl text-sm shadow-lg flex items-center gap-1.5"
        >
          <ShoppingBag className="w-4 h-4" />
          COMPRAR
        </button>
      </div>
    </div>
  );
}

// ------- Subcomponentes -------

function TopMiniHeader() {
  return (
    <>
      <div className="bg-gradient-to-r from-pink-600 to-rose-600 text-white text-center text-xs sm:text-sm py-2 px-4 font-medium">
        🚚 FRETE GRÁTIS acima de R$ 500 · 💳 12x sem juros · 🎁 5% OFF no PIX
      </div>
      <header className="sticky top-0 bg-white border-b border-slate-200 z-40 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/vitrine" className="font-black text-lg tracking-tight">
            <span className="bg-gradient-to-r from-pink-600 to-rose-600 bg-clip-text text-transparent">
              LURDS
            </span>
          </Link>
          <Link
            href="/vitrine"
            className="text-sm font-semibold text-slate-600 hover:text-pink-600 transition flex items-center gap-1"
          >
            <ChevronLeft className="w-4 h-4" />
            Continuar comprando
          </Link>
        </div>
      </header>
    </>
  );
}

function TrustItem({ icon: Icon, title, sub }: { icon: any; title: string; sub: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="w-5 h-5 text-pink-600 shrink-0 mt-0.5" />
      <div>
        <div className="text-sm font-bold text-slate-800 leading-tight">{title}</div>
        <div className="text-[11px] text-slate-500">{sub}</div>
      </div>
    </div>
  );
}

function MiniCard({ p }: { p: RelatedProduct }) {
  const discount = p.regularPrice && p.salePrice && p.regularPrice > p.salePrice
    ? Math.round(((p.regularPrice - p.salePrice) / p.regularPrice) * 100)
    : 0;
  return (
    <Link
      href={`/vitrine/${p.slug}`}
      className="group bg-white rounded-xl overflow-hidden shadow-sm hover:shadow-lg transition"
    >
      <div className="relative aspect-[3/4] bg-slate-100 overflow-hidden">
        {p.image ? (
          <img
            src={p.image}
            alt={p.name}
            className="w-full h-full object-cover group-hover:scale-105 transition duration-500"
          />
        ) : (
          <div className="flex items-center justify-center h-full text-slate-300 text-xs">
            Sem imagem
          </div>
        )}
        {discount > 0 && (
          <span className="absolute top-2 left-2 px-2 py-0.5 bg-red-600 text-white text-[10px] font-bold rounded">
            -{discount}%
          </span>
        )}
      </div>
      <div className="p-3">
        <div className="text-xs text-slate-700 line-clamp-2 mb-1 min-h-[2rem]">
          {p.name}
        </div>
        <div className="flex items-baseline gap-2">
          <div className="text-pink-600 font-bold text-sm">{fmt(p.price)}</div>
          {discount > 0 && (
            <div className="text-[10px] text-slate-400 line-through">{fmt(p.regularPrice)}</div>
          )}
        </div>
      </div>
    </Link>
  );
}
