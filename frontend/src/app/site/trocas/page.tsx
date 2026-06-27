'use client';

/**
 * /retaguarda/trocas-site
 *
 * Aceitar troca/devolução de pedido feito no SITE (WooCommerce).
 *
 * Fluxo:
 *  1. Busca por nome do cliente OU número do pedido
 *  2. Vê resultados com badge VERDE (dentro do prazo) ou VERMELHO (fora)
 *  3. Click → tela de detalhe com items
 *  4. Seleciona peças + quantidade + LOJA RECEPTORA (que recebeu fisicamente)
 *  5. Aceitar → backend estorna estoque Giga DA LOJA RECEPTORA via increaseStock
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Search, Calendar, CheckCircle2, AlertTriangle, X, Check,
  Banknote, ArrowRightLeft, CreditCard, Store as StoreIcon, Loader2,
  Package, Settings,
} from 'lucide-react';
import { api } from '@/lib/api';

type SearchResult = {
  wcOrderId: number;
  wcOrderNumber: string;
  status: string;
  total: number;
  dateCreated: string | null;
  datePaid: string | null;
  dateCompleted: string | null;
  diasDesde: number | null;
  prazoDias: number;
  dentroDoPrazo: boolean;
  diasRestantes: number | null;
  customerName: string | null;
  customerCpf: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  items: any[];
  itemCount: number;
  previousReturnsCount: number;
  previousReturnsValor: number;
};

type StoreOpt = { code: string; name: string; active?: boolean };

const fmt = (n: number) =>
  (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function TrocasSitePage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<SearchResult | null>(null);
  const [stores, setStores] = useState<StoreOpt[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [prazoConfig, setPrazoConfig] = useState(7);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    api<StoreOpt[]>('/stores')
      .then((s) => setStores(s.filter((x) => x.active !== false)))
      .catch(() => {});
    api<{ dias: number }>('/wc-returns/prazo')
      .then((r) => setPrazoConfig(r.dias))
      .catch(() => {});
  }, []);

  const search = useCallback(async () => {
    setErr('');
    setSelectedOrder(null);
    if (!query.trim() || query.trim().length < 2) return;
    setBusy(true);
    try {
      const r = await api<SearchResult[]>(`/wc-returns/search?q=${encodeURIComponent(query.trim())}`);
      setResults(r);
      if (r.length === 0) setErr('Nenhum pedido encontrado.');
    } catch (e: any) {
      setErr(e?.message || 'Falha na busca');
      setResults([]);
    } finally {
      setBusy(false);
    }
  }, [query]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-rose-50 via-pink-50 to-fuchsia-50 p-4 md:p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
          <Link
            href="/retaguarda"
            className="inline-flex items-center gap-2 text-rose-700 hover:text-rose-900"
          >
            <ArrowLeft size={18} /> Voltar
          </Link>
          <button
            onClick={() => setShowSettings(true)}
            className="text-xs px-3 py-1.5 rounded-lg bg-white hover:bg-rose-50 text-rose-700 border border-rose-200 flex items-center gap-1.5 font-semibold"
          >
            <Settings size={14} /> Prazo: {prazoConfig} dias
          </button>
        </div>

        <h1 className="text-2xl md:text-3xl font-black bg-gradient-to-r from-rose-700 to-pink-600 bg-clip-text text-transparent mb-1">
          Trocas/Devoluções do Site
        </h1>
        <p className="text-sm text-gray-600 mb-6">
          Aceitar peças que voltaram pra loja física e estornar pro estoque Giga.
        </p>

        {/* BUSCA */}
        {!selectedOrder && (
          <div className="bg-white rounded-2xl shadow-sm p-5 mb-5">
            <label className="block text-sm font-bold text-rose-900 mb-2">
              Buscar pedido (nome do cliente ou nº do pedido)
            </label>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') search();
                }}
                placeholder="Ex: Maria Silva  ·  ou  ·  19134"
                className="flex-1 p-3 border-2 border-rose-200 rounded-xl focus:outline-none focus:border-rose-400 text-base"
              />
              <button
                onClick={search}
                disabled={busy || query.trim().length < 2}
                className="bg-gradient-to-br from-rose-500 to-pink-600 hover:from-rose-600 hover:to-pink-700 text-white px-6 py-3 rounded-xl font-bold disabled:opacity-50 flex items-center gap-2 shadow-md"
              >
                {busy ? <Loader2 className="animate-spin w-5 h-5" /> : <Search size={18} />}
                Buscar
              </button>
            </div>
            {err && <div className="mt-3 text-sm text-red-600">{err}</div>}
          </div>
        )}

        {/* RESULTADOS */}
        {!selectedOrder && results.length > 0 && (
          <div className="space-y-3">
            <div className="text-xs text-gray-600 font-semibold uppercase tracking-wide">
              {results.length} pedido(s) encontrado(s)
            </div>
            {results.map((r) => (
              <OrderCard key={r.wcOrderId} order={r} onClick={() => setSelectedOrder(r)} />
            ))}
          </div>
        )}

        {/* DETALHE DO PEDIDO + ACEITAR */}
        {selectedOrder && (
          <OrderDetail
            order={selectedOrder}
            stores={stores}
            onBack={() => setSelectedOrder(null)}
            onAccepted={() => {
              setSelectedOrder(null);
              setQuery('');
              setResults([]);
            }}
          />
        )}
      </div>

      {showSettings && (
        <SettingsModal
          current={prazoConfig}
          onClose={() => setShowSettings(false)}
          onSaved={(n) => {
            setPrazoConfig(n);
            setShowSettings(false);
          }}
        />
      )}
    </div>
  );
}

