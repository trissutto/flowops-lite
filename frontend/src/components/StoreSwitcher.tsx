'use client';

/**
 * StoreSwitcher — Botao fixo no topo da retaguarda que abre dropdown
 * com lista de lojas. Clica numa -> abre PDV daquela loja em aba NOVA
 * (modo impersonate). Sua sessao de admin permanece na aba atual.
 *
 * Lazy load: a lista de lojas so e buscada quando o dropdown abre.
 * Cache: mantemos em memoria depois da primeira abertura.
 *
 * Visibilidade: so renderiza para role=admin/master. Vendedora (role=store)
 * nao precisa desse botao — ela ja esta no PDV dela.
 */

import { useEffect, useRef, useState } from 'react';
import { Zap, ChevronDown, Loader2, Store as StoreIcon } from 'lucide-react';
import { api } from '@/lib/api';

type Store = {
  id: string;
  code: string;
  name: string;
  active: boolean;
};

type Me = {
  role?: string;
};

export default function StoreSwitcher() {
  const [open, setOpen] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [stores, setStores] = useState<Store[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Checa role uma vez no mount — so renderiza pra admin/master e master da
  // franquia (este ve so as lojas FILIAL: o backend ja filtra /stores e o
  // impersonate recusa loja REDE).
  useEffect(() => {
    api<Me>('/auth/me')
      .then((me) => {
        setAllowed(me?.role === 'admin' || me?.role === 'master' || me?.role === 'master_franquia');
      })
      .catch(() => setAllowed(false));
  }, []);

  // Carrega lojas lazy quando o dropdown abre pela 1a vez.
  useEffect(() => {
    if (!open || stores !== null) return;
    setLoading(true);
    setError(null);
    api<Store[]>('/stores')
      .then((arr) => {
        const sorted = arr
          .filter((s) => s.active)
          .sort((a, b) => a.code.localeCompare(b.code));
        setStores(sorted);
      })
      .catch((e: any) => setError(e?.message || 'Erro ao carregar lojas'))
      .finally(() => setLoading(false));
  }, [open, stores]);

  // Fecha ao clicar fora.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const enterAsStore = async (store: Store) => {
    setEntering(store.code);
    try {
      const res = await api<{ accessToken: string }>('/auth/impersonate-store', {
        method: 'POST',
        body: JSON.stringify({ storeCode: store.code }),
      });
      if (!res?.accessToken) {
        alert('Falha ao gerar acesso a loja.');
        return;
      }
      const url = `/impersonate?token=${encodeURIComponent(res.accessToken)}&dest=${encodeURIComponent('/minha-loja/pdv')}`;
      const w = window.open(url, `_blank_pdv_${store.code}`);
      if (!w) {
        alert('Pop-up bloqueado. Permita pop-ups pra este site.');
      }
      setOpen(false);
    } catch (e: any) {
      alert(`Erro ao entrar como ${store.name}: ${e?.message || 'falha'}`);
    } finally {
      setEntering(null);
    }
  };

  if (!allowed) return null;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs sm:text-sm px-2.5 sm:px-3 py-1.5 rounded-full transition font-semibold text-white shadow-sm"
        style={{ background: '#10b981' }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = '#059669';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = '#10b981';
        }}
        title="Entrar no PDV de uma loja em aba nova (modo master)"
      >
        <Zap className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Entrar PDV</span>
        <ChevronDown className="w-3 h-3 opacity-80" />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-72 max-h-[70vh] overflow-y-auto bg-white rounded-xl shadow-2xl border border-slate-200 z-50"
        >
          <div className="px-4 py-3 border-b border-slate-100 bg-emerald-50/50">
            <div className="text-xs font-bold text-emerald-700 uppercase tracking-wide">
              Modo Master
            </div>
            <div className="text-[11px] text-slate-600 mt-0.5 leading-tight">
              Abre PDV em aba nova. Sua sessao admin nesta aba continua.
            </div>
          </div>

          {loading && (
            <div className="p-6 text-center text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
              <div className="text-xs">Carregando lojas...</div>
            </div>
          )}

          {error && (
            <div className="p-4 text-xs text-red-700 bg-red-50 border-b border-red-100">
              {error}
            </div>
          )}

          {!loading && stores && stores.length === 0 && (
            <div className="p-6 text-center text-xs text-slate-400">
              Nenhuma loja ativa.
            </div>
          )}

          {!loading && stores && stores.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {stores.map((s) => {
                const isEntering = entering === s.code;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => enterAsStore(s)}
                      disabled={!!entering}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-emerald-50 transition disabled:opacity-50 disabled:cursor-not-allowed text-left"
                    >
                      <StoreIcon className="w-4 h-4 text-emerald-600 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-slate-800 truncate">
                          {s.name}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono">
                          loja {s.code}
                        </div>
                      </div>
                      {isEntering ? (
                        <Loader2 className="w-4 h-4 animate-spin text-emerald-600 shrink-0" />
                      ) : (
                        <Zap className="w-4 h-4 text-slate-300 shrink-0" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
