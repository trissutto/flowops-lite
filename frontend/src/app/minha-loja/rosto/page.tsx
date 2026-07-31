'use client';

/**
 * /minha-loja/rosto — a GERENTE cadastra o rosto (facial do ponto) das
 * funcionárias DA LOJA dela. Lista quem já tem rosto e quem falta; clica
 * → captura os 3 ângulos. A loja não acessa a retaguarda, então isso vive aqui.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { ArrowLeft, Camera, CheckCircle2, ScanFace } from 'lucide-react';

interface StoreSeller { id: string; name: string; cargo: string; hasFace: boolean; faceEnrolledAt: string | null; }

export default function RostoLojaPage() {
  const router = useRouter();
  const [sellers, setSellers] = useState<StoreSeller[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const me = await api<{ storeId?: string }>('/auth/me');
        if (!me?.storeId) { setErr('Sem loja no seu login.'); return; }
        setSellers(await api<StoreSeller[]>(`/ponto/face/store-sellers/${me.storeId}`));
      } catch { setErr('Falha ao carregar as funcionárias.'); }
      finally { setLoading(false); }
    })();
  }, []);

  const semRosto = sellers.filter((s) => !s.hasFace);
  const comRosto = sellers.filter((s) => s.hasFace);

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6">
      <div className="max-w-2xl mx-auto">
        <Link href="/minha-loja" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4">
          <ArrowLeft className="w-4 h-4" /> Loja
        </Link>
        <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          <ScanFace className="w-5 h-5 text-[#B8912B]" /> Cadastro de rosto (ponto)
        </h1>
        <p className="text-sm text-slate-500 mt-1 mb-5">
          Cadastre o rosto de cada funcionária pra ela bater ponto pela câmera. Você vê só as da sua loja.
        </p>

        {loading ? <p className="text-slate-400 text-sm">Carregando…</p>
          : err ? <p className="text-red-600 text-sm">{err}</p>
          : sellers.length === 0 ? <p className="text-slate-400 text-sm">Nenhuma funcionária ativa na loja.</p>
          : (
            <div className="space-y-6">
              {semRosto.length > 0 && (
                <div>
                  <div className="text-xs font-bold uppercase text-amber-700 mb-2">Falta cadastrar ({semRosto.length})</div>
                  <div className="space-y-2">
                    {semRosto.map((s) => (
                      <button key={s.id} onClick={() => router.push(`/minha-loja/rosto/${s.id}`)}
                        className="w-full bg-white rounded-xl border border-amber-200 p-3 flex items-center gap-3 hover:border-[#B8912B] text-left">
                        <div className="w-9 h-9 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center"><Camera className="w-4 h-4" /></div>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-slate-800 truncate">{s.name}</div>
                          <div className="text-xs text-slate-500">{s.cargo} · sem rosto</div>
                        </div>
                        <span className="text-xs font-bold text-[#8C7325]">Cadastrar →</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {comRosto.length > 0 && (
                <div>
                  <div className="text-xs font-bold uppercase text-emerald-700 mb-2">Já têm rosto ({comRosto.length})</div>
                  <div className="space-y-2">
                    {comRosto.map((s) => (
                      <button key={s.id} onClick={() => router.push(`/minha-loja/rosto/${s.id}`)}
                        className="w-full bg-white rounded-xl border border-slate-200 p-3 flex items-center gap-3 hover:border-slate-300 text-left">
                        <div className="w-9 h-9 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center"><CheckCircle2 className="w-4 h-4" /></div>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-slate-800 truncate">{s.name}</div>
                          <div className="text-xs text-slate-500">{s.cargo} · rosto cadastrado</div>
                        </div>
                        <span className="text-xs font-semibold text-slate-500">Refazer</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
      </div>
    </div>
  );
}
