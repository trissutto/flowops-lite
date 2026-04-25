'use client';

/**
 * /retaguarda/crediario — Cobrança de parcelas vencidas (loja 01 default).
 *
 * Conecta direto na tabela `movimento` do MySQL Gigasistemas via endpoint
 * /crediarios/vencidos-clientes. Lista clientes com parcelas vencidas
 * agrupados, mostrando: total devido, parcelas em atraso, dias atraso, e
 * dropdown com cada parcela (data compra, valor compra, parcela X/Y, data
 * vencimento, valor parcela).
 *
 * Ações por cliente:
 *   - Abrir WhatsApp pré-preenchido com mensagem de cobrança
 *   - Copiar dados do cliente
 *   - Ver detalhe das parcelas (expansível)
 *
 * Filtros: loja, dias atrás (default 365), busca por nome/código.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CreditCard, AlertTriangle, Loader2, MessageSquare, Search,
  RefreshCw, ChevronDown, ChevronRight, Download, Copy, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import PastelShell from '@/components/PastelShell';

// ---------- types ----------
interface Parcela {
  registro?: any;
  controle?: any;
  numeroCompra?: any;
  codCliente?: any;
  nome?: string;
  telefone?: string | null;
  dataCompra?: string;
  valorCompra?: number;
  parcela?: any;
  totalParcelas?: any;
  vencimento?: string;
  valorParcela?: number;
  dataPagamento?: any;
  valorPago?: number;
  status?: any;
}

interface CustomerOverdue {
  codCliente: string;
  nome: string;
  telefone: string | null;
  parcelasVencidas: number;
  totalDevido: number;
  vencimentoMaisAntigo: string | null;
  vencimentoMaisRecente: string | null;
  diasAtraso: number;
  parcelas: Parcela[];
}

interface Resp {
  customers: CustomerOverdue[];
  summary: { totalClientes: number; totalParcelas: number; totalDevido: number };
  columnMap: Record<string, string | null>;
}

export default function CrediarioPage() {
  const router = useRouter();
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) { router.push('/login'); return; }
    api<{ role: string }>('/auth/me')
      .then((me) => {
        if (me.role !== 'admin' && me.role !== 'operator') {
          router.push('/');
          return;
        }
        setAuthed(true);
      })
      .catch(() => router.push('/login'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [loja, setLoja] = useState('01');
  const [daysBack, setDaysBack] = useState(365);
  const [search, setSearch] = useState('');
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api<Resp>(`/crediarios/vencidos-clientes?loja=${loja}&daysBack=${daysBack}`);
      setData(res);
    } catch (e: any) {
      setError(e.message || 'falha ao carregar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (authed) load(); /* eslint-disable-next-line */ }, [authed]);

  // Filtros locais
  const filteredCustomers = useMemo(() => {
    if (!data) return [];
    if (!search.trim()) return data.customers;
    const q = search.toLowerCase();
    return data.customers.filter((c) =>
      c.nome.toLowerCase().includes(q) || c.codCliente.includes(q),
    );
  }, [data, search]);

  function toggleExpand(cod: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cod)) next.delete(cod);
      else next.add(cod);
      return next;
    });
  }

  function whatsappLink(c: CustomerOverdue) {
    const tel = (c.telefone || '').replace(/\D/g, '');
    const partes = c.parcelas
      .map((p) => `• Parcela ${p.parcela ?? '?'}/${p.totalParcelas ?? '?'} — venc. ${fmtDate(p.vencimento)} — ${brl(p.valorParcela)}`)
      .join('\n');
    const msg = encodeURIComponent(
      `Olá, ${c.nome.split(' ')[0]}! Aqui é da Lurd's Plus Size.\n\n` +
      `Identificamos parcelas em atraso:\n${partes}\n\n` +
      `Total em aberto: ${brl(c.totalDevido)} (${c.parcelasVencidas} parcelas — ${c.diasAtraso} dias atraso).\n\n` +
      `Pode regularizar pelo PIX, cartão ou direto na loja. Qualquer dúvida, é só chamar! ❤️`,
    );
    if (tel) return `https://web.whatsapp.com/send?phone=55${tel}&text=${msg}`;
    // sem telefone, abre o WhatsApp Web pra digitar manualmente
    return `https://web.whatsapp.com/send?text=${msg}`;
  }

  function exportCsv() {
    if (!data) return;
    const lines = [
      'codCliente,nome,telefone,parcelasVencidas,totalDevido,vencimentoMaisAntigo,diasAtraso',
      ...data.customers.map((c) =>
        [
          c.codCliente,
          esc(c.nome),
          esc(c.telefone || ''),
          c.parcelasVencidas,
          c.totalDevido.toFixed(2),
          c.vencimentoMaisAntigo || '',
          c.diasAtraso,
        ].join(','),
      ),
    ];
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crediario-vencidos-loja${loja}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Carregando…
      </div>
    );
  }

  return (
    <PastelShell
      title="Crediário"
      subtitle="Parcelas vencidas — cobrança via WhatsApp"
      icon={CreditCard}
      tone="rose"
      backHref="/loja"
    >
      {/* Filtros */}
      <div className="panel-pastel p-3 mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Loja</label>
          <input
            value={loja}
            onChange={(e) => setLoja(e.target.value.replace(/\D/g, '').slice(0, 2).padStart(2, '0'))}
            className="w-20 px-2 py-1.5 text-sm rounded-lg border border-rose-200 bg-white focus:outline-none focus:border-rose-400"
            placeholder="01"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Janela</label>
          <select
            value={daysBack}
            onChange={(e) => setDaysBack(Number(e.target.value))}
            className="px-2 py-1.5 text-sm rounded-lg border border-rose-200 bg-white"
          >
            <option value={30}>30 dias</option>
            <option value={60}>60 dias</option>
            <option value={90}>90 dias</option>
            <option value={180}>6 meses</option>
            <option value={365}>1 ano</option>
            <option value={730}>2 anos</option>
            <option value={3650}>10 anos</option>
          </select>
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Buscar cliente</label>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nome ou código…"
              className="w-full pl-7 pr-2 py-1.5 text-sm rounded-lg border border-rose-200 bg-white"
            />
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 text-sm rounded-lg text-white shadow-sm flex items-center gap-1.5 disabled:opacity-50"
          style={{ background: '#8b4f55' }}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Atualizar
        </button>
        <button
          onClick={exportCsv}
          disabled={!data || data.customers.length === 0}
          className="px-3 py-1.5 text-sm rounded-lg border border-rose-200 bg-white hover:bg-rose-50 disabled:opacity-40 flex items-center gap-1.5"
        >
          <Download className="w-4 h-4 text-rose-700" /> CSV
        </button>
      </div>

      {/* KPIs */}
      {data && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <Kpi label="Clientes em atraso"  value={data.summary.totalClientes.toLocaleString('pt-BR')}  tone="rose" />
          <Kpi label="Parcelas vencidas"   value={data.summary.totalParcelas.toLocaleString('pt-BR')} tone="peach" />
          <Kpi label="Total em aberto"     value={brl(data.summary.totalDevido)}                       tone="coral" />
        </div>
      )}

      {/* Erro */}
      {error && (
        <div className="panel-pastel p-3 border-l-4 border-rose-400 mb-3">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-rose-700">Erro ao carregar</div>
              <div className="text-rose-600 text-xs mt-1 font-mono whitespace-pre-wrap break-words">{error}</div>
              {error.includes('Colunas essenciais') && (
                <div className="text-rose-700 text-xs mt-2">
                  As colunas da tabela `movimento` desta instalação não bateram com os padrões esperados.
                  Use o <a href="/relatorios/giga" className="underline">Giga Explorer</a> pra ver `DESCRIBE movimento` e me manda os nomes reais.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Mapeamento de colunas detectado (debug) */}
      {data?.columnMap && (
        <details className="panel-pastel p-2 mb-3">
          <summary className="text-xs text-slate-500 cursor-pointer">Mapeamento de colunas detectado (debug)</summary>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-1 text-[11px] font-mono">
            {Object.entries(data.columnMap).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <span className="text-slate-500">{k}:</span>
                <span className={v ? 'text-emerald-700' : 'text-rose-500'}>{v || '✗'}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Lista clientes */}
      {loading && !data && (
        <div className="panel-pastel p-8 text-center text-slate-400 text-sm">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Buscando parcelas vencidas na Loja {loja}…
        </div>
      )}

      {data && filteredCustomers.length === 0 && !loading && (
        <div className="panel-pastel p-8 text-center text-slate-500 text-sm">
          Nenhum cliente em atraso encontrado{search ? ' pra esse filtro' : ''}.
        </div>
      )}

      {data && filteredCustomers.length > 0 && (
        <div className="panel-pastel p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="text-sm w-full">
              <thead>
                <tr className="text-left bg-rose-50 text-rose-900 border-b border-rose-200">
                  <th className="px-3 py-2 w-8"></th>
                  <th className="px-3 py-2">Cliente</th>
                  <th className="px-3 py-2 text-right">Parcelas</th>
                  <th className="px-3 py-2 text-right">Total devido</th>
                  <th className="px-3 py-2">Vencimento + antigo</th>
                  <th className="px-3 py-2 text-right">Atraso</th>
                  <th className="px-3 py-2 text-center">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredCustomers.map((c) => {
                  const isOpen = expanded.has(c.codCliente);
                  return (
                    <FragmentRow
                      key={c.codCliente}
                      c={c}
                      isOpen={isOpen}
                      onToggle={() => toggleExpand(c.codCliente)}
                      whatsappHref={whatsappLink(c)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </PastelShell>
  );
}

// ---------- subcomponentes ----------
function FragmentRow({
  c, isOpen, onToggle, whatsappHref,
}: {
  c: CustomerOverdue;
  isOpen: boolean;
  onToggle: () => void;
  whatsappHref: string;
}) {
  return (
    <>
      <tr className="border-b border-rose-100 hover:bg-rose-50/40 transition">
        <td className="px-3 py-2">
          <button onClick={onToggle} className="p-1 hover:bg-rose-100 rounded">
            {isOpen ? <ChevronDown className="w-4 h-4 text-rose-700" /> : <ChevronRight className="w-4 h-4 text-rose-700" />}
          </button>
        </td>
        <td className="px-3 py-2">
          <div className="font-semibold text-slate-800">{c.nome}</div>
          <div className="text-xs text-slate-500">cod {c.codCliente}{c.telefone ? ` · ${formatPhone(c.telefone)}` : ''}</div>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{c.parcelasVencidas}</td>
        <td className="px-3 py-2 text-right tabular-nums font-semibold" style={{ color: '#8b4f55' }}>{brl(c.totalDevido)}</td>
        <td className="px-3 py-2 text-xs text-slate-600">{fmtDate(c.vencimentoMaisAntigo)}</td>
        <td className="px-3 py-2 text-right tabular-nums">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${atrasoCor(c.diasAtraso)}`}>
            {c.diasAtraso}d
          </span>
        </td>
        <td className="px-3 py-2 text-center">
          <div className="flex items-center justify-center gap-1">
            <a
              href={whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2 py-1 text-xs rounded-lg text-white flex items-center gap-1 shadow-sm"
              style={{ background: '#5d7048' }}
              title="Cobrar via WhatsApp"
            >
              <MessageSquare className="w-3 h-3" /> WA
            </a>
            <button
              onClick={() => navigator.clipboard.writeText(`${c.nome} (${c.codCliente}) — ${brl(c.totalDevido)}`)}
              className="p-1 hover:bg-rose-100 rounded"
              title="Copiar dados"
            >
              <Copy className="w-3 h-3 text-slate-500" />
            </button>
          </div>
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-rose-50/30 border-b border-rose-100">
          <td colSpan={7} className="px-3 py-3">
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr className="text-left text-rose-800 border-b border-rose-200">
                    <th className="px-2 py-1">Compra</th>
                    <th className="px-2 py-1">Data compra</th>
                    <th className="px-2 py-1 text-right">Valor compra</th>
                    <th className="px-2 py-1 text-center">Parcela</th>
                    <th className="px-2 py-1">Vencimento</th>
                    <th className="px-2 py-1 text-right">Valor parcela</th>
                  </tr>
                </thead>
                <tbody>
                  {c.parcelas.map((p, i) => (
                    <tr key={i} className="border-b border-rose-50 last:border-0">
                      <td className="px-2 py-1 font-mono">{String(p.numeroCompra ?? '-')}</td>
                      <td className="px-2 py-1">{fmtDate(p.dataCompra)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{brl(p.valorCompra)}</td>
                      <td className="px-2 py-1 text-center">{p.parcela ?? '?'}/{p.totalParcelas ?? '?'}</td>
                      <td className="px-2 py-1">{fmtDate(p.vencimento)}</td>
                      <td className="px-2 py-1 text-right tabular-nums font-semibold" style={{ color: '#8b4f55' }}>{brl(p.valorParcela)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone: 'rose' | 'peach' | 'coral' }) {
  const palette = {
    rose:   { bg: '#f5e6e3', ring: '#c08081', icon: '#8b4f55', text: '#6e3a40' },
    peach:  { bg: '#f3e2d6', ring: '#c87f5e', icon: '#8b4d31', text: '#6f3b25' },
    coral:  { bg: '#ecdac9', ring: '#b87355', icon: '#7d4a30', text: '#5e3823' },
  }[tone];
  return (
    <div className="rounded-2xl px-4 py-3" style={{ background: palette.bg, border: `2px solid ${palette.ring}` }}>
      <div className="text-[10px] uppercase tracking-wider font-bold" style={{ color: palette.text }}>{label}</div>
      <div className="font-display text-2xl tabular-nums font-semibold mt-1" style={{ color: palette.icon }}>{value}</div>
    </div>
  );
}

// ---------- helpers ----------
function brl(v: any): string {
  const n = Number(v ?? 0);
  if (!isFinite(n)) return 'R$ 0,00';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtDate(s?: string | null): string {
  if (!s) return '-';
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s).slice(0, 10);
  return d.toLocaleDateString('pt-BR');
}
function formatPhone(tel: string): string {
  const d = tel.replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return tel;
}
function atrasoCor(dias: number): string {
  if (dias > 90) return 'bg-rose-200 text-rose-900';
  if (dias > 30) return 'bg-amber-200 text-amber-900';
  return 'bg-yellow-200 text-yellow-900';
}
function esc(s: any): string {
  const v = String(s ?? '');
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
