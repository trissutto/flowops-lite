'use client';

/**
 * /site/portal-trocas — painel ADMIN das solicitações do Portal de Trocas.
 *
 * Lista com filtros De/Até + status + busca. Detalhe em drawer com:
 *  - linha do tempo completa (auditoria)
 *  - painel de BENEFÍCIOS da cliente (reversa grátis disponível/usada, alerta)
 *  - colar código reverso → dispara e-mail automático pra cliente
 *  - avançar status manualmente · conceder reversa extra · cancelar
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Search, Loader2, X, AlertTriangle, CheckCircle2, Mail,
  PackageCheck, Gift, Ban, RefreshCw,
} from 'lucide-react';
import { api } from '@/lib/api';

type TrocaRow = {
  id: string;
  numero: number;
  numeroFmt: string;
  wcOrderId: number;
  wcOrderNumber: string | null;
  customerName: string | null;
  customerCpf: string | null;
  customerEmail: string | null;
  motivo: string;
  motivoDetalhe: string | null;
  status: string;
  reversaGratis: boolean;
  reversaCodigo: string | null;
  reversaPrazo: string | null;
  reversaEnviadaAt: string | null;
  clienteTrackingCode: string | null;
  trackingCodePedido: string | null;
  prazoVerificadoVia: string | null;
  diasDesdeEntrega: number | null;
  dentroDoPrazo: boolean | null;
  valorTotalPago: number;
  createdAt: string;
  // Fase 2
  recebidaAt: string | null;
  conferenciaAt: string | null;
  conferenciaAprovada: boolean | null;
  conferenciaReprovadaMotivo: string | null;
  receivingStoreCode: string | null;
  receivingStoreName: string | null;
  decisao: string | null;
  novaSku: string | null;
  novaProductName: string | null;
  novaCor: string | null;
  novaTamanho: string | null;
  valeCode: string | null;
  valeValidade: string | null;
  reembolsoForma: string | null;
  reembolsoChavePix: string | null;
  reembolsoConcluidoAt: string | null;
  envioTrackingCode: string | null;
  envioAt: string | null;
  items: Array<{ sku: string; productName: string | null; qty: number; valorPagoUnit: number; totalPago: number; valorOriginalUnit: number; stockReturnedAt: string | null; stockError: string | null }>;
};

type Dash = {
  total: number;
  canceladas: number;
  finalizadas: number;
  abertas: number;
  porStatus: Record<string, number>;
  valorTotalPeriodo: number;
  tempoMedioPostagem: number | null;
  tempoMedioConferencia: number | null;
  tempoMedioConclusao: number | null;
  motivos: Array<{ nome: string; total: number }>;
  produtosMaisTrocados: Array<{ nome: string; total: number }>;
  trocasPorTamanho: number;
  trocasPorCor: number;
  trocasPorDefeito: number;
  trocasEncadeadas: number;
  pctVale: number;
  pctReembolso: number;
  pctTrocaPeca: number;
  reversasGratis: number;
};

const CHECKLIST = ['Produto correto', 'Sem uso', 'Etiqueta presente', 'Sem avarias', 'Conforme política'];
const REPROVACAO_MOTIVOS = ['Produto usado', 'Sem etiqueta', 'Produto danificado', 'Produto diferente'];
type StoreOpt = { code: string; name: string; active?: boolean };

type TrocaDetail = TrocaRow & {
  eventos: Array<{ id: string; tipo: string; descricao: string; statusPara: string | null; userName: string | null; createdAt: string }>;
  beneficio: {
    disponivel: boolean;
    usos: Array<{ trocaId: string; numero: string; data: string }>;
    concessoes: number;
    permitidas: number;
    totalTrocas: number;
  } | null;
  parent: { id: string; numero: number; status: string } | null;
  filhas: Array<{ id: string; numero: number; status: string }>;
};

const STATUS_LABEL: Record<string, string> = {
  solicitada: 'Solicitada',
  aguardando_postagem: 'Aguardando postagem',
  aguardando_envio_cliente: 'Aguardando envio da cliente',
  postada: 'Postada',
  em_transporte: 'Em transporte',
  recebida: 'Recebida',
  em_conferencia: 'Em conferência',
  aguardando_decisao: 'Aguardando decisão da cliente',
  produto_reservado: 'Produto reservado',
  aguardando_pagamento_diferenca: 'Aguardando pagamento de diferença',
  reembolso_andamento: 'Reembolso em andamento',
  finalizada: 'Finalizada',
  cancelada: 'Cancelada',
};

const STATUS_TONE: Record<string, string> = {
  solicitada: 'bg-sky-100 text-sky-800',
  aguardando_postagem: 'bg-amber-100 text-amber-800',
  aguardando_envio_cliente: 'bg-orange-100 text-orange-800',
  postada: 'bg-indigo-100 text-indigo-800',
  em_transporte: 'bg-indigo-100 text-indigo-800',
  recebida: 'bg-teal-100 text-teal-800',
  em_conferencia: 'bg-purple-100 text-purple-800',
  aguardando_decisao: 'bg-pink-100 text-pink-800',
  produto_reservado: 'bg-cyan-100 text-cyan-800',
  aguardando_pagamento_diferenca: 'bg-yellow-100 text-yellow-800',
  reembolso_andamento: 'bg-blue-100 text-blue-800',
  finalizada: 'bg-green-100 text-green-800',
  cancelada: 'bg-gray-200 text-gray-600',
};

function brl(v: number): string {
  return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtDataHora(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function fmtCpf(cpf: string | null): string {
  if (!cpf || cpf.length !== 11) return cpf || '—';
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parseErr(e: any): string {
  const raw = String(e?.message || '');
  const i = raw.indexOf(': ');
  const tail = i >= 0 ? raw.slice(i + 2) : raw;
  try {
    const j = JSON.parse(tail);
    if (j?.message) return Array.isArray(j.message) ? j.message[0] : j.message;
  } catch { /* texto puro */ }
  return raw || 'Erro inesperado';
}