// ── Card de resultado da busca ──────────────────────────────────────────
function OrderCard({ order, onClick }: { order: SearchResult; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full bg-white rounded-2xl shadow-sm hover:shadow-md transition border-2 border-transparent hover:border-rose-200 p-4 text-left"
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-rose-100 to-pink-200 flex items-center justify-center">
          <Package className="w-6 h-6 text-rose-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-mono font-black text-rose-900 text-base">
              #{order.wcOrderNumber}
            </span>
            <PrazoBadge order={order} />
            {order.previousReturnsCount > 0 && (
              <span className="text-[10px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-bold">
                {order.previousReturnsCount} devolução(ões) anteriores
              </span>
            )}
          </div>
          <div className="font-bold text-gray-800">
            {order.customerName || 'Cliente sem nome'}
          </div>
          <div className="text-xs text-gray-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {order.customerCpf && <span>CPF {order.customerCpf}</span>}
            {order.shippingCity && (
              <span>
                {order.shippingCity}/{order.shippingState}
              </span>
            )}
            {order.dateCreated && (
              <span>
                <Calendar size={11} className="inline mr-0.5" />
                {new Date(order.dateCreated).toLocaleDateString('pt-BR')}
              </span>
            )}
            <span className="font-mono">{order.itemCount} item(ns)</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-lg font-black text-rose-900">R$ {fmt(order.total)}</div>
          <div className="text-[10px] text-gray-500 uppercase">{order.status}</div>
        </div>
      </div>
    </button>
  );
}

// ── Badge de prazo ──────────────────────────────────────────────────────
function PrazoBadge({ order }: { order: SearchResult }) {
  if (order.diasDesde == null) {
    return (
      <span className="text-[10px] bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full font-bold">
        SEM DATA
      </span>
    );
  }
  if (order.dentroDoPrazo) {
    return (
      <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
        <CheckCircle2 size={10} /> DENTRO DO PRAZO ({order.diasRestantes}d restantes)
      </span>
    );
  }
  return (
    <span className="text-[10px] bg-red-100 text-red-800 px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
      <AlertTriangle size={10} /> FORA DO PRAZO ({order.diasDesde}d desde envio)
    </span>
  );
}

