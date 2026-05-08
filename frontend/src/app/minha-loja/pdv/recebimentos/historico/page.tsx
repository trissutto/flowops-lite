'use client';

/**
 * /minha-loja/pdv/recebimentos/historico
 *
 * Histórico de baixas de crediário com possibilidade de ESTORNO.
 *
 * - Lista baixas dos últimos N dias (default 30) da loja atual
 * - Mostra cliente, total, forma, vendedora, data
 * - Botão "Estornar" com confirmação dupla + razão obrigatória
 * - Estorno reverte UPDATE no Wincred (PAGO='N', etc) + marca canceled no Postgres
 */

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, RefreshCw, AlertCircle, CheckCircle2, XCircle, Banknote, QrCode, Undo2,
} from 'lucide-react';
import { api } from '@/lib/api';

type BaixaItem = {
  id: string;
  registro: string;
  controle: string;
  parcelaNum: number | null;
  totalParcelas: number | null;
  vencimento: string;
  valorParcela: number;
  jurosCalculado: number;
  valorPago: number;
  gigaUpdateOk: boolean;
  gigaError: string | null;
};
type Baixa = {
  id: string;
  codCliente: string | null;
  customerName: string | null;
  customerCpf: string | null;
  lojaCode: string;
  lojaName: string | null;
  userName: string | null;
  formaPagamento: string;
  status: 'pending' | 'paid' | 'canceled';
  totalParcelas: number;
  totalPrincipal: number;
  totalJuros: number;
  totalPago: number;
  paidAt: string | null;
  canceledAt: string | null;
  canceledByUserName: string | null;
  canceledReason: string | null;
  createdAt: string;
  items: BaixaItem[];
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtDateTime = (iso: string | null) => {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
};

export default function HistoricoBaixasPage() {
  const [baixas, setBaixas] = useState<Baixa[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dias, setDias] = useState(7);
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'canceled'>('all');
  const [busca, setBusca] = useState('');

  // Estorno modal
  const [estornoBaixa, setEstornoBaixa] = useState<Baixa | null>(null);
  const [estornoReason, setEstornoReason] = useState('');
  const [estornando, setEstornando] = useState(false);
  const [estornoResult, setEstornoResult] = useState<any>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api<Baixa[]>(
        `/crediarios/baixa/historico?dias=${dias}&status=${statusFilter}`,
      );
      setBaixas(data);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [dias, statusFilter]);

  const baixasFiltradas = useMemo(() => {
    if (!busca.trim()) return baixas;
    const q = busca.toLowerCase().trim();
    return baixas.filter((b) => {
      const nome = (b.customerName || '').toLowerCase();
      const cod = (b.codCliente || '').toLowerCase();
      return nome.includes(q) || cod.includes(q);
    });
  }, [busca, baixas]);

  async function confirmarEstorno() {
    if (!estornoBaixa) return;
    if (!estornoReason.trim()) {
      alert('Razão obrigatória — descreva por que está estornando');
      return;
    }
    setEstornando(true);
    setEstornoResult(null);
    try {
      const r = await api<{ ok: boolean; revertidos: number; falhas: number; details: any[] }>(
        `/crediarios/baixa/${estornoBaixa.id}/estornar`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: estornoReason.trim() }),
        },
      );
      setEstornoResult(r);
      // Recarrega lista após sucesso
      if (r.ok) {
        await load();
        // Aguarda 1.5s pra mostrar resultado e fecha
        setTimeout(() => {
          setEstornoBaixa(null);
          setEstornoReason('');
          setEstornoResult(null);
        }, 1800);
      }
    } catch (e: any) {
      setEstornoResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setEstornando(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/minha-loja/pdv/recebimentos" className="text-rose-700 hover:text-rose-900">
              <ArrowLeft size={24} />
            </Link>
            <div>
              <h1 className="text-2xl font-black text-rose-700">HISTÓRICO DE BAIXAS</h1>
              <p className="text-xs text-gray-500">crediário · auditoria · estorno</p>
            </div>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="text-rose-700 hover:text-rose-900 disabled:opacity-50"
            title="Recarregar"
          >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Filtros */}
        <div className="bg-white rounded-xl shadow p-4 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] uppercase font-bold text-gray-500 block mb-1">Período</label>
              <select
                value={dias}
                onChange={(e) => setDias(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-bold border-2 border-gray-200 rounded-lg"
              >
                <option value={1}>Hoje</option>
                <option value={3}>3 dias</option>
                <option value={7}>7 dias</option>
                <option value={15}>15 dias</option>
                <option value={30}>30 dias</option>
                <option value={90}>90 dias</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase font-bold text-gray-500 block mb-1">Status</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as any)}
                className="w-full px-3 py-2 text-sm font-bold border-2 border-gray-200 rounded-lg"
              >
                <option value="all">Todos</option>
                <option value="paid">Pagas</option>
                <option value="canceled">Estornadas</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase font-bold text-gray-500 block mb-1">Buscar cliente</label>
              <input
                type="text"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="nome ou código..."
                className="w-full px-3 py-2 text-sm border-2 border-gray-200 rounded-lg"
              />
            </div>
          </div>
        </div>

        {/* Erro */}
        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg p-3 text-sm flex items-center gap-2">
            <AlertCircle size={18} /> {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="text-center p-12">
            <Loader2 size={32} className="mx-auto animate-spin text-rose-600" />
            <div className="text-sm text-gray-500 mt-2">Carregando histórico…</div>
          </div>
        )}

        {/* Empty */}
        {!loading && baixasFiltradas.length === 0 && (
          <div className="bg-white rounded-xl shadow p-12 text-center text-gray-500 text-sm">
            Nenhuma baixa encontrada nos filtros selecionados.
          </div>
        )}

        {/* Lista */}
        {!loading && baixasFiltradas.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs text-gray-500 font-bold">
              {baixasFiltradas.length} baixa{baixasFiltradas.length > 1 ? 's' : ''} no período
            </div>
            {baixasFiltradas.map((b) => {
              const cancelada = b.status === 'canceled';
              return (
                <div
                  key={b.id}
                  className={`bg-white rounded-xl shadow border-2 ${cancelada ? 'border-gray-300 opacity-70' : 'border-emerald-200'} overflow-hidden`}
                >
                  <div className="p-3 grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                    {/* Cliente + cod */}
                    <div className="sm:col-span-3">
                      <div className={`font-bold text-sm ${cancelada ? 'line-through text-gray-500' : 'text-rose-900'}`}>
                        {b.customerName || '—'}
                      </div>
                      <div className="text-[10px] text-gray-500">cód {b.codCliente || '—'}</div>
                    </div>
                    {/* Total + parcelas */}
                    <div className="sm:col-span-2">
                      <div className={`font-black text-lg tabular-nums ${cancelada ? 'text-gray-500' : 'text-emerald-700'}`}>
                        {brl(b.totalPago)}
                      </div>
                      <div className="text-[10px] text-gray-500">
                        {b.totalParcelas} parc{b.totalParcelas > 1 ? 'elas' : 'ela'}
                        {b.totalJuros > 0 && ` · juros ${brl(b.totalJuros)}`}
                      </div>
                    </div>
                    {/* Forma */}
                    <div className="sm:col-span-2">
                      <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded ${
                        b.formaPagamento === 'pix' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                      }`}>
                        {b.formaPagamento === 'pix' ? <QrCode size={12} /> : <Banknote size={12} />}
                        {b.formaPagamento.toUpperCase()}
                      </span>
                    </div>
                    {/* Vendedora */}
                    <div className="sm:col-span-2">
                      <div className="text-[10px] uppercase text-gray-400 font-bold">vendedora</div>
                      <div className="text-xs font-bold text-gray-700 truncate">{b.userName || '—'}</div>
                    </div>
                    {/* Data */}
                    <div className="sm:col-span-2">
                      <div className="text-[10px] uppercase text-gray-400 font-bold">data baixa</div>
                      <div className="text-xs font-mono text-gray-700 tabular-nums">{fmtDateTime(b.paidAt || b.createdAt)}</div>
                    </div>
                    {/* Ação */}
                    <div className="sm:col-span-1 flex justify-end">
                      {cancelada ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 bg-rose-100 px-2 py-1 rounded">
                          <XCircle size={12} /> ESTORNADA
                        </span>
                      ) : (
                        <button
                          onClick={() => { setEstornoBaixa(b); setEstornoReason(''); setEstornoResult(null); }}
                          className="px-2.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded flex items-center gap-1"
                          title="Estornar essa baixa"
                        >
                          <Undo2 size={12} /> Estornar
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Itens da baixa (parcelas) — sempre visível em fonte pequena */}
                  <div className="bg-gray-50 px-3 py-2 border-t border-gray-200">
                    <div className="text-[10px] uppercase font-bold text-gray-500 mb-1">parcelas baixadas</div>
                    <div className="flex flex-wrap gap-1.5">
                      {b.items.map((it) => (
                        <span
                          key={it.id}
                          className="inline-flex items-center gap-1 text-[10px] font-mono bg-white border border-gray-200 px-1.5 py-0.5 rounded"
                          title={`Reg ${it.registro} · Ctrl ${it.controle} · Venc ${it.vencimento}`}
                        >
                          {it.parcelaNum && it.totalParcelas ? `${it.parcelaNum}/${it.totalParcelas}` : 'parc'}
                          {' · '}
                          {brl(it.valorPago)}
                          {it.jurosCalculado > 0 && ` (+${brl(it.jurosCalculado)})`}
                        </span>
                      ))}
                    </div>
                    {cancelada && b.canceledReason && (
                      <div className="mt-1 text-[10px] text-rose-700 italic">
                        Estorno: <strong>{b.canceledByUserName || '—'}</strong> · {fmtDateTime(b.canceledAt)} · "{b.canceledReason}"
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* MODAL DE ESTORNO */}
        {estornoBaixa && (
          <div
            className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
            onClick={() => !estornando && setEstornoBaixa(null)}
          >
            <div
              className="bg-white rounded-xl max-w-md w-full p-5 space-y-3"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-lg font-black text-rose-700 flex items-center gap-2">
                <Undo2 size={20} /> Confirmar estorno
              </h2>

              {!estornoResult && (
                <>
                  <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm space-y-1">
                    <div><strong>Cliente:</strong> {estornoBaixa.customerName}</div>
                    <div><strong>Total:</strong> <span className="font-mono font-bold">{brl(estornoBaixa.totalPago)}</span></div>
                    <div><strong>Parcelas:</strong> {estornoBaixa.totalParcelas}</div>
                    <div><strong>Forma:</strong> {estornoBaixa.formaPagamento.toUpperCase()}</div>
                    <div><strong>Data:</strong> {fmtDateTime(estornoBaixa.paidAt)}</div>
                  </div>

                  <div className="bg-rose-50 border border-rose-300 rounded-lg p-3 text-xs text-rose-800">
                    <strong>Atenção:</strong> o estorno reverte as parcelas no Wincred (volta pra "em aberto"). Essa ação ficará registrada na auditoria. Não há volta — pra refazer a baixa terá que iniciar de novo.
                  </div>

                  <div>
                    <label className="text-xs uppercase font-bold text-gray-700 block mb-1">
                      Razão do estorno (obrigatório)
                    </label>
                    <textarea
                      value={estornoReason}
                      onChange={(e) => setEstornoReason(e.target.value.slice(0, 200))}
                      placeholder="Ex: cliente pagou parcela errada, baixa duplicada, etc"
                      rows={2}
                      className="w-full px-3 py-2 text-sm border-2 border-gray-200 rounded-lg focus:outline-none focus:border-rose-400"
                      autoFocus
                    />
                    <div className="text-[10px] text-gray-400 text-right">{estornoReason.length}/200</div>
                  </div>

                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() => setEstornoBaixa(null)}
                      disabled={estornando}
                      className="flex-1 px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold rounded-lg disabled:opacity-50"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={confirmarEstorno}
                      disabled={estornando || !estornoReason.trim()}
                      className="flex-[2] px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg disabled:opacity-40 flex items-center justify-center gap-2"
                    >
                      {estornando ? <Loader2 size={16} className="animate-spin" /> : <Undo2 size={16} />}
                      {estornando ? 'Estornando…' : 'Confirmar estorno'}
                    </button>
                  </div>
                </>
              )}

              {estornoResult && estornoResult.ok && (
                <div className="bg-emerald-50 border-2 border-emerald-300 rounded-lg p-4 text-center text-emerald-900">
                  <CheckCircle2 size={32} className="mx-auto mb-2" />
                  <div className="font-bold">Estorno realizado!</div>
                  <div className="text-xs mt-1">
                    {estornoResult.revertidos}/{estornoResult.revertidos + estornoResult.falhas} parcelas revertidas no Wincred
                  </div>
                </div>
              )}

              {estornoResult && !estornoResult.ok && (
                <div className="bg-rose-50 border-2 border-rose-300 rounded-lg p-4 text-rose-900 space-y-2">
                  <div className="flex items-center gap-2 font-bold">
                    <AlertCircle size={20} /> Estorno parcial / falhou
                  </div>
                  <div className="text-xs">
                    Revertidos: {estornoResult.revertidos || 0} · Falhas: {estornoResult.falhas || 0}
                  </div>
                  {estornoResult.error && <div className="text-xs italic">{estornoResult.error}</div>}
                  <button
                    onClick={() => setEstornoBaixa(null)}
                    className="w-full px-3 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold rounded text-sm"
                  >
                    Fechar
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
