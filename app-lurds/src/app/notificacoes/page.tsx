'use client';
import Link from 'next/link';
import { ArrowLeft, Bell, BellOff } from 'lucide-react';
import BottomNav from '@/components/BottomNav';

export default function NotificacoesPage() {
  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Notificações</h1>
      </header>
      <div className="mt-16 text-center px-8">
        <BellOff className="w-16 h-16 mx-auto text-gold/40" />
        <h2 className="font-serif text-xl font-bold mt-4">Tudo zerado</h2>
        <p className="text-sm text-cream/60 mt-2">
          Sua caixa de notificações vai aparecer aqui assim que vc ativar e receber a primeira.
        </p>
      </div>
      <BottomNav />
    </div>
  );
}
