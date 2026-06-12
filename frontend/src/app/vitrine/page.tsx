'use client';

/**
 * /vitrine — Home pública simulada (ecommerce de moda plus size).
 *
 * Objetivo: testar diagramação de alta conversão com os produtos reais do WC,
 * dentro do próprio projeto LURDS ORDER ONE. Roda sem login (endpoint público
 * /public/vitrine no backend) pra parecer com a experiência do cliente final.
 *
 * Estrutura (ordem decrescente de prioridade de conversão):
 *   1. TOP BAR de urgência/benefício (frete grátis, parcelamento)
 *   2. HEADER com logo + busca + ícones
 *   3. HERO grande com proposta de valor + CTA forte
 *   4. TRUST BAR (pagamento, troca, atendimento)
 *   5. BARRA DE CATEGORIAS (chips clicáveis)
 *   6. SECTION "MAIS VENDIDAS" (ordem por totalSales)
 *   7. SECTION "NOVIDADES" (ordem por dateModified/date)
 *   8. CTA de captura (cupom por WhatsApp)
 *   9. FOOTER com trust signals, pagamento, contato
 *
 * Layout:
 *   - Grid responsivo: 2 colunas mobile → 3 tablet → 4 desktop (e-commerce padrão)
 *   - Card com imagem QUADRADA grande, badge de promoção/novidade, preço destaque
 *   - Tipografia forte em preto/rosa (chamativo pra público feminino plus size)
 *
 * NÃO exibe SideNav/TopNav (escondido via check em layout / hide na página).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Search, ShoppingBag, User, Heart, Menu, Truck, Shield, Undo2,
  MessageCircle, Star, Flame, Sparkles, ChevronRight, Instagram, Facebook,
} from 'lucide-react';

// Configuração: se quiser trocar a URL pra sua matriz local, ajuste aqui.
// A api.ts já resolve dinamicamente, mas esta página NÃO usa JWT — bate
// direto no endpoint público /api/public/vitrine.
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

type Product = {
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
  categories: string[];
  dateModified: string;
};

// Formatação de preço BR (R$ 189,90)
const fmt = (n: number | null) =>
  n == null ? '' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function VitrinePage() {
  const apiBase = useApiBase();
  const [bestsellers, setBestsellers] = useState<Product[]>([]);
  const [novidades, setNovidades] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [activeCat, setActiveCat] = useState<string | null>(null);

  // Busca 2 chamadas em paralelo: mais vendidos + novidades
  useEffect(() => {
    if (!apiBase) return;
    setLoading(true);
    setErr(null);
    Promise.all([
      fetch(`${apiBase}/api/public/vitrine?per_page=12&orderby=sales`).then((r) => r.json()),
      fetch(`${apiBase}/api/public/vitrine?per_page=24&orderby=date`).then((r) => r.json()),
    ])
      .then(([bs, nv]) => {
        setBestsellers(bs?.data ?? []);
        setNovidades(nv?.data ?? []);
      })
      .catch((e) => setErr(e?.message ?? 'Falha ao carregar catálogo'))
      .finally(() => setLoading(false));
  }, [apiBase]);

  // Extrai categorias únicas (top 8) pras chips
  const allCats = Array.from(
    new Set([...bestsellers, ...novidades].flatMap((p) => p.categories ?? [])),
  ).filter(Boolean).slice(0, 8);

  // Filtra por categoria quando selecionada
  const filter = (list: Product[]) =>
    activeCat ? list.filter((p) => p.categories?.includes(activeCat)) : list;

  return (
    <div className="min-h-screen bg-white">
      {/* ═══ 1. TOP BAR URGÊNCIA ═══ */}
      <div className="bg-gradient-to-r from-pink-600 via-rose-600 to-pink-600 text-white text-xs md:text-sm font-medium text-center py-2 px-4">
        <span className="inline-flex items-center gap-1.5">
          <Flame className="w-3.5 h-3.5" />
          FRETE GRÁTIS ACIMA DE R$ 500 · 5% OFF no PIX · Parcele em até 12x sem juros
        </span>
      </div>

      {/* ═══ 2. HEADER ═══ */}
      <header className="sticky top-0 z-40 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4">
          <button className="md:hidden p-2 -ml-2" aria-label="Menu">
            <Menu className="w-6 h-6 text-slate-700" />
          </button>
          <Link href="/vitrine" className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-pink-500 to-rose-600 flex items-center justify-center text-white font-black text-lg shadow">
              L
            </div>
            <div className="hidden sm:block">
              <div className="font-black text-slate-900 text-lg leading-none tracking-tight">
                LURD&apos;S
              </div>
              <div className="text-[10px] text-pink-600 font-bold tracking-[0.2em] uppercase leading-none mt-0.5">
                Plus Size
              </div>
            </div>
          </Link>

          {/* Busca (desktop) */}
          <div className="flex-1 hidden md:block max-w-xl mx-auto">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="O que você está procurando?"
                className="w-full pl-11 pr-4 py-2.5 bg-slate-100 border border-transparent hover:border-slate-300 focus:border-pink-400 focus:bg-white rounded-full text-sm outline-none transition"
              />
            </div>
          </div>

          <div className="flex items-center gap-1 ml-auto">
            <button className="p-2 hover:bg-slate-100 rounded-full" aria-label="Buscar">
              <Search className="w-5 h-5 text-slate-700 md:hidden" />
            </button>
            <button className="p-2 hover:bg-slate-100 rounded-full hidden sm:block" aria-label="Minha conta">
              <User className="w-5 h-5 text-slate-700" />
            </button>
            <button className="p-2 hover:bg-slate-100 rounded-full hidden sm:block" aria-label="Favoritos">
              <Heart className="w-5 h-5 text-slate-700" />
            </button>
            <button className="relative p-2 hover:bg-slate-100 rounded-full" aria-label="Carrinho">
              <ShoppingBag className="w-5 h-5 text-slate-700" />
              <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-pink-600 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                0
              </span>
            </button>
          </div>
        </div>

        {/* Barra secundária com categorias em destaque (desktop) */}
        <nav className="hidden md:block border-t border-slate-100 bg-white">
          <div className="max-w-7xl mx-auto px-4 flex items-center gap-6 text-sm font-medium text-slate-700 overflow-x-auto py-2.5">
            <a className="hover:text-pink-600 whitespace-nowrap cursor-pointer">Lançamentos</a>
            <a className="hover:text-pink-600 whitespace-nowrap cursor-pointer">Vestidos</a>
            <a className="hover:text-pink-600 whitespace-nowrap cursor-pointer">Blusas</a>
            <a className="hover:text-pink-600 whitespace-nowrap cursor-pointer">Calças</a>
            <a className="hover:text-pink-600 whitespace-nowrap cursor-pointer">Saias</a>
            <a className="hover:text-pink-600 whitespace-nowrap cursor-pointer">Macacões</a>
            <a className="hover:text-pink-600 whitespace-nowrap cursor-pointer">Praia</a>
            <a className="hover:text-pink-600 whitespace-nowrap cursor-pointer">Acessórios</a>
            <a className="text-rose-700 font-bold whitespace-nowrap hover:text-rose-900 cursor-pointer">
              OFERTAS ↗
            </a>
          </div>
        </nav>
      </header>

      {/* ═══ 3. HERO ═══ */}
      <section className="relative bg-gradient-to-br from-pink-50 via-rose-50 to-amber-50 overflow-hidden">
        <div className="absolute inset-0 opacity-20 pointer-events-none"
             style={{ backgroundImage: 'radial-gradient(circle at 20% 20%, #f472b6 0%, transparent 40%), radial-gradient(circle at 80% 80%, #fbbf24 0%, transparent 40%)' }} />
        <div className="relative max-w-7xl mx-auto px-4 py-12 md:py-20 grid md:grid-cols-2 gap-8 items-center">
          <div>
            <span className="inline-block px-3 py-1 bg-white/80 backdrop-blur text-pink-700 text-xs font-bold rounded-full shadow-sm mb-4 uppercase tracking-wider">
              Coleção Outono/Inverno 2026
            </span>
            <h1 className="text-4xl md:text-6xl font-black text-slate-900 leading-tight tracking-tight">
              Moda que
              <br />
              <span className="bg-gradient-to-r from-pink-600 to-rose-600 bg-clip-text text-transparent">
                veste seu jeito.
              </span>
            </h1>
            <p className="mt-5 text-lg text-slate-700 max-w-md leading-relaxed">
              Do 44 ao 60. Peças que cabem no seu corpo e no seu estilo —
              com a qualidade e o caimento que você merece.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3">
              <a href="#bestsellers" className="inline-flex items-center justify-center gap-2 px-8 py-4 bg-slate-900 hover:bg-pink-600 text-white font-bold rounded-full shadow-lg hover:shadow-xl transition transform hover:scale-105">
                COMPRAR AGORA
                <ChevronRight className="w-5 h-5" />
              </a>
              <a href="#novidades" className="inline-flex items-center justify-center gap-2 px-8 py-4 bg-white hover:bg-slate-100 text-slate-900 font-bold rounded-full border-2 border-slate-900 transition">
                Ver novidades
              </a>
            </div>
            <div className="mt-8 flex items-center gap-6 text-sm">
              <div className="flex items-center gap-1">
                <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
                <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
                <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
                <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
                <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
                <span className="ml-1 text-slate-700 font-semibold">4.9</span>
              </div>
              <span className="text-slate-600 font-medium">+50 mil clientes felizes</span>
            </div>
          </div>

          {/* Visual: mosaico de produtos ao vivo (4 bestsellers) */}
          <div className="grid grid-cols-2 gap-3 md:gap-4">
            {bestsellers.slice(0, 4).map((p, i) => (
              <div
                key={p.id}
                className={`relative aspect-[3/4] rounded-2xl overflow-hidden shadow-xl bg-slate-100 ${
                  i === 0 ? 'md:translate-y-6' : ''
                } ${i === 3 ? 'md:translate-y-6' : ''}`}
              >
                {p.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.image}
                    alt={p.name}
                    className="w-full h-full object-cover hover:scale-110 transition-transform duration-500"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-4xl text-slate-300">
                    👗
                  </div>
                )}
                <div className="absolute top-2 left-2">
                  <span className="bg-rose-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow">
                    TOP {i + 1}
                  </span>
                </div>
              </div>
            ))}
            {bestsellers.length === 0 && !loading && (
              <div className="col-span-2 aspect-[3/2] rounded-2xl bg-white/50 flex items-center justify-center text-slate-400">
                Sem produtos disponíveis
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ═══ 4. TRUST BAR ═══ */}
      <section className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 py-5 grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { icon: Truck, title: 'Frete Grátis', sub: 'Acima de R$ 299' },
            { icon: Shield, title: 'Compra Segura', sub: 'Site blindado SSL' },
            { icon: Undo2, title: 'Troca Fácil', sub: '30 dias garantidos' },
            { icon: MessageCircle, title: 'Atendimento', sub: 'WhatsApp 9h-20h' },
          ].map((t, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-pink-50 flex items-center justify-center">
                <t.icon className="w-5 h-5 text-pink-600" />
              </div>
              <div>
                <div className="font-bold text-slate-900 text-sm">{t.title}</div>
                <div className="text-xs text-slate-600">{t.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ═══ 5. CATEGORIAS ═══ */}
      {allCats.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 py-8">
          <div className="flex items-center gap-2 overflow-x-auto pb-2 -mx-4 px-4">
            <button
              onClick={() => setActiveCat(null)}
              className={`whitespace-nowrap px-5 py-2.5 rounded-full text-sm font-bold transition shadow-sm ${
                !activeCat
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-700 border border-slate-200 hover:border-slate-400'
              }`}
            >
              TUDO
            </button>
            {allCats.map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCat(cat)}
                className={`whitespace-nowrap px-5 py-2.5 rounded-full text-sm font-semibold transition shadow-sm ${
                  activeCat === cat
                    ? 'bg-pink-600 text-white'
                    : 'bg-white text-slate-700 border border-slate-200 hover:border-pink-300'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ═══ 6. MAIS VENDIDAS ═══ */}
      <section id="bestsellers" className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex items-end justify-between mb-6">
          <div>
            <span className="inline-flex items-center gap-1 text-pink-600 text-xs font-bold uppercase tracking-widest mb-1">
              <Flame className="w-3.5 h-3.5" />
              Queridinhas
            </span>
            <h2 className="text-2xl md:text-3xl font-black text-slate-900 tracking-tight">
              MAIS VENDIDAS DA SEMANA
            </h2>
          </div>
          <a className="text-sm font-bold text-pink-600 hover:text-pink-800 hidden md:flex items-center gap-1 cursor-pointer">
            Ver todos <ChevronRight className="w-4 h-4" />
          </a>
        </div>
        {loading && <GridSkeleton />}
        {err && <ErrorBox msg={err} />}
        {!loading && !err && (
          <ProductGrid products={filter(bestsellers)} badgeVariant="bestseller" />
        )}
      </section>

      {/* ═══ 7. FAIXA DE DESTAQUE ═══ */}
      <section className="bg-slate-900 text-white my-12">
        <div className="max-w-7xl mx-auto px-4 py-12 md:py-16 grid md:grid-cols-3 gap-8 items-center">
          <div className="md:col-span-2">
            <span className="text-pink-400 text-xs font-bold uppercase tracking-widest">
              Exclusivo online
            </span>
            <h3 className="text-3xl md:text-4xl font-black mt-2 leading-tight">
              Primeira compra?
              <br />
              <span className="text-pink-400">Ganhe 15% OFF</span>
            </h3>
            <p className="mt-3 text-slate-300 max-w-lg">
              Manda um oi no nosso WhatsApp e a gente te envia o cupom exclusivo
              de boas-vindas + acesso antecipado às novidades.
            </p>
          </div>
          <div>
            <a
              href="https://wa.me/5511999999999?text=Oi!%20Quero%20meu%20cupom%20de%20boas-vindas"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 px-6 py-4 bg-green-500 hover:bg-green-600 text-white font-bold rounded-full shadow-xl transition"
            >
              <MessageCircle className="w-5 h-5" />
              Falar no WhatsApp
            </a>
          </div>
        </div>
      </section>

      {/* ═══ 8. NOVIDADES ═══ */}
      <section id="novidades" className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex items-end justify-between mb-6">
          <div>
            <span className="inline-flex items-center gap-1 text-pink-600 text-xs font-bold uppercase tracking-widest mb-1">
              <Sparkles className="w-3.5 h-3.5" />
              Acabou de chegar
            </span>
            <h2 className="text-2xl md:text-3xl font-black text-slate-900 tracking-tight">
              NOVIDADES DA SEMANA
            </h2>
          </div>
        </div>
        {loading && <GridSkeleton />}
        {!loading && !err && (
          <ProductGrid products={filter(novidades)} badgeVariant="new" />
        )}
      </section>

      {/* ═══ 9. FOOTER ═══ */}
      <footer className="bg-slate-950 text-slate-300 mt-16">
        <div className="max-w-7xl mx-auto px-4 py-12 grid md:grid-cols-4 gap-8">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-pink-500 to-rose-600 flex items-center justify-center text-white font-black">
                L
              </div>
              <div>
                <div className="font-black text-white text-lg leading-none">LURD&apos;S</div>
                <div className="text-[10px] text-pink-400 font-bold tracking-[0.2em] uppercase">
                  Plus Size
                </div>
              </div>
            </div>
            <p className="text-sm text-slate-400 leading-relaxed">
              Moda plus size feita pra mulher real. Do 44 ao 60, com carinho e qualidade.
            </p>
            <div className="mt-4 flex gap-3">
              <a className="w-9 h-9 rounded-full bg-slate-800 hover:bg-pink-600 flex items-center justify-center transition cursor-pointer">
                <Instagram className="w-4 h-4" />
              </a>
              <a className="w-9 h-9 rounded-full bg-slate-800 hover:bg-pink-600 flex items-center justify-center transition cursor-pointer">
                <Facebook className="w-4 h-4" />
              </a>
              <a className="w-9 h-9 rounded-full bg-slate-800 hover:bg-green-600 flex items-center justify-center transition cursor-pointer">
                <MessageCircle className="w-4 h-4" />
              </a>
            </div>
          </div>
          <div>
            <h4 className="font-bold text-white mb-3 text-sm uppercase tracking-wider">Institucional</h4>
            <ul className="space-y-2 text-sm">
              <li><a className="hover:text-white cursor-pointer">Sobre nós</a></li>
              <li><a className="hover:text-white cursor-pointer">Nossas lojas</a></li>
              <li><a className="hover:text-white cursor-pointer">Trabalhe conosco</a></li>
              <li><a className="hover:text-white cursor-pointer">Blog</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-bold text-white mb-3 text-sm uppercase tracking-wider">Ajuda</h4>
            <ul className="space-y-2 text-sm">
              <li><a className="hover:text-white cursor-pointer">Central de atendimento</a></li>
              <li><a className="hover:text-white cursor-pointer">Trocas e devoluções</a></li>
              <li><a className="hover:text-white cursor-pointer">Formas de pagamento</a></li>
              <li><a className="hover:text-white cursor-pointer">Prazos de entrega</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-bold text-white mb-3 text-sm uppercase tracking-wider">Receba novidades</h4>
            <p className="text-sm text-slate-400 mb-3">
              Cupons e lançamentos antes de todo mundo.
            </p>
            <form className="flex gap-2" onSubmit={(e) => e.preventDefault()}>
              <input
                type="email"
                placeholder="seu@email.com"
                className="flex-1 px-3 py-2 rounded bg-slate-800 text-white text-sm border border-slate-700 focus:border-pink-500 outline-none"
              />
              <button type="submit" className="px-4 py-2 bg-pink-600 hover:bg-pink-700 rounded text-white text-sm font-bold">
                OK
              </button>
            </form>
          </div>
        </div>
        <div className="border-t border-slate-800">
          <div className="max-w-7xl mx-auto px-4 py-5 flex flex-col md:flex-row items-center justify-between gap-3 text-xs text-slate-500">
            <span>© 2026 Lurd&apos;s Plus Size. Todos os direitos reservados.</span>
            <span>CNPJ 00.000.000/0001-00 · contato@lurds.com.br</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// COMPONENTES AUXILIARES
// ───────────────────────────────────────────────────────────────────────

function ProductGrid({
  products,
  badgeVariant,
}: {
  products: Product[];
  badgeVariant: 'bestseller' | 'new';
}) {
  if (products.length === 0) {
    return (
      <div className="py-12 text-center text-slate-500">
        Nenhum produto encontrado nessa seleção.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-5">
      {products.map((p, i) => (
        <ProductCard key={p.id} p={p} index={i} variant={badgeVariant} />
      ))}
    </div>
  );
}

function ProductCard({
  p,
  index,
  variant,
}: {
  p: Product;
  index: number;
  variant: 'bestseller' | 'new';
}) {
  const onSale = !!(p.salePrice && p.regularPrice && p.salePrice < p.regularPrice);
  const discount = onSale
    ? Math.round(((p.regularPrice! - p.salePrice!) / p.regularPrice!) * 100)
    : 0;
  const lowStock = p.stockQuantity != null && p.stockQuantity > 0 && p.stockQuantity <= 3;

  return (
    <Link
      href={`/vitrine/${p.slug}`}
      className="group block bg-white rounded-2xl overflow-hidden hover:shadow-xl transition-all duration-300"
    >
      <div className="relative aspect-[3/4] bg-slate-100 overflow-hidden">
        {p.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={p.image}
            alt={p.name}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-5xl text-slate-300">
            👗
          </div>
        )}

        {/* Badges superiores */}
        <div className="absolute top-2 left-2 flex flex-col gap-1">
          {onSale && (
            <span className="bg-rose-600 text-white text-[10px] font-black px-2 py-1 rounded-full shadow-md">
              -{discount}%
            </span>
          )}
          {variant === 'bestseller' && index < 3 && (
            <span className="bg-amber-500 text-white text-[10px] font-bold px-2 py-1 rounded-full shadow-md flex items-center gap-0.5">
              <Flame className="w-2.5 h-2.5" />
              TOP {index + 1}
            </span>
          )}
          {variant === 'new' && index < 4 && !onSale && (
            <span className="bg-emerald-600 text-white text-[10px] font-bold px-2 py-1 rounded-full shadow-md">
              NOVO
            </span>
          )}
          {lowStock && (
            <span className="bg-orange-600 text-white text-[10px] font-bold px-2 py-1 rounded-full shadow-md">
              ÚLTIMAS {p.stockQuantity}!
            </span>
          )}
        </div>

        {/* Favorito */}
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          className="absolute top-2 right-2 w-8 h-8 bg-white/90 hover:bg-pink-600 hover:text-white rounded-full flex items-center justify-center shadow-md transition"
          aria-label="Favoritar"
        >
          <Heart className="w-4 h-4" />
        </button>

        {/* CTA que desliza no hover (desktop) */}
        <div className="hidden md:flex absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-12 pb-3 px-3 opacity-0 group-hover:opacity-100 transition-opacity">
          <button className="w-full bg-white text-slate-900 font-bold text-xs py-2.5 rounded-full hover:bg-pink-600 hover:text-white transition">
            COMPRAR AGORA
          </button>
        </div>
      </div>

      <div className="p-3 md:p-4">
        {/* Categoria */}
        {p.categories?.[0] && (
          <div className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">
            {p.categories[0]}
          </div>
        )}
        {/* Nome — limite de 2 linhas */}
        <h3 className="text-sm font-semibold text-slate-900 line-clamp-2 leading-snug min-h-[2.5rem]">
          {p.name}
        </h3>

        {/* Preço */}
        <div className="mt-2 flex items-baseline gap-2 flex-wrap">
          {onSale ? (
            <>
              <span className="text-lg font-black text-rose-600">{fmt(p.salePrice)}</span>
              <span className="text-xs text-slate-400 line-through">{fmt(p.regularPrice)}</span>
            </>
          ) : (
            <span className="text-lg font-black text-slate-900">{fmt(p.price)}</span>
          )}
        </div>
        {/* Parcelas */}
        {(p.salePrice ?? p.price) && (
          <div className="mt-0.5 text-[11px] text-slate-600">
            ou 12x de {fmt(((p.salePrice ?? p.price ?? 0) / 12))} sem juros
          </div>
        )}
      </div>
    </Link>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-5">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="bg-white rounded-2xl overflow-hidden">
          <div className="aspect-[3/4] bg-slate-200 animate-pulse" />
          <div className="p-4 space-y-2">
            <div className="h-3 bg-slate-200 rounded animate-pulse w-1/3" />
            <div className="h-4 bg-slate-200 rounded animate-pulse w-5/6" />
            <div className="h-4 bg-slate-200 rounded animate-pulse w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="p-6 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
      <strong>Erro ao carregar produtos:</strong> {msg}
      <div className="mt-2 text-xs text-red-600">
        Verifique se o backend está rodando em <code>localhost:3001</code> e se
        o WooCommerce retornou produtos (rodou o sync?).
      </div>
    </div>
  );
}
