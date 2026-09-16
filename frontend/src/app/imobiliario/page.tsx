'use client';

/**
 * /imobiliario — Hub principal do módulo IMOBILIÁRIO.
 *
 * ORDER ONE · Executive Operations UI (15/09/2026) — primeira tela da
 * linguagem enterprise: casca navy (EnterpriseShell), faixa de indicadores,
 * abas com sublinhado, busca protagonista, filtros em popover e tabela densa
 * com barra de risco. Tokens `oo-*` no tailwind.config.ts.
 *
 * Tudo que aparece JÁ vem de /properties e /properties/dashboard:
 *  - documentos = `docsFaltando` (Água, Energia, IPTU, Matrícula, Escritura);
 *  - IPTU = `iptu.dataVencimento` + flag `iptuVencendo` (vence em até 30 dias
 *    OU já venceu — regra do backend); os DIAS saem da própria data.
 *  - "Com pendência" é recorte da lista carregada, não regra nova.
 *
 * ⚠️ Sem `sticky`: o `overflow-x: hidden` do html/body (globals.css) desliga
 * sticky no app inteiro.
 *
 * Acesso: roles admin, imobiliario_admin, imobiliario_user, imobiliario_viewer.
 * Click numa linha abre /imobiliario/[id] (painel individual).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, Archive, Building2, ChevronDown, ChevronRight, FileText,
  ListFilter, Plus, RotateCw, Search, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { podeVerImoveis, type MeSupremo } from '@/lib/supremo';
import EnterpriseShell from '@/components/enterprise/EnterpriseShell';
import PageHeader from '@/components/enterprise/PageHeader';
import MetricStrip, { BarraSegmentos } from '@/components/enterprise/MetricStrip';
import {
  DocumentStatus, EmptyState, RiskBar, StatusIndicator,
  type EstadoDoc, type Risco, type TomStatus,
} from '@/components/enterprise/Indicators';

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

const STATUS: { value: string; label: string; aba: string; tom: TomStatus; conta: (d: Dashboard) => number }[] = [
  { value: 'ativo', label: 'Ativo', aba: 'Ativos', tom: 'success', conta: (d) => d.ativos },
  { value: 'em_construcao', label: 'Em construção', aba: 'Em construção', tom: 'info', conta: (d) => d.em_construcao },
  { value: 'pronta_locacao', label: 'Pronta p/ locação', aba: 'Para locação', tom: 'neutral', conta: (d) => d.pronta_locacao },
  { value: 'vendido', label: 'Vendido', aba: 'Vendidos', tom: 'muted', conta: (d) => d.vendidos },
  { value: 'inativo', label: 'Inativo', aba: 'Inativos', tom: 'muted', conta: (d) => d.inativos },
];
const ABAS = [{ value: '', aba: 'Todos', conta: (d: Dashboard) => d.total }, ...STATUS];
const statusDe = (s: string) => STATUS.find((o) => o.value === s) || { label: s, tom: 'muted' as TomStatus };

/** Mesma ordem e nomes que o backend usa em `docsFaltando`. */
const DOCS = ['Água', 'Energia', 'IPTU', 'Matrícula', 'Escritura'];
const MESES = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];

