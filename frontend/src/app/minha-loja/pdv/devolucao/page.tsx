'use client';

/**
 * /minha-loja/pdv/devolucao
 *
 * Fluxo:
 *  1. Bipa/digita ID ou nº NFC-e do cupom original
 *  2. Vê itens da venda + quantidade já devolvida
 *  3. Marca peças e quantidade a devolver
 *  4. Escolhe modo: Dinheiro / Troca / Vale-troca
 *  5. Confirma
 *
 * Após confirmar, mostra:
 *  - Modo dinheiro: aviso "sangria automática registrada"
 *  - Modo troca/credito: código TROCA-XXXXX (cliente leva o vale)
 */

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ArrowLeft, Search, Check, X, Banknote, ArrowRightLeft, CreditCard } from 'lucide-react';
import { api } from '@/lib/api';

type Item = {
  id: string;
  sku: string;
  ref?: string;
  cor?: string;
  tamanho?: string;
  descricao: string;
  qty: number;
  precoUnit: number;
  total: number;
  jaDevolvido: number;
  disponivel: number;
};

type Sale = {
  id: string;
  storeCode: string;
  storeName: string;
  customerName?: string;
  customerCpf?: string;
  total: number;
  finalizedAt: string;
  nfceNumber?: string;
};

type LookupResult = {
  sale: Sale;
  items: Item[];
  previousReturns: number;
};

