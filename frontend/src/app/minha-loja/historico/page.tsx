'use client';

/**
 * /minha-loja/historico
 *
 * Histórico de pedidos REPOSIÇÃO e VENDA CERTA da loja.
 *
 * A direção (EU PEDI / ME PEDIRAM) vem calculada do backend pelo campo
 * `direction` ('out' | 'in'), baseado no storeCode do JWT. Não é mais
 * inferido no frontend (fallback anterior causava bug quando a loja
 * origem logava e nunca tinha pedidos com ela como destino).
 *
 * VENDA CERTA abre com status=pending + prazo de 7 dias. A loja destino
 * (quem pediu) tem que confirmar "Vendi" ou "Não vendi" pra matriz poder
 * auditar. Enquanto pendente, card fica em vermelho pulsante com
 * contagem regressiva — pressão visual pra combater abuso do recurso.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, RefreshCw, Search, Package, ShoppingBag,
  ArrowDownLeft, ArrowUpRight, User, MessageCircle, History,
  AlertTriangle, CheckCircle2, XCircle, Clock, Check, X,
} from 'lucide-react';
import { api } from '@/lib/api';

type TransferOrder = {
  id: string;
  tipo: 'REPOSICAO' | 'VENDA_CERTA';
  refCode: string;
  cor: string | null;
  tamanho: string | null;
  qtyOrigem: number;
  lojaOrigemCode: string;
  lojaOrigemName: string;
  lojaDestinoCode: string;
  lojaDestinoName: string;
  solicitanteNome: string;
  clienteNome: string | null;
  mensagem: string;
  createdAt: string;
  // Controle VENDA CERTA
  saleStatus: 'pending' | 'confirmed' | 'cancelled' | null;
  saleDeadline: string | null;
  saleConfirmedAt: string | null;
  saleCancelReason: string | null;
  saleNote: string | null;
  // Decoração backend
  direction: 'out' | 'in' | null;
};

type TipoFiltro = 'all' | 'REPOSICAO' | 'VENDA_CERTA';
type DirecaoFiltro = 'all' | 'out' | 'in';
type StatusFiltro = 'all' | 'pending' | 'confirmed' | 'cancelled';

export default function HistoricoPage() {
  const router = useRouter();
  const [items, setItems] = useState<TransferOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [myStoreCode, setMyStoreCode] = useState<string>('');
  const [tipoFiltro, setTipoFiltro] = useState<TipoFiltro>('all');
  const [direcaoFiltro, setDirecaoFiltro] = useState<DirecaoFiltro>('all');
  const [statusFiltro, setStatusFiltro] = useState<StatusFiltro>('all');
  const [busca, setBusca] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ items: TransferOrder[]; myStoreCode: string | null }>(
        '/products/transfer-orders?limit=200',
      );
      setItems(data.items || []);
      setMyStoreCode(data.myStoreCode || '');
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.includes('401') || msg.includes('403')) {
        router.push('/login');
        return;
      }
      setError('Não foi possível carregar o histórico.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const needle = busca.trim().toLowerCase();
    return items.filter((it) => {
      if (tipoFiltro !== 'all' && it.tipo !== tipoFiltro) return false;
      if (direcaoFiltro !== 'all' && it.direction !== direcaoFiltro) return false;
      if (statusFiltro !== 'all') {
        if (it.tipo !== 'VENDA_CERTA') return false;
        if ((it.saleStatus || 'pending') !== statusFiltro) return false;
      }
      if (!needle) return true;
      return (
        it.refCode.toLowerCase().includes(needle) ||
        it.solicitanteNome.toLowerCase().includes(needle) ||
        (it.clienteNome || '').toLowerCase().includes(needle) ||
        it.lojaOrigemName.toLowerCase().includes(needle) ||
        it.lojaDestinoName.toLowerCase().includes(needle) ||
        (it.cor || '').toLowerCase().includes(needle) ||
        (it.tamanho || '').toLowerCase().includes(needle)
      );
    });
  }, [items, tipoFiltro, direcaoFiltro, statusFiltro, busca]);

  const kpis = useMemo(() => {
    const out = items.filter((i) => i.direction === 'out');
    const inc = items.filter((i) => i.direction === 'in');
    // Vendas certas PENDENTES que EU pedi (tenho que confirmar)
    const vcPendingMine = out.filter(
      (i) => i.tipo === 'VENDA_CERTA' && (i.saleStatus || 'pending') === 'pending',
    );
    return {
      totalOut: out.length,
      totalIn: inc.length,
      reposicao: items.filter((i) => i.tipo === 'REPOSICAO').length,
      vendaCerta: items.filter((i) => i.tipo === 'VENDA_CERTA').length,
      vcPendingMine: vcPendingMine.length,
    };
  }, [items]);

  async function updateSale(
    id: string,
    status: 'confirmed' | 'cancelled',
    body: { reason?: string; saleNote?: string } = {},
  ) {
    try {
      await api(`/products/transfer-orders/${id}/sale-status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, ...body }),
      });
      // Atualiza local sem recarregar tudo
      setItems((cur) =>
        cur.map((it) =>
          it.id === id
            ? {
                ...it,
                saleStatus: status,
                saleConfirmedAt: status === 'confirmed' ? new Date().toISOString() : null,
                saleCancelReason: status === 'cancelled' ? body.reason || null : null,
                saleNote: body.saleNote || null,
              }
            : it,
        ),
      );
    } catch (err: any) {
      alert('Erro ao atualizar: ' + String(err?.message || err));
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-brand text-white sticky top-0 z-20 shadow">
        <div className="px-4 py-3 flex items-center gap-3 max-w-5xl mx-auto">
          <Link href="/minha-loja" className="p-2 hover:bg-white/10 rounded" title="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-2 font-bold">
              <History className="w-5 h-5" />
              Histórico de transferências
            </div>
            <div className="text-xs opacity-80">
              Pedidos de reposição e venda certa
            </div>
          </div>
          <button
            onClick={load}
            className="p-2 hover:bg-white/10 rounded"
            title="Atualizar"
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-3 sm:p-4 space-y-3">
        {/* Alerta de VENDA CERTA pendente */}
        {kpis.vcPendingMine > 0 && (
          <div className="bg-red-50 border-2 border-red-300 rounded-xl p-4 flex items-start gap-3 animate-pulse-slow">
            <AlertTriangle className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-bold text-red-800 text-sm">
                Você tem {kpis.vcPendingMine} venda{kpis.vcPendingMine > 1 ? 's' : ''} certa{kpis.vcPendingMine > 1 ? 's' : ''} pendente{kpis.vcPendingMine > 1 ? 's' : ''} de confirmação
              </div>
              <div className="text-xs text-red-700 mt-0.5">
                Confirme &quot;Vendi&quot; ou &quot;Não vendi&quot; em cada card abaixo. A matriz está monitorando.
              </div>
            </div>
            <button
              onClick={() => {
                setTipoFiltro('VENDA_CERTA');
                setDirecaoFiltro('out');
                setStatusFiltro('pending');
              }}
              className="px-3 py-1.5 bg-red-600 text-white text-xs font-bold rounded hover:bg-red-700 flex-shrink-0"
            >
              Ver só pendentes
            </button>
          </div>
        )}

        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <Kpi icon={<ArrowUpRight className="w-4 h-4" />} label="Eu pedi" value={kpis.totalOut} color="text-sky-700 bg-sky-50 border-sky-200" />
          <Kpi icon={<ArrowDownLeft className="w-4 h-4" />} label="Me pediram" value={kpis.totalIn} color="text-violet-700 bg-violet-50 border-violet-200" />
          <Kpi icon={<Package className="w-4 h-4" />} label="Reposição" value={kpis.reposicao} color="text-brand bg-brand/5 border-brand/20" />
          <Kpi icon={<ShoppingBag className="w-4 h-4" />} label="Venda certa" value={kpis.vendaCerta} color="text-amber-700 bg-amber-50 border-amber-200" />
          <Kpi
            icon={<AlertTriangle className="w-4 h-4" />}
            label="VC pendentes"
            value={kpis.vcPendingMine}
            color={kpis.vcPendingMine > 0 ? 'text-red-800 bg-red-50 border-red-300' : 'text-slate-500 bg-slate-50 border-slate-200'}
          />
        </div>

        {/* Filtros */}
        <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por REF, loja, solicitante ou cliente…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <select
              value={tipoFiltro}
              onChange={(e) => setTipoFiltro(e.target.value as TipoFiltro)}
              className="border border-slate-200 rounded-lg text-sm py-2 px-2 bg-white"
            >
              <option value="all">Todos os tipos</option>
              <option value="REPOSICAO">Só Reposição</option>
              <option value="VENDA_CERTA">Só Venda Certa</option>
            </select>
            <select
              value={direcaoFiltro}
              onChange={(e) => setDirecaoFiltro(e.target.value as DirecaoFiltro)}
              className="border border-slate-200 rounded-lg text-sm py-2 px-2 bg-white"
            >
              <option value="all">Todas as direções</option>
              <option value="out">Só o que EU pedi</option>
              <option value="in">Só o que ME PEDIRAM</option>
            </select>
            <select
              value={statusFiltro}
              onChange={(e) => setStatusFiltro(e.target.value as StatusFiltro)}
              className="border border-slate-200 rounded-lg text-sm py-2 px-2 bg-white"
            >
              <option value="all">Todos os status</option>
              <option value="pending">VC Pendente</option>
              <option value="confirmed">VC Confirmada</option>
              <option value="cancelled">VC Cancelada</option>
            </select>
          </div>
        </div>

        {/* Lista */}
        {error ? (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm">
            {error}
          </div>
        ) : loading && items.length === 0 ? (
          <div className="text-center text-slate-500 py-10 text-sm">Carregando…</div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-slate-500 text-sm">
            {items.length === 0
              ? 'Nenhum pedido de transferência ainda. Quando vc apertar "Pedir" na tela Consultar, o histórico aparece aqui.'
              : 'Nenhum pedido bate com os filtros.'}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((it) => (
              <HistoricoCard
                key={it.id}
                item={it}
                myStoreCode={myStoreCode}
                onConfirm={(saleNote) => updateSale(it.id, 'confirmed', { saleNote })}
                onCancel={(reason) => updateSale(it.id, 'cancelled', { reason })}
              />
            ))}
          </div>
        )}
      </main>

      <style jsx global>{`
        @keyframes pulse-slow {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.75; }
        }
        .animate-pulse-slow { animation: pulse-slow 2.5s ease-in-out infinite; }
      `}</style>
    </div>
  );
}

