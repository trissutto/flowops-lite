'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Sparkles, Heart, Bell, ChevronRight, Tag, Tv, MapPin, Wallet } from 'lucide-react';
import InstallBanner from '@/components/InstallBanner';
import BottomNav from '@/components/BottomNav';

/**
 * HOME do app Lurd's — primeira impressão da cliente.
 *
 * Estrutura:
 *  - Header com logo + sino notificação
 *  - Banner promo principal (rotativo no futuro — mock por ora)
 *  - Atalhos rápidos (Cashback, Catálogo, Live, Lojas)
 *  - Destaques da semana (carrossel horizontal)
 *  - Banner R$ 20 (se não logada ou não fez 1ª compra)
 *  - Bottom Nav fixa
 *  - Banner Install (smart — só mostra se ainda não instalou)
 */
export default function HomePage() {
  const [showInstallBanner, setShowInstallBanner] = useState(false);

  useEffect(() => {
    // Mostra banner de instalação após 5s na home (não interrompe primeira navegação)
    const t = setTimeout(() => setShowInstallBanner(true), 5000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="pb-24">
      {/* ── HEADER ── */}
      <header className="flex items-center justify-between px-5 pt-5">
        <Image
          src="/images/logo-branco.png"
          alt="Lurd's Plus Size"
          width={120}
          height={66}
          priority
          className="h-12 w-auto"
        />
        <Link
          href="/notificacoes"
          aria-label="Notificações"
          className="relative p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition"
        >
          <Bell className="w-5 h-5 text-gold" />
          <span className="absolute top-1 right-1 w-2 h-2 bg-gold rounded-full" />
        </Link>
      </header>

      {/* ── BANNER PRINCIPAL ── */}
      <section className="mt-6 px-5">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-ink-800 via-ink to-ink-800 border border-gold/20 p-6 shadow-gold">
          <div className="absolute inset-0 opacity-10"
               style={{
                 backgroundImage: 'radial-gradient(circle at 30% 30%, #C9A961 0%, transparent 50%)',
               }} />
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
            <Link href="/catalogo?campanha=inverno" className="btn-gold mt-4">
              Ver coleção
              <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* ── ATALHOS RÁPIDOS ── */}
      <section className="mt-7 px-5">
        <div className="grid grid-cols-4 gap-3">
          <QuickShortcut href="/cashback" icon={<Wallet className="w-5 h-5" />} label="Cashback" />
          <QuickShortcut href="/cupons" icon={<Tag className="w-5 h-5" />} label="Cupons" />
          <QuickShortcut href="/live" icon={<Tv className="w-5 h-5" />} label="Live" badge />
          <QuickShortcut href="/lojas" icon={<MapPin className="w-5 h-5" />} label="Lojas" />
        </div>
      </section>

      {/* ── DESTAQUES ── */}
      <section className="mt-8">
        <div className="flex items-center justify-between px-5 mb-3">
          <h3 className="font-serif text-xl font-bold">Destaques da semana</h3>
          <Link href="/catalogo" className="text-xs text-gold font-bold uppercase tracking-wider">
            Ver todos
          </Link>
        </div>
        <div className="flex gap-3 overflow-x-auto no-scrollbar px-5 pb-2 snap-x snap-mandatory">
          {[1, 2, 3, 4, 5].map((i) => (
            <ProductPlaceholder key={i} />
          ))}
        </div>
      </section>

      {/* ── BANNER R$ 20 BÔNUS ── */}
      <section className="mt-8 px-5">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-gold via-gold-light to-gold p-6 text-ink">
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
              <Link href="/cadastro" className="inline-flex items-center gap-1 mt-3 text-sm font-bold uppercase tracking-wider border-b border-ink/40">
                Pegar meu bônus
                <ChevronRight className="w-4 h-4" />
              </Link>
            </div>
            <Heart className="w-16 h-16 fill-ink/10 stroke-ink/30 shrink-0" />
          </div>
        </div>
      </section>

      {/* ── CATEGORIAS ── */}
      <section className="mt-8 px-5">
        <h3 className="font-serif text-xl font-bold mb-3">Por categoria</h3>
        <div className="grid grid-cols-2 gap-3">
          {[
            { name: 'Blusas', emoji: '👚' },
            { name: 'Calças', emoji: '👖' },
            { name: 'Vestidos', emoji: '👗' },
            { name: 'Saias', emoji: '🩱' },
          ].map((c) => (
            <Link
              key={c.name}
              href={`/catalogo?cat=${c.name.toLowerCase()}`}
              className="card-dark flex items-center gap-3 hover:border-gold/50 transition"
            >
              <span className="text-2xl">{c.emoji}</span>
              <span className="font-semibold">{c.name}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* Espaço pra Bottom Nav não cobrir conteúdo */}
      <div className="h-20" />

      {/* ── BOTTOM NAV ── */}
      <BottomNav />

      {/* ── INSTALL BANNER (smart) ── */}
      {showInstallBanner && <InstallBanner onClose={() => setShowInstallBanner(false)} />}
    </div>
  );
}

/* ─────────────────── Subcomponents ─────────────────── */

function QuickShortcut({
  href,
  icon,
  label,
  badge,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  badge?: boolean;
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

function ProductPlaceholder() {
  return (
    <div className="snap-start shrink-0 w-40 rounded-2xl overflow-hidden bg-ink-800 border border-ink-600">
      <div className="aspect-[3/4] shimmer" />
      <div className="p-2">
        <div className="h-3 w-3/4 rounded shimmer mb-1.5" />
        <div className="h-4 w-1/2 rounded shimmer" />
      </div>
    </div>
  );
}