/* ── IPTU: data só-dia gravada à meia-noite UTC → compara pela parte UTC ── */
function hojeBrasilia(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

type LeituraIptu = {
  rotulo: string;
  detalhe: string;
  tom: 'danger' | 'warning' | 'success' | 'neutral' | 'muted';
  risco: Risco;
};

/**
 * IPTU = DATA + SITUAÇÃO CADASTRADA (em_dia | em_atraso | parcelado).
 *
 * ⚠️ Data passada NÃO é atraso. Em produção (15/09) 11 de 12 IPTU "vencendo"
 * tinham a data do carnê de janeiro com situação "em dia" — pintar tudo de
 * vermelho foi alarme falso ("12 críticos" com só 1 em atraso de verdade).
 * Crítico é SÓ a situação `em_atraso`. Data passada sem situação informada é
 * atenção (alguém precisa confirmar), nunca crítico.
 */
function lerIptu(p: Property): LeituraIptu {
  if (p.docsFaltando.includes('IPTU')) return { rotulo: 'Sem cadastro', detalhe: 'não registrado', tom: 'warning', risco: 'atencao' };
  const situacao = p.iptu?.situacao || null;
  const iso = p.iptu?.dataVencimento ? new Date(p.iptu.dataVencimento).toISOString().slice(0, 10) : null;

  let data = '';
  let dias = 0;
  if (iso) {
    const hoje = hojeBrasilia();
    const [a, m, d] = iso.split('-').map(Number);
    const [ha, hm, hd] = hoje.split('-').map(Number);
    dias = Math.round((Date.UTC(a, m - 1, d) - Date.UTC(ha, hm - 1, hd)) / 86_400_000);
    data = `${String(d).padStart(2, '0')} ${MESES[m - 1]}${a !== ha ? ` ${a}` : ''}`;
  }
  const plural = (n: number) => `${n} ${n === 1 ? 'dia' : 'dias'}`;

  if (situacao === 'em_atraso') {
    return {
      rotulo: 'Em atraso',
      detalhe: !iso ? 'situação cadastrada' : dias < 0 ? `venc. ${data} · há ${plural(-dias)}` : `venc. ${data}`,
      tom: 'danger',
      risco: 'critico',
    };
  }
  if (!iso) {
    if (situacao === 'em_dia') return { rotulo: 'Em dia', detalhe: 'sem data de vencimento', tom: 'success', risco: null };
    if (situacao === 'parcelado') return { rotulo: 'Parcelado', detalhe: 'sem data de vencimento', tom: 'neutral', risco: null };
    return { rotulo: 'Sem vencimento', detalhe: 'data não informada', tom: 'muted', risco: null };
  }
  if (dias < 0) {
    if (situacao === 'em_dia') return { rotulo: 'Em dia', detalhe: `último venc. ${data}`, tom: 'success', risco: null };
    if (situacao === 'parcelado') return { rotulo: 'Parcelado', detalhe: `venc. ${data}`, tom: 'neutral', risco: null };
    return { rotulo: 'Data vencida', detalhe: `${data} · situação não informada`, tom: 'warning', risco: 'atencao' };
  }
  if (dias === 0) return { rotulo: 'Vence hoje', detalhe: data, tom: 'warning', risco: 'atencao' };
  if (p.iptuVencendo) return { rotulo: 'A vencer', detalhe: `${data} · em ${plural(dias)}`, tom: 'warning', risco: 'atencao' };
  return {
    rotulo: situacao === 'parcelado' ? 'Parcelado' : situacao === 'em_dia' ? 'Em dia' : 'Vence',
    detalhe: `venc. ${data} · em ${plural(dias)}`,
    tom: situacao === 'em_dia' ? 'success' : 'neutral',
    risco: null,
  };
}

function riscoDe(p: Property, iptu: LeituraIptu): Risco {
  if (iptu.risco === 'critico') return 'critico';
  if (p.docsFaltandoCount > 0 || iptu.risco === 'atencao') return 'atencao';
  return null;
}

function docsDe(p: Property, iptu: LeituraIptu): { nome: string; estado: EstadoDoc; nota?: string }[] {
  const faltando = new Set(p.docsFaltando);
  const lista = DOCS.map((nome) => {
    if (faltando.has(nome)) return { nome, estado: 'pendente' as EstadoDoc };
    if (nome === 'IPTU' && iptu.risco === 'critico') return { nome, estado: 'vencido' as EstadoDoc, nota: `${iptu.rotulo.toLowerCase()} · ${iptu.detalhe}` };
    if (nome === 'IPTU' && iptu.risco === 'atencao') return { nome, estado: 'pendente' as EstadoDoc, nota: `${iptu.rotulo.toLowerCase()} · ${iptu.detalhe}` };
    return { nome, estado: 'ok' as EstadoDoc };
  });
  /* documento que o backend venha a criar e a tela ainda não conhece */
  for (const nome of p.docsFaltando) if (!DOCS.includes(nome)) lista.push({ nome, estado: 'pendente' });
  return lista;
}

const TOM_IPTU = {
  danger: 'text-oo-danger',
  warning: 'text-oo-warning',
  success: 'text-oo-success',
  neutral: 'text-oo-ink-2',
  muted: 'text-oo-muted',
};

/* colunas do desktop — cabeçalho e linhas usam o MESMO molde */
const GRADE =
  'lg:grid lg:items-center lg:gap-x-5 lg:grid-cols-[minmax(0,1fr)_148px_196px_172px_64px_20px] ' +
  'xl:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_156px_196px_188px_72px_20px]';

const BTN_PRIMARIO =
  'inline-flex h-10 items-center gap-2 rounded-md bg-oo-primary px-4 text-[14px] font-semibold text-white ' +
  'transition-colors duration-150 hover:bg-oo-primary-hover active:translate-y-px ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-primary focus-visible:ring-offset-2';
const BTN_SECUNDARIO =
  'inline-flex h-10 items-center gap-2 rounded-md border border-oo-line-strong bg-oo-surface px-3.5 text-[14px] font-medium text-oo-ink ' +
  'transition-colors duration-150 hover:bg-oo-subtle active:translate-y-px ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-primary';
const CAMPO =
  'h-10 w-full rounded-md border border-oo-line-strong bg-oo-surface px-3 text-[14px] font-medium text-oo-ink ' +
  'placeholder:font-normal placeholder:text-oo-muted transition-shadow duration-150 ' +
  'focus:border-oo-primary focus:outline-none focus:ring-[3px] focus:ring-oo-primary/15';

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
  const [soPendencias, setSoPendencias] = useState(false);
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const pedido = useRef(0);
  const popover = useRef<HTMLDivElement>(null);
  const busca = useRef<HTMLInputElement>(null);

  // Atalho '/' foca a busca (fora de campo de texto)
  useEffect(() => {
    const atalho = (e: KeyboardEvent) => {
      const alvo = e.target as HTMLElement | null;
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (alvo && alvo.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      busca.current?.focus();
    };
    document.addEventListener('keydown', atalho);
    return () => document.removeEventListener('keydown', atalho);
  }, []);

  // Auth check
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login?redirect=/imobiliario');
      return;
    }
    api<{ role: string; name: string } & MeSupremo>('/auth/me')
      .then((me) => {
        // SUPREMO: módulo Imobiliário restrito à lista do backend (acima de admin).
        if (!podeVerImoveis(me)) {
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

  // Popover de filtros fecha no clique fora e no Esc
  useEffect(() => {
    if (!filtrosAbertos) return;
    const fora = (e: MouseEvent) => {
      if (popover.current && !popover.current.contains(e.target as Node)) setFiltrosAbertos(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setFiltrosAbertos(false);
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', fora);
      document.removeEventListener('keydown', esc);
    };
  }, [filtrosAbertos]);

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
    setSoPendencias(false);
  };

  const linhas = useMemo(
    () =>
      (properties || []).map((p) => {
        const iptu = lerIptu(p);
        return { p, iptu, risco: riscoDe(p, iptu), docs: docsDe(p, iptu) };
      }),
    [properties],
  );
  const comPendencia = linhas.filter((l) => l.risco).length;
  const criticas = linhas.filter((l) => l.risco === 'critico').length;
  const visiveis = soPendencias ? linhas.filter((l) => l.risco) : linhas;

  const extras = [cidade, bairro, showArchived].filter(Boolean).length;
  const filtrosLigados = !!(search || cidade || bairro || status || showArchived || soPendencias);
  const primeiraCarga = loading && properties === null;

  return (
    <EnterpriseShell trilha={[{ label: 'Início', href: '/' }, { label: 'Imobiliário' }]}>
      {/* Faixa de comando: título + inteligência operacional sobre o navy da casca */}
      <div className="bg-oo-nav pb-16 sm:pb-20">
        <div className="mx-auto w-full max-w-[2400px] px-4 pt-6 sm:px-6 sm:pt-8 2xl:px-12">
          <PageHeader
            escuro
            icone={<Building2 className="h-5 w-5" />}
            titulo="Imobiliário"
            subtitulo="Gestão de imóveis · documentos · taxas"
            acoes={
              <Link href="/imobiliario/novo" className={`${BTN_PRIMARIO} focus-visible:ring-offset-oo-nav`}>
                <Plus className="h-4 w-4" strokeWidth={2.5} />
                Novo imóvel
              </Link>
            }
          />

          <div className="mt-6 sm:mt-8">
            <MetricStrip
              escuro
              carregando={!dashboard}
              metricas={
                dashboard
                  ? [
                      {
                        rotulo: 'Imóveis',
                        valor: dashboard.total,
                        title: 'imóveis no portfólio (sem arquivados)',
                        viz: (
                          <BarraSegmentos
                            escuro
                            partes={[
                              { valor: dashboard.ativos, cor: 'bg-[#47CD89]', title: `${dashboard.ativos} ativo(s)` },
                              { valor: dashboard.em_construcao, cor: 'bg-[#53B1FD]', title: `${dashboard.em_construcao} em construção` },
                              { valor: dashboard.pronta_locacao, cor: 'bg-slate-200', title: `${dashboard.pronta_locacao} pronta(s) p/ locação` },
                              { valor: dashboard.vendidos, cor: 'bg-slate-400', title: `${dashboard.vendidos} vendido(s)` },
                              { valor: dashboard.inativos, cor: 'bg-slate-600', title: `${dashboard.inativos} inativo(s)` },
                            ]}
                          />
                        ),
                        apoio: `${dashboard.ativos} ${dashboard.ativos === 1 ? 'ativo' : 'ativos'} · ${dashboard.em_construcao} em construção · ${dashboard.inativos} ${dashboard.inativos === 1 ? 'inativo' : 'inativos'}`,
                      },
                      {
                        rotulo: 'Documentos pendentes',
                        valor: dashboard.docsFaltando,
                        tom: dashboard.docsFaltando > 0 ? 'warning' : undefined,
                        title: 'Água, Energia, IPTU, Matrícula e Escritura não cadastrados',
                        viz: (
                          <BarraSegmentos
                            escuro
                            partes={[
                              { valor: dashboard.total * DOCS.length - dashboard.docsFaltando, cor: 'bg-white', title: 'cadastrados' },
                              { valor: dashboard.docsFaltando, cor: 'bg-[#FDB022]', title: 'pendentes' },
                            ]}
                          />
                        ),
                        apoio: `${dashboard.total * DOCS.length - dashboard.docsFaltando} de ${dashboard.total * DOCS.length} cadastrados`,
                      },
                      {
                        rotulo: 'IPTU pendente',
                        valor: dashboard.iptuPendente,
                        tom: dashboard.iptuPendente > 0 ? 'danger' : undefined,
                        apoio: 'sem cadastro ou em atraso',
                      },
                      {
                        rotulo: 'IPTU vencendo',
                        valor: dashboard.iptuVencendo,
                        tom: dashboard.iptuVencendo > 0 ? 'warning' : undefined,
                        apoio: 'data em até 30 dias ou já passou',
                        title: 'Conta a data do carnê, não a situação — veja a coluna IPTU',
                      },
                      {
                        rotulo: 'Anexos',
                        valor: dashboard.totalAnexos,
                        apoio: 'arquivos no portfólio',
                      },
                    ]
                  : ['Imóveis', 'Documentos pendentes', 'IPTU pendente', 'IPTU vencendo', 'Anexos'].map((rotulo) => ({ rotulo, valor: 0 }))
              }
            />
          </div>
        </div>
      </div>

      <main className="mx-auto -mt-10 w-full max-w-[2400px] px-4 pb-12 sm:-mt-12 sm:px-6 2xl:px-12">
        {/* Área de dados — folha sobreposta à faixa */}
        <section className="relative rounded-xl border border-oo-line bg-oo-surface shadow-[0_1px_2px_rgba(16,24,40,.06),0_8px_24px_-12px_rgba(16,24,40,.12)]">
          {/* Abas */}
          <div className="flex overflow-x-auto border-b border-oo-line px-2 [scrollbar-width:none] sm:px-4" role="tablist" aria-label="Filtrar por situação">
            {ABAS.map((o) => {
              const ativo = status === o.value;
              return (
                <button
                  key={o.value || 'todos'}
                  type="button"
                  role="tab"
                  aria-selected={ativo}
                  onClick={() => setStatus(o.value)}
                  className={`relative flex h-12 shrink-0 items-center gap-2 px-3 text-[13px] font-semibold uppercase tracking-[0.04em] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oo-primary ${
                    ativo ? 'text-oo-ink' : 'text-oo-muted hover:text-oo-ink'
                  }`}
                >
                  {o.aba}
                  <span
                    className={`rounded px-1.5 py-0.5 text-[12px] tabular-nums tracking-normal ${
                      ativo ? 'bg-oo-ink text-white' : 'bg-oo-hover text-oo-ink-2'
                    }`}
                  >
                    {dashboard ? o.conta(dashboard) : '–'}
                  </span>
                  {ativo && <span className="absolute inset-x-3 bottom-0 h-[2px] bg-oo-ink" />}
                </button>
              );
            })}
          </div>

          {/* Barra de busca e filtros */}
          <div className="flex flex-wrap items-center gap-2 border-b border-oo-line px-3 py-3 sm:px-4">
            <div className="relative min-w-0 flex-1 basis-full sm:basis-auto lg:max-w-[520px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-oo-muted" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar imóvel, endereço, proprietário"
                aria-label="Buscar por nome, endereço, proprietário"
                ref={busca}
                className={`${CAMPO} pl-9 sm:pr-9`}
              />
              <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-oo-line bg-oo-subtle px-1.5 py-px text-[11px] font-semibold text-oo-muted sm:block" title="Atalho: /">/</kbd>
            </div>

            <div ref={popover} className="relative">
              <button
                type="button"
                onClick={() => setFiltrosAbertos((v) => !v)}
                aria-expanded={filtrosAbertos}
                className={`${BTN_SECUNDARIO} ${extras > 0 ? 'border-oo-ink' : ''}`}
              >
                <ListFilter className="h-4 w-4" />
                Filtros
                {extras > 0 && (
                  <span className="grid h-5 min-w-[20px] place-items-center rounded bg-oo-ink px-1 text-[12px] font-semibold text-white tabular-nums">{extras}</span>
                )}
                <ChevronDown className={`h-4 w-4 text-oo-muted transition-transform duration-150 ${filtrosAbertos ? 'rotate-180' : ''}`} />
              </button>
              {filtrosAbertos && (
                <div className="absolute left-0 top-full z-30 mt-2 w-[min(320px,calc(100vw-32px))] rounded-lg border border-oo-line bg-oo-surface p-4 shadow-oo-pop">
                  <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-oo-muted" htmlFor="f-cidade">Cidade</label>
                  <input id="f-cidade" type="text" value={cidade} onChange={(e) => setCidade(e.target.value)} placeholder="Itanhaém" className={`${CAMPO} mt-1.5`} />
                  <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.06em] text-oo-muted" htmlFor="f-bairro">Bairro</label>
                  <input id="f-bairro" type="text" value={bairro} onChange={(e) => setBairro(e.target.value)} placeholder="Centro" className={`${CAMPO} mt-1.5`} />
                  <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-[14px] font-medium text-oo-ink">
                    <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="h-4 w-4 accent-[#2563EB]" />
                    Mostrar arquivados
                  </label>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setSoPendencias((v) => !v)}
              aria-pressed={soPendencias}
              className={`${BTN_SECUNDARIO} ${soPendencias ? 'border-oo-ink bg-oo-ink text-white hover:bg-oo-nav-2' : ''}`}
            >
              <span className={`h-2 w-2 rounded-full ${soPendencias ? 'bg-white' : 'bg-oo-warning'}`} />
              Com pendência
              <span className={`text-[12px] tabular-nums ${soPendencias ? 'text-white/80' : 'text-oo-muted'}`}>{properties ? comPendencia : '–'}</span>
            </button>

            {/* Filtros ligados, visíveis sem abrir o popover */}
            {cidade && <Chip onRemover={() => setCidade('')}>Cidade: {cidade}</Chip>}
            {bairro && <Chip onRemover={() => setBairro('')}>Bairro: {bairro}</Chip>}
            {showArchived && <Chip onRemover={() => setShowArchived(false)}>Com arquivados</Chip>}

            <div className="ml-auto flex items-center gap-3">
              {filtrosLigados && (
                <button
                  type="button"
                  onClick={limparFiltros}
                  className="inline-flex h-10 items-center rounded-md px-2.5 text-[13px] font-semibold text-oo-primary transition-colors duration-150 hover:bg-oo-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-primary"
                >
                  Limpar
                </button>
              )}
              <span className="hidden text-[13px] font-medium text-oo-ink-2 sm:inline">
                <span className="font-semibold text-oo-ink tabular-nums">{properties ? visiveis.length : '–'}</span>{' '}
                {visiveis.length === 1 ? 'imóvel' : 'imóveis'}
                {criticas > 0 && (
                  <>
                    {' · '}
                    <span className="font-semibold text-oo-danger tabular-nums">{criticas}</span> {criticas === 1 ? 'crítico' : 'críticos'}
                  </>
                )}
              </span>
            </div>
          </div>

          {/* Progresso de atualização (não apaga a lista) */}
          <div className="relative h-0.5 overflow-hidden" aria-hidden="true">
            {loading && !primeiraCarga && <div className="absolute inset-y-0 w-1/3 animate-[oo-barra_1s_ease-in-out_infinite] bg-oo-primary" />}
          </div>

          {/* Tabela */}
          {error ? (
            <EmptyState
              icone={<AlertCircle className="h-5 w-5 text-oo-danger" />}
              titulo="Não foi possível carregar os imóveis"
              texto={error}
              acoes={
                <button onClick={fetchData} className={BTN_PRIMARIO}>
                  <RotateCw className="h-4 w-4" />
                  Tentar novamente
                </button>
              }
            />
          ) : (
            <div role="table" aria-label="Imóveis" aria-busy={loading}>
              <div
                role="row"
                className={`hidden border-b border-oo-line bg-oo-subtle py-2.5 pl-5 pr-4 text-[11px] font-semibold uppercase tracking-[0.06em] text-oo-ink-2 ${GRADE}`}
              >
                <span role="columnheader">Imóvel</span>
                <span role="columnheader" className="hidden xl:block">Proprietário</span>
                <span role="columnheader">Situação</span>
                <span role="columnheader" title="Água · Energia · IPTU · Matrícula · Escritura">Documentos</span>
                <span role="columnheader">IPTU</span>
                <span role="columnheader" className="text-right">Anexos</span>
                <span />
              </div>

              {primeiraCarga ? (
                <Esqueleto />
              ) : visiveis.length === 0 ? (
                <EmptyState
                  icone={<Building2 className="h-5 w-5" />}
                  titulo="Nenhum imóvel encontrado"
                  texto={
                    search || cidade || bairro || status || soPendencias
                      ? 'Tente ajustar os filtros'
                      : 'Comece cadastrando seu primeiro imóvel'
                  }
                  acoes={
                    <>
                      {filtrosLigados && (
                        <button onClick={limparFiltros} className={BTN_SECUNDARIO}>
                          Limpar filtros
                        </button>
                      )}
                      <Link href="/imobiliario/novo" className={BTN_PRIMARIO}>
                        <Plus className="h-4 w-4" strokeWidth={2.5} />
                        {filtrosLigados ? 'Novo imóvel' : 'Cadastrar primeiro imóvel'}
                      </Link>
                    </>
                  }
                />
              ) : (
                <div className="divide-y divide-oo-line">
                  {visiveis.map(({ p, iptu, risco, docs }) => (
                    <Linha key={p.id} p={p} iptu={iptu} risco={risco} docs={docs} />
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Legenda */}
        {!primeiraCarga && !error && (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-[12px] font-medium text-oo-ink-2">
            <span className="inline-flex items-center gap-2"><span className="h-3 w-[3px] rounded bg-oo-danger" />Crítico: IPTU em atraso (situação cadastrada)</span>
            <span className="inline-flex items-center gap-2"><span className="h-3 w-[3px] rounded bg-oo-warning" />Atenção: documento pendente, IPTU a vencer em 30 dias ou data vencida sem situação</span>
          </div>
        )}
      </main>
      <style>{`@keyframes oo-barra{0%{left:-33%}100%{left:100%}}`}</style>
    </EnterpriseShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Linha — uma Link só (ctrl+clique abre em aba nova)
// ─────────────────────────────────────────────────────────────────────────
function Linha({
  p,
  iptu,
  risco,
  docs,
}: {
  p: Property;
  iptu: LeituraIptu;
  risco: Risco;
  docs: { nome: string; estado: EstadoDoc; nota?: string }[];
}) {
  const st = statusDe(p.status);
  const arquivado = !!p.archivedAt;
  const rua = [p.endereco, p.numero].filter(Boolean).join(', ');
  const local = [p.bairro, [p.cidade, p.estado].filter(Boolean).join('/')].filter(Boolean).join(' · ');
  const okDocs = docs.length - p.docsFaltando.length; // cadastrados (IPTU a vencer continua cadastrado)

  return (
    <Link
      role="row"
      href={`/imobiliario/${p.id}`}
      className={`group relative block py-2.5 pl-5 pr-4 transition-colors duration-150 hover:bg-oo-subtle focus-visible:bg-oo-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oo-primary lg:min-h-[64px] ${
        arquivado ? 'bg-oo-subtle/60' : ''
      } ${GRADE}`}
    >
      <RiskBar risco={risco} />

      {/* Imóvel */}
      <div role="cell" className="min-w-0 pr-8 lg:pr-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] font-semibold tracking-[-0.005em] text-oo-ink">{p.name}</span>
          {arquivado && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded border border-oo-line-strong px-1.5 py-px text-[11px] font-semibold uppercase tracking-[0.04em] text-oo-ink-2">
              <Archive className="h-3 w-3" />
              Arquivado
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[12px] font-medium text-oo-muted">
          {rua || local ? (
            <>
              {rua}
              {rua && local ? <span className="text-oo-line-strong"> · </span> : null}
              {local}
            </>
          ) : (
            '—'
          )}
        </div>

        {/* Mobile: situação, documentos e IPTU numa faixa compacta */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 lg:hidden">
          <StatusIndicator tom={st.tom}>{st.label}</StatusIndicator>
          <DocumentStatus docs={docs} />
          <span className={`text-[12px] font-semibold ${TOM_IPTU[iptu.tom]}`}>
            IPTU {iptu.rotulo.toLowerCase()} <span className="font-medium text-oo-muted">{iptu.detalhe}</span>
          </span>
        </div>
        <ChevronRight className="absolute right-3 top-4 h-5 w-5 text-oo-muted lg:hidden" />
      </div>

      {/* Desktop */}
      <div role="cell" className="hidden min-w-0 truncate text-[13px] font-medium text-oo-ink-2 xl:block">{p.proprietario || '—'}</div>
      <div role="cell" className="hidden lg:block">
        <StatusIndicator tom={st.tom}>{st.label}</StatusIndicator>
      </div>
      <div role="cell" className="hidden items-center gap-3 lg:flex">
        <DocumentStatus docs={docs} />
        <span className={`text-[12px] font-semibold tabular-nums ${p.docsFaltandoCount > 0 ? 'text-oo-warning' : 'text-oo-muted'}`}>
          {okDocs}/{docs.length}
        </span>
      </div>
      <div role="cell" className="hidden min-w-0 lg:block" title={p.iptu?.situacao ? `Situação cadastrada: ${p.iptu.situacao.replace('_', ' ')}` : undefined}>
        <div className={`text-[11px] font-bold uppercase tracking-[0.06em] ${TOM_IPTU[iptu.tom]}`}>{iptu.rotulo}</div>
        <div className="mt-0.5 truncate text-[13px] font-medium text-oo-ink tabular-nums">{iptu.detalhe}</div>
      </div>
      <div role="cell" className="hidden items-center justify-end gap-1.5 text-[13px] font-semibold text-oo-ink tabular-nums lg:flex" title="Anexos">
        {p.anexosCount > 0 ? (
          <>
            <FileText className="h-3.5 w-3.5 text-oo-muted" />
            {p.anexosCount}
          </>
        ) : (
          <span className="font-medium text-oo-line-strong">—</span>
        )}
      </div>
      <ChevronRight className="hidden h-4 w-4 text-oo-line-strong transition-colors duration-150 group-hover:text-oo-ink lg:block" />
    </Link>
  );
}

function Chip({ children, onRemover }: { children: ReactNode; onRemover: () => void }) {
  return (
    <span className="inline-flex h-8 items-center gap-1 rounded-md border border-oo-line bg-oo-subtle pl-2.5 pr-1 text-[13px] font-medium text-oo-ink">
      {children}
      <button
        type="button"
        onClick={onRemover}
        aria-label="Remover filtro"
        className="grid h-6 w-6 place-items-center rounded text-oo-muted transition-colors hover:bg-oo-hover hover:text-oo-ink"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

function Esqueleto() {
  return (
    <div className="divide-y divide-oo-line" aria-label="Carregando imóveis...">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className={`py-3 pl-5 pr-4 lg:min-h-[64px] ${GRADE}`}>
          <div>
            <div className="h-3.5 w-48 animate-pulse rounded bg-oo-hover" />
            <div className="mt-2 h-3 w-72 max-w-full animate-pulse rounded bg-oo-hover" />
          </div>
          <div className="hidden h-3 w-24 animate-pulse rounded bg-oo-hover xl:block" />
          <div className="hidden h-3 w-20 animate-pulse rounded bg-oo-hover lg:block" />
          <div className="hidden h-6 w-36 animate-pulse rounded bg-oo-hover lg:block" />
          <div className="hidden h-7 w-28 animate-pulse rounded bg-oo-hover lg:block" />
          <div className="hidden h-3 w-6 animate-pulse justify-self-end rounded bg-oo-hover lg:block" />
          <span />
        </div>
      ))}
      <span className="sr-only">Carregando imóveis...</span>
    </div>
  );
}
