'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  Package, MapPin, User, Mail, Phone, Zap, Send, Check,
  Store as StoreIcon, X, ChevronDown, ChevronUp, MessageCircle,
} from 'lucide-react';

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending:        { label: 'Aguardando pagto', color: 'bg-yellow-100 text-yellow-800' },
  processing:     { label: 'Pago - separar',   color: 'bg-emerald-100 text-emerald-800 font-bold' },
  routing:        { label: 'Roteando',         color: 'bg-blue-100 text-blue-800' },
  awaiting_stock: { label: 'Sem estoque',      color: 'bg-red-100 text-red-800' },
  separating:     { label: 'Separando',        color: 'bg-purple-100 text-purple-800' },
  ready:          { label: 'Pronto',           color: 'bg-teal-100 text-teal-800' },
  shipped:        { label: 'Enviado',          color: 'bg-green-100 text-green-800' },
  delivered:      { label: 'Entregue',         color: 'bg-slate-200 text-slate-800' },
  cancelled:      { label: 'Cancelado',        color: 'bg-slate-100 text-slate-500' },
  failed:         { label: 'Falhou',           color: 'bg-orange-100 text-orange-700' },
};

function parseJSON(s: any) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

interface Assignment {
  storeId: string;
  storeCode: string;
  storeName: string;
  whatsapp?: string;
  contactName?: string;
  city?: string;
  state?: string;
  items: Array<{ sku: string; quantity: number }>;
}

