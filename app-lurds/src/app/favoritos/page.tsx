'use client';
import Link from 'next/link';
import { ArrowLeft, Heart } from 'lucide-react';
import BottomNav from '@/components/BottomNav';

export default function FavoritosPage() {
  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Meus favoritos</h1>
      </header>
      <div className="mt-16 text-center px-8">
        <Heart className="w-16 h-16 mx-auto text-gold/40" />
        <h2 className="font-serif text-xl font-bold mt-4">Sem favoritos ainda</h2>
        <p className="text-sm text-cream/60 mt-2">
          Toca no coração das peças que vc gostar pra guardar aqui.
        </p>
        <Link href="/catalogo" className="btn-gold mt-6">Ver catálogo</Link>
      </div>
      <BottomNav />
    </div>
  );
}
