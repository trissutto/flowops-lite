'use client';

/**
 * /minha-loja/historico
 *
 * Histórico de pedidos REPOSIÇÃO e VENDA CERTA da loja.
 *
 * A direção (EU PEDI / ME PEDIRAM) vem calculada do backend pelo campo
 * `direction` ('out' | 'in'), baseado no storeCode do JWT.
 *
 * VENDA CERTA: NÃO tem mais botão manual "Vendi / Não vendeu". A baixa
 * acontece SÓ automaticamente, via cron que lê a tabela caixa do PDV
 * Gigasistemas da loja solicitante — se o produto apareceu em venda
 * lá, o status vira 'confirmed' com nota "AUTO:cupom_XXX". Se passar
 * do prazo de 7 dias sem venda, a matriz decide manualmente.
 *
 * Essa tela é só informativa pro lojista. Botão manual foi removido
 * pra impedir "burla" (lojista marcar como vendido sem ter passado no PDV).
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, RefreshCw, Search, Package, ShoppingBag,
  ArrowDownLeft, ArrowUpRight, User, MessageCircle, History,
  CheckCircle2, XCircle, Clock,
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
    return {
      totalOut: out.length,
      totalIn: inc.length,
      reposicao: items.filter((i) => i.tipo === 'REPOSICAO').length,
      vendaCerta: items.filter((i) => i.tipo === 'VENDA_CERTA').length,
    };
  }, [items]);

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
        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Kpi icon={<ArrowUpRight className="w-4 h-4" />} label="Eu pedi" value={kpis.totalOut} color="text-sky-700 bg-sky-50 border-sky-200" />
          <Kpi icon={<ArrowDownLeft className="w-4 h-4" />} label="Me pediram" value={kpis.totalIn} color="text-violet-700 bg-violet-50 border-violet-200" />
          <Kpi icon={<Package className="w-4 h-4" />} label="Reposição" value={kpis.reposicao} color="text-brand bg-brand/5 border-brand/20" />
          <Kpi icon={<ShoppingBag className="w-4 h-4" />} label="Venda certa" value={kpis.vendaCerta} color="text-amber-700 bg-amber-50 border-amber-200" />
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
              <option value="pending">VC Aguardando PDV</option>
              <option value="confirmed">VC Baixada</option>
              <option value="cancelled">VC Não vendida</option>
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
              />
            ))}
          </div>
        )}
      </main>

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
  item, myStoreCode,
}: {
  item: TransferOrder;
  myStoreCode: string;
}) {
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

  // Cores do card — VENDA CERTA aguardando PDV = âmbar discreto (antes era vermelho
  // pulsante porque existia botão manual "Vendi/Não vendeu" e queria chamar a
  // atenção do lojista. Com a baixa 100% automática via PDV, ele não tem o que
  // fazer — só aguardar. Cor suave pra não poluir a tela).
  const cardClass = isPending
    ? isOverdue
      ? 'bg-amber-50 border border-amber-300'
      : 'bg-amber-50/60 border border-amber-200'
    : isConfirmed
      ? 'bg-emerald-50 border border-emerald-200'
      : isCancelled
        ? 'bg-slate-100 border border-slate-300 opacity-75'
        : 'bg-white border border-slate-200 hover:border-slate-300';

  const tipoColor = isVendaCerta
    ? isPending
      ? 'bg-amber-100 text-amber-900 border-amber-300'
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
            {isVendaCerta ? (isPending ? '⏳ Venda certa' : isConfirmed ? '✅ Venda certa' : '❌ Venda certa') : '📦 Reposição'}
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

      {/* Nota informativa quando VC está aguardando PDV — explica pro lojista
           que não precisa fazer nada, o sistema baixa sozinho quando passar no caixa. */}
      {isPending && isOutgoing && (
        <div className="mt-2 text-xs bg-amber-100 text-amber-900 rounded px-2 py-1.5 flex items-start gap-1.5">
          <Clock className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <div>
            <b>Aguardando PDV Gigasistemas.</b> A baixa é automática — assim que o produto passar no caixa da loja, esse pedido vira &quot;Vendida auto&quot;. Nada pra fazer aqui.
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
  // pending — aguardando baixa via PDV. Não é mais "ameaça vermelha" porque
  // lojista não tem ação manual; só visual informativo.
  const remaining = deadline ? Math.ceil((new Date(deadline).getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : null;
  return (
    <span
      className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border inline-flex items-center gap-1 ${
        isOverdue
          ? 'bg-amber-200 text-amber-900 border-amber-400'
          : 'bg-amber-50 text-amber-800 border-amber-200'
      }`}
      title="Aguardando baixa automática via PDV Gigasistemas"
    >
      <Clock className="w-3 h-3" />
      {isOverdue
        ? `Prazo venceu ${remaining !== null ? Math.abs(remaining) + 'd' : ''}`
        : remaining !== null && remaining >= 0
          ? `Aguardando PDV · ${remaining}d`
          : 'Aguardando PDV'}
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