export default function PedidoDetalhePage() {
  const { id } = useParams<{ id: string }>();

  const [order, setOrder] = useState<any>(null);
  const [stockMap, setStockMap] = useState<any>(null);
  const [loadingStock, setLoadingStock] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function load() {
    try {
      const data = await api<any>(`/orders/${id}`);
      setOrder(data);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function loadStock() {
    setLoadingStock(true);
    setError(null);
    try {
      const data = await api<any>(`/orders/${id}/stock-by-store`);
      setStockMap(data.stock);
    } catch (e: any) {
      setError(`Erro consultando estoque do ERP: ${e.message}`);
    } finally {
      setLoadingStock(false);
    }
  }

  async function gerarPreview() {
    setPreviewLoading(true);
    setError(null);
    setPreview(null);
    try {
      const res = await api<any>(`/orders/${id}/preview-route`, { method: 'POST' });
      setPreview(res);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function confirmar() {
    if (!preview) return;
    setConfirming(true);
    try {
      await api(`/orders/${id}/confirm-route`, {
        method: 'POST',
        body: JSON.stringify(preview),
      });
      setPreview(null);
      await load();
      alert('Pedido enviado pra(s) loja(s). Use os botões WhatsApp pra notificar cada uma.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setConfirming(false);
    }
  }

  function montarMensagemWA(a: Assignment): string {
    const shipping = parseJSON(order.shippingAddress) || {};
    const enderecoLinhas = [
      `${shipping.address_1 ?? ''}${shipping.number ? ', ' + shipping.number : ''}`,
      shipping.address_2 || '',
      shipping.neighborhood || '',
      `${shipping.city ?? ''}/${shipping.state ?? ''}`,
      `CEP: ${order.shippingCep ?? '—'}`,
    ].filter(Boolean).join('\n');

    const itens = a.items.map((it) => {
      const original = order.items.find((oi: any) => oi.sku === it.sku);
      return `• ${it.quantity}x  ${original?.productName ?? it.sku}  (SKU: ${it.sku})`;
    }).join('\n');

    const formaEnvio = parseJSON(order.routingResult)?.shippingMethod ?? 'Conforme padrão da loja';

    return `🛍 *PEDIDO #${order.wcOrderNumber}*

*Cliente:* ${order.customerName ?? '—'}
*Telefone:* ${order.customerPhone ?? '—'}

📍 *Endereço de entrega:*
${enderecoLinhas}

📦 *Itens para separar:*
${itens}

🚚 *Forma de envio:* ${formaEnvio}

Por favor confirmar separação no sistema assim que finalizar.

— LURDS ORDER ONE`;
  }

  function abrirWhatsApp(a: Assignment) {
    if (!a.whatsapp) {
      alert(`A loja ${a.storeName} não tem WhatsApp cadastrado.\nVá em "Lojas" e cadastre o número.`);
      return;
    }
    const numero = a.whatsapp.replace(/\D/g, '');
    const mensagem = encodeURIComponent(montarMensagemWA(a));
    // Nome fixo → reusa a mesma aba do WhatsApp (sem re-login a cada clique)
    window.open(`https://wa.me/${numero}?text=${mensagem}`, 'flowops-whatsapp');
  }

  if (!order) {
    return <div className="p-8 text-slate-500">{error ?? 'Carregando...'}</div>;
  }

  const statusInfo = STATUS_LABELS[order.status] ?? { label: order.status, color: 'bg-slate-100' };
  const shipping = parseJSON(order.shippingAddress) || {};

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <Link href="/pedidos" className="text-brand text-sm hover:underline">← Todos os pedidos</Link>
        <div className="flex items-center justify-between mt-2">
          <div>
            <h1 className="text-2xl font-bold">
              Pedido #{order.wcOrderNumber}
              <span className={`ml-3 px-3 py-1 rounded text-sm font-medium ${statusInfo.color}`}>
                {statusInfo.label}
              </span>
            </h1>
            <p className="text-slate-500 text-sm mt-1">
              Feito no site: {order.wcDateCreated ? new Date(order.wcDateCreated).toLocaleString('pt-BR') : '—'}
              <span className="ml-3 text-xs text-slate-400">
                · chegou em {new Date(order.createdAt).toLocaleString('pt-BR')}
              </span>
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">Total</div>
            <div className="text-2xl font-bold">
              {order.totalAmount ? `R$ ${Number(order.totalAmount).toFixed(2)}` : '—'}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
          {error}
        </div>
      )}

      {/* CTA principal: Separar pedido */}
      {(order.status === 'processing' || order.status === 'awaiting_stock') && !preview && (
        <div className="bg-gradient-to-r from-brand to-brand-light text-white rounded-lg p-5 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-lg">Pronto para separar?</h3>
            <p className="text-sm opacity-90">
              O sistema vai analisar o estoque do gigasistemas21 e sugerir qual(is) loja(s) atendem.
            </p>
          </div>
          <button
            onClick={gerarPreview}
            disabled={previewLoading}
            className="bg-white text-brand font-bold px-5 py-3 rounded shadow hover:bg-slate-50 disabled:opacity-50 flex items-center gap-2"
          >
            <Zap className="w-5 h-5" />
            {previewLoading ? 'Analisando...' : 'SEPARAR PEDIDO'}
          </button>
        </div>
      )}

      {/* Preview de roteamento */}
      {preview && (
        <div className="bg-white border-2 border-brand rounded-lg shadow-lg overflow-hidden">
          <div className="bg-brand text-white p-4 flex items-center justify-between">
            <div>
              <h3 className="font-bold text-lg flex items-center gap-2">
                <Check className="w-5 h-5" /> Preview de separação
              </h3>
              <p className="text-sm opacity-90">
                Estratégia: <strong>{preview.strategy}</strong> · {preview.assignments.length} loja(s)
              </p>
            </div>
            <button onClick={() => setPreview(null)} className="text-white/80 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>

          {!preview.success && preview.missing?.length > 0 && (
            <div className="bg-red-50 text-red-700 p-3 text-sm border-b">
              ⚠ Sem estoque suficiente para: {preview.missing.map((m: any) => m.sku).join(', ')}
            </div>
          )}

          <div className="p-5 space-y-4">
            {preview.assignments.map((a: Assignment, idx: number) => (
              <div key={idx} className="border rounded-lg p-4 hover:shadow">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h4 className="font-bold text-lg flex items-center gap-2">
                      <StoreIcon className="w-5 h-5 text-brand" />
                      {a.storeName}
                    </h4>
                    <p className="text-sm text-slate-500">
                      {a.city}/{a.state}
                      {a.contactName && ` · Contato: ${a.contactName}`}
                    </p>
                    <p className="text-sm text-slate-500 font-mono mt-1">
                      {a.whatsapp ? `WhatsApp: ${a.whatsapp}` : '⚠ Sem WhatsApp cadastrado'}
                    </p>
                  </div>
                  <button
                    onClick={() => abrirWhatsApp(a)}
                    disabled={!a.whatsapp}
                    className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={a.whatsapp ? 'Abre WhatsApp Web/App com mensagem pronta' : 'Sem WhatsApp — cadastre em Lojas'}
                  >
                    <MessageCircle className="w-4 h-4" />
                    WhatsApp
                  </button>
                </div>

                <div className="bg-slate-50 rounded p-3">
                  <div className="text-xs font-semibold text-slate-500 uppercase mb-2">Vai separar:</div>
                  <ul className="text-sm space-y-1">
                    {a.items.map((it) => {
                      const o = order.items.find((oi: any) => oi.sku === it.sku);
                      return (
                        <li key={it.sku} className="flex justify-between">
                          <span><strong>{it.quantity}x</strong> {o?.productName ?? '—'}</span>
                          <span className="text-slate-400 font-mono text-xs">{it.sku}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700">
                    Ver mensagem WhatsApp
                  </summary>
                  <pre className="bg-slate-100 p-3 rounded mt-2 text-xs whitespace-pre-wrap font-sans">
                    {montarMensagemWA(a)}
                  </pre>
                </details>
              </div>
            ))}
          </div>

          <div className="bg-slate-50 p-4 flex justify-between items-center border-t">
            <p className="text-sm text-slate-600">
              ✓ Após confirmar, o status do pedido vira <strong>Separando</strong> e as lojas ficam atribuídas.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setPreview(null)} className="px-4 py-2 border rounded hover:bg-white">
                Recalcular
              </button>
              <button
                onClick={confirmar}
                disabled={confirming || !preview.success}
                className="px-4 py-2 bg-brand text-white rounded hover:bg-brand-dark disabled:opacity-50 flex items-center gap-2"
              >
                <Send className="w-4 h-4" />
                {confirming ? 'Confirmando...' : 'Confirmar separação'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2 colunas: Cliente + Entrega */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg shadow p-5">
          <div className="flex items-center gap-2 text-slate-600 mb-3">
            <User className="w-4 h-4" /> <h2 className="font-semibold">Cliente</h2>
          </div>
          <div className="space-y-1 text-sm">
            <div className="text-base font-medium">{order.customerName || '—'}</div>
            <div className="flex items-center gap-2 text-slate-600"><Mail className="w-3 h-3" /> {order.customerEmail || '—'}</div>
            <div className="flex items-center gap-2 text-slate-600"><Phone className="w-3 h-3" /> {order.customerPhone || '—'}</div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-5">
          <div className="flex items-center gap-2 text-slate-600 mb-3">
            <MapPin className="w-4 h-4" /> <h2 className="font-semibold">Endereço de entrega</h2>
          </div>
          <div className="space-y-1 text-sm">
            <div>{shipping.address_1 || '—'}{shipping.number && `, ${shipping.number}`}</div>
            {shipping.address_2 && <div className="text-slate-500">{shipping.address_2}</div>}
            {shipping.neighborhood && <div className="text-slate-500">{shipping.neighborhood}</div>}
            <div>{shipping.city || '—'} / {shipping.state || '—'}</div>
            <div className="font-mono text-slate-600">CEP: {order.shippingCep || '—'}</div>
          </div>
        </div>
      </div>

      {/* Itens + estoque por loja */}
      <div className="bg-white rounded-lg shadow">
        <div className="flex items-center justify-between p-5 border-b">
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-slate-600" />
            <h2 className="font-semibold text-lg">Itens ({order.items.length})</h2>
          </div>
          <button
            onClick={loadStock}
            disabled={loadingStock}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50 flex items-center gap-2"
          >
            <StoreIcon className="w-4 h-4" />
            {loadingStock ? 'Consultando ERP...' : 'Ver estoque por loja'}
          </button>
        </div>

        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="p-3 text-left">SKU</th>
              <th className="p-3 text-left">Produto</th>
              <th className="p-3 text-right">Qtd</th>
              <th className="p-3 text-right">Unit.</th>
              <th className="p-3 text-left">Loja atribuída</th>
              <th className="p-3 text-center w-32">Estoque</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item: any) => {
              const isOpen = expanded === item.id;
              const stock = stockMap?.[item.sku];
              const stockComEstoque = stock?.filter((s: any) => s.qty > 0) ?? [];
              return (
                <>
                  <tr key={item.id} className="border-t hover:bg-slate-50">
                    <td className="p-3 font-mono text-xs">{item.sku}</td>
                    <td className="p-3">{item.productName || '—'}</td>
                    <td className="p-3 text-right font-semibold">{item.quantity}</td>
                    <td className="p-3 text-right">
                      {item.unitPrice ? `R$ ${Number(item.unitPrice).toFixed(2)}` : '—'}
                    </td>
                    <td className="p-3">
                      {item.assignedStore?.name ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="p-3 text-center">
                      {stock ? (
                        <button
                          onClick={() => setExpanded(isOpen ? null : item.id)}
                          className="text-brand hover:underline flex items-center gap-1 mx-auto text-xs"
                        >
                          {isOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          {stockComEstoque.length} loja(s)
                        </button>
                      ) : (
                        <span className="text-slate-400 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                  {isOpen && stock && (
                    <tr key={`${item.id}-detail`}>
                      <td colSpan={6} className="bg-slate-50 p-4">
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                          {stock.map((s: any) => (
                            <div
                              key={s.storeCode}
                              className={`p-2 rounded border text-xs ${
                                s.qty >= item.quantity
                                  ? 'bg-green-50 border-green-300'
                                  : s.qty > 0
                                  ? 'bg-yellow-50 border-yellow-300'
                                  : 'bg-slate-100 border-slate-200 text-slate-400'
                              }`}
                            >
                              <div className="font-semibold">{s.storeName}</div>
                              <div className="text-slate-500">{s.city}/{s.state}</div>
                              <div className="text-right font-mono font-bold">{s.qty} un</div>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pick orders já criadas */}
      {order.pickOrders && order.pickOrders.length > 0 && (
        <div className="bg-white rounded-lg shadow p-5">
          <h2 className="font-semibold text-lg mb-3">Lojas atribuídas</h2>
          <div className="space-y-2">
            {order.pickOrders.map((p: any) => (
              <div key={p.id} className="flex items-center justify-between p-3 border rounded hover:bg-slate-50">
                <div>
                  <div className="font-medium">{p.store.name}</div>
                  <div className="text-xs text-slate-500">
                    {p.store.city}/{p.store.state}
                    {p.store.whatsapp && ` · 📱 ${p.store.whatsapp}`}
                  </div>
                </div>
                <div className="text-right">
                  <span className="px-2 py-0.5 rounded text-xs bg-slate-100">{p.status}</span>
                  {p.trackingCode && (
                    <div className="text-xs text-slate-500 mt-1">{p.carrier}: {p.trackingCode}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