export default function PortalTrocasAdminPage() {
  const [rows, setRows] = useState<TrocaRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Filtros — padrão De/Até + atalhos (convenção do projeto)
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');

  // Drawer de detalhe
  const [detail, setDetail] = useState<TrocaDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Ações do drawer
  const [codigoReversa, setCodigoReversa] = useState('');
  const [novoStatus, setNovoStatus] = useState('');
  const [notaStatus, setNotaStatus] = useState('');
  const [justificativa, setJustificativa] = useState('');
  const [showConceder, setShowConceder] = useState(false);

  // Fase 2 — conferência / envio
  const [stores, setStores] = useState<StoreOpt[]>([]);
  const [confChecks, setConfChecks] = useState<boolean[]>(CHECKLIST.map(() => false));
  const [confStore, setConfStore] = useState('');
  const [confReprovaMotivo, setConfReprovaMotivo] = useState('');
  const [envioRastreio, setEnvioRastreio] = useState('');

  useEffect(() => {
    api<StoreOpt[]>('/stores')
      .then((s) => setStores((s || []).filter((x) => x.active !== false)))
      .catch(() => setStores([]));
  }, []);

  // Fase 3 — dashboard gerencial
  const [showDash, setShowDash] = useState(false);
  const [dash, setDash] = useState<Dash | null>(null);
  const [dashLoading, setDashLoading] = useState(false);

  const loadDash = useCallback(async () => {
    setDashLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      setDash(await api<Dash>(`/trocas/dashboard?${params.toString()}`));
    } catch {
      setDash(null);
    } finally {
      setDashLoading(false);
    }
  }, [from, to]);

  useEffect(() => { if (showDash) loadDash(); }, [showDash, loadDash]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (status) params.set('status', status);
      if (q.trim()) params.set('q', q.trim());
      const res = await api<TrocaRow[]>(`/trocas?${params.toString()}`);
      setRows(res);
    } catch (e: any) {
      setErr(parseErr(e));
    } finally {
      setLoading(false);
    }
  }, [from, to, status, q]);

  useEffect(() => { load(); }, [load]);

  function atalho(dias: number | 'hoje' | 'ontem' | 'mes') {
    const hoje = new Date();
    if (dias === 'hoje') { setFrom(isoDay(hoje)); setTo(isoDay(hoje)); return; }
    if (dias === 'ontem') {
      const d = new Date(hoje.getTime() - 86_400_000);
      setFrom(isoDay(d)); setTo(isoDay(d)); return;
    }
    if (dias === 'mes') {
      setFrom(isoDay(new Date(hoje.getFullYear(), hoje.getMonth(), 1)));
      setTo(isoDay(hoje)); return;
    }
    setFrom(isoDay(new Date(hoje.getTime() - dias * 86_400_000)));
    setTo(isoDay(hoje));
  }

  async function openDetail(id: string) {
    setDetailLoading(true);
    setCodigoReversa('');
    setNovoStatus('');
    setNotaStatus('');
    setJustificativa('');
    setShowConceder(false);
    setConfChecks(CHECKLIST.map(() => false));
    setConfReprovaMotivo('');
    setEnvioRastreio('');
    try {
      const d = await api<TrocaDetail>(`/trocas/${id}`);
      setDetail(d);
    } catch (e: any) {
      setErr(parseErr(e));
    } finally {
      setDetailLoading(false);
    }
  }

  async function action(fn: () => Promise<any>) {
    if (!detail) return;
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await openDetail(detail.id);
      await load();
    } catch (e: any) {
      setErr(parseErr(e));
    } finally {
      setBusy(false);
    }
  }

  const enviarReversa = () =>
    action(() =>
      api(`/trocas/${detail!.id}/reversa`, {
        method: 'POST',
        body: JSON.stringify({ codigo: codigoReversa }),
      }),
    );

  const mudarStatus = () =>
    action(() =>
      api(`/trocas/${detail!.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: novoStatus, nota: notaStatus || undefined }),
      }),
    );

  const conceder = () =>
    action(() =>
      api(`/trocas/${detail!.id}/conceder-reversa`, {
        method: 'POST',
        body: JSON.stringify({ justificativa }),
      }),
    );

  const receber = () => action(() => api(`/trocas/${detail!.id}/receber`, { method: 'POST', body: '{}' }));

  const conferir = (aprovado: boolean) =>
    action(() =>
      api(`/trocas/${detail!.id}/conferir`, {
        method: 'POST',
        body: JSON.stringify({
          aprovado,
          checklist: Object.fromEntries(CHECKLIST.map((c, i) => [c, confChecks[i]])),
          motivoReprovacao: aprovado ? undefined : confReprovaMotivo,
          storeCode: aprovado ? confStore : undefined,
        }),
      }),
    );

  const registrarEnvio = () =>
    action(() =>
      api(`/trocas/${detail!.id}/envio`, {
        method: 'POST',
        body: JSON.stringify({ trackingCode: envioRastreio }),
      }),
    );

  const concluirReembolso = () =>
    action(() => api(`/trocas/${detail!.id}/reembolso-concluido`, { method: 'POST', body: '{}' }));

  const cancelar = () => {
    const motivo = window.prompt('Motivo do cancelamento (fica na auditoria):');
    if (motivo === null) return;
    action(() =>
      api(`/trocas/${detail!.id}/cancelar`, {
        method: 'POST',
        body: JSON.stringify({ motivo }),
      }),
    );
  };

  return (
    <div className="min-h-screen bg-[#FAFAF7] text-[#2A2620]">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-[#EDE7D8] px-4 py-3 flex items-center gap-3">
        <Link href="/site" className="p-2 rounded-lg hover:bg-[#FBF6E6]">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex-1">
          <h1 className="font-extrabold text-base">Portal de Trocas — solicitações</h1>
          <p className="text-xs text-[#6B6456]">Self-service da cliente · reversa · conferência</p>
        </div>
        <button
          onClick={() => setShowDash((v) => !v)}
          className={`px-3 py-2 rounded-lg text-sm font-bold border ${showDash ? 'bg-[#FBF6E6] border-[#B8912B] text-[#8C7325]' : 'border-[#E4DDCB] text-[#6B6456] hover:bg-[#FBF6E6]'}`}
        >
          📊 Dashboard
        </button>
        <button onClick={load} className="p-2 rounded-lg hover:bg-[#FBF6E6]" title="Atualizar">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="max-w-6xl mx-auto p-4">
        {/* Filtros */}
        <div className="bg-white rounded-2xl border border-[#EDE7D8] p-4 mb-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs font-bold text-[#6B6456]">
              De
              <input type="date" className="block mt-1 px-2.5 py-2 rounded-lg border border-[#E4DDCB] text-sm font-normal" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="text-xs font-bold text-[#6B6456]">
              Até
              <input type="date" className="block mt-1 px-2.5 py-2 rounded-lg border border-[#E4DDCB] text-sm font-normal" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <div className="flex gap-1.5">
              {([['Hoje', 'hoje'], ['Ontem', 'ontem'], ['7 dias', 7], ['Mês', 'mes']] as const).map(([lbl, v]) => (
                <button key={lbl} onClick={() => atalho(v as any)} className="px-2.5 py-2 rounded-lg text-xs font-bold border border-[#E4DDCB] text-[#8C7325] hover:bg-[#FBF6E6]">
                  {lbl}
                </button>
              ))}
            </div>
            <select className="px-2.5 py-2 rounded-lg border border-[#E4DDCB] text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Todos os status</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <div className="flex-1 min-w-[200px] relative">
              <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#A79F8E]" />
              <input
                className="w-full pl-8 pr-3 py-2 rounded-lg border border-[#E4DDCB] text-sm"
                placeholder="Nº troca, pedido, nome ou CPF…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && load()}
              />
            </div>
          </div>
        </div>

        {err && !detail && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{err}</div>
        )}

        {/* Dashboard gerencial (Fase 3) */}
        {showDash && (
          <div className="bg-white rounded-2xl border border-[#EDE7D8] p-4 mb-4">
            {dashLoading && (
              <div className="py-6 text-center text-[#6B6456] text-sm">
                <Loader2 className="inline animate-spin mr-2" size={15} />Calculando indicadores…
              </div>
            )}
            {!dashLoading && dash && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                  {[
                    ['Trocas no período', String(dash.total)],
                    ['Em aberto', String(dash.abertas)],
                    ['Finalizadas', String(dash.finalizadas)],
                    ['Valor movimentado', brl(dash.valorTotalPeriodo)],
                    ['Tempo até postagem', dash.tempoMedioPostagem != null ? `${dash.tempoMedioPostagem}d` : '—'],
                    ['Tempo de conferência', dash.tempoMedioConferencia != null ? `${dash.tempoMedioConferencia}d` : '—'],
                    ['Tempo até conclusão', dash.tempoMedioConclusao != null ? `${dash.tempoMedioConclusao}d` : '—'],
                    ['Reversas grátis usadas', String(dash.reversasGratis)],
                  ].map(([label, val]) => (
                    <div key={label} className="border border-[#EDE7D8] rounded-xl p-3">
                      <div className="text-[11px] font-bold text-[#6B6456]">{label}</div>
                      <div className="text-lg font-extrabold text-[#2A2620]">{val}</div>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                  {[
                    ['% troca de peça', `${dash.pctTrocaPeca}%`],
                    ['% vale-compras', `${dash.pctVale}%`],
                    ['% reembolso', `${dash.pctReembolso}%`],
                    ['Trocas da troca', String(dash.trocasEncadeadas)],
                    ['Por tamanho', String(dash.trocasPorTamanho)],
                    ['Por cor', String(dash.trocasPorCor)],
                    ['Com defeito', String(dash.trocasPorDefeito)],
                    ['Canceladas', String(dash.canceladas)],
                  ].map(([label, val]) => (
                    <div key={label} className="border border-[#EDE7D8] rounded-xl p-3">
                      <div className="text-[11px] font-bold text-[#6B6456]">{label}</div>
                      <div className="text-lg font-extrabold text-[#2A2620]">{val}</div>
                    </div>
                  ))}
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="border border-[#EDE7D8] rounded-xl p-3">
                    <div className="text-[11px] font-bold text-[#6B6456] mb-2">Motivos mais frequentes</div>
                    {dash.motivos.length === 0 && <div className="text-sm text-[#6B6456]">Sem dados no período.</div>}
                    {dash.motivos.map((m) => (
                      <div key={m.nome} className="flex justify-between text-sm py-0.5">
                        <span>{m.nome}</span><b>{m.total}</b>
                      </div>
                    ))}
                  </div>
                  <div className="border border-[#EDE7D8] rounded-xl p-3">
                    <div className="text-[11px] font-bold text-[#6B6456] mb-2">Produtos mais trocados</div>
                    {dash.produtosMaisTrocados.length === 0 && <div className="text-sm text-[#6B6456]">Sem dados no período.</div>}
                    {dash.produtosMaisTrocados.map((p) => (
                      <div key={p.nome} className="flex justify-between text-sm py-0.5 gap-2">
                        <span className="truncate">{p.nome}</span><b className="shrink-0">{p.total}</b>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Tabela */}
        <div className="bg-white rounded-2xl border border-[#EDE7D8] overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[#6B6456] border-b border-[#EDE7D8]">
                <th className="px-3 py-2.5">Troca</th>
                <th className="px-3 py-2.5">Pedido</th>
                <th className="px-3 py-2.5">Cliente</th>
                <th className="px-3 py-2.5">Peças</th>
                <th className="px-3 py-2.5">Motivo</th>
                <th className="px-3 py-2.5">Valor pago</th>
                <th className="px-3 py-2.5">Reversa</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5">Data</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={9} className="px-3 py-10 text-center text-[#6B6456]">
                  <Loader2 className="inline animate-spin mr-2" size={16} />Carregando…
                </td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-10 text-center text-[#6B6456]">
                  Nenhuma solicitação no período.
                </td></tr>
              )}
              {!loading && rows.map((t) => (
                <tr key={t.id} className="border-b border-[#F5F1E8] hover:bg-[#FBF6E6] cursor-pointer" onClick={() => openDetail(t.id)}>
                  <td className="px-3 py-2.5 font-extrabold text-[#8C7325]">{t.numeroFmt}</td>
                  <td className="px-3 py-2.5">#{t.wcOrderNumber || t.wcOrderId}</td>
                  <td className="px-3 py-2.5">
                    <div className="font-bold truncate max-w-[160px]">{t.customerName || '—'}</div>
                    <div className="text-xs text-[#6B6456]">{fmtCpf(t.customerCpf)}</div>
                  </td>
                  <td className="px-3 py-2.5 text-xs max-w-[200px] truncate">
                    {t.items.map((it) => `${it.qty}× ${it.productName || it.sku}`).join(' · ')}
                  </td>
                  <td className="px-3 py-2.5 text-xs">{t.motivo}</td>
                  <td className="px-3 py-2.5 font-bold text-[#2E7D46]">{brl(t.valorTotalPago)}</td>
                  <td className="px-3 py-2.5 text-xs">
                    {t.reversaGratis
                      ? (t.reversaCodigo
                          ? <span className="text-green-700 font-bold">{t.reversaCodigo}</span>
                          : <span className="text-amber-700 font-bold">grátis · gerar código</span>)
                      : <span className="text-orange-700">por conta da cliente</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold ${STATUS_TONE[t.status] || 'bg-gray-100 text-gray-700'}`}>
                      {STATUS_LABEL[t.status] || t.status}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-[#6B6456]">{fmtDataHora(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Drawer de detalhe */}
      {(detail || detailLoading) && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={() => setDetail(null)}>
          <div className="w-full max-w-xl bg-white h-full overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {detailLoading && (
              <div className="p-10 text-center text-[#6B6456]"><Loader2 className="inline animate-spin mr-2" />Carregando…</div>
            )}
            {detail && (
              <div className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <div className="text-xl font-extrabold text-[#8C7325]">{detail.numeroFmt}</div>
                    <div className="text-sm text-[#6B6456]">
                      Pedido #{detail.wcOrderNumber || detail.wcOrderId}
                      {detail.parent && <> · origem T{String(detail.parent.numero).padStart(4, '0')}</>}
                      {detail.filhas?.length > 0 && (
                        <> · gerou {detail.filhas.map((f) => `T${String(f.numero).padStart(4, '0')}`).join(', ')}</>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${STATUS_TONE[detail.status] || 'bg-gray-100'}`}>
                      {STATUS_LABEL[detail.status] || detail.status}
                    </span>
                    <button onClick={() => setDetail(null)} className="p-2 rounded-lg hover:bg-[#FBF6E6]"><X size={18} /></button>
                  </div>
                </div>

                {err && (
                  <div className="mb-3 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{err}</div>
                )}

                {/* Cliente + prazo */}
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="border border-[#EDE7D8] rounded-xl p-3">
                    <div className="text-xs font-bold text-[#6B6456] mb-1">Cliente</div>
                    <div className="font-bold text-sm">{detail.customerName || '—'}</div>
                    <div className="text-xs text-[#6B6456]">{fmtCpf(detail.customerCpf)}</div>
                    <div className="text-xs text-[#6B6456] truncate">{detail.customerEmail || 'sem e-mail'}</div>
                  </div>
                  <div className="border border-[#EDE7D8] rounded-xl p-3">
                    <div className="text-xs font-bold text-[#6B6456] mb-1">Prazo</div>
                    <div className="text-sm">
                      {detail.dentroDoPrazo
                        ? <span className="text-green-700 font-bold"><CheckCircle2 className="inline mr-1" size={14} />Dentro do prazo</span>
                        : <span className="text-red-700 font-bold"><AlertTriangle className="inline mr-1" size={14} />Fora do prazo</span>}
                    </div>
                    <div className="text-xs text-[#6B6456]">
                      {detail.diasDesdeEntrega != null && <>{detail.diasDesdeEntrega} dias · </>}
                      via {detail.prazoVerificadoVia === 'rastreio' ? 'rastreio ✓' : detail.prazoVerificadoVia === 'data_pedido' ? 'data do pedido (fallback)' : 'não verificado ⚠️'}
                    </div>
                    {detail.trackingCodePedido && (
                      <div className="text-xs text-[#6B6456]">Envio: {detail.trackingCodePedido}</div>
                    )}
                  </div>
                </div>

                {/* Painel de benefícios */}
                {detail.beneficio && (
                  <div className={`rounded-xl p-3.5 mb-4 border ${detail.beneficio.disponivel ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-300'}`}>
                    <div className="text-xs font-bold text-[#6B6456] mb-1.5 flex items-center gap-1.5">
                      <Gift size={14} /> Benefícios da cliente (CPF)
                    </div>
                    <div className="text-sm">
                      Reversa gratuita disponível:{' '}
                      {detail.beneficio.disponivel
                        ? <b className="text-green-700">Sim</b>
                        : <b className="text-amber-800">Não — já utilizada</b>}
                    </div>
                    {detail.beneficio.usos.length > 0 && (
                      <div className="text-xs text-[#6B6456] mt-1">
                        {detail.beneficio.usos.map((u) => (
                          <div key={u.trocaId}>
                            Usada em {fmtDataHora(u.data)} na troca <b>{u.numero}</b>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="text-xs text-[#6B6456] mt-1">
                      {detail.beneficio.totalTrocas} troca(s) no CPF · {detail.beneficio.permitidas} reversa(s) grátis permitida(s) ({detail.beneficio.concessoes} concessão(ões) extra)
                    </div>
                    {!detail.beneficio.disponivel && !detail.reversaGratis && (
                      <div className="mt-2 text-xs font-bold text-amber-800 flex items-center gap-1.5">
                        <AlertTriangle size={13} />
                        Devolução e reenvio por conta da cliente — NÃO gerar postagem gratuita sem concessão.
                      </div>
                    )}
                  </div>
                )}

                {/* Itens */}
                <div className="border border-[#EDE7D8] rounded-xl p-3.5 mb-4">
                  <div className="text-xs font-bold text-[#6B6456] mb-2">Peças da troca</div>
                  {detail.items.map((it, i) => (
                    <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-[#F5F1E8] last:border-0">
                      <div className="min-w-0">
                        <div className="font-bold truncate">{it.qty}× {it.productName || it.sku}</div>
                        <div className="text-xs text-[#6B6456]">
                          SKU {it.sku}
                          {it.valorPagoUnit < it.valorOriginalUnit && (
                            <> · cheio {brl(it.valorOriginalUnit)}</>
                          )}
                          {it.stockReturnedAt && <span className="text-green-700"> · estoque OK</span>}
                          {it.stockError && <span className="text-red-700 font-bold"> · ERRO estoque: {it.stockError}</span>}
                        </div>
                      </div>
                      <div className="font-bold text-[#2E7D46] shrink-0">{brl(it.totalPago)}</div>
                    </div>
                  ))}
                  <div className="flex justify-between font-extrabold text-sm mt-2">
                    <span>Valor elegível (líquido pago)</span>
                    <span className="text-[#2E7D46]">{brl(detail.valorTotalPago)}</span>
                  </div>
                  <div className="text-[11px] text-[#6B6456] mt-1">
                    Motivo: {detail.motivo}{detail.motivoDetalhe ? ` — ${detail.motivoDetalhe}` : ''}
                  </div>
                </div>

                {/* Ações */}
                <div className="space-y-3 mb-4">
                  {/* FASE 2 — Produto recebido (Etapa 9) */}
                  {['solicitada', 'aguardando_postagem', 'aguardando_envio_cliente', 'postada', 'em_transporte', 'recebida'].includes(detail.status) && (
                    <button
                      className="w-full py-3 rounded-xl font-bold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-50 flex items-center justify-center gap-2"
                      disabled={busy}
                      onClick={receber}
                    >
                      <PackageCheck size={16} /> Produto recebido → conferência
                    </button>
                  )}

                  {/* FASE 2 — Conferência (Etapa 10) */}
                  {detail.status === 'em_conferencia' && (
                    <div className="border border-purple-200 bg-purple-50 rounded-xl p-3.5">
                      <div className="text-xs font-bold text-purple-800 mb-2">Conferência da peça</div>
                      {detail.conferenciaAprovada === false && (
                        <div className="mb-2 text-xs font-bold text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
                          Reprovada em {fmtDataHora(detail.conferenciaAt)} — {detail.conferenciaReprovadaMotivo}. Cliente orientada pro WhatsApp; refaça a conferência ou cancele.
                        </div>
                      )}
                      <div className="space-y-1.5 mb-3">
                        {CHECKLIST.map((c, i) => (
                          <label key={c} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              className="accent-purple-600"
                              checked={confChecks[i]}
                              onChange={(e) => setConfChecks((v) => v.map((x, j) => (j === i ? e.target.checked : x)))}
                            />
                            {c}
                          </label>
                        ))}
                      </div>
                      <div className="flex gap-2 items-center mb-2">
                        <span className="text-xs font-bold text-[#6B6456]">Entrada de estoque na loja:</span>
                        <select
                          className="flex-1 px-2.5 py-2 rounded-lg border border-[#E4DDCB] text-sm"
                          value={confStore}
                          onChange={(e) => setConfStore(e.target.value)}
                        >
                          <option value="">Loja que recebeu…</option>
                          {stores.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
                        </select>
                      </div>
                      <button
                        className="w-full py-2.5 rounded-lg font-bold text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 text-sm"
                        disabled={busy || !confChecks.every(Boolean) || !confStore}
                        onClick={() => conferir(true)}
                      >
                        ✓ Aprovar (entrada de estoque + e-mail pra cliente escolher)
                      </button>
                      <div className="flex gap-2 mt-2">
                        <select
                          className="flex-1 px-2.5 py-2 rounded-lg border border-red-200 text-sm"
                          value={confReprovaMotivo}
                          onChange={(e) => setConfReprovaMotivo(e.target.value)}
                        >
                          <option value="">Motivo da reprovação…</option>
                          {REPROVACAO_MOTIVOS.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                        <button
                          className="px-4 py-2 rounded-lg font-bold text-red-700 border border-red-300 hover:bg-red-50 disabled:opacity-50 text-sm"
                          disabled={busy || !confReprovaMotivo}
                          onClick={() => conferir(false)}
                        >
                          Reprovar
                        </button>
                      </div>
                    </div>
                  )}

                  {/* FASE 2 — Decisão da cliente / reserva / envio */}
                  {detail.decisao && (
                    <div className="border border-[#EDE7D8] rounded-xl p-3.5 text-sm">
                      <div className="text-xs font-bold text-[#6B6456] mb-1">Decisão da cliente</div>
                      {(detail.decisao === 'trocar_tamanho' || detail.decisao === 'trocar_cor') && (
                        <>
                          {detail.decisao === 'trocar_tamanho' ? 'Trocar TAMANHO' : 'Trocar COR'} →{' '}
                          <b>{detail.novaProductName}</b> ({detail.novaCor} · {detail.novaTamanho}) · SKU {detail.novaSku}
                          <div className="text-xs text-[#6B6456]">Reserva lógica ativa — separar e enviar.</div>
                        </>
                      )}
                      {detail.decisao === 'vale' && (
                        <>Vale-compras <b>{detail.valeCode}</b> · {brl(detail.valorTotalPago)}{detail.valeValidade && <> · até {fmtDataHora(detail.valeValidade).slice(0, 10)}</>}</>
                      )}
                      {detail.decisao === 'reembolso' && (
                        <>
                          Reembolso {(detail.reembolsoForma || '').toUpperCase()} de <b>{brl(detail.valorTotalPago)}</b>
                          {detail.reembolsoChavePix && <div className="text-xs mt-1">Chave PIX: <b className="select-all">{detail.reembolsoChavePix}</b></div>}
                          {detail.reembolsoConcluidoAt && <div className="text-xs text-green-700 mt-1">Concluído em {fmtDataHora(detail.reembolsoConcluidoAt)}</div>}
                        </>
                      )}
                    </div>
                  )}

                  {detail.status === 'produto_reservado' && (
                    <div className="border border-cyan-200 bg-cyan-50 rounded-xl p-3.5">
                      <div className="text-xs font-bold text-cyan-800 mb-2">Enviar nova peça (Etapa 18)</div>
                      <div className="flex gap-2">
                        <input
                          className="flex-1 px-3 py-2 rounded-lg border border-[#E4DDCB] text-sm"
                          placeholder="Código de rastreio do envio"
                          value={envioRastreio}
                          onChange={(e) => setEnvioRastreio(e.target.value)}
                        />
                        <button
                          className="px-4 py-2 rounded-lg font-bold text-white bg-[#B8912B] hover:bg-[#8C7325] disabled:opacity-50 text-sm"
                          disabled={busy || envioRastreio.trim().length < 8}
                          onClick={registrarEnvio}
                        >
                          Enviar + finalizar
                        </button>
                      </div>
                    </div>
                  )}

                  {detail.status === 'reembolso_andamento' && (
                    <button
                      className="w-full py-3 rounded-xl font-bold text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
                      disabled={busy}
                      onClick={concluirReembolso}
                    >
                      💰 Reembolso executado no gateway → finalizar
                    </button>
                  )}

                  {detail.envioTrackingCode && (
                    <div className="border border-green-200 bg-green-50 rounded-xl p-3.5 text-sm">
                      📦 Nova peça enviada em {fmtDataHora(detail.envioAt)} · rastreio <b>{detail.envioTrackingCode}</b>
                    </div>
                  )}

                  {/* Reversa */}
                  {!detail.reversaCodigo && detail.status !== 'cancelada' && detail.status !== 'finalizada' && (
                    <div className="border border-[#EDE7D8] rounded-xl p-3.5">
                      <div className="text-xs font-bold text-[#6B6456] mb-2 flex items-center gap-1.5">
                        <Mail size={14} /> Código de postagem reversa
                        {detail.reversaGratis
                          ? <span className="text-green-700">(gratuita — 1ª do CPF)</span>
                          : <span className="text-amber-700">(cliente paga / concessão)</span>}
                      </div>
                      <div className="flex gap-2">
                        <input
                          className="flex-1 px-3 py-2 rounded-lg border border-[#E4DDCB] text-sm"
                          placeholder="Cole o código gerado nos Correios"
                          value={codigoReversa}
                          onChange={(e) => setCodigoReversa(e.target.value)}
                        />
                        <button
                          className="px-4 py-2 rounded-lg font-bold text-white bg-[#B8912B] hover:bg-[#8C7325] disabled:opacity-50 text-sm"
                          disabled={busy || codigoReversa.trim().length < 6}
                          onClick={enviarReversa}
                        >
                          {busy ? '…' : 'Salvar + e-mail'}
                        </button>
                      </div>
                      {!detail.reversaGratis && !showConceder && (
                        <button className="mt-2 text-xs font-bold text-[#8C7325] underline" onClick={() => setShowConceder(true)}>
                          Conceder reversa gratuita excepcional…
                        </button>
                      )}
                      {showConceder && (
                        <div className="mt-2">
                          <input
                            className="w-full px-3 py-2 rounded-lg border border-[#E4DDCB] text-sm"
                            placeholder="Justificativa (erro operacional, defeito, autorização gerência…)"
                            value={justificativa}
                            onChange={(e) => setJustificativa(e.target.value)}
                          />
                          <button
                            className="mt-2 px-3 py-2 rounded-lg text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50"
                            disabled={busy || justificativa.trim().length < 5}
                            onClick={conceder}
                          >
                            Conceder (fica na auditoria)
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {detail.reversaCodigo && (
                    <div className="border border-green-200 bg-green-50 rounded-xl p-3.5 text-sm">
                      <PackageCheck className="inline mr-1.5 text-green-700" size={15} />
                      Código reverso: <b>{detail.reversaCodigo}</b>
                      {detail.reversaPrazo && <> · válido até {fmtDataHora(detail.reversaPrazo).slice(0, 10)}</>}
                      <div className="text-xs text-[#6B6456] mt-1">
                        {detail.reversaEnviadaAt
                          ? `E-mail enviado em ${fmtDataHora(detail.reversaEnviadaAt)}`
                          : 'E-mail NÃO enviado — avisar a cliente manualmente'}
                      </div>
                    </div>
                  )}

                  {detail.clienteTrackingCode && (
                    <div className="border border-[#EDE7D8] rounded-xl p-3.5 text-sm">
                      Rastreio da devolução (informado pela cliente): <b>{detail.clienteTrackingCode}</b>
                    </div>
                  )}

                  {/* Mudar status */}
                  {detail.status !== 'cancelada' && (
                    <div className="border border-[#EDE7D8] rounded-xl p-3.5">
                      <div className="text-xs font-bold text-[#6B6456] mb-2">Avançar status</div>
                      <div className="flex gap-2">
                        <select
                          className="flex-1 px-3 py-2 rounded-lg border border-[#E4DDCB] text-sm"
                          value={novoStatus}
                          onChange={(e) => setNovoStatus(e.target.value)}
                        >
                          <option value="">Escolher…</option>
                          {Object.entries(STATUS_LABEL)
                            .filter(([k]) => k !== detail.status && k !== 'cancelada')
                            .map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                        <button
                          className="px-4 py-2 rounded-lg font-bold text-white bg-[#B8912B] hover:bg-[#8C7325] disabled:opacity-50 text-sm"
                          disabled={busy || !novoStatus}
                          onClick={mudarStatus}
                        >
                          Aplicar
                        </button>
                      </div>
                      <input
                        className="w-full mt-2 px-3 py-2 rounded-lg border border-[#E4DDCB] text-sm"
                        placeholder="Nota (opcional, fica na auditoria)"
                        value={notaStatus}
                        onChange={(e) => setNotaStatus(e.target.value)}
                      />
                    </div>
                  )}

                  {detail.status !== 'cancelada' && detail.status !== 'finalizada' && (
                    <button
                      className="w-full py-2.5 rounded-xl text-sm font-bold text-red-700 border border-red-200 hover:bg-red-50 flex items-center justify-center gap-2"
                      disabled={busy}
                      onClick={cancelar}
                    >
                      <Ban size={15} /> Cancelar solicitação
                    </button>
                  )}
                </div>

                {/* Timeline */}
                <div className="border border-[#EDE7D8] rounded-xl p-3.5">
                  <div className="text-xs font-bold text-[#6B6456] mb-2">Linha do tempo</div>
                  <ul className="space-y-2">
                    {detail.eventos.map((ev) => (
                      <li key={ev.id} className="text-[13px] flex gap-2">
                        <span className="text-[#B8912B] shrink-0">•</span>
                        <span>
                          <b>{fmtDataHora(ev.createdAt)}</b>
                          {ev.userName && <span className="text-[#6B6456]"> · {ev.userName}</span>}
                          <br />
                          {ev.descricao}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