function Kpi({
  icon, label, value, color,
}: { icon: React.ReactNode; label: string; value: number; color: string }) {
  return (
    <div className={`rounded-lg border p-3 ${color}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}

function HistoricoCard({
  item, myStoreCode, onConfirm, onCancel,
}: {
  item: TransferOrder;
  myStoreCode: string;
  onConfirm: (saleNote?: string) => void;
  onCancel: (reason: string) => void;
}) {
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const isOutgoing = item.direction === 'out';
  const isIncoming = item.direction === 'in';
  const outraLojaName = isOutgoing ? item.lojaOrigemName : item.lojaDestinoName;
  const outraLojaCode = isOutgoing ? item.lojaOrigemCode : item.lojaDestinoCode;

  // VENDA CERTA state
  const isVendaCerta = item.tipo === 'VENDA_CERTA';
  const saleStatus = item.saleStatus || (isVendaCerta ? 'pending' : null);
  const isPending = isVendaCerta && saleStatus === 'pending';
  const isConfirmed = isVendaCerta && saleStatus === 'confirmed';
  const isCancelled = isVendaCerta && saleStatus === 'cancelled';
  const isOverdue =
    isPending && item.saleDeadline && new Date(item.saleDeadline).getTime() < Date.now();

  // Só a loja destino (quem pediu = outgoing) pode confirmar/cancelar
  const canAct = isVendaCerta && isPending && isOutgoing;

  // Cores do card — VENDA CERTA pendente = vermelho pulsante
  const cardClass = isPending
    ? isOverdue
      ? 'bg-red-50 border-2 border-red-500 shadow-lg shadow-red-200 animate-pulse-slow'
      : 'bg-red-50 border-2 border-red-300 shadow-md shadow-red-100'
    : isConfirmed
      ? 'bg-emerald-50 border border-emerald-200'
      : isCancelled
        ? 'bg-slate-100 border border-slate-300 opacity-75'
        : 'bg-white border border-slate-200 hover:border-slate-300';

  const tipoColor = isVendaCerta
    ? isPending
      ? 'bg-red-200 text-red-900 border-red-400'
      : isConfirmed
        ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
        : 'bg-slate-200 text-slate-700 border-slate-300'
    : 'bg-brand/10 text-brand border-brand/20';

  const direcaoColor = isOutgoing
    ? 'bg-sky-50 text-sky-700 border-sky-200'
    : isIncoming
      ? 'bg-violet-50 text-violet-700 border-violet-200'
      : 'bg-slate-50 text-slate-600 border-slate-200';

  const direcaoLabel = isOutgoing ? 'EU PEDI' : isIncoming ? 'ME PEDIRAM' : '';

  return (
    <div className={`rounded-xl p-3 transition ${cardClass}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${tipoColor}`}>
            {isVendaCerta ? (isPending ? '⚠️ Venda certa' : isConfirmed ? '✅ Venda certa' : '❌ Venda certa') : '📦 Reposição'}
          </span>
          {direcaoLabel && (
            <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${direcaoColor}`}>
              {isOutgoing ? <ArrowUpRight className="inline w-3 h-3 mr-0.5" /> : <ArrowDownLeft className="inline w-3 h-3 mr-0.5" />}
              {direcaoLabel}
            </span>
          )}
          {isVendaCerta && (
            <SaleStatusBadge
              status={saleStatus}
              isOverdue={!!isOverdue}
              deadline={item.saleDeadline}
              isAuto={!!(item.saleNote && item.saleNote.startsWith('AUTO:'))}
            />
          )}
        </div>
        <div className="text-[11px] text-slate-500 font-mono">
          {formatDate(item.createdAt)}
        </div>
      </div>

      <div className="mt-2 flex items-baseline gap-2 flex-wrap">
        <div className="font-bold text-slate-900 text-base">{item.refCode}</div>
        {item.cor && <span className="text-sm text-slate-700">{item.cor}</span>}
        {item.tamanho && <span className="text-sm text-slate-700">tam {item.tamanho}</span>}
        <span className="text-xs text-slate-500">· {item.qtyOrigem} peça{item.qtyOrigem === 1 ? '' : 's'} na origem</span>
      </div>

      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="text-slate-600">
          <span className="text-slate-400">Outra loja:</span>{' '}
          <span className="font-semibold text-slate-800">{outraLojaCode} — {outraLojaName}</span>
        </div>
        <div className="text-slate-600 flex items-center gap-1">
          <User className="w-3 h-3 text-slate-400" />
          <span className="text-slate-400">Solicitante:</span>{' '}
          <span className="font-semibold text-slate-800">{item.solicitanteNome}</span>
        </div>
        {item.clienteNome && (
          <div className="text-slate-600 sm:col-span-2">
            <span className="text-slate-400">Cliente:</span>{' '}
            <span className="font-semibold text-amber-800">{item.clienteNome}</span>
          </div>
        )}
      </div>

      {/* Info extra do status de venda */}
      {isConfirmed && item.saleConfirmedAt && (
        (() => {
          const note = item.saleNote || '';
          const isAuto = note.startsWith('AUTO:');
          const cupomMatch = note.match(/AUTO:cupom_(.+)/);
          const cupom = cupomMatch ? cupomMatch[1] : null;
          return (
            <div
              className={`mt-2 text-xs rounded px-2 py-1.5 flex items-center gap-1.5 ${
                isAuto
                  ? 'bg-blue-100 text-blue-800 border border-blue-200'
                  : 'bg-emerald-100 text-emerald-800'
              }`}
            >
              {isAuto ? (
                <>
                  <span aria-hidden className="text-base leading-none">🤖</span>
                  <div className="flex-1">
                    <span className="font-bold">Vendida automaticamente</span>
                    {cupom && (
                      <span className="ml-1 font-mono text-blue-700">
                        · Cupom PDV {cupom}
                      </span>
                    )}
                    <span className="ml-1 text-blue-700/80">
                      · baixa em {formatDate(item.saleConfirmedAt)}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Venda confirmada em {formatDate(item.saleConfirmedAt)}
                  {note && <span className="text-emerald-700">· {note}</span>}
                </>
              )}
            </div>
          );
        })()
      )}
      {isCancelled && (
        <div className="mt-2 text-xs bg-slate-200 text-slate-700 rounded px-2 py-1.5 flex items-center gap-1.5">
          <XCircle className="w-3.5 h-3.5" />
          Venda não se concretizou
          {item.saleCancelReason && <span>· {item.saleCancelReason}</span>}
        </div>
      )}

      {/* Botões de ação (só loja destino com pedido pendente) */}
      {canAct && !showCancelForm && (
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => {
              const note = window.prompt('Número do pedido WC ou observação (opcional):') || '';
              onConfirm(note.trim() || undefined);
            }}
            className="flex-1 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-sm flex items-center justify-center gap-1.5"
          >
            <Check className="w-4 h-4" /> Vendi (confirmar)
          </button>
          <button
            onClick={() => setShowCancelForm(true)}
            className="px-3 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 font-semibold rounded-lg text-sm flex items-center justify-center gap-1.5"
          >
            <X className="w-4 h-4" /> Não vendeu
          </button>
        </div>
      )}
      {canAct && showCancelForm && (
        <div className="mt-3 space-y-2 bg-white border border-slate-300 rounded-lg p-2">
          <div className="text-xs font-semibold text-slate-700">Por que não se concretizou?</div>
          <textarea
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Ex: cliente desistiu, cor errada, não compareceu..."
            rows={2}
            className="w-full border border-slate-200 rounded text-sm px-2 py-1.5 focus:outline-none focus:border-brand"
          />
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (!cancelReason.trim()) {
                  alert('Informe o motivo (a matriz precisa dessa info).');
                  return;
                }
                onCancel(cancelReason.trim());
              }}
              className="flex-1 px-3 py-1.5 bg-slate-700 hover:bg-slate-800 text-white font-semibold rounded text-xs"
            >
              Confirmar cancelamento
            </button>
            <button
              onClick={() => { setShowCancelForm(false); setCancelReason(''); }}
              className="px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-semibold rounded text-xs"
            >
              Voltar
            </button>
          </div>
        </div>
      )}

      {item.mensagem && (
        <details className="mt-2">
          <summary className="text-[11px] text-slate-500 cursor-pointer hover:text-slate-700 flex items-center gap-1">
            <MessageCircle className="w-3 h-3" /> Ver mensagem enviada
          </summary>
          <pre className="mt-1 text-[11px] text-slate-700 bg-slate-50 border border-slate-200 rounded p-2 whitespace-pre-wrap font-mono">
            {item.mensagem}
          </pre>
        </details>
      )}
    </div>
  );
}

