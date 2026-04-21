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
  XCircle, AlertCircle, Store, Tag, Barcode, ChevronRight,
} from 'lucide-react';

type Mode = 'desc' | 'sku';

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

  const [mode, setMode] = useState<Mode>('desc');
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
  /**
   * Detecta padrão óbvio de REF — pra pular a etapa de lista e ir direto pra matriz.
   * Casos cobertos:
   *  - "vlm-222", "r-100", "abc-1234"       (letras-números)
   *  - "r5578", "v002"                      (1-5 letras + dígitos)
   *  - "12345"                              (só dígitos, 3-6)
   * Descartado:
   *  - Qualquer coisa com espaço (descrição multi-palavra)
   *  - Menos de 3 chars
   */
  const looksLikeRef = (s: string): boolean => {
    const c = s.trim().toLowerCase();
    if (!c || c.includes(' ')) return false;
    if (c.length < 3) return false;
    if (/^\d{3,6}$/.test(c)) return true;
    if (/^[a-z]{1,5}-?\d{2,6}[a-z0-9]*$/.test(c)) return true;
    return false;
  };

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

    // FAST-PATH: no modo desc, se o query parece uma REF, chama mode=ref direto.
    // Economiza 1 roundtrip (desc → escolher REF → detail) e já mostra a matriz.
    const tryRefFirst = m === 'desc' && looksLikeRef(clean);
    const firstMode: 'ref' | Mode = tryRefFirst ? 'ref' : m;

    try {
      let resp = await apiRetry<StoreSearchResult>(
        `/products/store-search?mode=${firstMode}&q=${encodeURIComponent(clean)}`,
        { signal: ac.signal },
      );
      if (lastKeyRef.current !== key) return;

      // Atalho REF não bateu nada → tenta desc (fallback 1 roundtrip extra).
      if (tryRefFirst && resp.results.length === 0) {
        resp = await apiRetry<StoreSearchResult>(
          `/products/store-search?mode=desc&q=${encodeURIComponent(clean)}`,
          { signal: ac.signal },
        );
        if (lastKeyRef.current !== key) return;
      }

      setData(resp);

      // Se veio pelo atalho REF com pelo menos 1 resultado, já joga pra matriz.
      // O user continua no modo DESC (pra conseguir voltar), mas vê o detalhe.
      if (tryRefFirst && resp.results.length >= 1) {
        setPickedRefFromDesc(resp.results[0]);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      if (lastKeyRef.current !== key) return;
      setSearchError(err?.message ?? 'Falha ao buscar.');
      setData(null);
    } finally {
      if (lastKeyRef.current === key) setLoading(false);
    }
  }, [data]);

  // debounce — DESC com palavra livre precisa mais tempo; REF-like responde rápido.
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    const isRefLike = mode === 'desc' && looksLikeRef(query);
    const delay = isRefLike ? 200 : mode === 'desc' ? 450 : 250;
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
        if (e.key === '1') { e.preventDefault(); setMode('desc'); inputRef.current?.focus(); }
        else if (e.key === '2') { e.preventDefault(); setMode('sku'); inputRef.current?.focus(); }
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

  // AUTO-SKIP: se a busca por descrição retornou EXATAMENTE 1 REF, pula a
  // tela intermediária e já carrega o detalhe. Economiza 1 clique pra quando
  // a vendedora digita a REF direta (ex: "vlm-222" — é obviamente uma REF).
  useEffect(() => {
    if (mode !== 'desc') return;
    if (!data) return;
    if (pickedRefFromDesc) return;
    if (loadingRefFromDesc) return;
    const refs = data.refMatches ?? [];
    if (refs.length !== 1) return;
    loadRefDetail(refs[0].ref);
  }, [data, mode, pickedRefFromDesc, loadingRefFromDesc, loadRefDetail]);

  const clearInput = () => {
    setQuery(''); setData(null); setSearchError(null); setPickedRefFromDesc(null);
    inputRef.current?.focus();
  };

  const placeholder = useMemo(() => {
    if (mode === 'desc') return 'Digite REF, descrição ou palavras-chave (ex: vlm-222, vestido midi azul)...';
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
              <kbd className="px-1.5 py-0.5 bg-slate-200 rounded font-mono text-[10px]">Alt+1/2</kbd> trocar aba
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
    { key: 'desc', label: 'REF / Descrição', Icon: Tag,     hint: 'Alt+1' },
    { key: 'sku',  label: 'Cód. Etiqueta',   Icon: Barcode, hint: 'Alt+2' },
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

  // Auto-skip em andamento: 1 REF + carregando → só mostra spinner central.
  if (refs.length === 1 && loading) {
    return (
      <div className="mt-8 flex flex-col items-center gap-2 text-slate-500">
        <RefreshCw className="w-7 h-7 animate-spin text-brand" />
        <div className="text-sm">
          Abrindo <span className="font-bold text-slate-800">REF {refs[0].ref}</span>...
        </div>
      </div>
    );
  }

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
    desc: { title: 'Busca por REF ou DESCRIÇÃO', body: 'Digite a referência (ex: VLM-222) ou palavras da descrição (ex: "vestido midi preto"). Todas as palavras precisam bater — quanto mais específica, mais refinada a lista.' },
    sku:  { title: 'Busca por CÓD. ETIQUETA',    body: 'Bipe a etiqueta ou digite o código. Destacamos a variação exata E mostramos os outros tamanhos da mesma REF.' },
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
    desc: 'Tente outras palavras — REF (ex: VLM-222), cor, tipo da peça. Quanto mais específica a descrição, melhor.',
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
// Helpers de ordenação de tamanhos
// ============================================================
const SIZE_LETTER_ORDER = [
  'PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'EG', 'EGG',
  'XXG', 'XXGG', '2G', '3G', '4G', '5G', '6G',
  'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7',
];
function sortSizes(a: string, b: string): number {
  const ua = (a || '').toUpperCase().trim();
  const ub = (b || '').toUpperCase().trim();
  const ai = SIZE_LETTER_ORDER.indexOf(ua);
  const bi = SIZE_LETTER_ORDER.indexOf(ub);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  const na = Number(ua); const nb = Number(ub);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return ua.localeCompare(ub);
}

// ============================================================
// Product card — matriz cor × tamanho
// ============================================================
function ProductCard({ item, highlightSku }: { item: ProductResult; highlightSku: string | null }) {
  const hasInMyStore = item.myStoreTotal > 0;

  // Monta a matriz: lista de tamanhos únicos (colunas) × lista de cores (linhas)
  const { sizes, colors, cellsByColor, totalsBySize, totalsByColor, cellByColorSize } = useMemo(() => {
    const sizeSet = new Set<string>();
    const colorSet = new Set<string>();
    const cellByColorSize = new Map<string, Map<string, Variant>>(); // cor → tamanho → variant
    const totalsByColor = new Map<string, number>();
    const totalsBySize = new Map<string, number>();

    for (const v of item.variants) {
      const cor = (v.cor || '—').trim();
      const tam = (v.tamanho || '—').trim();
      sizeSet.add(tam);
      colorSet.add(cor);
      if (!cellByColorSize.has(cor)) cellByColorSize.set(cor, new Map());
      cellByColorSize.get(cor)!.set(tam, v);
      totalsByColor.set(cor, (totalsByColor.get(cor) || 0) + v.myStoreQty);
      totalsBySize.set(tam, (totalsBySize.get(tam) || 0) + v.myStoreQty);
    }

    const sizes = Array.from(sizeSet).sort(sortSizes);
    // cores: primeiro as que têm estoque (desc), depois as zeradas (alfa)
    const colors = Array.from(colorSet).sort((a, b) => {
      const ta = totalsByColor.get(a) || 0;
      const tb = totalsByColor.get(b) || 0;
      if (ta !== tb) return tb - ta;
      return a.localeCompare(b);
    });

    const cellsByColor = new Map<string, Variant[]>();
    for (const c of colors) {
      cellsByColor.set(c, sizes.map((s) => cellByColorSize.get(c)?.get(s) || {
        sku: '', cor: c, tamanho: s, myStoreQty: 0,
      }));
    }

    return { sizes, colors, cellsByColor, totalsBySize, totalsByColor, cellByColorSize };
  }, [item.variants]);

  // Cor pré-selecionada: se tem SKU bipado, seleciona a cor do SKU.
  const highlightedColor = useMemo(() => {
    if (!highlightSku) return null;
    const v = item.variants.find((x) => x.sku === highlightSku);
    return v ? (v.cor || '—').trim() : null;
  }, [highlightSku, item.variants]);

  // Tamanho pré-selecionado: se tem SKU bipado, seleciona também o tamanho do SKU.
  const highlightedSize = useMemo(() => {
    if (!highlightSku) return null;
    const v = item.variants.find((x) => x.sku === highlightSku);
    return v ? (v.tamanho || '—').trim() : null;
  }, [highlightSku, item.variants]);

  const [selectedColor, setSelectedColor] = useState<string | null>(highlightedColor);
  const [selectedSize, setSelectedSize] = useState<string | null>(highlightedSize);
  useEffect(() => { setSelectedColor(highlightedColor); }, [highlightedColor]);
  useEffect(() => { setSelectedSize(highlightedSize); }, [highlightedSize]);

  // Clique numa célula (cor + tamanho): filtra outras lojas por essa combinação.
  const handleCellClick = useCallback((cor: string, tam: string) => {
    // Se clicou na mesma célula que já tá selecionada, limpa.
    if (selectedColor === cor && selectedSize === tam) {
      setSelectedColor(null); setSelectedSize(null);
    } else {
      setSelectedColor(cor); setSelectedSize(tam);
    }
  }, [selectedColor, selectedSize]);

  // Clique na label da cor (primeira coluna): filtra só por cor, libera tamanho.
  const handleColorClick = useCallback((cor: string) => {
    if (selectedColor === cor && !selectedSize) {
      setSelectedColor(null);
    } else {
      setSelectedColor(cor); setSelectedSize(null);
    }
  }, [selectedColor, selectedSize]);

  const clearFilter = useCallback(() => {
    setSelectedColor(null); setSelectedSize(null);
  }, []);

  // Filtro das outras lojas:
  //  - só cor selecionada → qualquer variante dessa cor
  //  - cor + tamanho → só variantes com AMBOS casando
  const filteredOtherStores = useMemo(() => {
    if (!selectedColor && !selectedSize) return item.otherStores;
    return item.otherStores
      .map((s) => {
        const matching = s.variants.filter((v) => {
          const corOk = !selectedColor || (v.cor || '—').trim() === selectedColor;
          const tamOk = !selectedSize || (v.tamanho || '—').trim() === selectedSize;
          return corOk && tamOk;
        });
        if (!matching.length) return null;
        const qty = matching.reduce((acc, v) => acc + v.qty, 0);
        return { ...s, variants: matching, qty };
      })
      .filter((x): x is OtherStore => !!x);
  }, [item.otherStores, selectedColor, selectedSize]);

  return (
    <article className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <header className={`px-4 py-3 border-b ${hasInMyStore ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-slate-500 font-medium">REF {item.ref}</div>
            <h2 className="font-bold text-slate-900 text-lg leading-tight mt-0.5">{item.name}</h2>
            <div className="text-xs text-slate-500 mt-0.5">
              {colors.length} cor{colors.length === 1 ? '' : 'es'} · {sizes.length} tamanho{sizes.length === 1 ? '' : 's'}
            </div>
          </div>
          <div className={`text-right flex-shrink-0 ${hasInMyStore ? 'text-emerald-700' : 'text-slate-400'}`}>
            <div className="text-3xl font-extrabold leading-none">{item.myStoreTotal}</div>
            <div className="text-[10px] uppercase tracking-wide font-bold mt-0.5">{hasInMyStore ? 'Na minha loja' : 'Sem estoque aqui'}</div>
          </div>
        </div>
      </header>

      {/* MATRIZ cor × tamanho */}
      <section className="p-3">
        <div className="flex items-center justify-between mb-2 px-1 gap-2 flex-wrap">
          <div className="text-[11px] uppercase tracking-wide font-bold text-slate-500">
            Grade · clique na célula pra ver quem tem esse tamanho
          </div>
          {(selectedColor || selectedSize) && (
            <button
              onClick={clearFilter}
              className="text-xs text-brand font-medium hover:underline flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Limpar filtro
              {selectedColor && <span className="font-normal">({selectedColor}{selectedSize ? ` · ${selectedSize}` : ''})</span>}
            </button>
          )}
        </div>

        <div className="overflow-x-auto border border-slate-200 rounded-lg">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-slate-100 border-b border-slate-200">
                <th className="text-left px-3 py-2 font-bold text-slate-700 sticky left-0 bg-slate-100 z-10 min-w-[90px]">
                  Cor
                </th>
                {sizes.map((s) => (
                  <th key={s} className="px-2 py-2 text-center font-bold text-slate-700 min-w-[48px]">
                    {s}
                  </th>
                ))}
                <th className="px-2 py-2 text-center font-bold text-slate-700 min-w-[48px] bg-slate-200">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {colors.map((cor) => {
                const colorTotal = totalsByColor.get(cor) || 0;
                const isColorSel = selectedColor === cor;
                const dimmed = selectedColor && !isColorSel;
                return (
                  <tr
                    key={cor}
                    className={`transition border-b border-slate-100 ${
                      isColorSel
                        ? 'bg-brand/5'
                        : dimmed
                        ? 'opacity-50 hover:opacity-80'
                        : 'hover:bg-slate-50'
                    }`}
                  >
                    <td
                      onClick={() => handleColorClick(cor)}
                      className={`px-3 py-2 font-semibold text-slate-800 sticky left-0 z-10 cursor-pointer select-none ${
                        isColorSel ? 'bg-brand/10' : 'bg-white'
                      } border-r border-slate-100 hover:bg-brand/5`}
                      title="Filtrar por esta cor"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${
                          colorTotal > 0 ? 'bg-emerald-500' : 'bg-slate-300'
                        }`} />
                        <span className="truncate max-w-[100px]" title={cor}>{cor}</span>
                      </div>
                    </td>
                    {sizes.map((s) => {
                      const v = cellByColorSize.get(cor)?.get(s);
                      const qty = v?.myStoreQty ?? 0;
                      const matched = !!v && highlightSku === v.sku;
                      const isCellSel = isColorSel && selectedSize === s;
                      return (
                        <td key={s} className="p-0.5 text-center">
                          <MatrixCell
                            qty={qty}
                            matched={matched}
                            selected={isCellSel}
                            onClick={() => handleCellClick(cor, s)}
                          />
                        </td>
                      );
                    })}
                    <td className={`px-2 py-2 text-center font-bold ${
                      colorTotal > 0 ? 'text-emerald-700' : 'text-slate-400'
                    } bg-slate-50`}>
                      {colorTotal}
                    </td>
                  </tr>
                );
              })}
              {/* Linha totais por tamanho */}
              <tr className="bg-slate-100 border-t-2 border-slate-300">
                <td className="px-3 py-2 font-bold text-slate-700 sticky left-0 bg-slate-100 z-10 border-r border-slate-200">
                  Total
                </td>
                {sizes.map((s) => {
                  const t = totalsBySize.get(s) || 0;
                  return (
                    <td key={s} className={`px-2 py-2 text-center font-bold ${
                      t > 0 ? 'text-slate-800' : 'text-slate-400'
                    }`}>
                      {t}
                    </td>
                  );
                })}
                <td className="px-2 py-2 text-center font-extrabold text-emerald-700 bg-slate-200">
                  {item.myStoreTotal}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <CellLegend />
      </section>

      {/* OUTRAS LOJAS — só aparece quando usuário clica em cor/tamanho/célula. */}
      {(selectedColor || selectedSize) && filteredOtherStores.length > 0 && (
        <section className="px-4 pb-4 pt-1 border-t border-slate-100 bg-slate-50/50">
          <div className="text-[11px] uppercase tracking-wide font-bold text-slate-600 mb-2 mt-3 flex items-center gap-1 flex-wrap">
            <Store className="w-3 h-3" /> Outras lojas com{' '}
            <span className="text-brand normal-case tracking-normal font-bold">
              {selectedColor && <span className="underline">{selectedColor}</span>}
              {selectedColor && selectedSize && ' · '}
              {selectedSize && <span className="underline">tam {selectedSize}</span>}
            </span>
            <span className="ml-1">({filteredOtherStores.length})</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {filteredOtherStores.map((s) => (
              <OtherStoreRow
                key={s.code}
                store={s}
                refCode={item.ref}
                selectedColor={selectedColor}
                selectedSize={selectedSize}
              />
            ))}
          </div>
        </section>
      )}

      {/* Filtro aplicado mas zero lojas casam */}
      {(selectedColor || selectedSize) && filteredOtherStores.length === 0 && (
        <section className="px-4 py-3 border-t border-slate-100 bg-red-50/60 text-sm text-red-800 flex items-center gap-2">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          <div>
            Nenhuma outra loja tem{' '}
            {selectedColor && <strong>{selectedColor}</strong>}
            {selectedColor && selectedSize && ' no '}
            {selectedSize && <strong>tamanho {selectedSize}</strong>}
            {' '}disponível.{' '}
            <button onClick={clearFilter} className="underline font-semibold">Limpar filtro</button>
          </div>
        </section>
      )}

      {/* Hint inicial — ainda não clicou em nada */}
      {!selectedColor && !selectedSize && item.otherStores.length > 0 && (
        <section className="px-4 py-3 border-t border-slate-100 bg-blue-50/60 text-xs text-blue-900 flex items-center gap-2">
          <Store className="w-4 h-4 flex-shrink-0" />
          <div>
            <strong>{item.otherStores.length}</strong> outras lojas da rede têm essa REF.
            Clique numa célula da grade (cor × tamanho) pra ver quais têm o que você precisa.
          </div>
        </section>
      )}

      {!hasInMyStore && item.otherStores.length === 0 && !selectedColor && !selectedSize && (
        <section className="px-4 py-3 border-t border-slate-100 bg-red-50/60 text-sm text-red-800 flex items-center gap-2">
          <XCircle className="w-4 h-4" />
          Sem estoque em nenhuma loja da rede no momento.
        </section>
      )}
    </article>
  );
}