const fmt = (n: number) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function DevolucaoPage() {
  const [query, setQuery] = useState('');
  const [data, setData] = useState<LookupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [modo, setModo] = useState<'dinheiro' | 'troca' | 'credito'>('dinheiro');
  const [motivo, setMotivo] = useState('');
  const [validade, setValidade] = useState(90);
  const [success, setSuccess] = useState<any>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function lookup() {
    setErr('');
    setData(null);
    setSelected({});
    setSuccess(null);
    if (!query.trim()) return;
    setBusy(true);
    try {
      const r = await api<LookupResult>(`/pdv/devolucao/lookup?q=${encodeURIComponent(query.trim())}`);
      setData(r);
    } catch (e: any) {
      setErr(e?.message || 'Venda não encontrada');
    } finally {
      setBusy(false);
    }
  }

  function toggle(itemId: string, max: number) {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[itemId]) {
        delete next[itemId];
      } else {
        next[itemId] = max; // padrão: tudo
      }
      return next;
    });
  }

  function setQty(itemId: string, qty: number, max: number) {
    setSelected((prev) => ({
      ...prev,
      [itemId]: Math.max(1, Math.min(max, qty)),
    }));
  }

  const totalDevolucao = (data?.items || [])
    .filter((it) => selected[it.id])
    .reduce((s, it) => {
      const valorUnit = it.qty > 0 ? it.total / it.qty : it.precoUnit;
      return s + valorUnit * (selected[it.id] || 0);
    }, 0);

  async function confirm() {
    setErr('');
    const items = Object.entries(selected).map(([originalItemId, qty]) => ({
      originalItemId,
      qty,
    }));
    if (!items.length) {
      setErr('Selecione ao menos uma peça');
      return;
    }
    setBusy(true);
    try {
      const r = await api<any>('/pdv/devolucao', {
        method: 'POST',
        body: JSON.stringify({
          originalSaleId: data!.sale.id,
          modo,
          items,
          motivo: motivo || undefined,
          creditoValidadeDias: modo === 'credito' ? validade : undefined,
        }),
      });
      setSuccess(r);
    } catch (e: any) {
      setErr(e?.message || 'Falha na devolução');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setQuery('');
    setData(null);
    setSelected({});
    setSuccess(null);
    setErr('');
    setMotivo('');
    inputRef.current?.focus();
  }

  return (
    <div className="min-h-screen bg-[#f4f1ec] p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <Link
          href="/minha-loja/pdv"
          className="inline-flex items-center gap-2 text-rose-700 hover:text-rose-900 mb-4"
        >
          <ArrowLeft size={18} /> Voltar pro PDV
        </Link>

        <h1 className="text-2xl md:text-3xl font-bold text-rose-900 mb-6">Devolução / Troca</h1>

        {!success && (
          <div className="bg-white rounded-2xl shadow-md p-5 mb-6">
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Bipe ou digite o cupom da venda
            </label>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') lookup();
                }}
                placeholder="ID da venda ou número da NFC-e"
                className="flex-1 p-3 border rounded-lg text-lg focus:ring-2 focus:ring-rose-400"
              />
              <button
                onClick={lookup}
                disabled={busy}
                className="bg-rose-600 hover:bg-rose-700 text-white px-6 py-3 rounded-lg font-semibold disabled:opacity-50 flex items-center gap-2"
              >
                <Search size={18} /> Buscar
              </button>
            </div>
            {err && <div className="mt-3 text-sm text-red-600">{err}</div>}
          </div>
        )}

        {data && !success && (
          <div className="space-y-5">
            <div className="bg-white rounded-2xl shadow-md p-5">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-bold text-rose-900">Venda original</h2>
                {data.previousReturns > 0 && (
                  <span className="text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded">
                    {data.previousReturns} devolução(ões) anteriores
                  </span>
                )}
              </div>
              <div className="text-sm text-gray-600">
                {data.sale.nfceNumber ? `NFC-e #${data.sale.nfceNumber} · ` : ''}
                {data.sale.storeName} ·{' '}
                {new Date(data.sale.finalizedAt).toLocaleString('pt-BR')}
              </div>
              <div className="text-sm text-gray-600">
                Cliente: {data.sale.customerName || '—'}{' '}
                {data.sale.customerCpf ? `· CPF ${data.sale.customerCpf}` : ''}
              </div>
              <div className="text-lg font-bold text-rose-900 mt-2">
                Total: R$ {fmt(data.sale.total)}
              </div>
            </div>

            <div className="bg-white rounded-2xl shadow-md p-5">
              <h3 className="font-bold text-rose-900 mb-3">Selecione as peças a devolver</h3>
              <div className="space-y-2">
                {data.items.map((it) => {
                  const isSel = !!selected[it.id];
                  const sel = selected[it.id] || 0;
                  const disabled = it.disponivel <= 0;
                  return (
                    <div
                      key={it.id}
                      className={`rounded-lg p-3 transition-all border-2 ${
                        disabled
                          ? 'bg-gray-100 border-gray-200 opacity-50'
                          : isSel
                          ? 'bg-rose-50 border-rose-400'
                          : 'bg-white border-gray-200 hover:border-rose-300'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={isSel}
                          disabled={disabled}
                          onChange={() => toggle(it.id, it.disponivel)}
                          className="mt-1 w-5 h-5"
                        />
                        <div className="flex-1">
                          <div className="font-semibold text-gray-800">{it.descricao}</div>
                          <div className="text-xs text-gray-500">
                            SKU {it.sku}
                            {it.cor ? ` · ${it.cor}` : ''}
                            {it.tamanho ? ` · ${it.tamanho}` : ''}
                          </div>
                          <div className="text-sm text-gray-600 mt-1">
                            R$ {fmt(it.precoUnit)} · Comprou {it.qty}
                            {it.jaDevolvido > 0 && (
                              <span className="text-amber-700">
                                {' '}
                                · já devolveu {it.jaDevolvido}
                              </span>
                            )}
                          </div>
                        </div>
                        {isSel && it.disponivel > 1 && (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setQty(it.id, sel - 1, it.disponivel)}
                              className="w-8 h-8 bg-rose-200 rounded font-bold"
                            >
                              −
                            </button>
                            <span className="w-8 text-center font-bold">{sel}</span>
                            <button
                              onClick={() => setQty(it.id, sel + 1, it.disponivel)}
                              className="w-8 h-8 bg-rose-200 rounded font-bold"
                            >
                              +
                            </button>
                          </div>
                        )}
                        {disabled && (
                          <div className="text-xs text-red-600">Tudo já devolvido</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {Object.keys(selected).length > 0 && (
              <div className="bg-white rounded-2xl shadow-md p-5">
                <h3 className="font-bold text-rose-900 mb-3">Modo de devolução</h3>
                <div className="grid grid-cols-3 gap-2 mb-4">
                  <ModoBtn
                    active={modo === 'dinheiro'}
                    onClick={() => setModo('dinheiro')}
                    icon={<Banknote size={20} />}
                    title="Dinheiro"
                    sub="Sangria caixa"
                  />
                  <ModoBtn
                    active={modo === 'troca'}
                    onClick={() => setModo('troca')}
                    icon={<ArrowRightLeft size={20} />}
                    title="Troca"
                    sub="Hoje mesmo"
                  />
                  <ModoBtn
                    active={modo === 'credito'}
                    onClick={() => setModo('credito')}
                    icon={<CreditCard size={20} />}
                    title="Vale"
                    sub="Usar depois"
                  />
                </div>

                {modo === 'credito' && (
                  <div className="mb-4">
                    <label className="block text-sm font-semibold text-gray-700 mb-1">
                      Validade do vale-troca (dias)
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

                <label className="block text-sm font-semibold text-gray-700 mb-1">
                  Motivo (opcional)
                </label>
                <textarea
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  rows={2}
                  placeholder="Defeito, tamanho, arrependimento..."
                  className="w-full p-3 border rounded-lg mb-4"
                />

                <div className="bg-rose-50 rounded-lg p-4 mb-4 text-center">
                  <div className="text-sm text-rose-700">Valor da devolução</div>
                  <div className="text-3xl font-bold text-rose-900">
                    R$ {fmt(totalDevolucao)}
                  </div>
                </div>

                {err && <div className="mb-3 text-sm text-red-600">{err}</div>}

                <button
                  onClick={confirm}
                  disabled={busy || !Object.keys(selected).length}
                  className="w-full py-4 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-lg disabled:opacity-50"
                >
                  {busy ? 'Processando…' : 'Confirmar Devolução'}
                </button>
              </div>
            )}
          </div>
        )}

        {success && (
          <div className="bg-white rounded-2xl shadow-md p-8 text-center">
            <div className="w-20 h-20 mx-auto bg-emerald-100 rounded-full flex items-center justify-center mb-4">
              <Check size={36} className="text-emerald-600" />
            </div>
            <h2 className="text-2xl font-bold text-rose-900 mb-2">Devolução registrada</h2>
            <div className="text-gray-600 mb-4">
              R$ {fmt(success.valorTotal)} em {success.modo}
            </div>

            {success.modo === 'dinheiro' && (
              <div className="bg-amber-50 rounded-lg p-4 mb-4 text-amber-800">
                <strong>Sangria automática</strong> registrada no caixa.
                <br />
                Entregue R$ {fmt(success.valorTotal)} em dinheiro pra cliente.
              </div>
            )}
            {(success.modo === 'troca' || success.modo === 'credito') && (
              <div className="bg-emerald-50 rounded-lg p-4 mb-4 text-emerald-800">
                <div className="text-sm mb-1">Vale-troca gerado:</div>
                <div className="text-2xl font-mono font-bold tracking-widest">
                  {success.creditoCode}
                </div>
                <div className="text-sm mt-1">
                  Válido até{' '}
                  {success.creditoValidade
                    ? new Date(success.creditoValidade).toLocaleDateString('pt-BR')
                    : '—'}
                </div>
              </div>
            )}

            {success.items?.some((it: any) => it.stockError) && (
              <div className="bg-red-50 rounded-lg p-3 mb-4 text-red-800 text-sm">
                ⚠️ Atenção: estoque Giga não foi estornado em uma ou mais peças.
                <br />
                Faça a entrada manual no Gigasistemas.
              </div>
            )}

            <button
              onClick={reset}
              className="w-full py-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold"
            >
              Nova Devolução
            </button>
          </div>
        )}
      </div>
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
      className={`p-3 rounded-xl text-center transition-all ${
        active
          ? 'bg-rose-600 text-white shadow-lg scale-105'
          : 'bg-rose-50 hover:bg-rose-100 text-rose-900'
      }`}
    >
      <div className="flex justify-center mb-1">{icon}</div>
      <div className="font-bold">{title}</div>
      <div className={`text-xs ${active ? 'text-rose-100' : 'text-gray-500'}`}>{sub}</div>
    </button>
  );
}