function SaleStatusBadge({
  status, isOverdue, deadline, isAuto = false,
}: {
  status: 'pending' | 'confirmed' | 'cancelled' | null;
  isOverdue: boolean;
  deadline: string | null;
  isAuto?: boolean;
}) {
  if (status === 'confirmed') {
    if (isAuto) {
      return (
        <span
          className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border bg-blue-100 text-blue-800 border-blue-300 inline-flex items-center gap-1"
          title="Confirmada automaticamente pelo PDV"
        >
          <span aria-hidden className="leading-none">🤖</span> Vendida auto
        </span>
      );
    }
    return (
      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border bg-emerald-100 text-emerald-800 border-emerald-300 inline-flex items-center gap-1">
        <CheckCircle2 className="w-3 h-3" /> Vendida
      </span>
    );
  }
  if (status === 'cancelled') {
    return (
      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border bg-slate-200 text-slate-700 border-slate-300 inline-flex items-center gap-1">
        <XCircle className="w-3 h-3" /> Não vendeu
      </span>
    );
  }
  // pending
  const remaining = deadline ? Math.ceil((new Date(deadline).getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : null;
  return (
    <span
      className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border inline-flex items-center gap-1 ${
        isOverdue
          ? 'bg-red-600 text-white border-red-700'
          : 'bg-red-100 text-red-800 border-red-300'
      }`}
    >
      <Clock className="w-3 h-3" />
      {isOverdue
        ? `ATRASADO ${remaining !== null ? Math.abs(remaining) + 'd' : ''}`
        : remaining !== null && remaining >= 0
          ? `Pendente ${remaining}d`
          : 'Pendente'}
    </span>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'agora';
    if (diffMin < 60) return `${diffMin} min atrás`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h atrás`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `${diffD}d atrás`;
    return d.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
