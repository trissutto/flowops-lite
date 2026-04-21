'use client';

/**
 * /minha-loja/consultar — Consulta rápida de produto pela vendedora.
 *
 * Objetivo prático:
 *  - Cliente na frente, vendedora precisa saber AGORA se a loja tem o tamanho
 *    maior/menor, se outra cor tá disponível, ou se alguma outra filial tem pra
 *    pedir transferência.
 *
 * UX (explicitado pelo CEO):
 *  - UMA barra única e grande (não 3 campos pra ref/descrição/código).
 *  - Detecta automaticamente se é EAN (bipado), ref, código ou texto.
 *  - Atalhos F2 e Ctrl+K focam de volta na barra.
 *  - Enter também dispara busca (leitor de código de barras costuma mandar Enter).
 *  - Main: MINHA loja em destaque (verde se tem, cinza se não).
 *  - Secundário: outras lojas que têm a ref, com botão WhatsApp pra pedir transferência.
 *
 * Resiliência (CEO: "O SISTEMA VAI FICAR O DIA TODO ABERTO E NAO PODE PERDER A CONEXAO"):
 *  - Usa apiRetry (3x, exponencial) em toda chamada.
 *  - ConnectionProvider com heartbeat de 30s + recheck no foco.
 *  - Indicador visual no header; se offline > 5min, botão de recarregar.
 *  - Se offline no momento da busca, mostra mensagem clara em vez de silent fail.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, apiRetry } from '@/lib/api';
import { ConnectionProvider, ConnectionBadge, useConnection } from '@/lib/connection';
import Logo from '@/components/Logo';
import {
  Search, ArrowLeft, RefreshCw, X, MessageCircle,
  CheckCircle2, XCircle, AlertCircle, Store, Wifi,
} from 'lucide-react';

interface MeProfile {
  userId: string;
  email: string;
  role: 'admin' | 'operator' | 'store';
  storeId: string | null;
  storeCode: string | null;
  storeName: string | null;
}

interface StoreSearchResult {
  query: string;
  detectedAs: 'ean' | 'text';
  myStore: { id: string; code: string; name: string };
  results: Array<{
    ref: string;
    name: string;
    variants: Array<{
      sku: string;
      cor: string;
      tamanho: string;
      myStoreQty: number;
    }>;
    myStoreTotal: number;
    otherStores: Array<{
      code: string;
      name: string;
      whatsapp: string | null;
      qty: number;
      variants: Array<{ sku: string; cor: string; tamanho: string; qty: number }>;
    }>;
  }>;
}

export default function ConsultarPage() {
  return (
    <ConnectionProvider>
      <ConsultarInner />
    </ConnectionProvider>
  );
}

function ConsultarInner() {
  const router = useRouter();
  const [me, setMe] = useState<MeProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [data, setData] = useState<StoreSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const lastTermRef = useRef<string>('');
  const abortRef = useRef<AbortController | null>(null);

  const { status: connStatus } = useConnection();

  // ---------- auth guard ----------
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    (async () => {
      try {
        const profile = await api<MeProfile>('/auth/me');
        if (profile.role !== 'store' || !profile.storeId) {
          router.push('/');
          return;
        }
        setMe(profile);
        if (typeof document !== 'undefined') {
          document.title = profile.storeName
            ? `Consultar · ${profile.storeName}`
            : 'Consultar · LURDS';
        }
      } catch (err: any) {
        setAuthError(err?.message ?? 'Erro ao carregar perfil');
        if (String(err?.message ?? '').startsWith('401')) {
          router.push('/login');
        }
      } finally {
        setLoadingProfile(false);
      }
    })();
  }, [router]);

  // ---------- busca propriamente dita ----------
  const runSearch = useCallback(async (term: string) => {
    const clean = term.trim();
    if (clean.length < 2) {
      setData(null);
      setSearchError(null);
      setLoading(false);
      return;
    }
    if (clean === lastTermRef.current && data) {
      return; // evita refetch de termo idêntico
    }
    lastTermRef.current = clean;

    // cancela busca anterior se ainda estava rodando (evita ordem fora)
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setSearchError(null);
    try {
      const resp = await apiRetry<StoreSearchResult>(
        `/products/store-search?q=${encodeURIComponent(clean)}`,
        { signal: ac.signal },
      );
      // ignora se já foi superada por outra busca
      if (lastTermRef.current !== clean) return;
      setData(resp);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      // ignora se foi superada
      if (lastTermRef.current !== clean) return;
      setSearchError(err?.message ?? 'Falha ao buscar.');
      setData(null);
    } finally {
      if (lastTermRef.current === clean) setLoading(false);
    }
  }, [data]);

  // Debounce do typing: 250ms
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      runSearch(query);
    }, 250);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  // Enter força busca IMEDIATA (leitores de código costumam mandar Enter no fim)
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      runSearch(query);
    }
    if (e.key === 'Escape') {
      setQuery('');
      setData(null);
      setSearchError(null);
    }
  }, [query, runSearch]);

  // F2 e Ctrl+K focam a barra
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isSearchShortcut =
        e.key === 'F2' ||
        ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K'));
      if (isSearchShortcut) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Autofocus inicial
  useEffect(() => {
    if (!loadingProfile && !authError) {
      inputRef.current?.focus();
    }
  }, [loadingProfile, authError]);

  // ---------- helpers ----------
  const isEanLike = /^\d{8,14}$/.test(query.trim());

  const clearInput = () => {
    setQuery('');
    setData(null);
    setSearchError(null);
    inputRef.current?.focus();
  };

  // ---------- render ----------
  if (loadingProfile) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <RefreshCw className="w-6 h-6 animate-spin text-slate-500" />
      </div>
    );
  }

  if (authError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-red-50 border border-red-300 rounded p-6 max-w-sm text-center">
          <AlertCircle className="w-10 h-10 text-red-600 mx-auto mb-2" />
          <p className="text-red-800 font-medium">{authError}</p>
          <button onClick={() => location.reload()} className="mt-4 px-4 py-2 bg-red-600 text-white rounded">
            Recarregar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Header */}
      <header className="bg-brand text-white sticky top-0 z-30 shadow">
        <div className="px-4 py-3 flex items-center justify-between max-w-4xl mx-auto gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href="/minha-loja"
              className="p-2 -ml-2 hover:bg-white/10 rounded"
              title="Voltar"
            >
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <Logo height={28} className="brightness-0 invert hidden sm:block" />
            <div className="min-w-0">
              <div className="font-bold leading-tight tracking-wide truncate">CONSULTAR PRODUTO</div>
              <div className="text-xs opacity-90 truncate">
                {me?.storeName ?? 'Minha Loja'}
              </div>
            </div>
          </div>
          <ConnectionBadge compact />
        </div>
      </header>

      {/* Search bar — gigante, autofocus */}
      <section className="max-w-4xl mx-auto px-3 pt-4">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-6 h-6 text-slate-400 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            inputMode="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Digite referência, descrição ou bipe o código de barras..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="w-full pl-14 pr-16 py-5 text-xl rounded-xl border-2 border-slate-300 bg-white shadow-md focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none"
          />
          {query && (
            <button
              onClick={clearInput}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-slate-100 text-slate-500"
              title="Limpar (Esc)"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-slate-500 px-1">
          <div className="flex items-center gap-3">
            <span>
              Atalhos: <kbd className="px-1.5 py-0.5 bg-slate-200 rounded font-mono text-[10px]">F2</kbd>{' '}
              ou <kbd className="px-1.5 py-0.5 bg-slate-200 rounded font-mono text-[10px]">Ctrl+K</kbd>
            </span>
            {isEanLike && (
              <span className="text-emerald-700 font-medium">• Detectado como código de barras</span>
            )}
          </div>
          {loading && (
            <span className="flex items-center gap-1 text-slate-400">
              <RefreshCw className="w-3 h-3 animate-spin" /> Buscando...
            </span>
          )}
        </div>
      </section>

      {/* Aviso offline */}
      {connStatus === 'offline' && (
        <div className="max-w-4xl mx-auto px-3 mt-3">
          <div className="bg-red-50 border border-red-300 rounded-lg p-3 flex items-center gap-2 text-red-800 text-sm">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <div>
              <strong>Sem conexão com o servidor.</strong> A busca pode demorar ou falhar. Assim que voltar, a consulta roda sozinha.
            </div>
          </div>
        </div>
      )}

      {/* Resultados */}
      <main className="max-w-4xl mx-auto p-3 pb-10">
        {searchError && (
          <ErrorBox message={searchError} onRetry={() => runSearch(query)} />
        )}

        {!searchError && !loading && data && data.results.length === 0 && query.trim().length >= 2 && (
          <EmptyResult query={data.query} />
        )}

        {!searchError && data && data.results.length > 0 && (
          <div className="space-y-4 mt-3">
            {data.results.map((r) => (
              <ProductCard key={r.ref} item={r} />
            ))}
          </div>
        )}

        {!data && !loading && !searchError && query.trim().length < 2 && (
          <Welcome storeName={me?.storeName ?? 'sua loja'} />
        )}
      </main>
    </div>
  );
}

