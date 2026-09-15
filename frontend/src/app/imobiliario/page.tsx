'use client';

/**
 * /imobiliario — Hub principal do módulo IMOBILIÁRIO.
 *
 * Visual SEMÁFORO (15/09/2026): cinza e grafite, cor só pra pendência.
 *  - As contagens do dashboard viram ABAS de situação (filtram a lista).
 *  - A lista é uma folha só com colunas fixas: os 5 documentos lado a lado,
 *    ✓ discreto quando existe e "falta" em âmbar quando não — dá pra correr o
 *    olho pela coluna e ver quem está sem Escritura, por exemplo.
 *  - IPTU mostra a data: âmbar se vence em até 30 dias, vermelho se já venceu.
 *  - Mobile tem layout próprio (filtros recolhíveis, imóvel em bloco).
 *
 * ⚠️ Sem `sticky`: o `overflow-x: hidden` do html/body (globals.css) desliga
 * sticky no app inteiro — o cabeçalho antigo "fixo" rolava junto.
 *
 * Acesso: roles admin, imobiliario_admin, imobiliario_user, imobiliario_viewer.
 * Click numa linha abre /imobiliario/[id] (painel individual).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Building2, Plus, Search, Loader2, AlertCircle, FileText, AlertTriangle,
  Archive, ArrowLeft, Check, ChevronRight, SlidersHorizontal, X,
} from 'lucide-react';
import { api } from '@/lib/api';

type Property = {
  id: string;
  name: string;
  endereco: string | null;
  numero: string | null;
  bairro: string | null;
  cidade: string | null;
  estado: string | null;
  status: string;
  proprietario: string | null;
  observacoes: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  anexosCount: number;
  taxasCount: number;
  docsFaltandoCount: number;
  docsFaltando: string[];
  iptuVencendo: boolean;
  /** já vem na resposta da lista (include do Prisma) */
  iptu?: { dataVencimento: string | null; situacao: string | null } | null;
};

type Dashboard = {
  total: number;
  ativos: number;
  em_construcao: number;
  pronta_locacao: number;
  vendidos: number;
  inativos: number;
  totalAnexos: number;
  docsFaltando: number;
  iptuPendente: number;
  iptuVencendo: number;
};

const STATUS_OPTIONS = [
  { value: 'ativo', label: 'Ativo', aba: 'Ativos', desc: 'em operação', conta: (d: Dashboard) => d.ativos },
  { value: 'em_construcao', label: 'Em construção', aba: 'Em construção', desc: 'obra em andamento', conta: (d: Dashboard) => d.em_construcao },
  { value: 'pronta_locacao', label: 'Pronta p/ locação', aba: 'Pronta p/ locação', desc: 'disponível', conta: (d: Dashboard) => d.pronta_locacao },
  { value: 'vendido', label: 'Vendido', aba: 'Vendidos', desc: 'histórico', conta: (d: Dashboard) => d.vendidos },
  { value: 'inativo', label: 'Inativo', aba: 'Inativos', desc: 'fora de operação', conta: (d: Dashboard) => d.inativos },
];

const statusLabel = (s: string) => STATUS_OPTIONS.find((o) => o.value === s)?.label || s;

/** Mesma ordem e nomes que o backend usa em `docsFaltando`. */
const DOCS = ['Água', 'Energia', 'IPTU', 'Matrícula', 'Escritura'];

