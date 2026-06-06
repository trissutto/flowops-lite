'use client';

import Link from 'next/link';
import { ArrowLeft, Search, SlidersHorizontal } from 'lucide-react';
import BottomNav from '@/components/BottomNav';

/**
 * /catalogo — Catálogo de produtos (placeholder Semana 1).
 * Vai puxar do WC via API do backend na Semana 2.
 */
export default function CatalogoPage() {
  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Catálogo</h1>
      </header>

      {/* Busca */}
      <div className="mt-5 px-5 flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-cream/40" />
          <input
            type="search"
            placeholder="Buscar peça, cor, tamanho..."
            className="input-dark pl-9"
          />
        </div>
        <button
          className="p-3 bg-ink-800 border border-ink-600 rounded-xl text-gold hover:border-gold/50 transition"
          aria-label="Filtros"
        >
          <SlidersHorizontal className="w-5 h-5" />
        </button>
      </div>

      {/* Empty state */}
      <div className="mt-12 text-center px-8">
        <div className="text-5xl mb-3">👗</div>
        <h2 className="font-serif text-xl font-bold">Em breve</h2>
        <p className="text-sm text-cream/60 mt-2">
          O catálogo completo estará disponível na próxima atualização.
          <br />
          Por enquanto, navegue pelo nosso site:
        </p>
        <a
          href="https://lurds.com.br"
          target="_blank"
          rel="noopener"
          className="btn-gold mt-5"
        >
          Ir pra lurds.com.br
        </a>
      </div>

      <div className="h-20" />
      <BottomNav />
    </div>
  );
}