/**
 * Célula da matriz — compacta, visual, CLICÁVEL.
 *  - verde (3+)
 *  - amarelo (1-2, avisa que tá acabando)
 *  - cinza "—" (sem estoque na minha loja — MAS clicável pra ver quem tem)
 *  - ring vinho quando é o SKU bipado
 *  - ring vinho grosso quando selecionada (filtra outras lojas por essa combinação)
 */
function MatrixCell({
  qty, matched, selected, onClick,
}: { qty: number; matched: boolean; selected: boolean; onClick: () => void }) {
  const base =
    'mx-auto w-full h-10 rounded flex items-center justify-center font-extrabold relative cursor-pointer transition hover:scale-[1.04] active:scale-95 select-none';

  if (qty === 0) {
    // ZERO: sem estoque aqui. Mas clicável — abre o filtro pra ver quem tem.
    return (
      <button
        type="button"
        onClick={onClick}
        title="Sem estoque aqui — clique pra ver quem tem"
        className={`${base} text-base ${
          selected
            ? 'ring-2 ring-brand bg-brand/10 text-brand'
            : matched
            ? 'ring-2 ring-brand bg-brand/5 text-brand'
            : 'bg-slate-50 text-slate-300 hover:bg-slate-100 hover:text-slate-500'
        }`}
      >
        {matched ? '0' : selected ? '?' : '—'}
      </button>
    );
  }
  const low = qty <= 2;
  return (
    <button
      type="button"
      onClick={onClick}
      title="Clique pra filtrar outras lojas por este tamanho/cor"
      className={`${base} text-base ${
        low
          ? 'bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-200'
          : 'bg-emerald-100 text-emerald-900 border border-emerald-300 hover:bg-emerald-200'
      } ${selected ? 'ring-2 ring-brand shadow-md scale-[1.02]' : matched ? 'ring-2 ring-brand' : ''}`}
    >
      {qty}
      {matched && <Barcode className="w-3 h-3 absolute top-0.5 right-0.5 text-brand" />}
    </button>
  );
}

function CellLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3 mt-2 px-1 text-[11px] text-slate-500">
      <span className="inline-flex items-center gap-1">
        <span className="w-3 h-3 rounded bg-emerald-100 border border-emerald-300 inline-block" />
        disponível
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="w-3 h-3 rounded bg-amber-100 border border-amber-300 inline-block" />
        acabando (≤2)
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="w-3 h-3 rounded bg-slate-50 border border-slate-200 inline-block" />
        sem estoque
      </span>
      <span className="inline-flex items-center gap-1 text-brand">
        <Barcode className="w-3 h-3" /> etiqueta bipada
      </span>
    </div>
  );
}

function OtherStoreRow({
  store, refCode, selectedColor, selectedSize,
}: {
  store: OtherStore;
  refCode: string;
  selectedColor?: string | null;
  selectedSize?: string | null;
}) {
  const [open, setOpen] = useState(false);

  const waHref = useMemo(() => {
    if (!store.whatsapp) return null;
    const onlyDigits = store.whatsapp.replace(/\D/g, '');
    if (onlyDigits.length < 10) return null;
    const colorPart = selectedColor ? ` na cor ${selectedColor}` : '';
    const sizePart = selectedSize ? ` no tamanho ${selectedSize}` : '';
    const tamsMsg = store.variants
      .slice()
      .sort((a, b) => sortSizes(a.tamanho, b.tamanho))
      .map((v) => `${v.tamanho} (×${v.qty})`)
      .join(', ');
    const msg = encodeURIComponent(
      selectedSize
        ? `Oi! Tem a REF ${refCode}${colorPart}${sizePart}? (${tamsMsg}) Pode transferir pra minha loja?`
        : `Oi! Tem a REF ${refCode}${colorPart} pra transferir pra minha loja? Tamanhos: ${tamsMsg}`,
    );
    return `https://wa.me/${onlyDigits.startsWith('55') ? onlyDigits : '55' + onlyDigits}?text=${msg}`;
  }, [store, refCode, selectedColor, selectedSize]);

  return (
    <div className={`bg-white rounded-lg border p-3 ${selectedSize ? 'border-brand/40 ring-1 ring-brand/10' : 'border-slate-200'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-bold text-slate-800 text-sm truncate">{store.name}</div>
          <div className="text-xs text-slate-500">
            <strong className="text-slate-800">{store.qty}</strong> peça(s)
            {selectedColor && <> · <span className="text-brand font-medium">{selectedColor}</span></>}
            {selectedSize && <> · <span className="text-brand font-medium">tam {selectedSize}</span></>}
          </div>
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
          {store.variants.slice().sort((a, b) => sortSizes(a.tamanho, b.tamanho)).map((v) => {
            const isTheOne = selectedSize && (v.tamanho || '—').trim() === selectedSize;
            return (
              <span
                key={v.sku}
                className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                  isTheOne
                    ? 'bg-brand/15 border border-brand/40 text-brand'
                    : 'bg-slate-100 border border-slate-200 text-slate-700'
                }`}
              >
                {v.tamanho || '—'}{!selectedColor && v.cor ? ` · ${v.cor}` : ''} <span className="text-slate-400">×{v.qty}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
