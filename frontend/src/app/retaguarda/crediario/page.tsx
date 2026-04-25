'use client';

/**
 * /retaguarda/crediario — Cobrança de parcelas vencidas (loja 01 default).
 *
 * Conecta direto na tabela `movimento` do MySQL Gigasistemas.
 *
 *   Filtro PAGO=N — confirmado pelo schema do Giga local
 *   ORDER BY VENCIMENTO ASC — fila de cobrança real
 *
 * 2 modos de visualização:
 *   - "Por parcela" (default): cada linha = 1 parcela, ordenada por vencimento ASC.
 *     Reflete a fila real de cobrança (mais antigo primeiro).
 *   - "Por cliente": agrupado, com expansão pra ver as parcelas e botão WA.
 *
 * Ações:
 *   - WhatsApp pré-preenchido com mensagem de cobrança
 *   - Export CSV (parcelas ou clientes, conforme view)
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CreditCard, AlertTriangle, Loader2, MessageSquare, Search,
  RefreshCw, ChevronDown, ChevronRight, Download, Copy, List, Users,
  Send, Megaphone, FlaskConical, Phone, X, Check, Zap, Settings, ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
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
  pago?: any;
  status?: any;
}

interface FlatResp {
  rows: Parcela[];
  summary: { totalParcelas: number; totalDevido: number; clientes: number };
  columnMap: Record<string, string | null>;
  rawSql: string;
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

interface GroupResp {
  customers: CustomerOverdue[];
  summary: { totalClientes: number; totalParcelas: number; totalDevido: number };
  columnMap: Record<string, string | null>;
  rawSql: string;
}

interface DiagnoseResp {
  columns: { field: string; type: string; null: string; default: any }[];
  sample: any[];
  pagoCandidates: string[];
  detected: Record<string, string | null>;
  clientesTable?: { table: string; codCliente: string; nome: string | null; telefone: string | null; telefone2: string | null } | null;
}

interface CampanhaItem {
  codCliente: string;
  nome: string;
  telefoneOriginal: string | null;
  telefone: string;
  diasAtraso: number;
  parcelasVencidas: number;
  totalDevido: number;
  mensagem: string;
  templateIndex: number;
}

interface CampanhaPreviewResp {
  queue: CampanhaItem[];
  skipped: Array<{ codCliente: string; nome: string; motivo: string }>;
  testMode: boolean;
  testPhone: string | null;
  summary: { totalClientes: number; totalMensagens: number; totalDevido: number };
}

interface CampanhaEnviarResp {
  total: number;
  sent: number;
  failed: Array<{ codCliente: string; nome: string; telefone: string; error: string }>;
  testMode: boolean;
  durationMs: number;
}

type ViewMode = 'parcela' | 'cliente';
type SortMode = 'nome' | 'totalDevido' | 'atraso';

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
  const [daysBack, setDaysBack] = useState(3650); // default: tudo que tá vencido (não filtra por idade)
  const [dataInicio, setDataInicio] = useState<string>(''); // YYYY-MM-DD opcional
  const [dataFim, setDataFim] = useState<string>('');       // YYYY-MM-DD opcional
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewMode>('cliente');
  const [sortMode, setSortMode] = useState<SortMode>('nome');
  const [sendingOne, setSendingOne] = useState<string | null>(null); // codCliente sendo enviado
  const [sendToast, setSendToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [flat, setFlat] = useState<FlatResp | null>(null);
  const [grouped, setGrouped] = useState<GroupResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [diagnose, setDiagnose] = useState<DiagnoseResp | null>(null);
  const [showDiag, setShowDiag] = useState(false);

  // Campanha WhatsApp
  const [minDiasAtraso, setMinDiasAtraso] = useState(3);
  const [delayMinutos, setDelayMinutos] = useState(2); // default 2min anti-ban
  const [campanha, setCampanha] = useState<CampanhaPreviewResp | null>(null);
  const [campanhaLoading, setCampanhaLoading] = useState(false);
  const [campanhaError, setCampanhaError] = useState<string | null>(null);
  const [showCampanha, setShowCampanha] = useState(false);
  const [campanhaResult, setCampanhaResult] = useState<CampanhaEnviarResp | null>(null);
  const [enviando, setEnviando] = useState(false);

  // Validação WhatsApp
  const [validating, setValidating] = useState(false);
  const [waValidation, setWaValidation] = useState<{
    results: Record<string, { exists: boolean | null; jid?: string }>;
    summary: { total: number; ativos: number; inativos: number; erros: number };
    connected: boolean;
  } | null>(null);

  async function loadDiagnose() {
    try {
      const r = await api<DiagnoseResp>('/crediarios/diagnose');
      setDiagnose(r);
      setShowDiag(true);
    } catch (e: any) {
      alert('Erro: ' + (e.message || 'falha ao diagnosticar'));
    }
  }

  function buildQs() {
    const qs: string[] = [`loja=${loja}`, `daysBack=${daysBack}`];
    if (dataInicio) qs.push(`dataInicio=${dataInicio}`);
    if (dataFim) qs.push(`dataFim=${dataFim}`);
    return qs.join('&');
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      if (view === 'parcela') {
        const res = await api<FlatResp>(`/crediarios/vencidos?${buildQs()}&limit=20000`);
        setFlat(res);
      } else {
        const res = await api<GroupResp>(`/crediarios/vencidos-clientes?${buildQs()}`);
        setGrouped(res);
      }
    } catch (e: any) {
      setError(e.message || 'falha ao carregar');
    } finally {
      setLoading(false);
    }
  }

  async function loadCampanha() {
    setCampanhaLoading(true);
    setCampanhaResult(null);
    setCampanhaError(null);
    setShowCampanha(true); // abre modal IMEDIATAMENTE com loader (evita "fica travado")
    setWaValidation(null);
    try {
      const res = await api<CampanhaPreviewResp>('/crediarios/cobranca/preview', {
        method: 'POST',
        body: JSON.stringify({
          loja,
          daysBack,
          dataInicio: dataInicio || undefined,
          dataFim: dataFim || undefined,
          minDiasAtraso,
        }),
      });
      setCampanha(res);
    } catch (e: any) {
      const msg = e.message || 'falha';
      setCampanhaError(msg);
      setCampanha(null);
    } finally {
      setCampanhaLoading(false);
    }
  }

  async function validarWhatsapp() {
    if (!campanha) return;
    setValidating(true);
    try {
      // Pega telefones únicos da fila + dos pulados que tem telefone
      const numbersSet = new Set<string>();
      for (const q of campanha.queue) {
        const t = String(q.telefoneOriginal || q.telefone || '').replace(/\D/g, '');
        if (t) numbersSet.add(t);
      }
      const res = await api<typeof waValidation>('/crediarios/validar-whatsapp', {
        method: 'POST',
        body: JSON.stringify({ numbers: Array.from(numbersSet) }),
      });
      setWaValidation(res as any);
    } catch (e: any) {
      alert('Erro ao validar WhatsApp: ' + (e.message || 'falha'));
    } finally {
      setValidating(false);
    }
  }

  async function dispararCampanha() {
    if (!campanha) return;
    const total = campanha.queue.length;
    const minutos = Math.ceil((total * delayMinutos) / 1);
    const msg = campanha.testMode
      ? `MODO TESTE ativo: vai mandar ${total} mensagens TODAS pro número ${formatPhone(campanha.testPhone || '')}.\n\n` +
        `Espaçamento: ${delayMinutos} min entre cada → tempo total ~${minutos} minutos.\n\nConfirma?`
      : `⚠️ ATENÇÃO: vai disparar ${total} mensagens REAIS pros clientes.\n\n` +
        `Espaçamento: ${delayMinutos} min entre cada → tempo total ~${minutos} minutos.\n\n` +
        `WhatsApp precisa estar conectado. Confirma?`;
    if (!confirm(msg)) return;
    setEnviando(true);
    setCampanhaResult(null);
    try {
      const res = await api<CampanhaEnviarResp>('/crediarios/cobranca/enviar', {
        method: 'POST',
        body: JSON.stringify({
          loja,
          daysBack,
          dataInicio: dataInicio || undefined,
          dataFim: dataFim || undefined,
          minDiasAtraso,
          delayMs: delayMinutos * 60_000,
        }),
      });
      setCampanhaResult(res);
    } catch (e: any) {
      alert('Erro ao disparar: ' + (e.message || 'falha'));
    } finally {
      setEnviando(false);
    }
  }

  useEffect(() => { if (authed) load(); /* eslint-disable-next-line */ }, [authed, view]);

  // Re-load quando filtros de data mudam (debounce simples 400ms)
  useEffect(() => {
    if (!authed) return;
    const t = setTimeout(() => load(), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [dataInicio, dataFim, daysBack, loja]);

  // ---- filtros locais ----
  const filteredParcelas = useMemo(() => {
    if (!flat) return [];
    let list = flat.rows;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) =>
        String(p.nome ?? '').toLowerCase().includes(q) ||
        String(p.codCliente ?? '').includes(q) ||
        String(p.numeroCompra ?? '').includes(q),
      );
    }
    list = [...list];
    if (sortMode === 'nome') {
      list.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR', { sensitivity: 'base' }));
    } else if (sortMode === 'totalDevido') {
      list.sort((a, b) => Number(b.valorParcela ?? 0) - Number(a.valorParcela ?? 0));
    } else if (sortMode === 'atraso') {
      // mais atrasado primeiro = vencimento mais antigo
      list.sort((a, b) => String(a.vencimento || '').localeCompare(String(b.vencimento || '')));
    }
    return list;
  }, [flat, search, sortMode]);

  const filteredCustomers = useMemo(() => {
    if (!grouped) return [];
    let list = grouped.customers;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((c) =>
        c.nome.toLowerCase().includes(q) || c.codCliente.includes(q),
      );
    }
    // Ordenação
    list = [...list];
    if (sortMode === 'nome') {
      list.sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR', { sensitivity: 'base' }));
    } else if (sortMode === 'totalDevido') {
      list.sort((a, b) => b.totalDevido - a.totalDevido);
    } else if (sortMode === 'atraso') {
      list.sort((a, b) => b.diasAtraso - a.diasAtraso);
    }
    return list;
  }, [grouped, search, sortMode]);

  // KPI summary depende da view
  const kpiData = useMemo(() => {
    if (view === 'parcela' && flat) {
      return {
        clientes: flat.summary.clientes,
        parcelas: flat.summary.totalParcelas,
        totalDevido: flat.summary.totalDevido,
      };
    }
    if (view === 'cliente' && grouped) {
      return {
        clientes: grouped.summary.totalClientes,
        parcelas: grouped.summary.totalParcelas,
        totalDevido: grouped.summary.totalDevido,
      };
    }
    return null;
  }, [view, flat, grouped]);

  const columnMap = view === 'parcela' ? flat?.columnMap : grouped?.columnMap;

  function toggleExpand(cod: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cod)) next.delete(cod);
      else next.add(cod);
      return next;
    });
  }

  /**
   * Envia uma mensagem direto pelo backend (Baileys já conectado), sem abrir
   * aba do web.whatsapp.com. Mostra toast com resultado.
   */
  async function sendDirect(key: string, number: string, text: string) {
    setSendingOne(key);
    setSendToast(null);
    try {
      const r = await api<{ ok: boolean; testMode: boolean; usedNumber: string; error?: string }>(
        '/crediarios/cobranca/send-one',
        {
          method: 'POST',
          body: JSON.stringify({ number, text }),
        },
      );
      if (r.ok) {
        setSendToast({
          ok: true,
          msg: r.testMode
            ? `Enviada em modo TESTE pra ${formatPhone(r.usedNumber)}`
            : `Enviada pra ${formatPhone(r.usedNumber)}`,
        });
      } else {
        setSendToast({ ok: false, msg: r.error || 'Falha ao enviar' });
      }
    } catch (e: any) {
      setSendToast({ ok: false, msg: e.message || 'Erro de rede' });
    } finally {
      setSendingOne(null);
      setTimeout(() => setSendToast(null), 4000);
    }
  }

  function buildMsgParcela(p: Parcela): string {
    const nome = String(p.nome ?? '').split(' ')[0] || 'cliente';
    return (
      `Olá, ${nome}! Aqui é da Lurd's Plus Size.\n\n` +
      `Tenho aqui uma parcela em aberto:\n` +
      `• Compra ${p.numeroCompra ?? '-'} — Parcela ${p.parcela ?? '?'}/${p.totalParcelas ?? '?'}\n` +
      `• Vencimento: ${fmtDate(p.vencimento)}\n` +
      `• Valor: ${brl(p.valorParcela)}\n\n` +
      `Pode regularizar pelo PIX, cartão ou direto na loja. Qualquer dúvida, é só chamar!`
    );
  }

  function buildMsgCliente(c: CustomerOverdue): string {
    const partes = c.parcelas
      .map((p) => `• Parcela ${p.parcela ?? '?'}/${p.totalParcelas ?? '?'} — venc. ${fmtDate(p.vencimento)} — ${brl(p.valorParcela)}`)
      .join('\n');
    return (
      `Olá, ${c.nome.split(' ')[0]}! Aqui é da Lurd's Plus Size.\n\n` +
      `Identificamos parcelas em atraso:\n${partes}\n\n` +
      `Total em aberto: ${brl(c.totalDevido)} (${c.parcelasVencidas} parcelas — ${c.diasAtraso} dias atraso).\n\n` +
      `Pode regularizar pelo PIX, cartão ou direto na loja. Qualquer dúvida, é só chamar!`
    );
  }

  function exportCsv() {
    let csv = '';
    let filename = '';
    if (view === 'parcela' && flat) {
      const lines = [
        'codCliente,nome,telefone,numeroCompra,dataCompra,valorCompra,parcela,totalParcelas,vencimento,valorParcela,diasAtraso',
        ...filteredParcelas.map((p) => [
          p.codCliente ?? '',
          esc(p.nome ?? ''),
          esc(p.telefone ?? ''),
          p.numeroCompra ?? '',
          p.dataCompra ? String(p.dataCompra).slice(0, 10) : '',
          Number(p.valorCompra ?? 0).toFixed(2),
          p.parcela ?? '',
          p.totalParcelas ?? '',
          p.vencimento ? String(p.vencimento).slice(0, 10) : '',
          Number(p.valorParcela ?? 0).toFixed(2),
          diasAtrasoFromDate(p.vencimento),
        ].join(',')),
      ];
      csv = lines.join('\n');
      filename = `crediario-parcelas-loja${loja}-${new Date().toISOString().slice(0, 10)}.csv`;
    } else if (view === 'cliente' && grouped) {
      const lines = [
        'codCliente,nome,telefone,parcelasVencidas,totalDevido,vencimentoMaisAntigo,diasAtraso',
        ...grouped.customers.map((c) => [
          c.codCliente,
          esc(c.nome),
          esc(c.telefone || ''),
          c.parcelasVencidas,
          c.totalDevido.toFixed(2),
          c.vencimentoMaisAntigo || '',
          c.diasAtraso,
        ].join(',')),
      ];
      csv = lines.join('\n');
      filename = `crediario-clientes-loja${loja}-${new Date().toISOString().slice(0, 10)}.csv`;
    }
    if (!csv) return;
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
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
      subtitle="Parcelas vencidas — fila de cobrança"
      icon={CreditCard}
      tone="rose"
      backHref="/loja"
    >
      {/* Filtros + view toggle */}
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
          <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Vencimento de</label>
          <input
            type="date"
            value={dataInicio}
            onChange={(e) => setDataInicio(e.target.value)}
            className="px-2 py-1.5 text-sm rounded-lg border border-rose-200 bg-white focus:outline-none focus:border-rose-400"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>até</label>
          <input
            type="date"
            value={dataFim}
            onChange={(e) => setDataFim(e.target.value)}
            className="px-2 py-1.5 text-sm rounded-lg border border-rose-200 bg-white focus:outline-none focus:border-rose-400"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Janela</label>
          <select
            value={daysBack}
            onChange={(e) => setDaysBack(Number(e.target.value))}
            disabled={!!dataInicio}
            className="px-2 py-1.5 text-sm rounded-lg border border-rose-200 bg-white disabled:opacity-50"
            title={dataInicio ? 'Janela ignorada quando "Vencimento de" está preenchido' : ''}
          >
            <option value={30}>30 dias</option>
            <option value={60}>60 dias</option>
            <option value={90}>90 dias</option>
            <option value={180}>6 meses</option>
            <option value={365}>1 ano</option>
            <option value={730}>2 anos</option>
            <option value={3650}>10 anos (tudo)</option>
          </select>
        </div>
        {(dataInicio || dataFim) && (
          <button
            onClick={() => { setDataInicio(''); setDataFim(''); }}
            className="px-2 py-1.5 text-xs rounded-lg border border-rose-200 bg-white hover:bg-rose-50 text-rose-700 flex items-center gap-1"
            title="Limpar datas"
          >
            <X className="w-3 h-3" /> Limpar datas
          </button>
        )}
        <div className="flex-1 min-w-[200px]">
          <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Buscar</label>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nome, código ou nº compra…"
              className="w-full pl-7 pr-2 py-1.5 text-sm rounded-lg border border-rose-200 bg-white"
            />
          </div>
        </div>

        {/* Toggle view */}
        <div className="flex items-center gap-1 bg-rose-50 rounded-lg p-0.5 border border-rose-200">
          <button
            onClick={() => setView('parcela')}
            className={`px-2.5 py-1.5 text-xs rounded-md flex items-center gap-1 font-semibold transition ${
              view === 'parcela' ? 'bg-white shadow-sm text-rose-800' : 'text-rose-600 hover:text-rose-800'
            }`}
            title="Lista de parcelas em ordem de vencimento"
          >
            <List className="w-3.5 h-3.5" /> Por parcela
          </button>
          <button
            onClick={() => setView('cliente')}
            className={`px-2.5 py-1.5 text-xs rounded-md flex items-center gap-1 font-semibold transition ${
              view === 'cliente' ? 'bg-white shadow-sm text-rose-800' : 'text-rose-600 hover:text-rose-800'
            }`}
            title="Agrupado por cliente"
          >
            <Users className="w-3.5 h-3.5" /> Por cliente
          </button>
        </div>

        {/* Ordenação */}
        <div>
          <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Ordenar por</label>
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="px-2 py-1.5 text-sm rounded-lg border border-rose-200 bg-white focus:outline-none focus:border-rose-400"
            title="Ordem da lista"
          >
            <option value="nome">Nome (A-Z)</option>
            <option value="totalDevido">Total devido (maior)</option>
            <option value="atraso">Mais atrasado</option>
          </select>
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
          onClick={loadCampanha}
          disabled={campanhaLoading || (!flat && !grouped)}
          className="px-3 py-1.5 text-sm rounded-lg text-white shadow-sm flex items-center gap-1.5 disabled:opacity-50"
          style={{ background: '#5d7048' }}
          title="Preview de campanha de cobrança WhatsApp"
        >
          {campanhaLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Megaphone className="w-4 h-4" />}
          Campanha WA
        </button>
        <Link
          href="/retaguarda/crediario/automatico"
          className="px-3 py-1.5 text-sm rounded-lg text-white shadow-sm flex items-center gap-1.5"
          style={{ background: '#a07f30' }}
          title="Disparador automático recorrente"
        >
          <Zap className="w-4 h-4" />
          Automático
        </Link>
        <Link
          href="/retaguarda/crediario/mensagens"
          className="px-3 py-1.5 text-sm rounded-lg shadow-sm flex items-center gap-1.5 border"
          style={{ background: '#fff', borderColor: '#c08081', color: '#6e3a40' }}
          title="Editar templates de cobrança"
        >
          <Settings className="w-4 h-4" />
          Mensagens
        </Link>
        <button
          onClick={exportCsv}
          disabled={!flat && !grouped}
          className="px-3 py-1.5 text-sm rounded-lg border border-rose-200 bg-white hover:bg-rose-50 disabled:opacity-40 flex items-center gap-1.5"
        >
          <Download className="w-4 h-4 text-rose-700" /> CSV
        </button>
      </div>

      {/* KPIs */}
      {kpiData && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <Kpi label="Clientes em atraso"  value={kpiData.clientes.toLocaleString('pt-BR')}  tone="rose" />
          <Kpi label="Parcelas vencidas"   value={kpiData.parcelas.toLocaleString('pt-BR')} tone="peach" />
          <Kpi label="Total em aberto"     value={brl(kpiData.totalDevido)}                  tone="coral" />
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

      {/* Aviso quando filtro PAGO não foi detectado */}
      {columnMap && !columnMap.pago && (
        <div className="panel-pastel p-3 border-l-4 border-amber-400 mb-3">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold text-amber-800">Coluna PAGO não foi detectada</div>
              <div className="text-amber-700 text-xs mt-1">
                Pode estar trazendo parcelas já pagas. Clique em <b>Diagnosticar</b> pra ver os nomes reais
                das colunas da tabela <code>movimento</code> e me passar o resultado.
              </div>
              <button
                onClick={loadDiagnose}
                className="mt-2 px-3 py-1.5 text-xs rounded-lg bg-amber-600 text-white shadow-sm hover:bg-amber-700"
              >
                Diagnosticar colunas
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mapeamento de colunas detectado (debug) + SQL gerado */}
      {columnMap && (
        <details className="panel-pastel p-2 mb-3">
          <summary className="text-xs text-slate-500 cursor-pointer">
            Mapeamento de colunas detectado (debug)
            {columnMap.pago && <span className="ml-2 text-emerald-700 text-[11px]">· filtro PAGO=N ativo</span>}
            {!columnMap.pago && columnMap.dataPagamento && <span className="ml-2 text-amber-700 text-[11px]">· fallback DATA_PAGAMENTO IS NULL</span>}
            {!columnMap.pago && !columnMap.dataPagamento && <span className="ml-2 text-rose-700 text-[11px]">· SEM filtro de pago — vai trazer pagas</span>}
          </summary>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-1 text-[11px] font-mono">
            {Object.entries(columnMap).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <span className="text-slate-500">{k}:</span>
                <span className={v ? 'text-emerald-700' : 'text-rose-500'}>{v || '✗'}</span>
              </div>
            ))}
          </div>
          {/* SQL gerado */}
          {(flat?.rawSql || grouped?.rawSql) && (
            <div className="mt-3 pt-2 border-t border-rose-100">
              <div className="text-[10px] uppercase tracking-widest font-semibold text-slate-500 mb-1">SQL gerado</div>
              <pre className="bg-slate-900 text-emerald-200 text-[10px] p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
{flat?.rawSql || grouped?.rawSql}
              </pre>
            </div>
          )}
          <button
            onClick={loadDiagnose}
            className="mt-2 px-2.5 py-1 text-[11px] rounded bg-slate-700 text-white hover:bg-slate-800"
          >
            Ver TODAS as colunas brutas + amostra
          </button>
        </details>
      )}

      {/* Modal diagnóstico */}
      {showDiag && diagnose && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setShowDiag(false)}>
          <div
            className="bg-white rounded-2xl max-w-5xl w-full max-h-[85vh] overflow-y-auto p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold" style={{ color: '#6e3a40' }}>Diagnóstico — tabela `movimento`</h2>
              <button onClick={() => setShowDiag(false)} className="text-slate-500 hover:text-slate-800 text-2xl">×</button>
            </div>

            {diagnose.pagoCandidates.length > 0 && (
              <div className="mb-3 p-3 bg-emerald-50 border-l-4 border-emerald-500 rounded">
                <div className="text-xs font-bold text-emerald-800 uppercase mb-1">Candidatos a coluna "pago"</div>
                <ul className="text-sm text-emerald-900">
                  {diagnose.pagoCandidates.map((c) => <li key={c} className="font-mono">• {c}</li>)}
                </ul>
                <div className="text-[11px] text-emerald-700 mt-2">
                  Se algum desses for o filtro de pago real, me passa o nome exato e eu adiciono no regex.
                </div>
              </div>
            )}

            <div className="mb-4">
              <h3 className="text-sm font-semibold mb-2" style={{ color: '#6e3a40' }}>Todas as colunas ({diagnose.columns.length})</h3>
              <div className="overflow-x-auto">
                <table className="text-xs w-full border border-slate-200">
                  <thead className="bg-slate-100">
                    <tr>
                      <th className="px-2 py-1 text-left">Campo</th>
                      <th className="px-2 py-1 text-left">Tipo</th>
                      <th className="px-2 py-1 text-left">Null</th>
                      <th className="px-2 py-1 text-left">Default</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diagnose.columns.map((c) => (
                      <tr key={c.field} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-2 py-1 font-mono font-semibold">{c.field}</td>
                        <td className="px-2 py-1 text-slate-600">{c.type}</td>
                        <td className="px-2 py-1">{c.null}</td>
                        <td className="px-2 py-1 text-slate-500">{c.default ?? '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold mb-2" style={{ color: '#6e3a40' }}>Amostra (5 linhas)</h3>
              <div className="overflow-x-auto">
                <pre className="bg-slate-900 text-emerald-200 text-[10px] p-2 rounded whitespace-pre-wrap break-all">
{JSON.stringify(diagnose.sample, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && !flat && !grouped && (
        <div className="panel-pastel p-8 text-center text-slate-400 text-sm">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Buscando parcelas vencidas na Loja {loja}…
        </div>
      )}

      {/* ---------- VIEW: POR PARCELA (default) ---------- */}
      {view === 'parcela' && flat && filteredParcelas.length === 0 && !loading && (
        <div className="panel-pastel p-8 text-center text-slate-500 text-sm">
          Nenhuma parcela vencida encontrada{search ? ' pra esse filtro' : ''}.
        </div>
      )}

      {view === 'parcela' && flat && filteredParcelas.length > 0 && (
        <div className="panel-pastel p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="text-sm w-full">
              <thead className="sticky top-0">
                <tr className="text-left bg-rose-50 text-rose-900 border-b border-rose-200">
                  <th className="px-3 py-2">Vencimento</th>
                  <th className="px-3 py-2 text-right">Atraso</th>
                  <th className="px-3 py-2">Cliente</th>
                  <th className="px-3 py-2">Compra</th>
                  <th className="px-3 py-2">Data compra</th>
                  <th className="px-3 py-2 text-right">Valor compra</th>
                  <th className="px-3 py-2 text-center">Parcela</th>
                  <th className="px-3 py-2 text-right">Valor parcela</th>
                  <th className="px-3 py-2 text-center">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredParcelas.map((p, i) => {
                  const dias = diasAtrasoFromDate(p.vencimento);
                  return (
                    <tr key={`${p.registro ?? p.controle ?? i}-${i}`} className="border-b border-rose-100 hover:bg-rose-50/40 transition">
                      <td className="px-3 py-2 font-semibold tabular-nums" style={{ color: '#6e3a40' }}>
                        {fmtDate(p.vencimento)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${atrasoCor(dias)}`}>
                          {dias}d
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-semibold text-slate-800 text-[13px]">{p.nome || '-'}</div>
                        <div className="text-[10px] text-slate-500">cod {p.codCliente ?? '-'}{p.telefone ? ` · ${formatPhone(String(p.telefone))}` : ''}</div>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{String(p.numeroCompra ?? '-')}</td>
                      <td className="px-3 py-2 text-xs">{fmtDate(p.dataCompra)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs text-slate-600">{brl(p.valorCompra)}</td>
                      <td className="px-3 py-2 text-center text-xs">
                        <span className="font-semibold">{p.parcela ?? '?'}</span>
                        <span className="text-slate-400">/{p.totalParcelas ?? '?'}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold" style={{ color: '#8b4f55' }}>
                        {brl(p.valorParcela)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {(() => {
                            const key = `parc-${p.registro ?? p.controle ?? i}`;
                            const sending = sendingOne === key;
                            const tel = String(p.telefone ?? '').replace(/\D/g, '');
                            const disabled = !tel || sending;
                            return (
                              <button
                                onClick={() => sendDirect(key, tel, buildMsgParcela(p))}
                                disabled={disabled}
                                className="px-2 py-1 text-xs rounded-lg text-white flex items-center gap-1 shadow-sm disabled:opacity-40"
                                style={{ background: '#5d7048' }}
                                title={tel ? 'Mandar WA direto pelo backend' : 'Sem telefone'}
                              >
                                {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <MessageSquare className="w-3 h-3" />}
                                WA
                              </button>
                            );
                          })()}
                          <button
                            onClick={() => navigator.clipboard.writeText(
                              `${p.nome ?? ''} (${p.codCliente ?? ''}) — Compra ${p.numeroCompra ?? '-'} — Parcela ${p.parcela ?? '?'}/${p.totalParcelas ?? '?'} — venc ${fmtDate(p.vencimento)} — ${brl(p.valorParcela)}`,
                            )}
                            className="p-1 hover:bg-rose-100 rounded"
                            title="Copiar dados"
                          >
                            <Copy className="w-3 h-3 text-slate-500" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-rose-50 border-t-2 border-rose-200 font-semibold">
                  <td className="px-3 py-2 text-xs" colSpan={7} style={{ color: '#6e3a40' }}>
                    Total: {filteredParcelas.length} parcelas
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums" style={{ color: '#8b4f55' }}>
                    {brl(filteredParcelas.reduce((s, p) => s + Math.max(0, Number(p.valorParcela ?? 0) - Number(p.valorPago ?? 0)), 0))}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ---------- VIEW: POR CLIENTE ---------- */}
      {view === 'cliente' && grouped && filteredCustomers.length === 0 && !loading && (
        <div className="panel-pastel p-8 text-center text-slate-500 text-sm">
          Nenhum cliente em atraso encontrado{search ? ' pra esse filtro' : ''}.
        </div>
      )}

      {/* Modal Campanha WhatsApp */}
      {showCampanha && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => !enviando && !campanhaLoading && setShowCampanha(false)}>
          <div
            className="bg-white rounded-2xl max-w-5xl w-full max-h-[90vh] overflow-y-auto p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Megaphone className="w-5 h-5" style={{ color: '#5d7048' }} />
                <h2 className="text-lg font-semibold" style={{ color: '#6e3a40' }}>Campanha de cobrança WhatsApp</h2>
              </div>
              <button
                onClick={() => !enviando && !campanhaLoading && setShowCampanha(false)}
                disabled={enviando || campanhaLoading}
                className="text-slate-500 hover:text-slate-800 text-2xl disabled:opacity-30"
              >×</button>
            </div>

            {/* Loading inicial */}
            {campanhaLoading && !campanha && (
              <div className="p-12 text-center text-slate-500">
                <Loader2 className="w-8 h-8 animate-spin inline mb-3" style={{ color: '#5d7048' }} />
                <div className="text-sm font-semibold" style={{ color: '#6e3a40' }}>Montando fila de cobrança…</div>
                <div className="text-xs text-slate-500 mt-1">
                  Buscando clientes em atraso, telefones e renderizando templates.
                  Pode demorar 30-60s pra lojas grandes.
                </div>
              </div>
            )}

            {/* Erro */}
            {campanhaError && !campanha && !campanhaLoading && (
              <div className="p-6 bg-rose-50 border-l-4 border-rose-500 rounded">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <div className="font-bold text-rose-900">Erro ao montar campanha</div>
                    <div className="text-sm text-rose-800 mt-1 font-mono break-words whitespace-pre-wrap">{campanhaError}</div>
                    <button
                      onClick={loadCampanha}
                      className="mt-3 px-3 py-1.5 text-xs rounded-lg bg-rose-700 text-white hover:bg-rose-800 flex items-center gap-1.5"
                    >
                      <RefreshCw className="w-3 h-3" /> Tentar novamente
                    </button>
                  </div>
                </div>
              </div>
            )}

            {campanha && (<>
              {/* CONTEÚDO ORIGINAL DO MODAL VEM A SEGUIR */}

            {/* Banner modo TESTE */}
            {campanha.testMode && (
              <div className="mb-4 p-3 bg-amber-50 border-l-4 border-amber-500 rounded flex items-start gap-2">
                <FlaskConical className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <div className="font-bold text-amber-900">MODO TESTE ATIVO</div>
                  <div className="text-amber-800 text-xs mt-1">
                    Todas as mensagens serão enviadas pro número de teste:&nbsp;
                    <span className="font-mono font-bold">{formatPhone(campanha.testPhone || '')}</span>.
                    <br />Pra desativar, remova a env var <code>COBRANCA_TEST_PHONE</code> no Railway.
                  </div>
                </div>
              </div>
            )}

            {/* Configs */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 p-3 bg-rose-50/50 rounded-lg border border-rose-100">
              <div>
                <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Atraso mínimo</label>
                <select
                  value={minDiasAtraso}
                  onChange={(e) => setMinDiasAtraso(Number(e.target.value))}
                  disabled={enviando}
                  className="w-full px-2 py-1.5 text-sm rounded-lg border border-rose-200 bg-white"
                >
                  <option value={0}>Qualquer atraso</option>
                  <option value={1}>1 dia</option>
                  <option value={3}>3 dias (recomendado)</option>
                  <option value={5}>5 dias</option>
                  <option value={7}>7 dias</option>
                  <option value={15}>15 dias</option>
                  <option value={30}>30 dias</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Espaçamento</label>
                <select
                  value={delayMinutos}
                  onChange={(e) => setDelayMinutos(Number(e.target.value))}
                  disabled={enviando}
                  className="w-full px-2 py-1.5 text-sm rounded-lg border border-rose-200 bg-white"
                >
                  <option value={1}>1 min (rápido — risco)</option>
                  <option value={2}>2 min (recomendado)</option>
                  <option value={3}>3 min</option>
                  <option value={5}>5 min (seguro)</option>
                  <option value={10}>10 min (ultra seguro)</option>
                </select>
              </div>
              <div className="col-span-2 flex items-end">
                <button
                  onClick={loadCampanha}
                  disabled={campanhaLoading || enviando}
                  className="px-3 py-1.5 text-xs rounded-lg border border-rose-200 bg-white hover:bg-rose-50 flex items-center gap-1 disabled:opacity-50"
                >
                  {campanhaLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  Recalcular fila
                </button>
              </div>
            </div>

            {/* KPIs da campanha */}
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                <div className="text-[10px] uppercase tracking-widest font-bold text-emerald-800">Vão receber</div>
                <div className="text-2xl font-semibold text-emerald-900 tabular-nums">{campanha.queue.length}</div>
                <div className="text-[10px] text-emerald-700">clientes</div>
              </div>
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
                <div className="text-[10px] uppercase tracking-widest font-bold text-amber-800">Pulados</div>
                <div className="text-2xl font-semibold text-amber-900 tabular-nums">{campanha.skipped.length}</div>
                <div className="text-[10px] text-amber-700">sem telefone / atraso</div>
              </div>
              <div className="p-3 rounded-lg bg-rose-50 border border-rose-200">
                <div className="text-[10px] uppercase tracking-widest font-bold text-rose-800">Total a cobrar</div>
                <div className="text-2xl font-semibold text-rose-900 tabular-nums">{brl(campanha.summary.totalDevido)}</div>
                <div className="text-[10px] text-rose-700">~{Math.ceil((campanha.queue.length * delayMinutos))} min de envio</div>
              </div>
            </div>

            {/* Resultado do disparo (depois) */}
            {campanhaResult && (
              <div className={`mb-4 p-3 rounded-lg border ${campanhaResult.failed.length > 0 ? 'bg-amber-50 border-amber-300' : 'bg-emerald-50 border-emerald-300'}`}>
                <div className="font-bold text-sm mb-1 flex items-center gap-2">
                  <Check className="w-4 h-4" />
                  Disparo concluído em {(campanhaResult.durationMs / 60000).toFixed(1)} min
                </div>
                <div className="text-xs text-slate-700">
                  {campanhaResult.sent} enviadas · {campanhaResult.failed.length} falhas
                  {campanhaResult.testMode && <span className="ml-2 text-amber-700 font-bold">(MODO TESTE)</span>}
                </div>
                {campanhaResult.failed.length > 0 && (
                  <details className="mt-2">
                    <summary className="text-xs cursor-pointer text-amber-800">Ver falhas</summary>
                    <div className="mt-2 max-h-40 overflow-y-auto text-[10px] font-mono space-y-1">
                      {campanhaResult.failed.map((f, i) => (
                        <div key={i} className="text-rose-700">• {f.nome} ({f.telefone}): {f.error}</div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}

            {/* Lista da fila */}
            {campanha.queue.length === 0 ? (
              <div className="p-6 text-center text-sm text-slate-500 bg-slate-50 rounded">
                Nenhum cliente elegível pra cobrança nesse filtro.
                {campanha.skipped.length > 0 && <div className="mt-2 text-xs">{campanha.skipped.length} pulados — veja motivos abaixo.</div>}
              </div>
            ) : (
              <div className="mb-4">
                <h3 className="text-sm font-semibold mb-2" style={{ color: '#6e3a40' }}>
                  Fila de envio ({campanha.queue.length})
                </h3>
                <div className="max-h-[40vh] overflow-y-auto border border-rose-100 rounded-lg">
                  <table className="text-xs w-full">
                    <thead className="bg-rose-50 sticky top-0">
                      <tr className="text-left">
                        <th className="px-2 py-1.5 w-6">#</th>
                        <th className="px-2 py-1.5">Cliente</th>
                        <th className="px-2 py-1.5">Telefone</th>
                        <th className="px-2 py-1.5 text-right">Atraso</th>
                        <th className="px-2 py-1.5 text-right">Devido</th>
                        <th className="px-2 py-1.5 text-center">Tpl</th>
                        <th className="px-2 py-1.5">Mensagem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {campanha.queue.map((q, i) => (
                        <tr key={q.codCliente} className="border-t border-rose-50 hover:bg-rose-50/30 align-top">
                          <td className="px-2 py-1.5 text-slate-500 tabular-nums">{i + 1}</td>
                          <td className="px-2 py-1.5">
                            <div className="font-semibold text-slate-800">{q.nome}</div>
                            <div className="text-[10px] text-slate-500">cod {q.codCliente} · {q.parcelasVencidas} parc.</div>
                          </td>
                          <td className="px-2 py-1.5 font-mono">
                            {campanha.testMode ? (
                              <span className="text-amber-700 font-bold">{formatPhone(q.telefone)}</span>
                            ) : (
                              <span>{formatPhone(q.telefone)}</span>
                            )}
                            {campanha.testMode && q.telefoneOriginal && (
                              <div className="text-[10px] text-slate-400">orig: {formatPhone(q.telefoneOriginal)}</div>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            <span className={`px-1 py-0.5 rounded text-[10px] font-semibold ${atrasoCor(q.diasAtraso)}`}>
                              {q.diasAtraso}d
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums font-semibold" style={{ color: '#8b4f55' }}>
                            {brl(q.totalDevido)}
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-mono">
                              T{q.templateIndex + 1}
                            </span>
                          </td>
                          <td className="px-2 py-1.5">
                            <details>
                              <summary className="cursor-pointer text-[10px] text-rose-700 hover:underline">ver msg</summary>
                              <pre className="mt-1 p-2 bg-slate-900 text-emerald-200 text-[10px] rounded whitespace-pre-wrap break-words max-w-md">{q.mensagem}</pre>
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Pulados */}
            {campanha.skipped.length > 0 && (
              <details className="mb-4">
                <summary className="text-xs cursor-pointer text-amber-800 hover:underline">
                  ⚠️ {campanha.skipped.length} clientes pulados
                </summary>
                <div className="mt-2 max-h-40 overflow-y-auto bg-amber-50/50 p-2 rounded text-[10px] font-mono space-y-1">
                  {campanha.skipped.map((s, i) => (
                    <div key={i} className="text-amber-900">• {s.nome} (cod {s.codCliente}) — {s.motivo}</div>
                  ))}
                </div>
              </details>
            )}

            {/* Validação WhatsApp */}
            {waValidation && (
              <div className="mb-3 p-3 rounded-lg bg-sky-50 border border-sky-200">
                <div className="text-xs font-bold text-sky-900 flex items-center gap-1.5 mb-2">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Validação WhatsApp ({waValidation.summary.total} números)
                  {!waValidation.connected && <span className="ml-auto text-rose-700">⚠ desconectado</span>}
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="bg-emerald-100 rounded p-2 text-emerald-900">
                    <div className="text-[10px] uppercase font-bold">Tem WhatsApp</div>
                    <div className="text-xl font-semibold tabular-nums">{waValidation.summary.ativos}</div>
                  </div>
                  <div className="bg-rose-100 rounded p-2 text-rose-900">
                    <div className="text-[10px] uppercase font-bold">Não tem</div>
                    <div className="text-xl font-semibold tabular-nums">{waValidation.summary.inativos}</div>
                  </div>
                  <div className="bg-slate-100 rounded p-2 text-slate-700">
                    <div className="text-[10px] uppercase font-bold">Erro/timeout</div>
                    <div className="text-xl font-semibold tabular-nums">{waValidation.summary.erros}</div>
                  </div>
                </div>
                {waValidation.summary.inativos > 0 && (
                  <details className="mt-2">
                    <summary className="text-[11px] cursor-pointer text-rose-700 hover:underline">
                      Ver {waValidation.summary.inativos} números sem WhatsApp
                    </summary>
                    <div className="mt-1 max-h-32 overflow-y-auto text-[10px] font-mono space-y-0.5 bg-white p-2 rounded border border-rose-200">
                      {campanha.queue
                        .filter((q) => {
                          const n = String(q.telefoneOriginal || q.telefone || '').replace(/\D/g, '');
                          return waValidation.results[n]?.exists === false;
                        })
                        .map((q) => (
                          <div key={q.codCliente} className="text-rose-800">
                            • {q.nome} ({formatPhone(q.telefoneOriginal || q.telefone)}) — cod {q.codCliente}
                          </div>
                        ))}
                    </div>
                  </details>
                )}
              </div>
            )}

            {/* Footer com ações */}
            <div className="flex items-center justify-between gap-3 pt-3 border-t border-rose-100">
              <div className="text-xs text-slate-500">
                <Phone className="w-3 h-3 inline mr-1" />
                {campanha.testMode
                  ? <span className="text-amber-700 font-bold">Modo teste — número {formatPhone(campanha.testPhone || '')}</span>
                  : <span>Disparo direto pros telefones reais</span>}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={validarWhatsapp}
                  disabled={validating || enviando || campanha.queue.length === 0}
                  className="px-3 py-1.5 text-sm rounded-lg border-2 flex items-center gap-1.5 disabled:opacity-50"
                  style={{ borderColor: '#0ea5e9', color: '#0369a1', background: '#f0f9ff' }}
                  title="Verifica quais números têm WhatsApp ativo"
                >
                  {validating ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  Validar WA
                </button>
                <button
                  onClick={() => !enviando && setShowCampanha(false)}
                  disabled={enviando}
                  className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50"
                >
                  Fechar
                </button>
                <button
                  onClick={dispararCampanha}
                  disabled={enviando || campanha.queue.length === 0}
                  className="px-4 py-2 text-sm rounded-lg text-white shadow-sm flex items-center gap-1.5 disabled:opacity-50"
                  style={{ background: campanha.testMode ? '#a07f30' : '#8b4f55' }}
                >
                  {enviando ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Enviando…</>
                  ) : (
                    <><Send className="w-4 h-4" /> Disparar {campanha.queue.length} mensagens</>
                  )}
                </button>
              </div>
            </div>
            </>)}
          </div>
        </div>
      )}

      {/* Toast de envio direto */}
      {sendToast && (
        <div
          className={`fixed bottom-6 right-6 z-[60] px-4 py-3 rounded-xl shadow-lg border flex items-center gap-2 text-sm max-w-md ${
            sendToast.ok
              ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
              : 'bg-rose-50 border-rose-300 text-rose-900'
          }`}
        >
          {sendToast.ok ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          <span className="flex-1">{sendToast.msg}</span>
          <button onClick={() => setSendToast(null)} className="opacity-60 hover:opacity-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {view === 'cliente' && grouped && filteredCustomers.length > 0 && (
        <div className="panel-pastel p-0 overflow-hidden">
          {/* Resumo de telefones */}
          <div className="px-3 py-2 bg-rose-50/40 border-b border-rose-100 text-xs flex items-center gap-3 flex-wrap">
            <span className="font-semibold" style={{ color: '#6e3a40' }}>
              Telefones cadastrados: {filteredCustomers.filter((c) => c.telefone).length}/{filteredCustomers.length}
            </span>
            {filteredCustomers.filter((c) => !c.telefone).length > 0 && (
              <span className="text-rose-600">
                ⚠️ {filteredCustomers.filter((c) => !c.telefone).length} sem telefone — não recebem cobrança WA
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="text-sm w-full">
              <thead>
                <tr className="text-left bg-rose-50 text-rose-900 border-b border-rose-200">
                  <th className="px-3 py-2 w-8"></th>
                  <th className="px-3 py-2">Cliente</th>
                  <th className="px-3 py-2">Telefone</th>
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
                  const sending = sendingOne === `cli-${c.codCliente}`;
                  return (
                    <FragmentRow
                      key={c.codCliente}
                      c={c}
                      isOpen={isOpen}
                      sending={sending}
                      onToggle={() => toggleExpand(c.codCliente)}
                      onSend={() => sendDirect(`cli-${c.codCliente}`, String(c.telefone ?? '').replace(/\D/g, ''), buildMsgCliente(c))}
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
  c, isOpen, sending, onToggle, onSend,
}: {
  c: CustomerOverdue;
  isOpen: boolean;
  sending: boolean;
  onToggle: () => void;
  onSend: () => void;
}) {
  const tel = String(c.telefone ?? '').replace(/\D/g, '');
  const disabled = !tel || sending;
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
          <div className="text-xs text-slate-500">cod {c.codCliente}</div>
        </td>
        <td className="px-3 py-2">
          {c.telefone ? (
            <span className="text-xs font-mono text-slate-700">{formatPhone(c.telefone)}</span>
          ) : (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-700">
              sem cadastro
            </span>
          )}
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
            <button
              onClick={onSend}
              disabled={disabled}
              className="px-2 py-1 text-xs rounded-lg text-white flex items-center gap-1 shadow-sm disabled:opacity-40"
              style={{ background: '#5d7048' }}
              title={tel ? 'Cobrar via WhatsApp (envio direto)' : 'Sem telefone'}
            >
              {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <MessageSquare className="w-3 h-3" />}
              WA
            </button>
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
          <td colSpan={8} className="px-3 py-3">
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
function diasAtrasoFromDate(s?: string | null): number {
  if (!s) return 0;
  const d = new Date(s);
  if (isNaN(d.getTime())) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((today.getTime() - d.getTime()) / 86400000));
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
