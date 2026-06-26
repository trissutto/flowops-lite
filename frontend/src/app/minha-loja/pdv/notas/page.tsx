'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, FileText, X, Search, Printer, Loader2, Check, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';

/**
 * Tela de NFC-es emitidas — visão por loja ou geral.
 *
 * Permite:
 *  - Ver todas as NFC-es do dia (ou período custom)
 *  - Filtrar por loja, status, busca livre
 *  - Cancelar NFC-e dentro dos 30 min
 *  - Reimprimir cupom
 *  - Ver totais agregados (autorizadas, canceladas, valor total, por loja)
 */

type NfceRow = {
  id: string;
  storeCode: string;
  storeName: string | null;
  total: number;
  paymentMethod: string | null;
  customerName: string | null;
  customerCpf: string | null;
  nfceStatus: string;
  nfceNumber: string | null;
  nfceSerie: string | null;
  nfceChave: string | null;
  nfceProtocolo: string | null;
  nfceAutorizadaEm: string | null;
  nfceCanceladaEm: string | null;
  nfceCancelamentoMotivo: string | null;
  finalizedAt: string | null;
  podeCancelar: boolean;
  minutosRestantes: number;
};

type Summary = {
  totalNotas: number;
  totalValor: number;
  autorizadas: number;
  canceladas: number;
  rejeitadas: number;
  porLoja: Array<{ storeCode: string; storeName: string | null; count: number; total: number }>;
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const formatDate = (s: string | null) => {
  if (!s) return '—';
  return new Date(s).toLocaleString('pt-BR');
};

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function NotasEmitidasPage() {
  const [rows, setRows] = useState<NfceRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // admin/master da MATRIZ vê todas as lojas e tem o filtro. Loja (role=store) —
  // inclusive o MODO MASTER operando um PDV de loja (impersonate = role=store +
  // storeCode da loja) — só vê as próprias notas.
  const [isAdmin, setIsAdmin] = useState(false);

  // Filtros
  const [storeCode, setStoreCode] = useState<string>(''); // default = loja do PDV atual (via /auth/me)
  const [startDate, setStartDate] = useState(todayStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [status, setStatus] = useState<string>('all');
  const [q, setQ] = useState<string>('');

  useEffect(() => {
    api<{ role?: string; storeCode?: string | null }>('/auth/me')
      .then((me) => {
        const adminLike = me?.role === 'admin' || me?.role === 'master';
        setIsAdmin(adminLike);
        // Escopa pra loja em que está operando. No PDV de ITANHAÉM (role=store,
        // storeCode=01) → só notas de ITANHAÉM. Admin/master da matriz sem loja
        // específica fica em "Todas".
        if (me?.storeCode) setStoreCode(me.storeCode);
      })
      .catch(() => {});
  }, []);

  // Cancelar modal
  const [cancelTarget, setCancelTarget] = useState<NfceRow | null>(null);
  const [cancelMotivo, setCancelMotivo] = useState('');
  const [cancelando, setCancelando] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Corrigir & reemitir (notas rejeitadas)
  const [fixTarget, setFixTarget] = useState<NfceRow | null>(null);
  const [fixDoc, setFixDoc] = useState('');
  const [fixName, setFixName] = useState('');
  const [fixSaving, setFixSaving] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [fixResult, setFixResult] = useState<{ ok: boolean; msg: string } | null>(null);

  function abrirCorrecao(r: NfceRow) {
    setFixTarget(r);
    setFixDoc((r.customerCpf || '').replace(/\D/g, ''));
    setFixName(r.customerName || '');
    setFixError(null);
    setFixResult(null);
  }

  async function executarReemissao() {
    if (!fixTarget) return;
    const doc = fixDoc.replace(/\D/g, '');
    // CPF é OPCIONAL: pode tirar nota sem CPF (consumidor não identificado).
    // Se informar, tem que ser 11 (CPF) ou 14 (CNPJ).
    if (doc && doc.length !== 11 && doc.length !== 14) {
      setFixError('Documento inválido — 11 dígitos (CPF), 14 (CNPJ), ou deixe em branco pra nota sem CPF.');
      return;
    }
    setFixSaving(true);
    setFixError(null);
    setFixResult(null);
    try {
      // 1) Atualiza CPF/nome SE informado (permitido enquanto a nota não foi
      //    autorizada). Em branco → emite sem destinatário.
      if (doc || fixName.trim()) {
        await api(`/pdv/sales/${fixTarget.id}/customer`, {
          method: 'PATCH',
          body: JSON.stringify({
            ...(doc ? { cpf: doc } : {}),
            ...(fixName.trim() ? { name: fixName.trim() } : {}),
          }),
        });
      }
      // 2) Emite/reemite a NFC-e (transmite pra SEFAZ).
      const r = await api<any>(`/pdv/sales/${fixTarget.id}/nfce`, { method: 'POST' });
      if (r?.status === 'authorized') {
        setFixResult({ ok: true, msg: `NFC-e ${r.numero || ''} autorizada!` });
        await carregar();
      } else {
        setFixResult({
          ok: false,
          msg: r?.motivo || `Status: ${r?.status || 'rejeitada'} — confira os dados e tente de novo.`,
        });
      }
    } catch (e: any) {
      setFixError(e?.message || String(e));
    } finally {
      setFixSaving(false);
    }
  }

  const carregar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (storeCode) params.set('storeCode', storeCode);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      if (status) params.set('status', status);
      if (q) params.set('q', q);
      const r = await api<{ rows: NfceRow[]; summary: Summary }>(`/pdv/nfces?${params}`);
      setRows(r.rows || []);
      setSummary(r.summary || null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [storeCode, startDate, endDate, status, q]);

  useEffect(() => { carregar(); }, [carregar]);

  // Auto-refresh a cada 60s pra atualizar o "minutosRestantes"
  useEffect(() => {
    const id = setInterval(() => carregar(), 60_000);
    return () => clearInterval(id);
  }, [carregar]);

  async function executarCancelamento() {
    if (!cancelTarget) return;
    if (cancelMotivo.trim().length < 15) {
      setCancelError('Justificativa precisa ter no mínimo 15 caracteres');
      return;
    }
    setCancelando(true);
    setCancelError(null);
    try {
      const r = await api<any>(`/pdv/sales/${cancelTarget.id}/nfce/cancel`, {
        method: 'POST',
        body: JSON.stringify({ justificativa: cancelMotivo.trim() }),
      });
      if (r?.success) {
        setCancelTarget(null);
        setCancelMotivo('');
        carregar();
      } else {
        setCancelError(r?.motivo || r?.error || 'Falha ao cancelar');
      }
    } catch (e: any) {
      setCancelError(e?.message || String(e));
    } finally {
      setCancelando(false);
    }
  }

  function reimprimirCupom(row: NfceRow) {
    // Se tem NFCe autorizada → cupom FISCAL (DANFE com chave, QR, protocolo)
    // Senão → cupom NÃO FISCAL (recibo simples)
    const isAuthorized = row.nfceStatus === 'authorized' && !!row.nfceChave;
    const route = isAuthorized
      ? `/minha-loja/pdv/nfce/${row.id}`
      : `/minha-loja/pdv/recibo/${row.id}`;
    window.open(route, '_blank');
  }

  function reimprimirNaoFiscal(row: NfceRow) {
    // Força cupom NÃO FISCAL mesmo que a venda tenha NFCe
    window.open(`/minha-loja/pdv/recibo/${row.id}`, '_blank');
  }

  function badge(status: string, canceladaEm: string | null) {
    if (canceladaEm || status === 'cancelled') return (
      <span className="text-[10px] px-2 py-0.5 bg-rose-100 text-rose-800 rounded font-bold">CANCELADA</span>
    );
    if (status === 'authorized') return (
      <span className="text-[10px] px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded font-bold">AUTORIZADA</span>
    );
    if (status === 'rejected' || status === 'error') return (
      <span className="text-[10px] px-2 py-0.5 bg-amber-100 text-amber-800 rounded font-bold">REJEITADA</span>
    );
    return <span className="text-[10px] px-2 py-0.5 bg-slate-100 text-slate-700 rounded font-bold">{status?.toUpperCase()}</span>;
  }

  return (
    <div className="max-w-7xl mx-auto p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/minha-loja/pdv" className="text-slate-600 hover:text-slate-900">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          <FileText className="w-5 h-5" /> NFC-es Emitidas
        </h1>
        <button
          onClick={carregar}
          disabled={loading}
          className="ml-auto px-3 py-1.5 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded text-sm font-bold flex items-center gap-1"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Atualizar
        </button>
      </div>

      {/* Filtros */}
      <div className="bg-white border rounded-lg p-3 grid grid-cols-2 md:grid-cols-6 gap-2 text-sm">
        {isAdmin && (
          <div>
            <label className="text-[10px] uppercase font-bold text-slate-500">Loja</label>
            <input
              type="text"
              value={storeCode}
              onChange={(e) => setStoreCode(e.target.value.toUpperCase())}
              placeholder="Todas"
              className="w-full border rounded px-2 py-1 text-sm"
            />
          </div>
        )}
        <div>
          <label className="text-[10px] uppercase font-bold text-slate-500">De</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full border rounded px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase font-bold text-slate-500">Até</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full border rounded px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase font-bold text-slate-500">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full border rounded px-2 py-1 text-sm"
          >
            <option value="all">Todos</option>
            <option value="authorized">Autorizadas</option>
            <option value="cancelled">Canceladas</option>
            <option value="rejected">Rejeitadas</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className="text-[10px] uppercase font-bold text-slate-500">Buscar (nº / CPF / nome)</label>
          <div className="flex gap-1">
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && carregar()}
              placeholder="ex: 12345 ou 286.655..."
              className="flex-1 border rounded px-2 py-1 text-sm"
            />
            <button onClick={carregar} className="px-3 py-1 bg-blue-600 text-white rounded">
              <Search className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Sumário */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div className="bg-white border rounded-lg p-3">
            <div className="text-[10px] uppercase text-slate-500 font-bold">Total Notas</div>
            <div className="text-2xl font-bold text-slate-800 tabular-nums">{summary.totalNotas}</div>
          </div>
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
            <div className="text-[10px] uppercase text-emerald-700 font-bold">Valor Total</div>
            <div className="text-2xl font-bold text-emerald-800 tabular-nums">{brl(summary.totalValor)}</div>
          </div>
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
            <div className="text-[10px] uppercase text-emerald-700 font-bold">Autorizadas</div>
            <div className="text-2xl font-bold text-emerald-800 tabular-nums">{summary.autorizadas}</div>
          </div>
          <div className="bg-rose-50 border border-rose-200 rounded-lg p-3">
            <div className="text-[10px] uppercase text-rose-700 font-bold">Canceladas / Rejeitadas</div>
            <div className="text-2xl font-bold text-rose-800 tabular-nums">{summary.canceladas + summary.rejeitadas}</div>
          </div>
        </div>
      )}

      {/* Por loja (só aparece se tem >1 loja) */}
      {summary && summary.porLoja.length > 1 && (
        <div className="bg-white border rounded-lg p-3">
          <div className="text-[10px] uppercase font-bold text-slate-500 mb-2">Por loja</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {summary.porLoja.map((l) => (
              <div key={l.storeCode} className="bg-slate-50 rounded p-2 text-sm">
                <div className="font-bold text-slate-800">{l.storeName || l.storeCode}</div>
                <div className="text-xs text-slate-500">{l.count} nota(s)</div>
                <div className="font-bold text-emerald-700 tabular-nums">{brl(l.total)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Erro */}
      {error && (
        <div className="bg-rose-50 border border-rose-300 rounded-lg p-3 text-rose-800 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {/* Lista */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 text-[10px] uppercase font-bold text-slate-600">
            <tr>
              <th className="text-left p-2">Status</th>
              <th className="text-left p-2">NFC-e</th>
              <th className="text-left p-2">Loja</th>
              <th className="text-left p-2">Cliente</th>
              <th className="text-right p-2">Valor</th>
              <th className="text-left p-2">Pagto</th>
              <th className="text-left p-2">Emissão</th>
              <th className="text-right p-2">Ações</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={8} className="text-center p-6 text-slate-400">Nenhuma NFC-e encontrada nesse período.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t hover:bg-slate-50">
                <td className="p-2">{badge(r.nfceStatus, r.nfceCanceladaEm)}</td>
                <td className="p-2 font-mono">
                  <div className="font-bold">{r.nfceNumber || '—'}</div>
                  <div className="text-[10px] text-slate-500">Série {r.nfceSerie || '1'}</div>
                </td>
                <td className="p-2">
                  <div className="font-bold">{r.storeName || r.storeCode}</div>
                  <div className="text-[10px] text-slate-500">{r.storeCode}</div>
                </td>
                <td className="p-2">
                  <div className="text-xs">{r.customerName || <span className="text-slate-400 italic">não identificado</span>}</div>
                  {r.customerCpf && <div className="text-[10px] text-slate-500 font-mono">{r.customerCpf}</div>}
                </td>
                <td className="p-2 text-right font-bold tabular-nums">{brl(r.total)}</td>
                <td className="p-2 text-xs uppercase">{r.paymentMethod || '—'}</td>
                <td className="p-2 text-xs">{formatDate(r.nfceAutorizadaEm)}</td>
                <td className="p-2">
                  <div className="flex gap-1 justify-end items-center">
                    {/* Tirar nota / Corrigir & reemitir — qualquer venda que ainda
                        NÃO tem NFC-e autorizada (preview, skipped, rejeitada). É o
                        caminho pra emitir DEPOIS quando a tela do PIX fechou antes. */}
                    {r.nfceStatus !== 'authorized' && r.nfceStatus !== 'cancelled' && !r.nfceCanceladaEm && (
                      <button
                        onClick={() => abrirCorrecao(r)}
                        className="px-2 py-1 bg-amber-100 hover:bg-amber-200 text-amber-900 rounded text-xs font-bold border border-amber-300 flex items-center gap-1"
                        title="Adicionar CPF (opcional) e tirar a NFC-e desta venda"
                      >
                        <AlertCircle className="w-3 h-3" />
                        {r.nfceStatus === 'rejected' || r.nfceStatus === 'error'
                          ? 'Corrigir & reemitir'
                          : 'Tirar nota'}
                      </button>
                    )}
                    {/* Reimprimir NFC-e (cupom fiscal) — só pra autorizadas */}
                    {r.nfceStatus === 'authorized' && r.nfceChave && (
                      <button
                        onClick={() => reimprimirCupom(r)}
                        className="px-2 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 rounded text-xs font-bold border border-emerald-200 flex items-center gap-1"
                        title="Reimprimir NFC-e (cupom fiscal com chave e QR Code)"
                      >
                        <Printer className="w-3 h-3" />
                        NFC-e
                      </button>
                    )}
                    {/* Imprimir cupom NÃO FISCAL — sempre disponível */}
                    <button
                      onClick={() => reimprimirNaoFiscal(r)}
                      className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-xs font-bold border border-slate-200 flex items-center gap-1"
                      title="Imprimir cupom NÃO FISCAL (recibo de venda)"
                    >
                      <FileText className="w-3 h-3" />
                      Não fiscal
                    </button>
                    {r.podeCancelar && (
                      <button
                        onClick={() => { setCancelTarget(r); setCancelMotivo(''); setCancelError(null); }}
                        className="px-2 py-1 bg-rose-100 hover:bg-rose-200 text-rose-800 rounded text-xs font-bold flex items-center gap-1"
                        title={`Cancelar NFC-e (${r.minutosRestantes} min restantes)`}
                      >
                        <X className="w-3 h-3" />
                        Cancelar ({r.minutosRestantes}min)
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal Cancelar */}
      {cancelTarget && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg w-full max-w-md p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg">Cancelar NFC-e {cancelTarget.nfceNumber}</h3>
              <button onClick={() => setCancelTarget(null)} disabled={cancelando}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="bg-slate-50 rounded p-2 text-sm">
              <div className="flex justify-between"><span>Loja:</span><b>{cancelTarget.storeName || cancelTarget.storeCode}</b></div>
              <div className="flex justify-between"><span>Cliente:</span><b>{cancelTarget.customerName || 'não identificado'}</b></div>
              <div className="flex justify-between"><span>Valor:</span><b>{brl(cancelTarget.total)}</b></div>
              <div className="flex justify-between"><span>Tempo restante:</span><b className="text-amber-700">{cancelTarget.minutosRestantes} min</b></div>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700 uppercase block mb-1">
                Motivo do cancelamento (mín. 15 caracteres)
              </label>
              <textarea
                value={cancelMotivo}
                onChange={(e) => setCancelMotivo(e.target.value.slice(0, 255))}
                placeholder="ex: Cliente desistiu da compra após emissão"
                rows={3}
                className="w-full border rounded p-2 text-sm"
              />
              <div className="text-[10px] text-slate-500 text-right">{cancelMotivo.trim().length}/255 (mín 15)</div>
            </div>
            {cancelError && (
              <div className="bg-rose-50 border border-rose-300 rounded p-2 text-xs text-rose-800">{cancelError}</div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => setCancelTarget(null)}
                disabled={cancelando}
                className="flex-1 px-3 py-2 border rounded text-sm"
              >
                Voltar
              </button>
              <button
                onClick={executarCancelamento}
                disabled={cancelando || cancelMotivo.trim().length < 15}
                className="flex-1 px-3 py-2 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white font-bold rounded text-sm flex items-center justify-center gap-2"
              >
                {cancelando ? <><Loader2 className="w-4 h-4 animate-spin" /> Cancelando…</> : <><Check className="w-4 h-4" /> Confirmar</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Corrigir & Reemitir (notas rejeitadas) */}
      {fixTarget && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg w-full max-w-md p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-amber-600" />
                {fixTarget.nfceStatus === 'rejected' || fixTarget.nfceStatus === 'error'
                  ? 'Corrigir & reemitir'
                  : 'Tirar nota desta venda'}
              </h3>
              <button onClick={() => setFixTarget(null)} disabled={fixSaving}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="bg-slate-50 rounded p-2 text-sm space-y-0.5">
              <div className="flex justify-between"><span>Loja:</span><b>{fixTarget.storeName || fixTarget.storeCode}</b></div>
              <div className="flex justify-between"><span>Valor:</span><b>{brl(fixTarget.total)}</b></div>
              <div className="flex justify-between"><span>Doc. atual:</span><b className="font-mono">{fixTarget.customerCpf || '—'}</b></div>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded p-2 text-[11px] text-amber-900">
              {fixTarget.nfceStatus === 'rejected' || fixTarget.nfceStatus === 'error' ? (
                <>A nota foi <b>rejeitada</b> pela SEFAZ. Corrija o CPF/CNPJ e reemita.</>
              ) : (
                <>Essa venda ainda <b>não tem NFC-e</b> (a tela do PIX fechou antes, etc). Adicione o CPF se quiser e clique em <b>Tirar nota</b> pra emitir agora.</>
              )}
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700 uppercase block mb-1">CPF / CNPJ do cliente (opcional)</label>
              <input
                value={fixDoc}
                onChange={(e) => setFixDoc(e.target.value)}
                inputMode="numeric"
                maxLength={18}
                placeholder="Só números"
                className="w-full border rounded p-2 text-sm font-mono"
              />
              <div className="text-[10px] text-slate-500 mt-0.5">
                {fixDoc.replace(/\D/g, '').length} dígitos · opcional — em branco = nota SEM CPF (consumidor não identificado)
              </div>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700 uppercase block mb-1">Nome / razão social (opcional)</label>
              <input
                value={fixName}
                onChange={(e) => setFixName(e.target.value)}
                placeholder="Nome do cliente na nota"
                className="w-full border rounded p-2 text-sm"
              />
            </div>
            {fixError && (
              <div className="bg-rose-50 border border-rose-300 rounded p-2 text-xs text-rose-800">{fixError}</div>
            )}
            {fixResult && (
              <div className={`rounded p-2 text-xs border ${fixResult.ok ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-rose-50 border-rose-300 text-rose-800'}`}>
                {fixResult.ok ? '✅ ' : '❌ '}{fixResult.msg}
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => setFixTarget(null)}
                disabled={fixSaving}
                className="flex-1 px-3 py-2 border rounded text-sm"
              >
                {fixResult?.ok ? 'Fechar' : 'Voltar'}
              </button>
              <button
                onClick={executarReemissao}
                disabled={
                  fixSaving ||
                  (fixDoc.replace(/\D/g, '').length !== 0 &&
                    ![11, 14].includes(fixDoc.replace(/\D/g, '').length)) ||
                  (fixResult?.ok ?? false)
                }
                className="flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white font-bold rounded text-sm flex items-center justify-center gap-2"
              >
                {fixSaving ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Emitindo…</>
                ) : (
                  <><FileText className="w-4 h-4" /> {fixTarget.nfceStatus === 'rejected' || fixTarget.nfceStatus === 'error' ? 'Reemitir NFC-e' : 'Tirar nota'}</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
