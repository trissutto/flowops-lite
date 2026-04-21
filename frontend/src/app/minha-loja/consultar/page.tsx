'use client';

/**
 * /minha-loja/consultar — Consulta de produto pela vendedora.
 *
 * UX pedida pelo CEO (iteração 2):
 *  - 3 abas: REFERÊNCIA · DESCRIÇÃO · CÓD ETIQUETA.
 *    Cada uma manda a busca com um mode específico pro backend — sem LIKE
 *    preguiçoso que travava no primeiro match.
 *  - Quando bipa o código da etiqueta: destaca a variante bipada E já mostra
 *    os outros tamanhos da MESMA REF bem chamativos (é o caso clássico:
 *    cliente quer 48 mas chegou só 46 — mostra tudo de uma vez).
 *  - Descrição agora PAGINA por REF, não por linha: cada REF é uma card
 *    clicável que expande pra ver tamanhos. Busca por múltiplas palavras
 *    (AND), pra refinar digitando mais.
 *  - Resto igual: loja atual em destaque, outras lojas com WhatsApp de
 *    transferência, heartbeat de conexão.
 *
 * Atalhos:
 *  - F2 / Ctrl+K      → foca a barra
 *  - Alt+1 / Alt+2 / Alt+3 → troca de aba (REF / DESC / SKU)
 *  - Enter            → força busca imediata (leitor de barras costuma bipar + Enter)
 *  - Esc              → limpa
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, apiRetry } from '@/lib/api';
import { ConnectionProvider, ConnectionBadge, useConnection } from '@/lib/connection';
import Logo from '@/components/Logo';
import {
  Search, ArrowLeft, RefreshCw, X, MessageCircle,
  CheckCircle2, XCircle, AlertCircle, Store, Hash, Tag, Barcode, ChevronRight,
} from 'lucide-react';

type Mode = 'ref' | 'desc' | 'sku';

interface MeProfile {
  userId: string;
  email: string;
  role: 'admin' | 'operator' | 'store';
  storeId: string | null;
  storeCode: string | null;
  storeName: string | null;
}

interface Variant {
  sku: string;
  cor: string;
  tamanho: string;
  myStoreQty: number;
}

interface OtherStoreVariant { sku: string; cor: string; tamanho: string; qty: number }
interface OtherStore {
  code: string;
  name: string;
  whatsapp: string | null;
  qty: number;
  variants: OtherStoreVariant[];
}

interface ProductResult {
  ref: string;
  name: string;
  variants: Variant[];
  myStoreTotal: number;
  matchedSku?: string | null;
  otherStores: OtherStore[];
}

interface StoreSearchResult {
  query: string;
  mode: Mode;
  detectedAs: 'ean' | 'text';
  myStore: { id: string; code: string; name: string };
  refMatches?: Array<{ ref: string; name: string; variantCount: number }>;
  results: ProductResult[];
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

  const [mode, setMode] = useState<Mode>('ref');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<StoreSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [pickedRefFromDesc, setPickedRefFromDesc] = useState<ProductResult | null>(null);
  const [loadingRefFromDesc, setLoadingRefFromDesc] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const lastKeyRef = useRef<string>(''); // key = `${mode}::${term}`
  const abortRef = useRef<AbortController | null>(null);

  const { status: connStatus } = useConnection();

  // ---------- auth guard ----------
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) { router.push('/login'); return; }
    (async () => {
      try {
        const profile = await api<MeProfile>('/auth/me');
        if (profile.role !== 'store' || !profile.storeId) {
          router.push('/'); return;
        }
        setMe(profile);
        if (typeof document !== 'undefined') {
          document.title = profile.storeName
            ? `Consultar · ${profile.storeName}`
            : 'Consultar · LURDS';
        }
      } catch (err: any) {
        setAuthError(err?.message ?? 'Erro ao carregar perfil');
        if (String(err?.message ?? '').startsWith('401')) router.push('/login');
      } finally {
        setLoadingProfile(false);
      }
    })();
  }, [router]);

  // ---------- busca ----------
  const runSearch = useCallback(async (m: Mode, term: string) => {
    const clean = term.trim();
    if (clean.length < 2) {
      setData(null); setSearchError(null); setLoading(false); setPickedRefFromDesc(null);
      return;
    }
    const key = `${m}::${clean}`;
    if (key === lastKeyRef.current && data) return;
    lastKeyRef.current = key;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setSearchError(null);
    setPickedRefFromDesc(null);
    try {
      const resp = await apiRetry<StoreSearchResult>(
        `/products/store-search?mode=${m}&q=${encodeURIComponent(clean)}`,
        { signal: ac.signal },
      );
      if (lastKeyRef.current !== key) return;
      setData(resp);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      if (lastKeyRef.current !== key) return;
      setSearchError(err?.message ?? 'Falha ao buscar.');
      setData(null);
    } finally {
      if (lastKeyRef.current === key) setLoading(false);
    }
  }, [data]);

  // debounce — DESC precisa mais tempo (busca mais cara)
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    const delay = mode === 'desc' ? 450 : 250;
    debounceRef.current = window.setTimeout(() => {
      runSearch(mode, query);
    }, delay);
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current); };
  }, [query, mode, runSearch]);

  // Enter força busca imediata
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      runSearch(mode, query);
    }
    if (e.key === 'Escape') {
      setQuery(''); setData(null); setSearchError(null); setPickedRefFromDesc(null);
    }
  }, [mode, query, runSearch]);

  // F2 / Ctrl+K focus · Alt+1/2/3 troca aba
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const focusShortcut =
        e.key === 'F2' || ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K'));
      if (focusShortcut) { e.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); return; }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === '1') { e.preventDefault(); setMode('ref'); inputRef.current?.focus(); }
        else if (e.key === '2') { e.preventDefault(); setMode('desc'); inputRef.current?.focus(); }
        else if (e.key === '3') { e.preventDefault(); setMode('sku'); inputRef.current?.focus(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // autofocus inicial e quando troca de mode
  useEffect(() => {
    if (!loadingProfile && !authError) inputRef.current?.focus();
  }, [loadingProfile, authError, mode]);

  // ao clicar numa REF do resultado de descrição → busca detalhe
  const loadRefDetail = useCallback(async (ref: string) => {
    setLoadingRefFromDesc(true);
    setSearchError(null);
    try {
      const resp = await apiRetry<StoreSearchResult>(
        `/products/store-search?mode=ref&q=${encodeURIComponent(ref)}`,
      );
      const first = resp.results[0] ?? null;
      setPickedRefFromDesc(first);
    } catch (err: any) {
      setSearchError(err?.message ?? 'Falha ao carregar REF.');
    } finally {
      setLoadingRefFromDesc(false);
    }
  }, []);

  const clearInput = () => {
    setQuery(''); setData(null); setSearchError(null); setPickedRefFromDesc(null);
    inputRef.current?.focus();
  };

  const placeholder = useMemo(() => {
    if (mode === 'ref') return 'Digite a referência do produto...';
    if (mode === 'desc') return 'Digite palavras da descrição (ex: vestido midi azul)...';
    return 'Bipe a etiqueta ou digite o código...';
  }, [mode]);

  // ---------- render ----------
  if (loadingProfile) {
    return <div className="min-h-screen flex items-center justify-center"><RefreshCw className="w-6 h-6 animate-spin text-slate-500" /></div>;
  }
  if (authError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-red-50 border border-red-300 rounded p-6 max-w-sm text-center">
          <AlertCircle className="w-10 h-10 text-red-600 mx-auto mb-2" />
          <p className="text-red-800 font-medium">{authError}</p>
          <button onClick={() => location.reload()} className="mt-4 px-4 py-2 bg-red-600 text-white rounded">Recarregar</button>
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
            <Link href="/minha-loja" className="p-2 -ml-2 hover:bg-white/10 rounded" title="Voltar"><ArrowLeft className="w-5 h-5" /></Link>
            <Logo height={28} className="brightness-0 invert hidden sm:block" />
            <div className="min-w-0">
              <div className="font-bold leading-tight tracking-wide truncate">CONSULTAR PRODUTO</div>
              <div className="text-xs opacity-90 truncate">{me?.storeName ?? 'Minha Loja'}</div>
            </div>
          </div>
          <ConnectionBadge compact />
        </div>
      </header>

      {/* Tabs + search */}
      <section className="max-w-4xl mx-auto px-3 pt-3">
        <ModeTabs mode={mode} onChange={(m) => { setMode(m); setData(null); setPickedRefFromDesc(null); }} />

        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-6 h-6 text-slate-400 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            inputMode={mode === 'sku' ? 'numeric' : 'search'}
            autoComplete="off" autoCorrect="off" spellCheck={false}
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="w-full pl-14 pr-16 py-5 text-xl rounded-xl border-2 border-slate-300 bg-white shadow-md focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none"
          />
          {query && (
            <button onClick={clearInput} className="absolute right-4 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-slate-100 text-slate-500" title="Limpar (Esc)">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="mt-2 flex items-center justify-between text-xs text-slate-500 px-1">
          <div className="flex items-center gap-3 flex-wrap">
            <span>
              <kbd className="px-1.5 py-0.5 bg-slate-200 rounded font-mono text-[10px]">F2</kbd> focar ·{' '}
              <kbd className="px-1.5 py-0.5 bg-slate-200 rounded font-mono text-[10px]">Alt+1/2/3</kbd> trocar aba
            </span>
          </div>
          {loading && <span className="flex items-center gap-1 text-slate-400"><RefreshCw className="w-3 h-3 animate-spin" /> Buscando...</span>}
        </div>
      </section>

      {connStatus === 'offline' && (
        <div className="max-w-4xl mx-auto px-3 mt-3">
          <div className="bg-red-50 border border-red-300 rounded-lg p-3 flex items-center gap-2 text-red-800 text-sm">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <div><strong>Sem conexão com o servidor.</strong> A busca pode demorar ou falhar. Assim que voltar, roda sozinha.</div>
          </div>
        </div>
      )}

      <main className="max-w-4xl mx-auto p-3 pb-10">
        {searchError && <ErrorBox message={searchError} onRetry={() => runSearch(mode, query)} />}

        {/* Modo DESC: lista de REFs clicáveis OU detalhe de uma REF escolhida */}
        {!searchError && mode === 'desc' && data && !pickedRefFromDesc && (
          <DescResults
            data={data}
            loading={loadingRefFromDesc}
            onPickRef={loadRefDetail}
          />
        )}
        {!searchError && mode === 'desc' && pickedRefFromDesc && (
          <div className="mt-3 space-y-3">
            <button
              onClick={() => setPickedRefFromDesc(null)}
              className="text-sm text-brand font-medium inline-flex items-center gap-1 hover:underline"
            >
              <ArrowLeft className="w-4 h-4" /> Voltar pra lista de REFs
            </button>
            <ProductCard item={pickedRefFromDesc} highlightSku={null} />
          </div>
        )}

        {/* Modo REF / SKU: resultados detalhados */}
        {!searchError && mode !== 'desc' && data && data.results.length > 0 && (
          <div className="space-y-4 mt-3">
            {mode === 'sku' && data.results[0]?.matchedSku && (
              <div className="bg-brand/10 border-2 border-brand rounded-xl p-4 text-sm flex items-start gap-3">
                <Barcode className="w-5 h-5 text-brand flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold text-brand">Etiqueta reconhecida</div>
                  <div className="text-slate-700">
                    O código bipado é a variação destacada abaixo. Abaixo dele estão
                    os <strong>outros tamanhos/cores da mesma REF</strong> — útil se
                    a cliente quer um tamanho diferente.
                  </div>
                </div>
              </div>
            )}
            {data.results.map((r) => (
              <ProductCard
                key={r.ref}
                item={r}
                highlightSku={mode === 'sku' ? r.matchedSku ?? null : null}
              />
            ))}
          </div>
        )}

        {!searchError && !loading && data && data.results.length === 0 &&
          (mode !== 'desc' || (data.refMatches?.length ?? 0) === 0) &&
          query.trim().length >= 2 && (
            <EmptyResult query={data.query} mode={mode} />
          )}

        {!data && !loading && !searchError && query.trim().length < 2 && (
          <Welcome storeName={me?.storeName ?? 'sua loja'} mode={mode} />
        )}
      </main>
    </div>
  );
}

