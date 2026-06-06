'use client';

import Link from 'next/link';
import { ArrowLeft, User, Bell, MapPin, FileText, Shield, LogOut, ChevronRight, Heart, ShoppingBag } from 'lucide-react';
import BottomNav from '@/components/BottomNav';
import { logout } from '@/lib/api';

/**
 * /conta — Tela de configurações e dados da cliente.
 * Lista links pra cada seção; conteúdo real virá nas Semanas 2-3.
 */
export default function ContaPage() {
  const sections = [
    {
      title: 'Minha conta',
      items: [
        { icon: User, label: 'Dados pessoais', href: '/conta/dados' },
        { icon: MapPin, label: 'Endereços', href: '/conta/enderecos' },
        { icon: Heart, label: 'Favoritos', href: '/favoritos' },
      ],
    },
    {
      title: 'Pedidos',
      items: [
        { icon: ShoppingBag, label: 'Meus pedidos', href: '/pedidos' },
      ],
    },
    {
      title: 'Preferências',
      items: [
        { icon: Bell, label: 'Notificações', href: '/conta/notificacoes' },
      ],
    },
    {
      title: 'Informações',
      items: [
        { icon: FileText, label: 'Termos de uso', href: '/termos' },
        { icon: Shield, label: 'Política de privacidade', href: '/privacidade' },
      ],
    },
  ];

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Minha conta</h1>
      </header>

      {/* Avatar + Nome */}
      <section className="mt-6 px-5">
        <div className="card-dark flex items-center gap-3">
          <div className="w-14 h-14 rounded-full bg-gradient-to-br from-gold to-gold-dark flex items-center justify-center font-serif text-2xl font-bold text-ink">
            L
          </div>
          <div className="flex-1">
            <div className="font-bold text-white">Olá, cliente!</div>
            <div className="text-xs text-cream/60">Entra ou cadastra-te pra acessar</div>
          </div>
          <Link href="/login" className="btn-ghost text-gold">
            Entrar
          </Link>
        </div>
      </section>

      {/* Seções */}
      {sections.map((section) => (
        <section key={section.title} className="mt-7 px-5">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-cream/40 mb-2 px-1">
            {section.title}
          </h2>
          <div className="card-dark divide-y divide-ink-600 !p-0 overflow-hidden">
            {section.items.map(({ icon: Icon, label, href }) => (
              <Link
                key={href}
                href={href}
                className="flex items-center gap-3 px-4 py-3.5 hover:bg-ink-700/50 transition touch-tap"
              >
                <Icon className="w-5 h-5 text-gold/70" />
                <span className="flex-1 text-sm font-medium">{label}</span>
                <ChevronRight className="w-4 h-4 text-cream/40" />
              </Link>
            ))}
          </div>
        </section>
      ))}

      {/* Logout */}
      <section className="mt-8 px-5">
        <button
          onClick={() => logout()}
          className="w-full flex items-center justify-center gap-2 py-3 text-red-300/80 hover:text-red-300 text-sm font-bold uppercase tracking-wider transition"
        >
          <LogOut className="w-4 h-4" />
          Sair
        </button>
      </section>

      {/* Versão */}
      <div className="mt-8 text-center text-[10px] text-cream/30">
        Lurd's Plus Size · v1.0.0
      </div>

      <div className="h-20" />
      <BottomNav />
    </div>
  );
}