// ============================================================
// Componentes internos
// ============================================================

function Welcome({ storeName }: { storeName: string }) {
  return (
    <div className="mt-6 bg-white rounded-xl border-2 border-dashed border-slate-300 p-8 text-center">
      <div className="w-16 h-16 mx-auto rounded-full bg-slate-100 flex items-center justify-center mb-3">
        <Search className="w-8 h-8 text-slate-400" />
      </div>
      <p className="font-bold text-lg text-slate-800">Pronto pra consultar</p>
      <p className="text-sm mt-1 text-slate-500">
        Digite a referência, descrição ou bipe o código de barras.<br />
        A busca roda enquanto você digita.
      </p>
      <p className="text-xs mt-3 text-slate-400">
        Loja atual: <strong>{storeName}</strong>
      </p>
    </div>
  );
}

function EmptyResult({ query }: { query: string }) {
  return (
    <div className="mt-6 bg-white rounded-xl border border-slate-200 p-6 text-center">
      <div className="w-14 h-14 mx-auto rounded-full bg-amber-50 flex items-center justify-center mb-2">
        <AlertCircle className="w-7 h-7 text-amber-500" />
      </div>
      <p className="font-bold text-slate-800">Nada encontrado pra &ldquo;{query}&rdquo;</p>
      <p className="text-sm mt-1 text-slate-500">
        Confere se digitou certo. Se bipou o código, tenta a referência por escrito.
      </p>
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-4 bg-red-50 border border-red-300 rounded-lg p-4">
      <div className="flex items-start gap-2">
        <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="font-bold text-red-900">Erro na busca</p>
          <p className="text-sm text-red-700 mt-0.5 break-words">{message}</p>
        </div>
        <button
          onClick={onRetry}
          className="px-3 py-1.5 bg-red-600 text-white rounded font-medium text-sm hover:bg-red-700"
        >
          Tentar de novo
        </button>
      </div>
    </div>
  );
}

