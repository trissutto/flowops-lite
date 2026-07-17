'use client';

/**
 * /retaguarda/conciliacao — CONCILIAÇÃO FINANCEIRA (aprovado 17/07).
 * Cartões/PIX das maquininhas Stone + PagBank + Pagar.me × vendas do sistema.
 * Só admin. Fluxo: Importar → Conciliar → revisar divergências.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Scale, Loader2, RefreshCw, X, FileJson } from 'lucide-react';
import { api } from '@/lib/api';

const brl = (cents: number | null | undefined) =>
  cents == null ? '—' : (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtData = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

const STATUS_STYLE: Record<string, string> = {
  CONCILIADO: 'bg-emerald-50 text-emerald-800 border-emerald-300',
  DIVERGENTE: 'bg-rose-50 text-rose-700 border-rose-300',
  NAO_ENCONTRADO: 'bg-amber-50 text-amber-800 border-amber-300',
  DUPLICADO: 'bg-violet-50 text-violet-800 border-violet-300',
};
const STATUS_LABEL: Record<string, string> = {
  CONCILIADO: 'Conciliado',
  DIVERGENTE: 'Divergente',
  NAO_ENCONTRADO: 'Pgto sem venda',
  DUPLICADO: 'Duplicado',
};

export default function ConciliacaoPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);
  const [status, setStatus] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [fStatus, setFStatus] = useState('');
  const [fGateway, setFGateway] = useState('');
  const [fLoja, setFLoja] = useState('');
  // Abreviação do nome da loja (mesmo padrão do editor de produtos)
  const [lojas, setLojas] = useState<Array<{ code: string; name: string }>>([]);
  useEffect(() => {
    api<Array<{ code: string; name: string }>>('/stores').then(setLojas).catch(() => {});
  }, []);
  const lojaAbbr = (code: string | null) => {
    if (!code) return '—';
    const l = lojas.find((x) => x.code === code || x.code === String(code).padStart(2, '0'));
    if (!l?.name) return code;
    return String(l.name).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().slice(0, 5);
  };
  const [busy, setBusy] = useState(false);
  const [rodando, setRodando] = useState<'importar' | 'conciliar' | null>(null);
  const [err, setErr] = useState('');
  const [jsonDe, setJsonDe] = useState<any | null>(null);

  useEffect(() => {
    api<{ role: string }>('/auth/me')
      .then((me) => { if (me.role !== 'admin') { router.push('/'); return; } setAllowed(true); })
      .catch(() => router.push('/login'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const carregar = async () => {
    setBusy(true); setErr('');
    try {
      const [st, lista] = await Promise.all([
        api<any>('/conciliacao/status'),
        api<any>(`/conciliacao/list?status=${fStatus}&gateway=${fGateway}&loja=${fLoja}&page=${page}`),
      ]);
      setStatus(st);
      setRows(lista.rows || []);
      setTotal(lista.total || 0);
    } catch (e: any) { setErr(e?.message || 'Falha ao carregar'); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (allowed) carregar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [allowed, fStatus, fGateway, fLoja, page]);

  const rodar = async (qual: 'importar' | 'conciliar') => {
    setRodando(qual); setErr('');
    try {
      const r = await api<any>(`/conciliacao/${qual}`, { method: 'POST', body: JSON.stringify({}) });
      setErr('');
      alert(qual === 'importar'
        ? `Importado: PagBank ${r.pagbank} · Pagar.me ${r.pagarme} · Stone ${r.stone}`
        : `Motor: ${r.conciliadas} conciliadas · ${r.divergentes} divergentes · ${r.semVenda} sem venda · ${r.duplicadas} duplicadas`);
      await carregar();
    } catch (e: any) { setErr(e?.message || 'Falhou'); }
    finally { setRodando(null); }
  };

  const verJson = async (transactionId: string) => {
    const t = await api<any>(`/conciliacao/tx/${transactionId}/json`).catch(() => null);
    if (t) setJsonDe(t);
  };

  const contagem = (s: string) => (status?.conciliacoes || []).find((c: any) => c.status === s)?.qtd || 0;

  if (!allowed) return <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm">Carregando…</div>;

  return (
    <div className="min-h-screen bg-[#FAFAF7] pb-16 text-slate-800">
      <header className="bg-white border-b border-[#E7E2D8] sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800"><ArrowLeft className="w-5 h-5" /></Link>
          <Scale className="w-5 h-5 text-[#B8912B]" />
          <div className="flex-1">
            <h1 className="font-bold text-lg">Conciliação Financeira</h1>
            <p className="text-xs text-slate-500">Stone (maquininhas) · PagBank · Pagar.me × vendas do sistema</p>
          </div>
          <button onClick={() => rodar('importar')} disabled={!!rodando}
            className="px-4 py-2 rounded-xl border-2 border-[#B8912B] text-[#8C7325] text-sm font-bold disabled:opacity-50 flex items-center gap-2">
            {rodando === 'importar' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} 1. Importar
          </button>
          <button onClick={() => rodar('conciliar')} disabled={!!rodando}
            className="px-4 py-2 rounded-xl text-white text-sm font-black disabled:opacity-50 flex items-center gap-2"
            style={{ background: '#B8912B' }}>
            {rodando === 'conciliar' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scale className="w-4 h-4" />} 2. Conciliar
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-5 space-y-4">
        {err && <div className="bg-rose-50 border border-rose-200 text-rose-700 px-3 py-2 rounded-lg text-sm">{err}</div>}

        {/* Cards por status (clicáveis = filtro) */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {(['CONCILIADO', 'DIVERGENTE', 'NAO_ENCONTRADO', 'DUPLICADO'] as const).map((s) => (
            <button key={s} onClick={() => { setFStatus(fStatus === s ? '' : s); setPage(1); }}
              className={`rounded-xl border-2 p-3 text-left ${fStatus === s ? STATUS_STYLE[s] : 'bg-white border-[#E7E2D8]'}`}>
              <div className="text-[11px] font-bold uppercase text-slate-500">{STATUS_LABEL[s]}</div>
              <div className={`text-2xl font-black ${s === 'CONCILIADO' ? 'text-emerald-700' : s === 'DIVERGENTE' ? 'text-rose-600' : 'text-slate-800'}`}>
                {contagem(s)}
              </div>
            </button>
          ))}
        </div>

        {/* Transações importadas por gateway */}
        {status?.transacoes?.length > 0 && (
          <div className="flex gap-2 flex-wrap text-xs">
            {status.transacoes.map((t: any) => (
              <button key={t.gateway} onClick={() => { setFGateway(fGateway === t.gateway ? '' : t.gateway); setPage(1); }}
                className={`px-3 py-1.5 rounded-full border-2 font-bold ${fGateway === t.gateway ? 'bg-slate-800 text-white border-slate-800' : 'bg-white border-[#E7E2D8] text-slate-600'}`}>
                {t.gateway} · {t.qtd} transações · {brl(t.brutoCents)}
              </button>
            ))}
            <select value={fLoja} onChange={(e) => { setFLoja(e.target.value); setPage(1); }}
              className="px-3 py-1.5 rounded-full border-2 border-[#E7E2D8] bg-white text-slate-600 font-bold">
              <option value="">Loja: todas</option>
              {lojas.map((l) => <option key={l.code} value={l.code}>{l.code} · {l.name}</option>)}
            </select>
          </div>
        )}

        {/* Tabela */}
        <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-x-auto">
          {busy && !rows.length ? (
            <div className="p-10 text-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
          ) : (
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="bg-[#FAFAF7] text-[10px] uppercase tracking-wide text-slate-500 border-b border-[#E7E2D8]">
                  <th className="text-left px-3 py-2">Data venda</th>
                  <th className="text-left px-3 py-2">Gateway</th>
                  <th className="text-left px-3 py-2">Loja</th>
                  <th className="text-left px-3 py-2">Forma</th>
                  <th className="text-left px-3 py-2">NSU / cartão</th>
                  <th className="text-left px-3 py-2">Pedido</th>
                  <th className="text-right px-3 py-2">Sistema</th>
                  <th className="text-right px-3 py-2">Gateway</th>
                  <th className="text-right px-3 py-2">Diferença</th>
                  <th className="text-center px-3 py-2">Status</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-[#F1EDE3] hover:bg-[#FBF6E6]">
                    <td className="px-3 py-2 whitespace-nowrap text-xs">{fmtData(r.dataVenda)}</td>
                    <td className="px-3 py-2 text-xs font-bold">{r.gateway}</td>
                    <td className="px-3 py-2 text-xs font-bold text-slate-600" title={r.storeCode ? `Loja ${r.storeCode}` : 'sem loja na transação'}>{lojaAbbr(r.storeCode)}</td>
                    <td className="px-3 py-2 text-xs">{r.tipoPagamento || '—'}{r.bandeira ? ` · ${r.bandeira}` : ''}{r.parcelas > 1 ? ` ${r.parcelas}x` : ''}</td>
                    <td className="px-3 py-2 text-xs font-mono text-slate-500">{r.nsu || '—'}{r.cartaoFinal ? ` ·${r.cartaoFinal}` : ''}</td>
                    <td className="px-3 py-2 text-xs font-mono text-slate-500">{r.pedidoRef ? String(r.pedidoRef).slice(0, 8) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{brl(r.valorSistemaCents)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{brl(r.valorGatewayCents)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-bold ${r.diferencaCents ? 'text-rose-600' : 'text-slate-400'}`}>
                      {r.diferencaCents ? brl(r.diferencaCents) : '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${STATUS_STYLE[r.status] || 'border-slate-200 text-slate-500'}`}
                        title={r.motivo || ''}>
                        {STATUS_LABEL[r.status] || r.status}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-center">
                      <button onClick={() => verJson(r.transactionId)} title="Ver JSON bruto da adquirente"
                        className="p-1.5 rounded-lg border border-[#E7E2D8] text-slate-400 hover:bg-[#FBF6E6]">
                        <FileJson className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {!rows.length && !busy && (
                  <tr><td colSpan={11} className="text-center text-slate-400 py-10">
                    Nada aqui ainda — clique em <b>1. Importar</b> e depois <b>2. Conciliar</b>.
                  </td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>{total} resultado(s)</span>
          <span className="flex items-center gap-2">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-3 py-1 rounded-lg border border-[#E7E2D8] disabled:opacity-40">‹</button>
            Pág. {page} / {Math.max(1, Math.ceil(total / 50))}
            <button disabled={page >= Math.ceil(total / 50)} onClick={() => setPage(page + 1)} className="px-3 py-1 rounded-lg border border-[#E7E2D8] disabled:opacity-40">›</button>
          </span>
        </div>
      </main>

      {/* JSON bruto */}
      {jsonDe && (
        <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4" onClick={() => setJsonDe(null)}>
          <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[85vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-bold">JSON bruto — {jsonDe.gateway} {jsonDe.transactionId}</h3>
              <button onClick={() => setJsonDe(null)} className="text-slate-400"><X className="w-5 h-5" /></button>
            </div>
            <pre className="text-[11px] bg-slate-50 border border-slate-200 rounded-xl p-3 overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(jsonDe.rawJson ?? jsonDe, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
