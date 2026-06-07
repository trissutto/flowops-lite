'use client';
import Link from 'next/link';
import { ArrowLeft, Tv, Instagram } from 'lucide-react';
import BottomNav from '@/components/BottomNav';

export default function LivePage() {
  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Live ao vivo</h1>
      </header>
      <div className="mt-6 px-5">
        <div className="card-gold-border bg-gradient-to-br from-ink-800 to-ink p-6 text-center">
          <Tv className="w-16 h-16 mx-auto text-gold mb-3" />
          <h2 className="font-serif text-xl font-bold">Sem live no momento</h2>
          <p className="text-sm text-cream/60 mt-2">
            Ative as notificações pra ser avisada na hora que começarmos uma live nova.
          </p>
          <a
            href="https://instagram.com/lurdsplussize"
            target="_blank"
            rel="noopener"
            className="btn-outline-gold mt-5 inline-flex"
          >
            <Instagram className="w-4 h-4" />
            Seguir no Instagram
          </a>
        </div>
      </div>
      <BottomNav />
    </div>
  );
}