function ProductCard({ item }: { item: StoreSearchResult['results'][number] }) {
  const hasInMyStore = item.myStoreTotal > 0;

  // Agrupa variants por cor pra facilitar leitura
  const byColor = useMemo(() => {
    const m = new Map<string, typeof item.variants>();
    for (const v of item.variants) {
      const key = v.cor || '—';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(v);
    }
    return Array.from(m.entries());
  }, [item.variants]);

  return (
    <article className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header do produto */}
      <header
        className={`px-4 py-3 border-b ${
          hasInMyStore
            ? 'bg-emerald-50 border-emerald-200'
            : 'bg-slate-50 border-slate-200'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-slate-500 font-medium">
              REF {item.ref}
            </div>
            <h2 className="font-bold text-slate-900 text-lg leading-tight mt-0.5">
              {item.name}
            </h2>
          </div>
          <div
            className={`text-right flex-shrink-0 ${
              hasInMyStore ? 'text-emerald-700' : 'text-slate-400'
            }`}
          >
            <div className="text-3xl font-extrabold leading-none">{item.myStoreTotal}</div>
            <div className="text-[10px] uppercase tracking-wide font-bold mt-0.5">
              {hasInMyStore ? 'Na minha loja' : 'Sem estoque aqui'}
            </div>
          </div>
        </div>
      </header>

      {/* Grid de tamanhos/cores */}
      <section className="p-4">
        <div className="text-[11px] uppercase tracking-wide font-bold text-slate-500 mb-2">
          Tamanhos & cores na minha loja
        </div>
        <div className="space-y-3">
          {byColor.map(([cor, vs]) => (
            <div key={cor}>
              {byColor.length > 1 && (
                <div className="text-xs font-medium text-slate-600 mb-1">
                  Cor: <span className="font-bold text-slate-800">{cor}</span>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {vs.map((v) => (
                  <VariantChip key={v.sku} variant={v} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Outras lojas — bloco menor */}
      {item.otherStores.length > 0 && (
        <section className="px-4 pb-4 pt-1 border-t border-slate-100 bg-slate-50/50">
          <div className="text-[11px] uppercase tracking-wide font-bold text-slate-600 mb-2 mt-3 flex items-center gap-1">
            <Store className="w-3 h-3" /> Outras lojas com essa REF ({item.otherStores.length})
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {item.otherStores.map((s) => (
              <OtherStoreRow key={s.code} store={s} refCode={item.ref} />
            ))}
          </div>
        </section>
      )}

      {/* Sem estoque em NENHUMA loja */}
      {!hasInMyStore && item.otherStores.length === 0 && (
        <section className="px-4 py-3 border-t border-slate-100 bg-red-50/60 text-sm text-red-800 flex items-center gap-2">
          <XCircle className="w-4 h-4" />
          Sem estoque em nenhuma loja da rede no momento.
        </section>
      )}
    </article>
  );
}

function VariantChip({ variant }: { variant: { sku: string; cor: string; tamanho: string; myStoreQty: number } }) {
  const has = variant.myStoreQty > 0;
  const low = variant.myStoreQty > 0 && variant.myStoreQty <= 2;
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border-2 font-medium text-sm ${
        has
          ? low
            ? 'bg-amber-50 border-amber-300 text-amber-900'
            : 'bg-emerald-50 border-emerald-400 text-emerald-900'
          : 'bg-slate-50 border-slate-200 text-slate-400 line-through'
      }`}
      title={`SKU ${variant.sku}`}
    >
      {has ? (
        <CheckCircle2 className={`w-4 h-4 ${low ? 'text-amber-600' : 'text-emerald-600'}`} />
      ) : (
        <XCircle className="w-4 h-4 text-slate-300" />
      )}
      <span className="font-bold">{variant.tamanho || '—'}</span>
      <span className="text-xs font-mono opacity-70">×{variant.myStoreQty}</span>
    </div>
  );
}