// ============================================================
// Tabs
// ============================================================
function ModeTabs({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const tabs: Array<{ key: Mode; label: string; Icon: any; hint: string }> = [
    { key: 'ref',  label: 'Referência',     Icon: Hash,    hint: 'Alt+1' },
    { key: 'desc', label: 'Descrição',      Icon: Tag,     hint: 'Alt+2' },
    { key: 'sku',  label: 'Cód. Etiqueta',  Icon: Barcode, hint: 'Alt+3' },
  ];
  return (
    <div className="flex gap-1 mb-3 bg-white p-1 rounded-xl border border-slate-200 shadow-sm">
      {tabs.map((t) => {
        const active = mode === t.key;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg font-semibold text-sm transition ${
              active
                ? 'bg-brand text-white shadow'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
            title={t.hint}
          >
            <t.Icon className="w-4 h-4" />
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ============================================================
// Desc results — lista de REFs
// ============================================================
function DescResults({
  data, loading, onPickRef,
}: {
  data: StoreSearchResult;
  loading: boolean;
  onPickRef: (ref: string) => void;
}) {
  const refs = data.refMatches ?? [];
  if (refs.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      <div className="text-xs uppercase tracking-wide font-bold text-slate-500 px-1">
        {refs.length} referência{refs.length === 1 ? '' : 's'} encontrada{refs.length === 1 ? '' : 's'}
        {refs.length >= 200 && ' (mostrando as 200 mais relevantes — refine a busca)'}
      </div>
      <div className="space-y-2">
        {refs.map((r) => (
          <button
            key={r.ref}
            onClick={() => onPickRef(r.ref)}
            disabled={loading}
            className="w-full text-left bg-white rounded-xl border border-slate-200 hover:border-brand hover:bg-brand/5 shadow-sm p-4 flex items-start gap-3 transition disabled:opacity-50"
          >
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-400">
              <Tag className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-slate-500 uppercase tracking-wide">REF {r.ref}</div>
              <div className="font-semibold text-slate-900 leading-tight truncate">{r.name}</div>
              <div className="text-xs text-slate-500 mt-0.5">{r.variantCount} variações</div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-300 mt-3 flex-shrink-0" />
          </button>
        ))}
      </div>
      {loading && (
        <div className="text-center text-slate-400 text-sm py-2 flex items-center justify-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin" /> Carregando detalhes...
        </div>
      )}
    </div>
  );
}

// ============================================================
// Welcome / Empty / Error
// ============================================================
function Welcome({ storeName, mode }: { storeName: string; mode: Mode }) {
  const copy: Record<Mode, { title: string; body: string }> = {
    ref:  { title: 'Busca por REFERÊNCIA',    body: 'Digite a referência do produto (ex: 1234, R5578). Retorna todos os tamanhos e cores da REF.' },
    desc: { title: 'Busca por DESCRIÇÃO',     body: 'Digite palavras separadas pra refinar (ex: "vestido midi preto"). Todas as palavras precisam bater.' },
    sku:  { title: 'Busca por CÓD. ETIQUETA', body: 'Bipe a etiqueta ou digite o código. Destacamos a variação exata E mostramos os outros tamanhos da mesma REF.' },
  };
  const c = copy[mode];
  return (
    <div className="mt-6 bg-white rounded-xl border-2 border-dashed border-slate-300 p-8 text-center">
      <div className="w-16 h-16 mx-auto rounded-full bg-slate-100 flex items-center justify-center mb-3"><Search className="w-8 h-8 text-slate-400" /></div>
      <p className="font-bold text-lg text-slate-800">{c.title}</p>
      <p className="text-sm mt-1 text-slate-500">{c.body}</p>
      <p className="text-xs mt-3 text-slate-400">Loja atual: <strong>{storeName}</strong></p>
    </div>
  );
}

function EmptyResult({ query, mode }: { query: string; mode: Mode }) {
  const tip: Record<Mode, string> = {
    ref:  'Confere se digitou a REF certinho. REF geralmente é curta (3-6 caracteres/dígitos).',
    desc: 'Tente palavras diferentes — ex: cor, tipo da peça, tamanho. Ou troca pra aba REFERÊNCIA se já sabe o código.',
    sku:  'O código da etiqueta não bate com nenhum produto do ERP. Confere se bipou a etiqueta inteira.',
  };
  return (
    <div className="mt-6 bg-white rounded-xl border border-slate-200 p-6 text-center">
      <div className="w-14 h-14 mx-auto rounded-full bg-amber-50 flex items-center justify-center mb-2"><AlertCircle className="w-7 h-7 text-amber-500" /></div>
      <p className="font-bold text-slate-800">Nada encontrado pra &ldquo;{query}&rdquo;</p>
      <p className="text-sm mt-1 text-slate-500">{tip[mode]}</p>
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-4 bg-red-50 border border-red-300 rounded-lg p-4 flex items-start gap-2">
      <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="font-bold text-red-900">Erro na busca</p>
        <p className="text-sm text-red-700 mt-0.5 break-words">{message}</p>
      </div>
      <button onClick={onRetry} className="px-3 py-1.5 bg-red-600 text-white rounded font-medium text-sm hover:bg-red-700">Tentar de novo</button>
    </div>
  );
}

// ============================================================
// Product card — detalhe de UMA ref
// ============================================================
function ProductCard({ item, highlightSku }: { item: ProductResult; highlightSku: string | null }) {
  const hasInMyStore = item.myStoreTotal > 0;

  const byColor = useMemo(() => {
    const m = new Map<string, Variant[]>();
    for (const v of item.variants) {
      const key = v.cor || '—';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(v);
    }
    return Array.from(m.entries());
  }, [item.variants]);

  return (
    <article className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <header className={`px-4 py-3 border-b ${hasInMyStore ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-slate-500 font-medium">REF {item.ref}</div>
            <h2 className="font-bold text-slate-900 text-lg leading-tight mt-0.5">{item.name}</h2>
          </div>
          <div className={`text-right flex-shrink-0 ${hasInMyStore ? 'text-emerald-700' : 'text-slate-400'}`}>
            <div className="text-3xl font-extrabold leading-none">{item.myStoreTotal}</div>
            <div className="text-[10px] uppercase tracking-wide font-bold mt-0.5">{hasInMyStore ? 'Na minha loja' : 'Sem estoque aqui'}</div>
          </div>
        </div>
      </header>

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
                  <VariantChip
                    key={v.sku}
                    variant={v}
                    highlight={highlightSku === v.sku}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

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

      {!hasInMyStore && item.otherStores.length === 0 && (
        <section className="px-4 py-3 border-t border-slate-100 bg-red-50/60 text-sm text-red-800 flex items-center gap-2">
          <XCircle className="w-4 h-4" /> Sem estoque em nenhuma loja da rede no momento.
        </section>
      )}
    </article>
  );
}

function VariantChip({ variant, highlight }: { variant: Variant; highlight: boolean }) {
  const has = variant.myStoreQty > 0;
  const low = variant.myStoreQty > 0 && variant.myStoreQty <= 2;

  // Variante "bipada" — destaque bem forte mesmo quando não tem estoque,
  // pra vendedora ver claramente qual é "a etiqueta" e comparar com as outras.
  const base = 'flex items-center gap-2 px-3 py-2 rounded-lg border-2 font-medium text-sm transition';
  let style = '';
  if (highlight) {
    style = has
      ? 'bg-brand text-white border-brand shadow-lg ring-2 ring-brand/30 scale-105'
      : 'bg-red-500 text-white border-red-600 shadow-lg ring-2 ring-red-300 scale-105';
  } else if (has) {
    style = low
      ? 'bg-amber-50 border-amber-300 text-amber-900'
      : 'bg-emerald-50 border-emerald-400 text-emerald-900';
  } else {
    style = 'bg-slate-50 border-slate-200 text-slate-400 line-through';
  }

  return (
    <div
      className={`${base} ${style} ${highlight ? 'text-base font-bold' : ''}`}
      title={`SKU ${variant.sku}${highlight ? ' · código bipado' : ''}`}
    >
      {highlight ? (
        <Barcode className="w-4 h-4" />
      ) : has ? (
        <CheckCircle2 className={`w-4 h-4 ${low ? 'text-amber-600' : 'text-emerald-600'}`} />
      ) : (
        <XCircle className="w-4 h-4 text-slate-300" />
      )}
      <span className="font-bold">{variant.tamanho || '—'}</span>
      <span className="text-xs font-mono opacity-70">×{variant.myStoreQty}</span>
      {highlight && <span className="text-[10px] uppercase font-bold opacity-90 ml-1">etiqueta</span>}
    </div>
  );
}

function OtherStoreRow({
  store, refCode,
}: { store: OtherStore; refCode: string }) {
  const [open, setOpen] = useState(false);

  const waHref = useMemo(() => {
    if (!store.whatsapp) return null;
    const onlyDigits = store.whatsapp.replace(/\D/g, '');
    if (onlyDigits.length < 10) return null;
    const msg = encodeURIComponent(
      `Oi! Tem disponível a REF ${refCode} pra transferir pra minha loja? ${store.variants.map((v) => `${v.tamanho}${v.cor ? ` ${v.cor}` : ''} (×${v.qty})`).join(', ')}`,
    );
    return `https://wa.me/${onlyDigits.startsWith('55') ? onlyDigits : '55' + onlyDigits}?text=${msg}`;
  }, [store, refCode]);

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-bold text-slate-800 text-sm truncate">{store.name}</div>
          <div className="text-xs text-slate-500">Tem <strong className="text-slate-800">{store.qty}</strong> peça(s) da ref</div>
        </div>
        {waHref ? (
          <a href={waHref} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-sm" title={`WhatsApp da ${store.name}`}>
            <MessageCircle className="w-3.5 h-3.5" /> Pedir
          </a>
        ) : (
          <span className="text-[10px] text-slate-400 italic self-center">sem WhatsApp</span>
        )}
      </div>
      <button onClick={() => setOpen((v) => !v)} className="mt-2 text-[11px] text-slate-500 hover:text-slate-700 underline underline-offset-2">
        {open ? 'Ocultar detalhes' : 'Ver tamanhos'}
      </button>
      {open && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {store.variants.slice().sort((a, b) => {
            const na = Number(a.tamanho); const nb = Number(b.tamanho);
            if (!isNaN(na) && !isNaN(nb)) return na - nb;
            return String(a.tamanho).localeCompare(String(b.tamanho));
          }).map((v) => (
            <span key={v.sku} className="px-2 py-0.5 bg-slate-100 border border-slate-200 rounded text-[11px] font-medium text-slate-700">
              {v.tamanho || '—'}{v.cor ? ` · ${v.cor}` : ''} <span className="text-slate-400">×{v.qty}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
