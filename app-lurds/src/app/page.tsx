'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Sparkles, Heart, Bell, ChevronRight, Tag, Tv, MapPin, Wallet, Loader2, ShoppingCart } from 'lucide-react';
import { HeroInstallCard } from '@/components/InstallBanner';
import AppGate from '@/components/AppGate';
import PushPrePrompt from '@/components/PushPrePrompt';
import BottomNav from '@/components/BottomNav';
import ProductCard from '@/components/ProductCard';
import AbandonedCartModal from '@/components/AbandonedCartModal';
import { useCart } from '@/contexts/CartContext';
import {
  getCategories, getProducts, getSizes, isLoggedIn, getCustomerFromToken, getFirstName,
  getUnreadNotificationsCount, getPreferredSize, setPreferredSize,
  type WcCategory, type WcProduct, type WcSize,
} from '@/lib/api';

export default function HomePage() {
  const [categories, setCategories] = useState<WcCategory[]>([]);
  const [highlights, setHighlights] = useState<WcProduct[]>([]);
  const [loadingHL, setLoadingHL] = useState(true);
  const [logged, setLogged] = useState(false);
  const [firstName, setFirstName] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const { itemCount } = useCart();

  // ── COMPRE POR TAMANHO ──
  const [sizes, setSizes] = useState<WcSize[]>([]);
  const [activeSize, setActiveSize] = useState<string | null>(null);

  // Lê tamanho salvo no localStorage e escuta mudanças globais
  useEffect(() => {
    setActiveSize(getPreferredSize());
    const onChange = (e: any) => setActiveSize(e?.detail?.size ?? null);
    window.addEventListener('lurds:size-changed', onChange);
    return () => window.removeEventListener('lurds:size-changed', onChange);
  }, []);

  // Carrega lista de tamanhos disponíveis (1 vez na home)
  useEffect(() => {
    getSizes()
      .then((r) => setSizes(r.sizes || []))
      .catch(() => setSizes([]));
  }, []);

  const handlePickSize = (slug: string) => {
    if (activeSize === slug) {
      // Click no mesmo tamanho desativa
      setPreferredSize(null);
    } else {
      setPreferredSize(slug);
    }
  };

  // Lê estado de login + nome do JWT (sem precisar bater na API)
  useEffect(() => {
    const isIn = isLoggedIn();
    setLogged(isIn);
    if (isIn) {
      const c = getCustomerFromToken();
      setFirstName(getFirstName(c?.name));
      // Busca contagem de notificações não lidas (hit leve)
      getUnreadNotificationsCount()
        .then((r) => setUnreadCount(r.count))
        .catch(() => null);
    }
  }, []);

  // Toast de boas-vindas se acabou de logar/cadastrar (?welcome=1)
  const [showWelcomeToast, setShowWelcomeToast] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('welcome') === '1') {
      setShowWelcomeToast(true);
      const t = setTimeout(() => setShowWelcomeToast(false), 4000);
      window.history.replaceState({}, '', window.location.pathname);
      return () => clearTimeout(t);
    }
  }, []);


  // Carrega categorias e destaques (em paralelo).
  // Destaques refazem fetch quando o tamanho preferido muda.
  useEffect(() => {
    setLoadingHL(true);
    Promise.all([
      getCategories().catch(() => ({ categories: [] })),
      getProducts({
        perPage: 10,
        orderby: 'popularity',
        size: activeSize || undefined,
      }).catch(() => ({ products: [] as WcProduct[] })),
    ]).then(([catsR, prodsR]) => {
      setCategories(catsR.categories.slice(0, 6));
      setHighlights(prodsR.products);
      setLoadingHL(false);
    });
  }, [activeSize]);

  // Mostrar pre-prompt push 1x após 4s na home (apenas pra logada)
  const [showGeneralPrompt, setShowGeneralPrompt] = useState(false);
  useEffect(() => {
    if (!logged) return;
    const t = setTimeout(() => setShowGeneralPrompt(true), 4000);
    return () => clearTimeout(t);
  }, [logged]);

  return (
    <AppGate>
    <div className="pb-24">
      {/* ── HEADER ── */}
      <header className="flex items-center justify-between px-5 pt-5">
        <Image
          src="/images/logo-branco.png"
          alt="Lurd's Plus Size"
          width={120} height={66}
          priority
          className="h-12 w-auto"
        />
        <div className="flex items-center gap-2">
          {/* CARRINHO — 50% maior + sempre destacado em dourado */}
          <Link
            href="/carrinho"
            aria-label="Carrinho"
            className={`relative p-3.5 rounded-full transition active:scale-95 ${
              itemCount > 0
                ? 'bg-gradient-to-br from-gold via-gold-light to-gold shadow-gold-lg ring-2 ring-gold/40'
                : 'bg-gradient-to-br from-gold/30 to-gold/10 border-2 border-gold/40'
            }`}
          >
            <ShoppingCart className={`w-9 h-9 ${itemCount > 0 ? 'text-ink' : 'text-gold'}`} strokeWidth={2.2} />
            {itemCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[24px] h-6 px-1.5 bg-rose-500 text-white text-xs font-black rounded-full flex items-center justify-center border-2 border-ink animate-pulse shadow-lg">
                {itemCount > 99 ? '99+' : itemCount}
              </span>
            )}
          </Link>

          {/* SINO */}
          <Link
            href="/notificacoes"
            aria-label="Notificações"
            className="relative p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition"
          >
            <Bell className="w-5 h-5 text-gold" />
            {unreadCount > 0 && (
              <span className="absolute top-0.5 right-0.5 min-w-[16px] h-4 px-1 bg-gold text-ink text-[9px] font-black rounded-full flex items-center justify-center">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </Link>
        </div>
      </header>

      {/* ── SAUDAÇÃO PERSONALIZADA — só quando logada ── */}
      {logged && firstName && (
        <div className="mt-4 px-5 animate-fade-in">
          <p className="font-serif text-2xl font-bold leading-tight">
            Olá, <span className="text-gold italic">{firstName}</span> 💛
          </p>
          <p className="text-xs text-cream/60 mt-0.5">
            Que bom te ver de novo!
          </p>
        </div>
      )}

      {/* ── CARD INSTALAR APP — GIGANTE, primeiro impacto visual ── */}
      <HeroInstallCard />

      {/* ── BANNER PRINCIPAL ── */}
      <section className="mt-6 px-5">
        <Link
          href="/catalogo?promo=1"
          className="block relative overflow-hidden rounded-3xl bg-gradient-to-br from-ink-800 via-ink to-ink-800 border border-gold/20 p-6 shadow-gold"
        >
          <div className="absolute inset-0 opacity-10"
               style={{ backgroundImage: 'radial-gradient(circle at 30% 30%, #C9A961 0%, transparent 50%)' }} />
          <div className="relative">
            <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-gold bg-gold/10 px-3 py-1 rounded-full mb-3">
              <Sparkles className="w-3 h-3" />
              Promoção
            </div>
            <h2 className="font-serif text-3xl font-bold text-white leading-tight">
              Inverno <span className="italic text-gold-gradient">Plus</span>
            </h2>
            <p className="mt-1 text-sm text-cream/70">
              Coleção nova com até 40% off — só no app
            </p>
            <div className="inline-flex items-center gap-1 mt-4 btn-gold">
              Ver coleção <ChevronRight className="w-4 h-4" />
            </div>
          </div>
        </Link>
      </section>

      {/* ── ATALHOS ── */}
      <section className="mt-7 px-5">
        <div className="grid grid-cols-4 gap-3">
          <QuickShortcut href="/cashback" icon={<Wallet className="w-5 h-5" />} label="Cashback" />
          <QuickShortcut href="/cupons" icon={<Tag className="w-5 h-5" />} label="Cupons" />
          <QuickShortcut href="/live" icon={<Tv className="w-5 h-5" />} label="Live" badge />
          <QuickShortcut href="/lojas" icon={<MapPin className="w-5 h-5" />} label="Lojas" />
        </div>
      </section>

      {/* ──────── COMPRE PELO SEU TAMANHO ────────
          Diferencial Lurd's: garantia de tamanho. Clica → filtra catálogo
          em tudo (home + /catalogo). Tamanho salvo no localStorage. */}
      {sizes.length > 0 && (
        <section className="mt-7 px-5">
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-gold/15 via-ink-800 to-ink-900 border border-gold/30 p-5">
            {/* Brilho decorativo */}
            <div
              className="absolute -top-10 -right-10 w-32 h-32 bg-gold/20 rounded-full blur-2xl"
              aria-hidden
            />
            <div className="relative">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-gold bg-gold/10 px-2 py-1 rounded-full mb-2">
                    <Sparkles className="w-3 h-3" />
                    Compre pelo seu tamanho
                  </div>
                  <h3 className="font-serif text-lg font-bold leading-tight">
                    {activeSize ? (
                      <>Filtrando peças do <span className="text-gold italic">tamanho {activeSize}</span></>
                    ) : (
                      <>Atendemos do <span className="text-gold italic">46 ao 60</span></>
                    )}
                  </h3>
                  <p className="text-[11px] text-cream/60 mt-0.5">
                    {activeSize
                      ? 'Mostramos só o que tem disponível pra você 💛'
                      : 'Toque no seu tamanho e veja só as peças disponíveis'}
                  </p>
                </div>
                {activeSize && (
                  <button
                    onClick={() => setPreferredSize(null)}
                    className="shrink-0 text-[10px] text-cream/60 underline whitespace-nowrap"
                  >
                    Limpar
                  </button>
                )}
              </div>

              {/* Chips de tamanhos — scroll horizontal */}
              <div className="mt-3 flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
                {sizes.map((s) => {
                  const isActive = activeSize === s.slug || activeSize === s.name;
                  return (
                    <button
                      key={s.id}
                      onClick={() => handlePickSize(s.slug)}
                      className={`shrink-0 min-w-[52px] h-12 rounded-2xl font-black text-base transition active:scale-95 ${
                        isActive
                          ? 'bg-gold text-ink shadow-gold-lg ring-2 ring-gold/40 scale-105'
                          : 'bg-ink-700 text-cream border border-ink-600 hover:border-gold/50'
                      }`}
                      aria-label={`Tamanho ${s.name}`}
                    >
                      {s.name}
                    </button>
                  );
                })}
              </div>

              {/* Botão "ver tudo" se tamanho ativo */}
              {activeSize && (
                <Link
                  href={`/catalogo?tamanho=${encodeURIComponent(activeSize)}`}
                  className="mt-3 inline-flex items-center gap-1 text-xs font-black text-gold uppercase tracking-wider"
                >
                  Ver todas do tamanho {activeSize}
                  <ChevronRight className="w-4 h-4" />
                </Link>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── DESTAQUES (REAL DO WC) ── */}
      <section className="mt-8">
        <div className="flex items-center justify-between px-5 mb-3">
          <h3 className="font-serif text-xl font-bold">
            {activeSize ? (
              <>Destaques <span className="text-gold italic">tam. {activeSize}</span></>
            ) : (
              'Destaques da semana'
            )}
          </h3>
          <Link
            href={activeSize ? `/catalogo?tamanho=${encodeURIComponent(activeSize)}` : '/catalogo'}
            className="text-xs text-gold font-bold uppercase tracking-wider"
          >
            Ver todos
          </Link>
        </div>
        {loadingHL ? (
          <div className="flex gap-3 overflow-x-auto no-scrollbar px-5 pb-2">
            {[1,2,3,4,5].map(i => (
              <div key={i} className="snap-start shrink-0 w-40 rounded-2xl overflow-hidden bg-ink-800 border border-ink-600">
                <div className="aspect-[3/4] shimmer" />
                <div className="p-2">
                  <div className="h-3 w-3/4 rounded shimmer mb-1.5" />
                  <div className="h-4 w-1/2 rounded shimmer" />
                </div>
              </div>
            ))}
          </div>
        ) : highlights.length === 0 ? (
          <div className="px-5 text-sm text-cream/50">
            Em breve produtos por aqui. Enquanto isso, visita o{' '}
            <a href="https://lurds.com.br" target="_blank" rel="noopener" className="text-gold underline">
              lurds.com.br
            </a>.
          </div>
        ) : (
          <div className="flex gap-3 overflow-x-auto no-scrollbar px-5 pb-2 snap-x snap-mandatory">
            {highlights.map((p) => (
              <div key={p.id} className="snap-start shrink-0 w-40">
                <ProductCard product={p} compact />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── BANNER R$ 20 (só se não logado) ── */}
      {!logged && (
        <section className="mt-8 px-5">
          <Link
            href="/cadastro"
            className="block relative overflow-hidden rounded-3xl bg-gradient-to-br from-gold via-gold-light to-gold p-6 text-ink"
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-widest opacity-80">
                  Bem-vinda 💛
                </div>
                <h3 className="font-serif text-2xl font-black mt-1 leading-tight">
                  R$ 20 grátis
                </h3>
                <p className="text-sm mt-1 opacity-90">
                  Cadastre-se e ganhe na primeira compra
                </p>
                <span className="inline-flex items-center gap-1 mt-3 text-sm font-bold uppercase tracking-wider border-b border-ink/40">
                  Pegar meu bônus
                  <ChevronRight className="w-4 h-4" />
                </span>
              </div>
              <Heart className="w-16 h-16 fill-ink/10 stroke-ink/30 shrink-0" />
            </div>
          </Link>
        </section>
      )}

      {/* ── CATEGORIAS REAIS WC ── */}
      <section className="mt-8 px-5">
        <h3 className="font-serif text-xl font-bold mb-3">Por categoria</h3>
        {categories.length === 0 ? (
          <div className="card-dark text-sm text-cream/50 text-center py-6">
            Categorias indisponíveis no momento.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {categories.map((c) => (
              <Link
                key={c.id}
                href={`/catalogo?cat=${c.slug}`}
                className="card-dark flex items-center gap-3 hover:border-gold/50 transition"
              >
                {c.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.image} alt={c.name} className="w-12 h-12 rounded-lg object-cover" />
                ) : (
                  <span className="text-2xl">👗</span>
                )}
                <div className="flex-1 min-w-0">
                  <span className="font-semibold block truncate">{c.name}</span>
                  <span className="text-[10px] text-cream/40">{c.count} peças</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <div className="h-20" />
      <BottomNav />
      {showGeneralPrompt && (
        <PushPrePrompt
          context="general"
          reward="Te avisamos em primeira mão quando rolar promoção de verdade e quando começar live com descontos. 💛"
          onClose={() => setShowGeneralPrompt(false)}
        />
      )}
      {/* Modal cupom relâmpago — só aparece com carrinho abandonado > 60min */}
      <AbandonedCartModal />
    </div>
    </AppGate>
  );
}

function QuickShortcut({ href, icon, label, badge }: {
  href: string; icon: React.ReactNode; label: string; badge?: boolean;
}) {
  return (
    <Link
      href={href}
      className="relative flex flex-col items-center gap-1.5 p-3 bg-ink-800 border border-ink-600 rounded-2xl hover:border-gold/50 transition touch-tap"
    >
      <div className="text-gold">{icon}</div>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-cream/80">
        {label}
      </span>
      {badge && (
        <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full animate-pulse" />
      )}
    </Link>
  );
}