function OtherStoreRow({
  store,
  refCode,
}: {
  store: { code: string; name: string; whatsapp: string | null; qty: number; variants: Array<{ sku: string; cor: string; tamanho: string; qty: number }> };
  refCode: string;
}) {
  const [open, setOpen] = useState(false);

  const waHref = useMemo(() => {
    if (!store.whatsapp) return null;
    const onlyDigits = store.whatsapp.replace(/\D/g, '');
    if (onlyDigits.length < 10) return null;
    const msg = encodeURIComponent(
      `Oi! Tem disponível a REF ${refCode} pra transferir pra minha loja? ${store.variants
        .map((v) => `${v.tamanho}${v.cor ? ` ${v.cor}` : ''} (×${v.qty})`)
        .join(', ')}`,
    );
    return `https://wa.me/${onlyDigits.startsWith('55') ? onlyDigits : '55' + onlyDigits}?text=${msg}`;
  }, [store, refCode]);

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-bold text-slate-800 text-sm truncate">{store.name}</div>
          <div className="text-xs text-slate-500">
            Tem <strong className="text-slate-800">{store.qty}</strong> peça(s) da ref
          </div>
        </div>
        {waHref ? (
          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-sm"
            title={`WhatsApp da ${store.name}`}
          >
            <MessageCircle className="w-3.5 h-3.5" /> Pedir
          </a>
        ) : (
          <span className="text-[10px] text-slate-400 italic self-center">sem WhatsApp</span>
        )}
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="mt-2 text-[11px] text-slate-500 hover:text-slate-700 underline underline-offset-2"
      >
        {open ? 'Ocultar detalhes' : 'Ver tamanhos'}
      </button>
      {open && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {store.variants
            .slice()
            .sort((a, b) => {
              const na = Number(a.tamanho);
              const nb = Number(b.tamanho);
              if (!isNaN(na) && !isNaN(nb)) return na - nb;
              return String(a.tamanho).localeCompare(String(b.tamanho));
            })
            .map((v) => (
              <span
                key={v.sku}
                className="px-2 py-0.5 bg-slate-100 border border-slate-200 rounded text-[11px] font-medium text-slate-700"
              >
                {v.tamanho || '—'}
                {v.cor ? ` · ${v.cor}` : ''} <span className="text-slate-400">×{v.qty}</span>
              </span>
            ))}
        </div>
      )}
    </div>
  );
}
