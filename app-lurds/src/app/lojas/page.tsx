'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, MapPin, Loader2 } from 'lucide-react';
import BottomNav from '@/components/BottomNav';
import { getStores, type AppStore } from '@/lib/api';

export default function LojasPage() {
  const [lojas, setLojas] = useState<AppStore[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getStores()
      .then((r) => setLojas(r.stores || []))
      .catch(() => setLojas([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Nossas lojas</h1>
      </header>

      {loading ? (
        <div className="text-center py-16 text-cream/60">
          <Loader2 className="w-7 h-7 animate-spin mx-auto" />
        </div>
      ) : lojas.length === 0 ? (
        <div className="mt-10 px-5 text-center text-sm text-cream/50">
          Não conseguimos carregar as lojas agora. Tenta de novo daqui a pouco.
        </div>
      ) : (
        <>
          <p className="px-5 mt-3 text-sm text-cream/60">
            {lojas.length} lojas Lurd's Plus Size no estado de São Paulo
          </p>
          <div className="mt-5 px-5 space-y-2">
            {lojas.map((l) => (
              <div key={l.code} className="card-dark flex items-center gap-3">
                <MapPin className="w-5 h-5 text-gold/70 shrink-0" />
                <div className="flex-1">
                  <div className="font-bold">{l.nome}</div>
                  <div className="text-xs text-cream/60">{l.cidade}</div>
                </div>
                <span className="text-[10px] font-mono text-cream/40">#{l.code}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="h-20" />
      <BottomNav />
    </div>
  );
}