/* ── IPTU: a data é só-dia gravada à meia-noite UTC → compara pela parte UTC ── */
function hojeBrasilia(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

type IptuAviso = { texto: string; tom: 'crit' | 'warn' } | null;

function avisoIptu(p: Property): IptuAviso {
  if (!p.iptuVencendo) return null;
  const iso = p.iptu?.dataVencimento ? new Date(p.iptu.dataVencimento).toISOString().slice(0, 10) : null;
  if (!iso) return { texto: 'vencendo', tom: 'warn' };
  const hoje = hojeBrasilia();
  const [a, m, d] = iso.split('-');
  const data = a === hoje.slice(0, 4) ? `${d}/${m}` : `${d}/${m}/${a}`;
  if (iso < hoje) return { texto: `venceu ${data}`, tom: 'crit' };
  if (iso === hoje) return { texto: 'vence hoje', tom: 'warn' };
  return { texto: `vence ${data}`, tom: 'warn' };
}

function estadoLinha(p: Property): 'crit' | 'warn' | null {
  if (avisoIptu(p)?.tom === 'crit') return 'crit';
  if (p.docsFaltandoCount > 0 || p.iptuVencendo) return 'warn';
  return null;
}

function enderecoDe(p: Property): string {
  const rua = [p.endereco, p.numero].filter(Boolean).join(', ');
  const local = [p.bairro, [p.cidade, p.estado].filter(Boolean).join('/')].filter(Boolean).join(', ');
  return [rua, local].filter(Boolean).join(', ');
}

const FAIXA: Record<'crit' | 'warn', string> = {
  crit: 'before:bg-crit',
  warn: 'before:bg-warn',
};

const CAMPO =
  'w-full rounded-field border border-line bg-surface px-3 py-2 text-[14px] text-ink ' +
  'placeholder:text-ink-faint focus:border-action focus:outline-none focus:ring-2 focus:ring-action';

/* colunas do desktop — cabeçalho e linhas usam o MESMO molde */
const GRADE =
  'lg:grid lg:grid-cols-[minmax(0,1fr)_128px_60px_64px_72px_104px_80px_80px_60px_16px] lg:items-center lg:gap-x-3';

export default function ImobiliarioPage() {
  const router = useRouter();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [properties, setProperties] = useState<Property[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [search, setSearch] = useState('');
  const [cidade, setCidade] = useState('');
  const [bairro, setBairro] = useState('');
  const [status, setStatus] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [searchDebounce, setSearchDebounce] = useState('');
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const pedido = useRef(0);

  // Auth check
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login?redirect=/imobiliario');
      return;
    }
    api<{ role: string; name: string; email?: string }>('/auth/me')
      .then((me) => {
        // SUPREMO: módulo Imobiliário restrito a este e-mail (acima de admin).
        if (String(me.email || '').trim().toLowerCase() !== 'trissutto@gmail.com') {
          alert('Você não tem acesso ao módulo Imobiliário.');
          router.push('/');
        }
      })
      .catch(() => router.push('/login?redirect=/imobiliario'));
  }, [router]);

  // Debounce do search
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounce(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const fetchData = useCallback(async () => {
    const meu = ++pedido.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (searchDebounce.trim()) params.set('search', searchDebounce.trim());
      if (cidade.trim()) params.set('cidade', cidade.trim());
      if (bairro.trim()) params.set('bairro', bairro.trim());
      if (status) params.set('status', status);
      if (showArchived) params.set('arquivados', 'true');

      const [d, list] = await Promise.all([
        api<Dashboard>('/properties/dashboard'),
        api<Property[]>(`/properties?${params}`),
      ]);
      if (meu !== pedido.current) return; // resposta velha: outro filtro já pediu
      setDashboard(d);
      setProperties(list);
    } catch (e: any) {
      if (meu !== pedido.current) return;
      setError(e?.message || 'Erro ao carregar imóveis');
    } finally {
      if (meu === pedido.current) setLoading(false);
    }
  }, [searchDebounce, cidade, bairro, status, showArchived]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const limparFiltros = () => {
    setSearch('');
    setCidade('');
    setBairro('');
    setStatus('');
    setShowArchived(false);
  };

  const filtrosLigados = !!(search || cidade || bairro || status || showArchived);
  const extrasLigados = [cidade, bairro, showArchived].filter(Boolean).length;
  const primeiraCarga = loading && properties === null;

  return (
    <div className="min-h-screen bg-ground text-ink">
      {/* Cabeçalho */}
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[1280px] items-center gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <Link
            href="/"
            className="-ml-1 rounded-field p-2 text-ink-soft transition-colors hover:bg-line-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action"
            title="Voltar pro hub principal"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-[19px] font-semibold tracking-[-.02em] sm:text-[21px]">
              <Building2 className="hidden h-5 w-5 text-ink-soft sm:block" />
              Imobiliário
            </h1>
            <p className="truncate text-[12px] text-ink-soft sm:text-[13px]">Gestão de imóveis · documentos · taxas</p>
          </div>
          <Link
            href="/imobiliario/novo"
            className="inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-field bg-action px-4 text-[14px] font-semibold text-action-ink transition hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2"
          >
            <Plus className="h-4 w-4" />
            <span className="sm:hidden">Novo</span>
            <span className="hidden sm:inline">Novo imóvel</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[1280px] px-4 py-4 sm:px-6 sm:py-6">
        {/* Pendências do portfólio */}
        {dashboard && (
          <div
            className={`mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[14px] ${
              dashboard.docsFaltando + dashboard.iptuVencendo > 0 ? 'text-warn' : 'text-ink-soft'
            }`}
          >
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="h-4 w-4" />
              <span className="tabular-nums">{dashboard.docsFaltando}</span> documentos pendentes
            </span>
            <span className="font-semibold" title="IPTU com vencimento nos próximos 30 dias ou já vencido">
              <span className="tabular-nums">{dashboard.iptuVencendo}</span> IPTU vencendo
            </span>
          </div>
        )}

        <section className="overflow-hidden rounded-card border border-line bg-surface">
          {/* Abas de situação = contagens do portfólio */}
          <div className="flex gap-1 overflow-x-auto border-b border-line px-2 py-2 [scrollbar-width:none] sm:px-3" role="tablist" aria-label="Filtrar por situação">
            {[{ value: '', aba: 'Todos', desc: 'imóveis no portfólio', conta: (d: Dashboard) => d.total }, ...STATUS_OPTIONS].map((o) => {
              const ativo = status === o.value;
              return (
                <button
                  key={o.value || 'todos'}
                  type="button"
                  role="tab"
                  aria-selected={ativo}
                  onClick={() => setStatus(o.value)}
                  title={dashboard ? `${o.conta(dashboard)} ${o.desc}` : o.desc}
                  className={`inline-flex min-h-[40px] shrink-0 items-center gap-2 rounded-field px-3 text-[14px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action ${
                    ativo ? 'bg-action font-semibold text-action-ink' : 'text-ink-soft hover:bg-line-soft hover:text-ink'
                  }`}
                >
                  {o.aba}
                  <span className={`tabular-nums text-[13px] ${ativo ? 'text-action-ink/80' : 'font-semibold text-ink'}`}>
                    {dashboard ? o.conta(dashboard) : '–'}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Busca + filtros */}
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-3 sm:px-4">
            <div className="relative min-w-0 flex-1 sm:min-w-[260px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nome, endereço, proprietário..."
                aria-label="Buscar imóvel"
                className={`${CAMPO} pl-9`}
              />
            </div>
            <button
              type="button"
              onClick={() => setFiltrosAbertos((v) => !v)}
              aria-expanded={filtrosAbertos}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-field border border-line px-3 text-[14px] text-ink sm:hidden"
            >
              <SlidersHorizontal className="h-4 w-4" />
              Filtros
              {extrasLigados > 0 && (
                <span className="rounded-full bg-action px-1.5 text-[12px] font-semibold text-action-ink tabular-nums">{extrasLigados}</span>
              )}
            </button>
            <div className={`${filtrosAbertos ? 'grid' : 'hidden'} w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center`}>
              <input
                type="text"
                value={cidade}
                onChange={(e) => setCidade(e.target.value)}
                placeholder="Cidade"
                aria-label="Cidade"
                className={`${CAMPO} sm:w-40`}
              />
              <input
                type="text"
                value={bairro}
                onChange={(e) => setBairro(e.target.value)}
                placeholder="Bairro"
                aria-label="Bairro"
                className={`${CAMPO} sm:w-40`}
              />
              <label className="col-span-2 inline-flex min-h-[40px] cursor-pointer items-center gap-2 rounded-field px-2 text-[14px] text-ink-soft hover:text-ink">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                  className="h-4 w-4 accent-[#2B2D31]"
                />
                Mostrar arquivados
              </label>
              <button
                type="button"
                onClick={limparFiltros}
                disabled={!filtrosLigados}
                className="col-span-2 inline-flex min-h-[40px] items-center justify-center gap-1 rounded-field px-3 text-[14px] text-ink-soft transition-colors hover:bg-line-soft hover:text-ink disabled:pointer-events-none disabled:opacity-40"
              >
                <X className="h-4 w-4" />
                Limpar
              </button>
            </div>
          </div>

          {/* Lista */}
          {primeiraCarga ? (
            <div className="p-16 text-center">
              <Loader2 className="mx-auto h-7 w-7 animate-spin text-ink-faint" />
              <div className="mt-3 text-[14px] text-ink-soft">Carregando imóveis...</div>
            </div>
          ) : error ? (
            <div className="p-12 text-center">
              <AlertCircle className="mx-auto h-9 w-9 text-crit" />
              <div className="mt-3 text-[15px] font-semibold text-ink">{error}</div>
              <button
                onClick={fetchData}
                className="mt-4 inline-flex min-h-[44px] items-center rounded-field bg-action px-4 text-[14px] font-semibold text-action-ink hover:brightness-125"
              >
                Tentar novamente
              </button>
            </div>
          ) : !properties || properties.length === 0 ? (
            <div className="p-16 text-center">
              <Building2 className="mx-auto h-10 w-10 text-ink-faint" />
              <div className="mt-3 text-[15px] font-semibold text-ink">Nenhum imóvel encontrado</div>
              <div className="mt-1 text-[13px] text-ink-soft">
                {search || cidade || bairro || status
                  ? 'Tente ajustar os filtros'
                  : 'Comece cadastrando seu primeiro imóvel'}
              </div>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {filtrosLigados && (
                  <button
                    onClick={limparFiltros}
                    className="inline-flex min-h-[44px] items-center rounded-field border border-line px-4 text-[14px] font-semibold text-ink hover:bg-line-soft"
                  >
                    Limpar filtros
                  </button>
                )}
                <Link
                  href="/imobiliario/novo"
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-field bg-action px-4 text-[14px] font-semibold text-action-ink hover:brightness-125"
                >
                  <Plus className="h-4 w-4" />
                  {filtrosLigados ? 'Novo imóvel' : 'Cadastrar primeiro imóvel'}
                </Link>
              </div>
            </div>
          ) : (
            <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={loading}>
              {/* Cabeçalho das colunas (desktop) */}
              <div className={`hidden border-b border-line bg-surface-2 py-2 pl-6 pr-4 text-[12px] font-medium text-ink-soft ${GRADE}`}>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-ink tabular-nums">{properties.length}</span>
                  {properties.length === 1 ? 'imóvel' : 'imóveis'}
                  {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                </div>
                <div>Situação</div>
                <div className="text-right" title="Documentos que faltam cadastrar">Faltam</div>
                {DOCS.map((doc) => (
                  <div key={doc} className="text-center">{doc}</div>
                ))}
                <div className="text-right">Anexos</div>
                <div />
              </div>

              {/* Contador (mobile) */}
              <div className="flex items-center gap-2 border-b border-line-soft px-4 py-2 text-[13px] text-ink-soft lg:hidden">
                <span className="font-semibold text-ink tabular-nums">{properties.length}</span>
                {properties.length === 1 ? 'imóvel' : 'imóveis'}
                {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              </div>

              <ul className="divide-y divide-line-soft">
                {properties.map((p) => (
                  <li key={p.id}>
                    <LinhaImovel p={p} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Linha do imóvel — uma Link só (ctrl+clique abre em aba nova)
// ─────────────────────────────────────────────────────────────────────────
function LinhaImovel({ p }: { p: Property }) {
  const isArchived = !!p.archivedAt;
  const estado = estadoLinha(p);
  const iptu = avisoIptu(p);
  const endereco = enderecoDe(p);
  const faltando = new Set(p.docsFaltando);
  const faltaFora = p.docsFaltando.filter((doc) => !DOCS.includes(doc));

  return (
    <Link
      href={`/imobiliario/${p.id}`}
      className={`group relative block py-3 pl-6 pr-4 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-action ${
        isArchived ? 'bg-surface-2' : ''
      } ${estado ? `before:absolute before:bottom-3 before:left-2 before:top-3 before:w-[3px] before:rounded-full before:content-[''] ${FAIXA[estado]}` : ''} ${GRADE}`}
    >
      {/* Imóvel */}
      <div className="min-w-0 pr-6 lg:pr-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`text-[15px] font-semibold leading-snug lg:truncate ${isArchived ? 'text-ink-soft' : 'text-ink'}`}>
            {p.name}
          </span>
          {isArchived && (
            <span className="inline-flex items-center gap-1 rounded-field bg-line-soft px-1.5 py-0.5 text-[12px] font-medium text-ink-soft">
              <Archive className="h-3 w-3" />
              Arquivado
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[13px] leading-snug text-ink-soft lg:truncate">{endereco || '—'}</div>

        {/* Mobile: situação + pendências em texto */}
        <div className="mt-2 flex flex-col gap-1 text-[13px] lg:hidden">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-soft">
            <span className="font-medium text-ink">{statusLabel(p.status)}</span>
            {p.anexosCount > 0 && (
              <span className="inline-flex items-center gap-1" title="Anexos">
                <FileText className="h-3.5 w-3.5" />
                {p.anexosCount} {p.anexosCount === 1 ? 'anexo' : 'anexos'}
              </span>
            )}
          </div>
          {p.docsFaltandoCount > 0 && (
            <span className="font-semibold text-warn">
              {p.docsFaltandoCount === 1 ? 'Falta' : `Faltam ${p.docsFaltandoCount}`}: {p.docsFaltando.join(', ')}
            </span>
          )}
          {iptu && (
            <span className={`font-semibold ${iptu.tom === 'crit' ? 'text-crit' : 'text-warn'}`}>IPTU {iptu.texto}</span>
          )}
          {p.docsFaltandoCount === 0 && !iptu && <span className="text-ink-faint">Documentos em dia</span>}
        </div>
        <ChevronRight className="absolute right-3 top-4 h-5 w-5 text-ink-faint lg:hidden" />
      </div>

      {/* Desktop: colunas */}
      <div className="hidden text-[14px] text-ink-soft lg:block">{statusLabel(p.status)}</div>
      <div
        className={`hidden text-right text-[14px] tabular-nums lg:block ${p.docsFaltandoCount > 0 ? 'font-semibold text-warn' : 'text-ink-faint'}`}
        title={p.docsFaltandoCount > 0 ? `Faltando: ${p.docsFaltando.join(', ')}` : undefined}
      >
        {p.docsFaltandoCount > 0 ? p.docsFaltandoCount : '—'}
        {faltaFora.length > 0 && <span className="sr-only"> ({faltaFora.join(', ')})</span>}
      </div>
      {DOCS.map((doc) => (
        <div key={doc} className="hidden justify-center lg:flex">
          {faltando.has(doc) ? (
            <span className="rounded-field bg-warn-soft px-1.5 py-0.5 text-[12px] font-semibold text-warn">falta</span>
          ) : doc === 'IPTU' && iptu ? (
            <span
              className={`whitespace-nowrap rounded-field px-1.5 py-0.5 text-[12px] font-semibold ${
                iptu.tom === 'crit' ? 'bg-crit-soft text-crit' : 'bg-warn-soft text-warn'
              }`}
            >
              {iptu.texto}
            </span>
          ) : (
            <Check className="h-4 w-4 text-ink-faint" aria-label={`${doc} ok`} />
          )}
        </div>
      ))}
      <div className="hidden items-center justify-end gap-1 text-[13px] text-ink-soft tabular-nums lg:flex" title="Anexos">
        {p.anexosCount > 0 && (
          <>
            <FileText className="h-3.5 w-3.5" />
            {p.anexosCount}
          </>
        )}
      </div>
      <ChevronRight className="hidden h-4 w-4 text-ink-faint transition-colors group-hover:text-ink lg:block" />
    </Link>
  );
}