// ── Detalhe + form de aceitar ───────────────────────────────────────────
function OrderDetail({
  order,
  stores,
  onBack,
  onAccepted,
}: {
  order: SearchResult;
  stores: StoreOpt[];
  onBack: () => void;
  onAccepted: () => void;
}) {
  const [detail, setDetail] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [receivingStore, setReceivingStore] = useState('');
  const [modo, setModo] = useState<'devolucao' | 'troca' | 'credito'>('devolucao');
  const [motivo, setMotivo] = useState('');
  const [obs, setObs] = useState('');
  const [validade, setValidade] = useState(90);
  const [forceOutOfPrazo, setForceOutOfPrazo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [success, setSuccess] = useState<any>(null);

  useEffect(() => {
    (async () => {
      try {
        const d = await api<SearchResult>(`/wc-returns/order/${order.wcOrderId}`);
        setDetail(d);
        // Pré-seleciona última loja escolhida
        const saved = typeof window !== 'undefined' ? localStorage.getItem('lurds_trocas_loja') : null;
        if (saved && stores.some((s) => s.code === saved)) {
          setReceivingStore(saved);
        } else if (stores[0]) {
          setReceivingStore(stores[0].code);
        }
      } catch (e: any) {
        setErr(e?.message || 'Falha ao carregar detalhes');
      } finally {
        setLoading(false);
      }
    })();
  }, [order.wcOrderId, stores]);

  function toggle(sku: string, max: number) {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[sku]) delete next[sku];
      else next[sku] = max;
      return next;
    });
  }

  function setQty(sku: string, qty: number, max: number) {
    setSelected((prev) => ({ ...prev, [sku]: Math.max(1, Math.min(max, qty)) }));
  }

  const totalDevolucao = (detail?.items || [])
    .filter((it) => selected[it.sku])
    .reduce((s, it) => s + (it.precoUnit || 0) * (selected[it.sku] || 0), 0);

  async function accept() {
    setErr('');
    if (!receivingStore) {
      setErr('Selecione a loja que está recebendo a peça.');
      return;
    }
    const items = Object.entries(selected).map(([sku, qty]) => {
      const item = (detail?.items || []).find((it) => it.sku === sku);
      return { sku, qty, productName: item?.productName };
    });
    if (!items.length) {
      setErr('Selecione ao menos uma peça.');
      return;
    }
    setBusy(true);
    try {
      // Salva loja no localStorage
      if (typeof window !== 'undefined') localStorage.setItem('lurds_trocas_loja', receivingStore);

      const r = await api<any>('/wc-returns/accept', {
        method: 'POST',
        body: JSON.stringify({
          wcOrderId: order.wcOrderId,
          receivingStoreCode: receivingStore,
          modo,
          items,
          motivo: motivo || undefined,
          obs: obs || undefined,
          forceOutOfPrazo,
          creditoValidadeDias: modo === 'credito' ? validade : undefined,
        }),
      });
      setSuccess(r);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao aceitar troca');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="bg-white rounded-2xl shadow-sm p-12 text-center">
        <Loader2 className="w-8 h-8 animate-spin mx-auto text-rose-500" />
      </div>
    );
  }

  if (!detail) return null;

  if (success) {
    return (
      <div className="bg-white rounded-2xl shadow-md p-8 text-center">
        <div className="w-20 h-20 mx-auto bg-emerald-100 rounded-full flex items-center justify-center mb-4">
          <Check size={36} className="text-emerald-600" />
        </div>
        <h2 className="text-2xl font-bold text-rose-900 mb-2">Troca registrada</h2>
        <div className="text-gray-600 mb-4">
          R$ {fmt(success.valorTotal)} em {success.modo} · Loja {success.receivingStoreCode}
        </div>

        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 mb-4 text-emerald-800 text-sm">
          <strong>✓ Estoque estornado no Giga</strong> da loja {success.receivingStoreName}.
          <br />
          A peça já está disponível pra venda novamente.
        </div>

        {success.creditoCode && (
          <div className="bg-rose-50 rounded-lg p-4 mb-4 text-rose-800">
            <div className="text-sm mb-1">Vale-troca gerado:</div>
            <div className="text-2xl font-mono font-bold tracking-widest">{success.creditoCode}</div>
            <div className="text-xs mt-1">
              Válido até{' '}
              {success.creditoValidade
                ? new Date(success.creditoValidade).toLocaleDateString('pt-BR')
                : '—'}
            </div>
          </div>
        )}

        {(success.items || []).some((it: any) => it.stockError) && (
          <div className="bg-red-50 rounded-lg p-3 mb-4 text-red-800 text-sm">
            ⚠️ Atenção: estoque Giga não foi estornado em uma ou mais peças. Faça a entrada
            manual no Gigasistemas.
          </div>
        )}

        <button
          onClick={onAccepted}
          className="w-full py-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold"
        >
          Nova Troca
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-2 text-rose-700 hover:text-rose-900 text-sm font-semibold"
      >
        <ArrowLeft size={16} /> Voltar pra busca
      </button>

      {/* Cabeçalho do pedido */}
      <div className="bg-white rounded-2xl shadow-sm p-5">
        <div className="flex items-start justify-between flex-wrap gap-3 mb-3">
          <div>
            <div className="font-mono font-black text-rose-900 text-lg">#{detail.wcOrderNumber}</div>
            <div className="font-bold text-gray-800">{detail.customerName}</div>
            {detail.customerCpf && <div className="text-xs text-gray-500">CPF {detail.customerCpf}</div>}
          </div>
          <div>
            <PrazoBadge order={detail} />
          </div>
        </div>
        <div className="text-sm text-gray-600 grid grid-cols-2 md:grid-cols-4 gap-2">
          <div>
            <div className="text-[10px] uppercase font-bold text-gray-400">Total pedido</div>
            <div className="font-bold text-rose-900">R$ {fmt(detail.total)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold text-gray-400">Pago em</div>
            <div className="font-mono text-xs">
              {detail.datePaid ? new Date(detail.datePaid).toLocaleDateString('pt-BR') : '—'}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold text-gray-400">Cidade</div>
            <div className="text-xs">
              {detail.shippingCity ? `${detail.shippingCity}/${detail.shippingState}` : '—'}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold text-gray-400">Status WC</div>
            <div className="text-xs uppercase">{detail.status}</div>
          </div>
        </div>
      </div>

      {/* Aviso fora do prazo */}
      {!detail.dentroDoPrazo && (
        <div className="bg-red-50 border-2 border-red-300 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="text-red-600 shrink-0 mt-0.5" size={20} />
          <div className="flex-1">
            <div className="font-bold text-red-900">Pedido fora do prazo de troca</div>
            <div className="text-sm text-red-800 mt-1">
              {detail.diasDesde} dias desde o envio (prazo: {detail.prazoDias} dias). Aceite só se for
              decisão da matriz.
            </div>
            <label className="inline-flex items-center gap-2 mt-2 text-sm font-bold text-red-900 cursor-pointer">
              <input
                type="checkbox"
                checked={forceOutOfPrazo}
                onChange={(e) => setForceOutOfPrazo(e.target.checked)}
                className="w-4 h-4"
              />
              Aceitar mesmo fora do prazo
            </label>
          </div>
        </div>
      )}

      {/* Itens */}
      <div className="bg-white rounded-2xl shadow-sm p-5">
        <h3 className="font-bold text-rose-900 mb-3">Selecione as peças que estão voltando</h3>
        <div className="space-y-2">
          {detail.items.map((it) => {
            const isSel = !!selected[it.sku];
            const sel = selected[it.sku] || 0;
            const disabled = it.disponivel <= 0;
            return (
              <div
                key={it.sku}
                className={`rounded-lg p-3 transition border-2 ${
                  disabled
                    ? 'bg-gray-100 border-gray-200 opacity-50'
                    : isSel
                    ? 'bg-rose-50 border-rose-400 shadow-sm'
                    : 'bg-white border-gray-200 hover:border-rose-300'
                }`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={isSel}
                    disabled={disabled}
                    onChange={() => toggle(it.sku, it.disponivel)}
                    className="mt-1 w-5 h-5 cursor-pointer"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-gray-800">{it.productName}</div>
                    <div className="text-xs text-gray-500 mt-0.5 flex flex-wrap gap-2">
                      <span className="font-mono">SKU {it.sku}</span>
                      <span>R$ {fmt(it.precoUnit)} unit</span>
                      <span>Comprou {it.qty}</span>
                      {it.jaDevolvido > 0 && (
                        <span className="text-amber-700 font-bold">já devolveu {it.jaDevolvido}</span>
                      )}
                    </div>
                  </div>
                  {isSel && it.disponivel > 1 && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => setQty(it.sku, sel - 1, it.disponivel)}
                        className="w-8 h-8 bg-rose-200 rounded font-bold"
                      >
                        −
                      </button>
                      <span className="w-8 text-center font-bold">{sel}</span>
                      <button
                        onClick={() => setQty(it.sku, sel + 1, it.disponivel)}
                        className="w-8 h-8 bg-rose-200 rounded font-bold"
                      >
                        +
                      </button>
                    </div>
                  )}
                  {disabled && <div className="text-xs text-red-600">Tudo já devolvido</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Form de aceitar */}
      {Object.keys(selected).length > 0 && (
        <div className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
          {/* LOJA RECEPTORA */}
          <div>
            <label className="block text-sm font-bold text-rose-900 mb-2 flex items-center gap-1.5">
              <StoreIcon size={16} /> Loja que está RECEBENDO a peça (estorna o estoque pra ela)
            </label>
            <select
              value={receivingStore}
              onChange={(e) => setReceivingStore(e.target.value)}
              className="w-full p-3 border-2 border-rose-200 rounded-xl font-semibold text-rose-900 focus:border-rose-400 focus:outline-none"
            >
              <option value="">Selecione...</option>
              {stores.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>
          </div>

          {/* MODO */}
          <div>
            <label className="block text-sm font-bold text-rose-900 mb-2">Modo</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <ModoBtn
                active={modo === 'devolucao'}
                onClick={() => setModo('devolucao')}
                icon={<Banknote size={18} />}
                title="Devolução"
                sub="Estorna $"
              />
              <ModoBtn
                active={modo === 'troca'}
                onClick={() => setModo('troca')}
                icon={<ArrowRightLeft size={18} />}
                title="Troca"
                sub="Vale 1 dia"
              />
              <ModoBtn
                active={modo === 'credito'}
                onClick={() => setModo('credito')}
                icon={<CreditCard size={18} />}
                title="Crédito"
                sub="Vale longo"
              />
            </div>
          </div>

          {modo === 'credito' && (
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
                Validade do vale (dias)
              </label>
              <input
                type="number"
                value={validade}
                onChange={(e) => setValidade(parseInt(e.target.value, 10) || 90)}
                min={1}
                max={365}
                className="w-full p-2 border rounded-lg"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
              Motivo (opcional)
            </label>
            <input
              type="text"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Tamanho errado, defeito, arrependimento..."
              className="w-full p-2 border rounded-lg"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
              Observação interna (opcional)
            </label>
            <textarea
              value={obs}
              onChange={(e) => setObs(e.target.value)}
              rows={2}
              className="w-full p-2 border rounded-lg"
            />
          </div>

          <div className="bg-rose-50 rounded-lg p-4 text-center">
            <div className="text-sm text-rose-700">Valor total da troca</div>
            <div className="text-3xl font-black text-rose-900">R$ {fmt(totalDevolucao)}</div>
          </div>

          {err && <div className="text-sm text-red-600">{err}</div>}

          <button
            onClick={accept}
            disabled={busy || !receivingStore}
            className="w-full py-4 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 hover:from-rose-600 hover:to-pink-700 text-white font-black text-lg disabled:opacity-50 shadow-md"
          >
            {busy ? 'Processando…' : 'Aceitar Troca e Estornar Estoque'}
          </button>
        </div>
      )}
    </div>
  );
}

function ModoBtn({
  active,
  onClick,
  icon,
  title,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`p-3 rounded-xl text-center transition ${
        active
          ? 'bg-rose-600 text-white shadow-lg scale-105'
          : 'bg-rose-50 hover:bg-rose-100 text-rose-900'
      }`}
    >
      <div className="flex justify-center mb-1">{icon}</div>
      <div className="font-bold text-sm">{title}</div>
      <div className={`text-xs ${active ? 'text-rose-100' : 'text-gray-500'}`}>{sub}</div>
    </button>
  );
}

// ── Modal de configuração de prazo ─────────────────────────────────────
function SettingsModal({
  current,
  onClose,
  onSaved,
}: {
  current: number;
  onClose: () => void;
  onSaved: (n: number) => void;
}) {
  const [dias, setDias] = useState(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setErr('');
    if (dias <= 0 || dias > 365) {
      setErr('Prazo inválido (1-365 dias)');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ dias: number }>('/wc-returns/prazo', {
        method: 'POST',
        body: JSON.stringify({ dias }),
      });
      onSaved(r.dias);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao salvar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-bold text-rose-900">Prazo de Troca</h2>
          <button onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="p-5">
          <p className="text-sm text-gray-600 mb-3">
            Quantos dias após o envio o cliente pode pedir troca? (Código de Defesa do Consumidor:
            mínimo 7 dias úteis.)
          </p>
          <input
            type="number"
            value={dias}
            onChange={(e) => setDias(parseInt(e.target.value, 10) || 0)}
            min={1}
            max={365}
            className="w-full p-3 border-2 border-rose-200 rounded-lg text-2xl font-bold text-center"
          />
          <div className="text-xs text-gray-500 text-center mt-1">dias</div>

          {err && <div className="mt-3 text-sm text-red-600">{err}</div>}

          <div className="mt-5 flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 py-3 rounded-xl bg-gray-200 hover:bg-gray-300 font-bold"
            >
              Cancelar
            </button>
            <button
              onClick={save}
              disabled={busy}
              className="flex-1 py-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold disabled:opacity-50"
            >
              {busy ? '...' : 'Salvar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
