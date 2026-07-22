'use client';

/**
 * /retaguarda/comissoes
 *
 * Hub admin pra gestao de comissao. 3 abas:
 *   - Regras       — CRUD de regras (global/store/seller)
 *   - Fechamentos  — periodos mensais (open/closed/paid)
 *   - Relatorio    — visao agregada por loja do periodo selecionado
 *
 * F4 da migracao 30/06: substitui o calculo que vinha do Wincred/Giga.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, DollarSign, Plus, Save, X, Trash2, Loader2, Calculator,
  Lock, CheckCircle2, Download, RefreshCw, AlertTriangle, Search,
  ChevronDown, ChevronRight, Printer, Users,
} from 'lucide-react';
import { api } from '@/lib/api';

type Cargo = 'VENDEDORA' | 'LIDER_B' | 'LIDER_A' | 'GERENTE_B' | 'GERENTE_A';

const CARGO_LABELS: Record<Cargo, string> = {
  VENDEDORA: 'Vendedora',
  LIDER_B: 'Líder B',
  LIDER_A: 'Líder A',
  GERENTE_B: 'Gerente B',
  GERENTE_A: 'Gerente A',
};

const CARGO_COLORS: Record<Cargo, string> = {
  VENDEDORA: 'bg-emerald-100 text-emerald-700',
  LIDER_B: 'bg-blue-100 text-blue-700',
  LIDER_A: 'bg-blue-200 text-blue-800',
  GERENTE_B: 'bg-violet-100 text-violet-700',
  GERENTE_A: 'bg-violet-200 text-violet-800',
};

type Rule = {
  id: string;
  scope: 'cargo' | 'global' | 'store' | 'seller';
  cargo: Cargo | null;
  calcMode: 'on_self' | 'on_responsible_store';
  storeId: string | null;
  sellerId: string | null;
  percentBase: number | string;
  meta: number | string | null;
  bonusPercent: number | string | null;
  validFrom: string;
  validTo: string | null;
  active: boolean;
  note: string | null;
  store?: { code: string; name: string } | null;
  seller?: { name: string } | null;
};

type Period = {
  id: string;
  yearMonth: string;
  status: 'open' | 'closed' | 'paid';
  startDate: string;
  endDate: string;
  totalSellers: number;
  totalCommission: number | string;
  totalVendido: number | string;
  closedAt: string | null;
  paidAt: string | null;
};

type Store = { id: string; code: string; name: string; active: boolean };
type Seller = { id: string; name: string; active: boolean; storeCodeOrigin?: string | null };

const brl = (n: number | string | null | undefined) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function ComissoesPage() {
  const [tab, setTab] = useState<'rules' | 'periods' | 'report' | 'sales' | 'folha'>('folha');
  // Atalhos do hub RH chegam com ?aba= — abre direto na aba pedida.
  // (window.location em vez de useSearchParams pra não exigir Suspense no build)
  useEffect(() => {
    try {
      const aba = new URLSearchParams(window.location.search).get('aba') || '';
      const mapa: Record<string, typeof tab> = {
        folha: 'folha', rules: 'rules', regras: 'rules',
        periods: 'periods', fechamentos: 'periods',
        report: 'report', relatorio: 'report', sales: 'sales',
      };
      if (mapa[aba]) setTab(mapa[aba]);
    } catch { /* fica na default */ }
  }, []);
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <Link
          href="/retaguarda"
          className="p-2 rounded-lg hover:bg-slate-100 text-slate-500"
          title="Voltar"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 text-white flex items-center justify-center shadow">
          <DollarSign className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900">Comissões</h1>
          <p className="text-sm text-slate-500">
            Engine de cálculo Flowops (substitui Wincred a partir de 30/06).
          </p>
        </div>
        <Link
          href="/retaguarda/comissoes/cargos"
          className="bg-violet-100 hover:bg-violet-200 text-violet-800 font-bold px-3 py-2 rounded-lg text-sm"
        >
          Cargos das vendedoras
        </Link>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        {[
          { k: 'folha', label: 'Folha RH' },
          { k: 'rules', label: 'Regras' },
          { k: 'periods', label: 'Fechamentos' },
          { k: 'report', label: 'Relatório' },
          { k: 'sales', label: 'Trocar vendedora' },
        ].map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k as any)}
            className={`px-4 py-2 font-bold text-sm border-b-2 transition ${
              tab === t.k
                ? 'border-emerald-600 text-emerald-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'folha' && <FolhaRhTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'periods' && <PeriodsTab />}
      {tab === 'report' && <ReportTab />}
      {tab === 'sales' && <SalesTab />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  SALES TAB — trocar vendedora de uma venda (estilo tela "Vendas" do Giga)
// ═══════════════════════════════════════════════════════════════════

type SaleRow = {
  id: string;
  finalizedAt: string | null;
  total: number | string;
  status: string;
  storeCode: string;
  storeName: string;
  sellerId: string | null;
  sellerName: string | null;
  vendedorName: string | null;
  customerName: string | null;
  nfceNumber: string | null;
  paymentMethod: string | null;
};

// Filtro de data livre — padrão do app (igual faturamento): De/Até + atalhos.
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const firstOfMonthIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const isoDaysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * FOLHA RH — comissão por FUNCIONÁRIA em período livre (De/Até + loja),
 * mesma matemática do fechamento, com cascata venda a venda e impressão.
 * Só PDV com vendedora identificada; o que ficou de fora aparece no aviso.
 */
function FolhaRhTab() {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const hoje = new Date();
  const [de, setDe] = useState(iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)));
  const [ate, setAte] = useState(iso(hoje));
  const [loja, setLoja] = useState('');
  const [lojas, setLojas] = useState<Array<{ code: string; name: string }>>([]);
  const [dados, setDados] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [abertos, setAbertos] = useState<Set<string>>(new Set());
  // Conferência Flow × caixa do Wincred (por vendedora, exige loja)
  const [conf, setConf] = useState<any | null>(null);
  const [confLoading, setConfLoading] = useState(false);

  useEffect(() => { api<any[]>('/stores').then((r) => setLojas(r || [])).catch(() => {}); }, []);

  const conferir = async () => {
    if (!loja) return;
    setConfLoading(true); setConf(null);
    try {
      const qs = new URLSearchParams({ de, ate, loja });
      setConf(await api(`/commissions/relatorio-rh/conferencia?${qs.toString()}`));
    } catch (e: any) {
      setConf({ ok: false, error: e?.message || 'Falha na conferência' });
    } finally { setConfLoading(false); }
  };

  const buscar = async (pDe = de, pAte = ate, pLoja = loja) => {
    setLoading(true); setErr(null);
    try {
      const qs = new URLSearchParams({ de: pDe, ate: pAte });
      if (pLoja) qs.set('loja', pLoja);
      setDados(await api(`/commissions/relatorio-rh?${qs.toString()}`));
    } catch (e: any) {
      setErr(e?.message || 'Falha ao calcular');
    } finally { setLoading(false); }
  };
  useEffect(() => { buscar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const atalho = (tipo: 'hoje' | 'ontem' | '7d' | 'mes' | 'mesAnterior') => {
    const h = new Date();
    let nDe = de, nAte = ate;
    if (tipo === 'hoje') { nDe = iso(h); nAte = iso(h); }
    if (tipo === 'ontem') { const d = new Date(h); d.setDate(d.getDate() - 1); nDe = iso(d); nAte = iso(d); }
    if (tipo === '7d') { const d = new Date(h); d.setDate(d.getDate() - 7); nDe = iso(d); nAte = iso(h); }
    if (tipo === 'mes') { nDe = iso(new Date(h.getFullYear(), h.getMonth(), 1)); nAte = iso(h); }
    if (tipo === 'mesAnterior') {
      nDe = iso(new Date(h.getFullYear(), h.getMonth() - 1, 1));
      nAte = iso(new Date(h.getFullYear(), h.getMonth(), 0));
    }
    setDe(nDe); setAte(nAte);
    buscar(nDe, nAte, loja);
  };

  const toggle = (id: string) => setAbertos((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const fmtD = (s: any) => (s ? new Date(s).toLocaleDateString('pt-BR') : '—');
  const funcionarias: any[] = dados?.funcionarias || [];
  const sem = dados?.semAtribuicao;

  return (
    <div className="space-y-4">
      {/* Filtros — De/Até + atalhos + loja (convenção da casa) */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap items-end gap-3 print:hidden">
        <div>
          <label className="text-[10px] uppercase font-bold text-slate-400 block">De</label>
          <input type="date" value={de} onChange={(e) => setDe(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="text-[10px] uppercase font-bold text-slate-400 block">Até</label>
          <input type="date" value={ate} onChange={(e) => setAte(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
        </div>
        <div className="flex gap-1">
          {([['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7d', '7 dias'], ['mes', 'Mês'], ['mesAnterior', 'Mês anterior']] as const).map(([k, l]) => (
            <button key={k} onClick={() => atalho(k)}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-emerald-50 hover:border-emerald-300">
              {l}
            </button>
          ))}
        </div>
        <div>
          <label className="text-[10px] uppercase font-bold text-slate-400 block">Loja</label>
          <select value={loja} onChange={(e) => { setLoja(e.target.value); buscar(de, ate, e.target.value); }}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
            <option value="">Todas</option>
            {lojas.map((l) => <option key={l.code} value={l.code}>{l.code} · {l.name}</option>)}
          </select>
        </div>
        <button onClick={() => buscar()} disabled={loading}
          className="rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold px-4 py-2 disabled:opacity-50 flex items-center gap-1.5">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calculator className="w-4 h-4" />} Calcular
        </button>
        <button onClick={conferir} disabled={confLoading || !loja}
          title={!loja ? 'Escolha UMA loja pra conferir' : 'Compara com a caixa do Wincred, vendedora a vendedora'}
          className="rounded-lg border border-amber-400 px-3 py-2 text-sm font-bold text-amber-700 hover:bg-amber-50 flex items-center gap-1.5 disabled:opacity-40">
          {confLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Conferir com Wincred
        </button>
        <button onClick={() => window.print()} disabled={!funcionarias.length}
          className="ml-auto rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-40">
          <Printer className="w-4 h-4" /> Imprimir
        </button>
      </div>

      {/* Painel da conferência Flow × Wincred */}
      {conf && (
        <div className="bg-white rounded-xl border border-amber-300 overflow-hidden print:hidden">
          <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm font-bold text-amber-900">
              Conferência Flow × Wincred — LJ {conf.loja || loja}
            </div>
            {conf.ok && (
              <div className="text-xs font-bold text-amber-800">
                Wincred {brl(conf.totais.wincred)} · Flow {brl(conf.totais.flow)} ·{' '}
                diferença <span className={conf.totais.diferenca > 0 ? 'text-rose-700' : 'text-emerald-700'}>{brl(conf.totais.diferenca)}</span>
              </div>
            )}
            <button onClick={() => setConf(null)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
          </div>
          {!conf.ok ? (
            <div className="px-4 py-3 text-sm text-rose-700">⚠️ {conf.error}</div>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase text-slate-400 border-b border-slate-100">
                    <th className="text-left px-4 py-1.5">Vendedora</th>
                    <th className="text-right px-2 py-1.5">Wincred (caixa)</th>
                    <th className="text-right px-2 py-1.5">Flow (PDV)</th>
                    <th className="text-right px-4 py-1.5">Diferença</th>
                  </tr>
                </thead>
                <tbody>
                  {conf.linhas.map((l: any, i: number) => (
                    <tr key={i} className={`border-b border-slate-50 last:border-b-0 ${Math.abs(l.diferenca) > 0.01 ? 'bg-rose-50/40' : ''}`}>
                      <td className="px-4 py-1.5 font-medium text-slate-700">
                        {l.nome}
                        <span className="text-[10px] text-slate-400 ml-1.5">
                          {l.wincredQtd} × {l.flowQtd} vendas
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{brl(l.wincredTotal)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{brl(l.flowTotal)}</td>
                      <td className={`px-4 py-1.5 text-right tabular-nums font-bold ${Math.abs(l.diferenca) > 0.01 ? 'text-rose-700' : 'text-emerald-600'}`}>
                        {Math.abs(l.diferenca) > 0.01 ? brl(l.diferenca) : '✓'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-2 text-[11px] text-slate-500 border-t border-slate-100">
                {conf.nota}
              </div>
            </>
          )}
        </div>
      )}

      {/* Cabeçalho de impressão */}
      <div className="hidden print:block text-center">
        <div className="text-lg font-black">LURD&apos;S PLUS SIZE — FOLHA DE COMISSÕES</div>
        <div className="text-sm text-slate-600">
          Período {fmtD(dados?.de)} a {fmtD(dados?.ate)}{dados?.loja ? ` · Loja ${dados.loja}` : ' · Todas as lojas'}
        </div>
      </div>

      {/* Totais — a conta INTEIRA visível:
          vendido − vale-troca usado − devoluções em dinheiro = base */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
          <div className="text-[10px] uppercase font-bold text-slate-400">Funcionárias</div>
          <div className="text-xl font-black text-slate-800">{dados?.totais?.funcionarias ?? '—'}</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
          <div className="text-[10px] uppercase font-bold text-slate-400">Vendido</div>
          <div className="text-xl font-black text-slate-800">{dados?.totais?.vendido != null ? brl(dados.totais.vendido) : '—'}</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
          <div className="text-[10px] uppercase font-bold text-slate-400">Vale-troca usado</div>
          <div className="text-xl font-black text-amber-600">{dados?.totais?.valeTroca != null ? `−${brl(dados.totais.valeTroca)}` : '—'}</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
          <div className="text-[10px] uppercase font-bold text-slate-400">Dev. dinheiro</div>
          <div className="text-xl font-black text-rose-600">{dados?.totais?.trocas != null ? `−${brl(dados.totais.trocas)}` : '—'}</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
          <div className="text-[10px] uppercase font-bold text-slate-400">= Base</div>
          <div className="text-xl font-black text-slate-800">{dados ? brl(dados.totais.vendidoLiquido) : '—'}</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
          <div className="text-[10px] uppercase font-bold text-slate-400">Comissão total</div>
          <div className="text-xl font-black text-emerald-700">{dados ? brl(dados.totais.comissao) : '—'}</div>
        </div>
      </div>

      {err && <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">⚠️ {err}</div>}
      {sem && (sem.semVendedoraQtd > 0 || sem.naoCadastradaQtd > 0) && (
        <div className="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-xs text-amber-800 print:hidden">
          ⚠️ Fora da folha: {sem.semVendedoraQtd > 0 && <b>{sem.semVendedoraQtd} venda(s) SEM vendedora ({brl(sem.semVendedoraValor)})</b>}
          {sem.semVendedoraQtd > 0 && sem.naoCadastradaQtd > 0 && ' · '}
          {sem.naoCadastradaQtd > 0 && <b>{sem.naoCadastradaQtd} vendedora(s) não cadastrada(s) ({brl(sem.naoCadastradaValor)}) — corrija em &quot;Trocar vendedora&quot;</b>}
        </div>
      )}

      {/* Lista por funcionária (alfabética) */}
      <div className="space-y-2">
        {loading && !dados && (
          <div className="text-center py-10 text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
        )}
        {dados && funcionarias.length === 0 && (
          <div className="text-center py-10 text-slate-400 text-sm">Nenhuma venda com vendedora no período.</div>
        )}
        {funcionarias.map((f) => {
          const aberto = abertos.has(f.sellerId);
          return (
            <div key={f.sellerId} className="bg-white rounded-xl border border-slate-200 overflow-hidden print:break-inside-avoid">
              <button onClick={() => toggle(f.sellerId)}
                className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-emerald-50/40 transition">
                {aberto ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0 print:hidden" /> : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0 print:hidden" />}
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-slate-900 truncate flex items-center gap-2">
                    {f.nome}
                    <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${CARGO_COLORS[f.cargo as Cargo] || 'bg-slate-100 text-slate-600'}`}>
                      {CARGO_LABELS[f.cargo as Cargo] || f.cargo}
                    </span>
                    {f.semRegra && (
                      <span className="text-[10px] font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded">SEM REGRA — R$ 0</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">
                    {f.qtdVendas} venda(s) · vendido {brl(f.totalVendido)}
                    {f.totalVale > 0 && <> · vale-troca −{brl(f.totalVale)}</>}
                    {f.totalTrocas > 0 && <> · dev. dinheiro −{brl(f.totalTrocas)}</>}
                    {' '}· base <b>{brl(f.vendidoLiquido)}</b>
                    {' '}· {f.lojas.map((lj: string) => (
                      <span key={lj} className="inline-block bg-slate-100 border border-slate-200 rounded px-1 text-[10px] font-bold mr-1">LJ {lj}</span>
                    ))}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-5">
                  <div className="text-right">
                    <div className="text-[10px] uppercase font-bold text-slate-400">Vendido</div>
                    <div className="font-black text-slate-800 tabular-nums text-lg">{brl(f.totalVendido)}</div>
                  </div>
                  <div className="text-right min-w-[110px]">
                    <div className="text-[10px] uppercase font-bold text-emerald-600">Comissão</div>
                    <div className="font-black text-emerald-700 tabular-nums text-lg">{brl(f.total)}</div>
                    {f.bonusValue > 0 && (
                      <div className="text-[10px] text-violet-600 font-bold">inclui bônus {brl(f.bonusValue)} 🎯</div>
                    )}
                  </div>
                </div>
              </button>
              {aberto && (
                <div className="border-t border-slate-100">
                  {/* Breakdown por loja/regra */}
                  <div className="px-4 py-2 flex gap-2 flex-wrap bg-slate-50/60 text-[11px] text-slate-600">
                    {f.linhas.map((l: any, i: number) => (
                      <span key={i} className="bg-white border border-slate-200 rounded px-2 py-0.5">
                        LJ {l.storeCode}: {l.calcMode === 'on_responsible_store' ? 'loja toda' : 'vendas próprias'}{' '}
                        {brl(l.vendidoLiquido)} × {Number(l.percentApplied)}% = <b>{brl(l.comissaoBase)}</b>
                        {l.metaAtingida && <> + bônus {Number(l.bonusPercent)}% = <b>{brl(l.bonusValue)}</b></>}
                        {!l.metaAtingida && l.metaValue != null && <> (meta {brl(l.metaValue)} não batida)</>}
                      </span>
                    ))}
                  </div>
                  {/* Cascata venda a venda (vendas próprias) */}
                  {f.vendas.length > 0 && (
                    <div className="overflow-x-auto max-h-96 overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-[10px] uppercase text-slate-400 border-b border-slate-100">
                            <th className="text-left px-4 py-1.5">Data</th>
                            <th className="text-left px-2 py-1.5">Cliente</th>
                            <th className="text-left px-2 py-1.5">Pagamento</th>
                            <th className="text-center px-2 py-1.5">Loja</th>
                            <th className="text-right px-2 py-1.5">Venda</th>
                            <th className="text-right px-4 py-1.5">Comissão</th>
                          </tr>
                        </thead>
                        <tbody>
                          {f.vendas.map((v: any) => (
                            <tr key={v.id} className="border-b border-slate-50 last:border-b-0">
                              <td className="px-4 py-1 text-xs text-slate-500 whitespace-nowrap">
                                {new Date(v.data).toLocaleDateString('pt-BR')} {new Date(v.data).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                              </td>
                              <td className="px-2 py-1 text-xs text-slate-600 truncate max-w-[180px]">{v.cliente || '—'}</td>
                              <td className="px-2 py-1 text-xs text-slate-500 uppercase">{v.pagamento || '—'}</td>
                              <td className="px-2 py-1 text-center text-xs font-bold text-slate-500">{v.loja}</td>
                              <td className="px-2 py-1 text-right tabular-nums">
                                {brl(v.valor)}
                                {(v.vale || 0) > 0 && (
                                  <div className="text-[10px] text-amber-700 whitespace-nowrap">
                                    − vale {brl(v.vale)} → base <b>{brl(v.base)}</b>
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-1 text-right tabular-nums font-bold text-emerald-700">{brl(v.comissao)}</td>
                            </tr>
                          ))}
                          {f.trocas.map((t: any, i: number) => (
                            <tr key={`t${i}`} className="border-b border-slate-50 last:border-b-0 bg-rose-50/40">
                              <td className="px-4 py-1 text-xs text-rose-600 whitespace-nowrap">{new Date(t.data).toLocaleDateString('pt-BR')}</td>
                              <td className="px-2 py-1 text-xs text-rose-600" colSpan={2}>DEVOLUÇÃO EM DINHEIRO/PIX (abate da base)</td>
                              <td className="px-2 py-1 text-center text-xs font-bold text-rose-500">{t.loja}</td>
                              <td className="px-2 py-1 text-right tabular-nums text-rose-600">−{brl(t.valor)}</td>
                              <td className="px-4 py-1" />
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {f.vendas.length === 0 && f.linhas.some((l: any) => l.calcMode === 'on_responsible_store') && (
                    <div className="px-4 py-2 text-xs text-slate-500">
                      Comissão calculada sobre a loja inteira (cargo {CARGO_LABELS[f.cargo as Cargo] || f.cargo}) — sem lista de vendas próprias.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SalesTab() {
  const [stores, setStores] = useState<Store[]>([]);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [from, setFrom] = useState<string>(firstOfMonthIso());
  const [to, setTo] = useState<string>(todayIso());
  const [storeCode, setStoreCode] = useState<string>('');
  const [q, setQ] = useState<string>('');
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Carrega lojas + vendedoras
  useEffect(() => {
    (async () => {
      try {
        const [s, se] = await Promise.all([
          api<Store[]>('/stores'),
          api<Seller[]>('/sellers'),
        ]);
        setStores(s.filter((x) => x.active).sort((a, b) => a.code.localeCompare(b.code)));
        setSellers(se.filter((x) => x.active).sort((a, b) => a.name.localeCompare(b.name)));
      } catch (e: any) {
        setMsg({ kind: 'err', text: 'Erro ao carregar filtros: ' + (e?.message || e) });
      }
    })();
  }, []);

  // override = datas passadas pelos atalhos (pra não esperar o setState)
  async function loadSales(override?: { from?: string; to?: string }) {
    const f = override?.from ?? from;
    const t = override?.to ?? to;
    if (!f || !t) return;
    setLoading(true);
    setMsg(null);
    try {
      const params = new URLSearchParams({ from: f, to: t });
      if (storeCode) params.set('storeCode', storeCode);
      if (q.trim()) params.set('q', q.trim());
      const r = await api<{ sales: SaleRow[]; count: number }>(
        `/commissions/sales?${params.toString()}`,
      );
      setSales(r.sales);
      setDraft({});
    } catch (e: any) {
      setMsg({ kind: 'err', text: 'Erro ao listar vendas: ' + (e?.message || e) });
      setSales([]);
    } finally {
      setLoading(false);
    }
  }

  // Recarrega ao trocar a loja (datas são aplicadas via botão/atalho)
  useEffect(() => {
    loadSales();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeCode]);

  async function reassign(sale: SaleRow) {
    const sellerId = draft[sale.id];
    if (!sellerId || sellerId === (sale.sellerId || '')) return;
    const seller = sellers.find((s) => s.id === sellerId);
    if (!seller) return;
    if (
      !confirm(
        `Passar esta venda para ${seller.name}?\n\n` +
          `Atual: ${sale.sellerName || '— (sem vendedora)'}\n` +
          `A comissão do mês da venda será recalculada automaticamente.`,
      )
    )
      return;
    setSavingId(sale.id);
    setMsg(null);
    try {
      const res = await api<any>(`/commissions/sales/${sale.id}/reassign`, {
        method: 'POST',
        body: JSON.stringify({ sellerId }),
      });
      const rc = res?.recalc;
      setMsg({
        kind: 'ok',
        text:
          `✓ Venda passada para ${seller.name}.` +
          (rc?.error
            ? ` (recálculo falhou: ${rc.error})`
            : ` Período ${rc?.yearMonth} recalculado — total R$ ${Number(rc?.total || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`),
      });
      await loadSales();
    } catch (e: any) {
      setMsg({ kind: 'err', text: 'Erro ao trocar vendedora: ' + (e?.message || e) });
    } finally {
      setSavingId(null);
    }
  }

  // Só as vendedoras da LOJA da venda (storeCodeOrigin === store da venda).
  // Sempre inclui a vendedora atual da venda (mesmo que de outra loja) pra o
  // select conseguir exibi-la. Fallback: se nenhuma casar com a loja, mostra
  // todas (evita dropdown vazio se o vínculo de loja estiver faltando).
  function sellersForStore(storeCode: string, currentSellerId: string | null): Seller[] {
    const norm = (c?: string | null) => (c || '').trim().replace(/^0+/, '');
    const matched = sellers.filter((v) => norm(v.storeCodeOrigin) === norm(storeCode));
    let base = matched.length ? matched : sellers;
    if (currentSellerId && !base.some((v) => v.id === currentSellerId)) {
      const cur = sellers.find((v) => v.id === currentSellerId);
      if (cur) base = [cur, ...base];
    }
    return base;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Troque a vendedora de uma venda finalizada (igual à tela <b>Vendas</b> do Giga). A
        comissão do mês da venda é <b>recalculada na hora</b>. Admin pode trocar em qualquer
        período — inclusive fechado ou pago.
      </p>

      {/* Filtros — intervalo de data LIVRE (De/Até) + atalhos, loja e busca */}
      <div className="flex flex-wrap items-end gap-3 bg-white border border-slate-200 rounded-xl p-3">
        <label className="text-sm">
          <span className="block text-xs font-bold text-slate-500 mb-1">De</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="border border-slate-300 rounded-lg px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="block text-xs font-bold text-slate-500 mb-1">Até</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="border border-slate-300 rounded-lg px-3 py-2"
          />
        </label>
        <button
          onClick={() => loadSales()}
          className="bg-slate-700 hover:bg-slate-800 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Aplicar
        </button>

        {/* Atalhos rápidos — aplicam na hora */}
        <div className="flex gap-1">
          <button
            onClick={() => { const t = todayIso(); setFrom(t); setTo(t); loadSales({ from: t, to: t }); }}
            className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold"
          >
            Hoje
          </button>
          <button
            onClick={() => { const y = isoDaysAgo(1); setFrom(y); setTo(y); loadSales({ from: y, to: y }); }}
            className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold"
          >
            Ontem
          </button>
          <button
            onClick={() => { const f = isoDaysAgo(7); const t = todayIso(); setFrom(f); setTo(t); loadSales({ from: f, to: t }); }}
            className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold"
          >
            7 dias
          </button>
          <button
            onClick={() => { const f = firstOfMonthIso(); const t = todayIso(); setFrom(f); setTo(t); loadSales({ from: f, to: t }); }}
            className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold"
          >
            Mês
          </button>
        </div>

        <label className="text-sm">
          <span className="block text-xs font-bold text-slate-500 mb-1">Loja</span>
          <select
            value={storeCode}
            onChange={(e) => setStoreCode(e.target.value)}
            className="border border-slate-300 rounded-lg px-3 py-2 min-w-[180px]"
          >
            <option value="">Todas as lojas</option>
            {stores.map((s) => (
              <option key={s.id} value={s.code}>
                {s.code} · {s.name}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm flex-1 min-w-[180px]">
          <span className="block text-xs font-bold text-slate-500 mb-1">
            Buscar (cliente / nº cupom)
          </span>
          <div className="flex gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') loadSales();
              }}
              placeholder="opcional…"
              className="border border-slate-300 rounded-lg px-3 py-2 w-full"
            />
            <button
              onClick={() => loadSales()}
              className="bg-slate-700 hover:bg-slate-800 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2"
            >
              <Search className="w-4 h-4" />
              Buscar
            </button>
          </div>
        </label>
      </div>

      {msg && (
        <div
          className={`text-sm rounded-lg px-3 py-2 border ${
            msg.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {msg.text}
        </div>
      )}

      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin mx-auto" />
      ) : sales.length === 0 ? (
        <div className="text-center py-10 bg-slate-50 border border-slate-200 rounded-lg text-slate-500 text-sm">
          Nenhuma venda finalizada nesse intervalo/loja.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full bg-white rounded-xl border border-slate-200 overflow-hidden text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Data</th>
                <th className="text-left px-3 py-2">Loja</th>
                <th className="text-left px-3 py-2">Cliente / Cupom</th>
                <th className="text-right px-3 py-2">Total</th>
                <th className="text-left px-3 py-2">Vendedora atual</th>
                <th className="text-left px-3 py-2">Passar para…</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((s) => {
                const chosen = draft[s.id] ?? (s.sellerId || '');
                const changed = chosen && chosen !== (s.sellerId || '');
                return (
                  <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600">
                      {s.finalizedAt
                        ? new Date(s.finalizedAt).toLocaleString('pt-BR', {
                            day: '2-digit',
                            month: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600">{s.storeCode}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800 truncate max-w-[220px]">
                        {s.customerName || '— balcão'}
                      </div>
                      {s.nfceNumber && (
                        <div className="text-xs text-slate-400">NFC-e {s.nfceNumber}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-slate-800 whitespace-nowrap">
                      {brl(s.total)}
                    </td>
                    <td className="px-3 py-2">
                      {s.sellerName ? (
                        <span className="font-medium text-slate-700">{s.sellerName}</span>
                      ) : (
                        <span className="text-amber-600 italic">sem vendedora</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <select
                          value={chosen}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, [s.id]: e.target.value }))
                          }
                          className={`border rounded-lg px-2 py-1.5 min-w-[150px] ${
                            changed ? 'border-emerald-400 bg-emerald-50' : 'border-slate-300'
                          }`}
                        >
                          <option value="">— escolher —</option>
                          {sellersForStore(s.storeCode, s.sellerId).map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name}
                            </option>
                          ))}
                        </select>
                        <button
                          disabled={!changed || savingId === s.id}
                          onClick={() => reassign(s)}
                          className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-lg font-bold flex items-center gap-1"
                        >
                          {savingId === s.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Save className="w-4 h-4" />
                          )}
                          Trocar
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs text-slate-400 mt-2">
            {sales.length} venda(s). Mostrando no máximo 300 por vez — use a busca ou filtre por
            loja pra refinar.
          </p>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  RULES TAB
// ═══════════════════════════════════════════════════════════════════

function RulesTab() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [r, s, se] = await Promise.all([
        api<Rule[]>('/commissions/rules?activeOnly=1'),
        api<Store[]>('/stores'),
        api<Seller[]>('/sellers'),
      ]);
      setRules(r);
      setStores(s.filter((x) => x.active).sort((a, b) => a.code.localeCompare(b.code)));
      setSellers(se.filter((x) => x.active).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleDeactivate(id: string) {
    if (!confirm('Desativar essa regra? Histórico de cálculos antigos é preservado.')) return;
    await api(`/commissions/rules/${id}/deactivate`, { method: 'POST' });
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">
          Regras hierárquicas: <b>seller &gt; store &gt; global</b>. A mais específica vale.
        </p>
        <button
          onClick={() =>
            setEditing({
              scope: 'global',
              percentBase: 3,
              validFrom: new Date().toISOString().slice(0, 10),
              active: true,
            })
          }
          className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Nova regra
        </button>
      </div>

      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin mx-auto" />
      ) : rules.length === 0 ? (
        <div className="text-center py-10 bg-amber-50 border border-amber-200 rounded-lg">
          <AlertTriangle className="w-8 h-8 mx-auto text-amber-600 mb-2" />
          <p className="font-bold text-amber-800">Nenhuma regra cadastrada</p>
          <p className="text-sm text-amber-700 mt-1 mb-3">
            Use o setup inicial Lurd&apos;s pra criar as 5 regras padrão por cargo de uma vez.
          </p>
          <button
            onClick={async () => {
              if (!confirm('Criar regras padrão Lurd\'s?\n\n• VENDEDORA 2% sobre vendas próprias\n• LIDER B 0,5% sobre loja toda\n• LIDER A 1,0% sobre loja toda\n• GERENTE B 1,5% sobre loja toda\n• GERENTE A 2,0% sobre loja toda')) return;
              await api('/commissions/rules/seed-defaults', { method: 'POST' });
              load();
            }}
            className="bg-amber-700 hover:bg-amber-800 text-white font-bold px-5 py-2 rounded"
          >
            ⚡ Setup inicial Lurd&apos;s (5 cargos)
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full bg-white rounded-xl border border-slate-200 overflow-hidden">
          <thead className="bg-slate-50 text-xs uppercase text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">Escopo / Cargo</th>
              <th className="text-left px-3 py-2">Aplica em</th>
              <th className="text-left px-3 py-2">Calcula</th>
              <th className="text-right px-3 py-2">% Base</th>
              <th className="text-left px-3 py-2">Vigência</th>
              <th className="text-center px-3 py-2">Ações</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">
                  {r.scope === 'cargo' && r.cargo ? (
                    <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${CARGO_COLORS[r.cargo]}`}>
                      {CARGO_LABELS[r.cargo]}
                    </span>
                  ) : (
                    <span
                      className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${
                        r.scope === 'global'
                          ? 'bg-slate-100 text-slate-700'
                          : r.scope === 'store'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-violet-100 text-violet-700'
                      }`}
                    >
                      {r.scope}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-sm">
                  {r.scope === 'store' && r.store
                    ? `${r.store.code} — ${r.store.name}`
                    : r.scope === 'seller' && r.seller
                    ? r.seller.name
                    : r.scope === 'cargo'
                    ? 'Todas vendedoras do cargo'
                    : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {r.calcMode === 'on_responsible_store'
                    ? '🏪 sobre loja toda'
                    : '👤 sobre vendas próprias'}
                </td>
                <td className="px-3 py-2 text-right font-bold tabular-nums">
                  {Number(r.percentBase).toFixed(2)}%
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {new Date(r.validFrom).toLocaleDateString('pt-BR')}
                  {r.validTo ? ` → ${new Date(r.validTo).toLocaleDateString('pt-BR')}` : ''}
                </td>
                <td className="px-3 py-2 text-center">
                  <button
                    onClick={() => handleDeactivate(r.id)}
                    className="p-1.5 hover:bg-red-50 rounded text-red-600"
                    title="Desativar"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {editing && (
        <RuleEditModal
          rule={editing}
          stores={stores}
          sellers={sellers}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function RuleEditModal({
  rule,
  stores,
  sellers,
  onClose,
  onSaved,
}: {
  rule: Partial<Rule>;
  stores: Store[];
  sellers: Seller[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [scope, setScope] = useState<'cargo' | 'global' | 'store' | 'seller'>(rule.scope || 'cargo');
  const [cargo, setCargo] = useState<Cargo>(rule.cargo || 'VENDEDORA');
  const [calcMode, setCalcMode] = useState<'on_self' | 'on_responsible_store'>(
    rule.calcMode || 'on_self',
  );
  const [storeId, setStoreId] = useState(rule.storeId || '');
  const [sellerId, setSellerId] = useState(rule.sellerId || '');
  const [percentBase, setPercentBase] = useState(String(rule.percentBase ?? '3'));
  const [meta, setMeta] = useState(String(rule.meta ?? ''));
  const [bonusPercent, setBonusPercent] = useState(String(rule.bonusPercent ?? ''));
  const [validFrom, setValidFrom] = useState(
    rule.validFrom ? String(rule.validFrom).slice(0, 10) : new Date().toISOString().slice(0, 10),
  );
  const [validTo, setValidTo] = useState(rule.validTo ? String(rule.validTo).slice(0, 10) : '');
  const [note, setNote] = useState(rule.note || '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const body: any = {
        scope,
        calcMode,
        percentBase: Number(percentBase),
        validFrom,
        active: true,
        note,
      };
      if (scope === 'cargo') {
        body.cargo = cargo;
        // Auto-define calcMode pelo cargo: VENDEDORA=on_self, demais=on_responsible_store
        body.calcMode = cargo === 'VENDEDORA' ? 'on_self' : 'on_responsible_store';
      }
      if (scope === 'store') body.storeId = storeId;
      if (scope === 'seller') body.sellerId = sellerId;
      if (meta.trim()) body.meta = Number(meta);
      if (bonusPercent.trim()) body.bonusPercent = Number(bonusPercent);
      if (validTo.trim()) body.validTo = validTo;
      await api('/commissions/rules', { method: 'POST', body: JSON.stringify(body) });
      onSaved();
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-3 border-b flex items-center justify-between sticky top-0 bg-white">
          <h2 className="font-bold">Nova regra de comissão</h2>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              Escopo
            </label>
            <div className="flex gap-2 flex-wrap">
              {(['cargo', 'global', 'store', 'seller'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className={`flex-1 min-w-[80px] py-2 rounded-lg font-bold text-sm ${
                    scope === s
                      ? s === 'cargo'
                        ? 'bg-emerald-600 text-white'
                        : s === 'global'
                        ? 'bg-slate-700 text-white'
                        : s === 'store'
                        ? 'bg-blue-600 text-white'
                        : 'bg-violet-600 text-white'
                      : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              <b>Cargo</b> (recomendado): aplica a todas vendedoras do cargo. Hierarquia: seller &gt; cargo &gt; store &gt; global.
            </p>
          </div>

          {scope === 'cargo' && (
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
                Cargo
              </label>
              <select
                value={cargo}
                onChange={(e) => {
                  const c = e.target.value as Cargo;
                  setCargo(c);
                  // Auto-define calcMode
                  setCalcMode(c === 'VENDEDORA' ? 'on_self' : 'on_responsible_store');
                }}
                className="w-full px-3 py-2 border rounded"
              >
                <option value="VENDEDORA">Vendedora (sobre vendas próprias)</option>
                <option value="LIDER_B">Líder B (sobre loja toda)</option>
                <option value="LIDER_A">Líder A (sobre loja toda)</option>
                <option value="GERENTE_B">Gerente B (sobre loja toda)</option>
                <option value="GERENTE_A">Gerente A (sobre loja toda)</option>
              </select>
            </div>
          )}

          {scope === 'store' && (
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Loja</label>
              <select
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                className="w-full px-3 py-2 border rounded"
              >
                <option value="">Escolha uma loja</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {scope === 'seller' && (
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
                Vendedora
              </label>
              <select
                value={sellerId}
                onChange={(e) => setSellerId(e.target.value)}
                className="w-full px-3 py-2 border rounded"
              >
                <option value="">Escolha uma vendedora</option>
                {sellers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
                % Base
              </label>
              <input
                type="number"
                step="0.01"
                value={percentBase}
                onChange={(e) => setPercentBase(e.target.value)}
                className="w-full px-3 py-2 border rounded text-right tabular-nums"
              />
              <p className="text-xs text-slate-400 mt-1">Ex: 3.00 = 3%</p>
            </div>
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
                Meta R$ (opcional)
              </label>
              <input
                type="number"
                step="0.01"
                value={meta}
                onChange={(e) => setMeta(e.target.value)}
                placeholder="Ex: 80000"
                className="w-full px-3 py-2 border rounded text-right tabular-nums"
              />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
                Bônus % (acima da meta)
              </label>
              <input
                type="number"
                step="0.01"
                value={bonusPercent}
                onChange={(e) => setBonusPercent(e.target.value)}
                placeholder="Ex: 1.00 = +1%"
                className="w-full px-3 py-2 border rounded text-right tabular-nums"
                disabled={!meta.trim()}
              />
            </div>
            <div />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
                Válida a partir de
              </label>
              <input
                type="date"
                value={validFrom}
                onChange={(e) => setValidFrom(e.target.value)}
                className="w-full px-3 py-2 border rounded"
              />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
                Até (opcional)
              </label>
              <input
                type="date"
                value={validTo}
                onChange={(e) => setValidTo(e.target.value)}
                className="w-full px-3 py-2 border rounded"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              Observação (opcional)
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Motivo da regra, contexto..."
              className="w-full px-3 py-2 border rounded text-sm"
              rows={2}
            />
          </div>
        </div>
        <div className="px-5 py-3 border-t flex items-center justify-end sticky bottom-0 bg-white">
          <button
            onClick={handleSave}
            disabled={saving || (scope === 'store' && !storeId) || (scope === 'seller' && !sellerId)}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold px-5 py-2 rounded flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  PERIODS TAB
// ═══════════════════════════════════════════════════════════════════

function PeriodsTab() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [calcMonth, setCalcMonth] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  async function load() {
    setLoading(true);
    try {
      const r = await api<Period[]>('/commissions/periods');
      setPeriods(r);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function action(yearMonth: string, action: 'calculate' | 'close' | 'pay') {
    if (action === 'pay' && !confirm(`Confirmar pagamento de ${yearMonth}? Não pode desfazer.`))
      return;
    if (action === 'close' && !confirm(`Fechar ${yearMonth}? Não recalcula mais (override admin).`))
      return;
    setWorking(yearMonth + ':' + action);
    try {
      const r = await api<any>(`/commissions/periods/${yearMonth}/${action}`, { method: 'POST' });
      if (action === 'calculate') {
        const skip = r?.skipped?.count
          ? `\n\n⚠️ ${r.skipped.count} venda(s) com vendedora não cadastrada (${brl(r.skipped.vendido)}) ficaram de fora. Corrija na aba "Trocar vendedora".`
          : '';
        alert(`Recálculo OK: ${r.entries?.length || 0} entries, total ${brl(r.total)}.${skip}`);
      }
      load();
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">
          Fechamentos mensais. Sempre rode <b>Calcular</b> antes de fechar.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={calcMonth}
            onChange={(e) => setCalcMonth(e.target.value)}
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm"
            title="Mês a calcular"
          />
          <button
            onClick={() => action(calcMonth, 'calculate')}
            disabled={!!working}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2"
          >
            {working === calcMonth + ':calculate' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Calculator className="w-4 h-4" />
            )}
            Calcular
          </button>
        </div>
      </div>

      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin mx-auto" />
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full bg-white rounded-xl border border-slate-200 overflow-hidden">
          <thead className="bg-slate-50 text-xs uppercase text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">Mês</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-right px-3 py-2">Vendedoras</th>
              <th className="text-right px-3 py-2">Vendido Liq.</th>
              <th className="text-right px-3 py-2">Comissão</th>
              <th className="text-center px-3 py-2">Ações</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-bold">{p.yearMonth}</td>
                <td className="px-3 py-2">
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${
                      p.status === 'open'
                        ? 'bg-amber-100 text-amber-700'
                        : p.status === 'closed'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-emerald-100 text-emerald-700'
                    }`}
                  >
                    {p.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{p.totalSellers}</td>
                <td className="px-3 py-2 text-right tabular-nums text-sm">
                  {brl(p.totalVendido)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-bold text-emerald-700">
                  {brl(p.totalCommission)}
                </td>
                <td className="px-3 py-2 text-center">
                  <div className="inline-flex gap-1">
                    {p.status === 'open' && (
                      <>
                        <button
                          onClick={() => action(p.yearMonth, 'calculate')}
                          disabled={!!working}
                          className="text-xs bg-slate-200 hover:bg-slate-300 px-2 py-1 rounded font-bold"
                          title="Recalcular"
                        >
                          <RefreshCw className="w-3 h-3 inline" />
                        </button>
                        <button
                          onClick={() => action(p.yearMonth, 'close')}
                          disabled={!!working}
                          className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded font-bold"
                        >
                          <Lock className="w-3 h-3 inline" /> Fechar
                        </button>
                      </>
                    )}
                    {p.status === 'closed' && (
                      <button
                        onClick={() => action(p.yearMonth, 'pay')}
                        disabled={!!working}
                        className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-2 py-1 rounded font-bold"
                      >
                        <CheckCircle2 className="w-3 h-3 inline" /> Marcar pago
                      </button>
                    )}
                    {p.status === 'paid' && (
                      <span className="text-xs text-emerald-700 font-bold">
                        ✓ Pago {p.paidAt && new Date(p.paidAt).toLocaleDateString('pt-BR')}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  REPORT TAB
// ═══════════════════════════════════════════════════════════════════

function ReportTab() {
  const now = new Date();
  const defaultYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [yearMonth, setYearMonth] = useState(defaultYM);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [calcing, setCalcing] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api<any>(`/commissions/periods/${yearMonth}/report`);
      setData(r);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  // Calcula (ou recalcula) o mês selecionado e recarrega o relatório.
  // O relatório é só leitura — é isso que popula os dados.
  async function calcNow() {
    setCalcing(true);
    try {
      const r = await api<any>(`/commissions/periods/${yearMonth}/calculate`, { method: 'POST' });
      const skip = r?.skipped?.count
        ? `\n\n⚠️ ${r.skipped.count} venda(s) com vendedora não cadastrada (${brl(r.skipped.vendido)}) ficaram de fora. Corrija na aba "Trocar vendedora" e calcule de novo.`
        : '';
      alert(`Cálculo OK: ${r.entries?.length || 0} lançamentos, total ${brl(r.total)}.${skip}`);
      await load();
    } catch (e: any) {
      alert('Erro ao calcular: ' + (e?.message || e));
    } finally {
      setCalcing(false);
    }
  }

  useEffect(() => {
    load();
  }, [yearMonth]);

  const semDados = !data || !data.byStore || data.byStore.length === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="month"
          value={yearMonth}
          onChange={(e) => setYearMonth(e.target.value)}
          className="px-3 py-2 border rounded"
        />
        <button
          onClick={load}
          className="bg-slate-700 hover:bg-slate-800 text-white px-3 py-2 rounded flex items-center gap-1"
        >
          <RefreshCw className="w-4 h-4" /> Atualizar
        </button>
        <button
          onClick={calcNow}
          disabled={calcing}
          className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3 py-2 rounded flex items-center gap-1 font-bold"
          title="Recalcula as comissões deste mês a partir das vendas"
        >
          {calcing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calculator className="w-4 h-4" />}
          Calcular este mês
        </button>
      </div>

      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin mx-auto" />
      ) : semDados ? (
        <div className="text-center py-10 bg-slate-50 border border-slate-200 rounded-lg">
          <p className="text-slate-500 text-sm">Nenhum dado calculado pra {yearMonth}.</p>
          <p className="text-slate-400 text-xs mt-1">
            O relatório só mostra o que já foi calculado. Clique em <b>Calcular este mês</b> acima —
            e confira se o mês selecionado é o das vendas (as vendas de junho ficam em 2026-06).
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card label="Vendido líquido" value={brl(data.period.totalVendido)} />
            <Card label="Comissão total" value={brl(data.period.totalCommission)} highlight />
            <Card label="Vendedoras" value={String(data.period.totalSellers)} />
          </div>

          {data.byStore.map((g: any) => (
            <div key={g.storeId} className="bg-white border rounded-xl overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 border-b flex items-center justify-between">
                <span className="font-bold text-sm">Loja</span>
                <span className="text-sm">
                  <b>{brl(g.totalVendido)}</b> vendido / <b className="text-emerald-700">{brl(g.totalComissao)}</b>{' '}
                  comissão
                </span>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-600">
                  <tr>
                    <th className="text-left px-3 py-1.5">Vendedora</th>
                    <th className="text-right px-3 py-1.5">Vendido Liq.</th>
                    <th className="text-right px-3 py-1.5">Comissão Base</th>
                    <th className="text-right px-3 py-1.5">Bônus</th>
                    <th className="text-right px-3 py-1.5">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {g.sellers.map((s: any) => (
                    <tr key={s.sellerId} className="border-t border-slate-100">
                      <td className="px-3 py-1.5 font-bold">{s.sellerName}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {brl(s.vendidoLiquido)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{brl(s.comissaoBase)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700">
                        {s.metaAtingida ? brl(s.bonusValue) : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-bold">
                        {brl(s.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Card({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        highlight ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-slate-200'
      }`}
    >
      <div className="text-xs font-bold uppercase text-slate-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : 'text-slate-800'}`}>
        {value}
      </div>
    </div>
  );
}
