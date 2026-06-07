'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, MapPin, Star, Loader2 } from 'lucide-react';
import BottomNav from '@/components/BottomNav';
import { getAddresses, isLoggedIn, type AppAddress } from '@/lib/api';

const TYPE_LABEL: Record<string, string> = {
  residential: '🏠 Residencial',
  delivery: '📦 Entrega',
  mailing: '📬 Correspondência',
  work: '💼 Trabalho',
};

export default function EnderecosPage() {
  const router = useRouter();
  const [list, setList] = useState<AppAddress[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.push('/login?next=/conta/enderecos');
      return;
    }
    getAddresses()
      .then((r) => setList(r.addresses))
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  }, [router]);

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/conta" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Meus endereços</h1>
      </header>

      {loading && (
        <div className="text-center py-16 text-cream/60">
          <Loader2 className="w-8 h-8 animate-spin mx-auto" />
        </div>
      )}

      {!loading && list.length === 0 && (
        <div className="mt-16 text-center px-8">
          <MapPin className="w-16 h-16 mx-auto text-gold/40" />
          <h2 className="font-serif text-xl font-bold mt-4">Sem endereços cadastrados</h2>
          <p className="text-sm text-cream/60 mt-2">
            Quando você comprar no site ou em alguma loja Lurd's, os endereços
            aparecem aqui automaticamente.
          </p>
        </div>
      )}

      {!loading && list.length > 0 && (
        <div className="mt-5 px-5 space-y-3">
          <p className="text-[11px] text-cream/50 uppercase tracking-wider font-bold px-1">
            {list.length} endereço{list.length > 1 ? 's' : ''} consolidado{list.length > 1 ? 's' : ''} de todas as lojas
          </p>
          {list.map((a) => (
            <div key={a.id} className={`card-dark ${a.isPrimary ? 'border-gold/40' : ''}`}>
              <div className="flex items-start justify-between gap-2 mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-gold">
                  {TYPE_LABEL[a.type] || a.type}
                </span>
                {a.isPrimary && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-gold">
                    <Star className="w-3 h-3 fill-gold" /> Principal
                  </span>
                )}
              </div>
              <div className="text-sm space-y-0.5">
                <div className="font-bold">
                  {a.street}{a.number ? `, ${a.number}` : ''}
                  {a.complement && <span className="text-cream/60"> · {a.complement}</span>}
                </div>
                {a.district && <div className="text-cream/70">{a.district}</div>}
                <div className="text-cream/60">
                  {a.city}{a.state ? ` — ${a.state}` : ''}
                  {a.cep && <span className="text-cream/40 ml-2">CEP {a.cep}</span>}
                </div>
                {a.reference && (
                  <div className="text-xs text-cream/50 mt-1.5 italic">
                    Ref.: {a.reference}
                  </div>
                )}
              </div>
            </div>
          ))}
          <p className="text-[11px] text-cream/40 text-center mt-4">
            Pra editar ou adicionar, vá em qualquer loja Lurd's ou no nosso site.
          </p>
        </div>
      )}

      <BottomNav />
    </div>
  );
}
