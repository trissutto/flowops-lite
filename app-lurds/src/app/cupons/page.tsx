'use client';
import Link from 'next/link';
import { ArrowLeft, Tag } from 'lucide-react';
import BottomNav from '@/components/BottomNav';

export default function CuponsPage() {
  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Cupons</h1>
      </header>
      <div className="mt-6 px-5">
        <div className="card-gold-border bg-gold/5">
          <div className="flex items-center gap-3">
            <Tag className="w-8 h-8 text-gold" />
            <div>
              <div className="font-bold text-white">APP10</div>
              <div className="text-xs text-cream/60">10% OFF na primeira compra · só no app</div>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-10 text-center px-8 text-sm text-cream/50">
        Mais cupons exclusivos em breve 🎟️
      </div>
      <BottomNav />
    </div>
  );
}
