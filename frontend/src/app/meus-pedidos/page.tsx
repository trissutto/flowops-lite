'use client';

/**
 * /meus-pedidos — página PÚBLICA (sem login) de acompanhamento de pedidos.
 *
 * A cliente entra com CELULAR + CPF e vê todos os pedidos dela (site e live)
 * com linha do tempo Pago → Em separação → Postado → Entregue, rastreio dos
 * Correios ao vivo (botão por pedido) e atalho pro Portal de Trocas quando
 * o pedido já chegou.
 *
 * Mesmo padrão visual do /trocas e /cadastro-live (Tailwind, mobile-first).
 */

import { useState } from 'react';
import { api } from '@/lib/api';

type PedidoItem = { nome: string; qtd: number };
type Pedido = {
  id: string;
  numero: string;
  origem: 'Live' | 'Site';
  data: string | null;
  total: number | null;
  etapa: number; // -1 cancelado · 0 confirmado · 1 separação · 2 postado/pronto · 3 entregue
  statusLabel: string;
  isPickup: boolean;
  pickupStoreCode: string | null;
  shippingMethod: string | null;
  trackingCode: string | null;
  carrier: string;
  items: PedidoItem[];
};

type LookupRes = { ok: boolean; nome: string | null; pedidos: Pedido[] };

type RastreioRes = {
  ok: boolean;
  code: string;
  delivered: boolean;
  lastStatus: string | null;
  events: Array<{ date: string; time: string; location: string; description: string; isDelivery: boolean }>;
  error: string | null;
};

const ETAPAS = ['Confirmado', 'Em separação', 'Postado', 'Entregue'];

function brl(v: number | null): string {
  return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtData(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
}

function maskPhone(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function maskCpf(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function parseErr(e: any): string {
  const raw = String(e?.message || '');
  const i = raw.indexOf(': ');
  const tail = i >= 0 ? raw.slice(i + 2) : raw;
  try {
    const j = JSON.parse(tail);
    if (j?.message) return Array.isArray(j.message) ? j.message[0] : j.message;
  } catch { /* texto puro */ }
  return 'Não consegui consultar agora. Confira os dados e tente de novo.';
}

const inputCls =
  'w-full box-border px-3.5 py-3.5 text-base rounded-xl bg-[#FCFBF7] text-[#2A2620] ' +
  'border-[1.5px] border-[#E4DDCB] outline-none transition-colors ' +
  'focus:border-[#B8912B] focus:ring-2 focus:ring-[#EBD9A6]';
const btnCls =
  'w-full py-3.5 rounded-xl font-bold text-white text-base bg-[#B8912B] hover:bg-[#8C7325] ' +
  'transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const cardCls = 'bg-white rounded-2xl border border-[#EDE7D8] shadow-sm p-5';

export default function MeusPedidosPage() {
  const [celular, setCelular] = useState('');
  const [cpf, setCpf] = useState('');
  const [data, setData] = useState<LookupRes | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Rastreio expandido por pedido
  const [rastreio, setRastreio] = useState<Record<string, RastreioRes | 'loading'>>({});

  async function consultar(e?: React.FormEvent) {
    e?.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const res = await api<LookupRes>('/public/meus-pedidos', {
        method: 'POST',
        body: JSON.stringify({ celular, cpf }),
      });
      setData(res);
      setRastreio({});
    } catch (e: any) {
      setErr(parseErr(e));
    } finally {
      setLoading(false);
    }
  }

  async function verRastreio(p: Pedido) {
    if (rastreio[p.id] && rastreio[p.id] !== 'loading') {
      // já carregado → recolhe
      setRastreio((m) => {
        const { [p.id]: _out, ...rest } = m;
        return rest;
      });
      return;
    }
    setRastreio((m) => ({ ...m, [p.id]: 'loading' }));
    try {
      const res = await api<RastreioRes>('/public/meus-pedidos/rastreio', {
        method: 'POST',
        body: JSON.stringify({ celular, cpf, orderId: p.id }),
      });
      setRastreio((m) => ({ ...m, [p.id]: res }));
    } catch (e: any) {
      setErr(parseErr(e));
      setRastreio((m) => {
        const { [p.id]: _out, ...rest } = m;
        return rest;
      });
    }
  }

  return (
    <div className="min-h-screen bg-[#FAFAF7] px-4 py-8">
      <div className="max-w-lg mx-auto">
        <div className="text-center mb-6">
          <div className="text-2xl font-extrabold text-[#8C7325]">Lurd&apos;s Plus Size</div>
          <h1 className="text-lg font-bold text-[#2A2620] mt-1">Meus Pedidos</h1>
          <p className="text-sm text-[#6B6456] mt-1">
            Acompanhe suas compras do site e das lives 💛
          </p>
        </div>

        {err && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-[#FDECEC] border border-[#E9B4B4] text-[#8C2B2B] text-sm">
            {err}
          </div>
        )}

        {!data && (
          <form onSubmit={consultar} className={cardCls}>
            <label className="block mb-3.5">
              <span className="block text-[13px] font-bold text-[#6B6456] mb-1.5">
                Celular (com DDD)
              </span>
              <input
                className={inputCls}
                inputMode="tel"
                placeholder="(13) 99999-9999"
                value={celular}
                onChange={(e) => setCelular(maskPhone(e.target.value))}
                required
              />
            </label>
            <label className="block mb-5">
              <span className="block text-[13px] font-bold text-[#6B6456] mb-1.5">CPF</span>
              <input
                className={inputCls}
                inputMode="numeric"
                placeholder="000.000.000-00"
                value={cpf}
                onChange={(e) => setCpf(maskCpf(e.target.value))}
                required
              />
            </label>
            <button type="submit" className={btnCls} disabled={loading}>
              {loading ? 'Consultando…' : 'Ver meus pedidos'}
            </button>
          </form>
        )}

        {data && (
          <div className="space-y-4">
            <div className="text-center text-sm text-[#6B6456]">
              {data.nome ? <>Olá, <b className="text-[#2A2620]">{data.nome}</b>! 💛 </> : null}
              {data.pedidos.length} pedido{data.pedidos.length !== 1 ? 's' : ''} encontrado{data.pedidos.length !== 1 ? 's' : ''}.
            </div>

            {data.pedidos.map((p) => {
              const r = rastreio[p.id];
              return (
                <div key={p.id} className={cardCls}>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-extrabold text-[#8C7325]">#{p.numero}</span>
                      <span className="ml-2 text-[11px] font-bold px-2 py-0.5 rounded-full bg-[#FBF6E6] text-[#8C7325]">
                        {p.origem}
                      </span>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold text-[#2E7D46]">{brl(p.total)}</div>
                      <div className="text-[11px] text-[#6B6456]">{fmtData(p.data)}</div>
                    </div>
                  </div>

                  {/* Linha do tempo */}
                  {p.etapa >= 0 ? (
                    <div className="mt-3">
                      <div className="flex items-center">
                        {ETAPAS.map((et, i) => (
                          <div key={et} className="flex items-center flex-1 last:flex-none">
                            <div
                              className={
                                'w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ' +
                                (i <= p.etapa
                                  ? 'bg-[#2E7D46] text-white'
                                  : 'bg-[#EDE7D8] text-[#A79F8E]')
                              }
                            >
                              {i < p.etapa ? '✓' : i === p.etapa ? '●' : i + 1}
                            </div>
                            {i < ETAPAS.length - 1 && (
                              <div
                                className={
                                  'h-1 flex-1 mx-1 rounded ' +
                                  (i < p.etapa ? 'bg-[#2E7D46]' : 'bg-[#EDE7D8]')
                                }
                              />
                            )}
                          </div>
                        ))}
                      </div>
                      <div className="flex justify-between mt-1">
                        {ETAPAS.map((et, i) => (
                          <span
                            key={et}
                            className={
                              'text-[10px] ' +
                              (i === p.etapa ? 'font-bold text-[#2E7D46]' : 'text-[#A79F8E]')
                            }
                          >
                            {i === 2 && p.isPickup ? 'Pronto' : et}
                          </span>
                        ))}
                      </div>
                      <div className="mt-2 text-sm font-bold text-[#2A2620]">
                        {p.isPickup && p.etapa === 2
                          ? `Pronto pra retirada${p.pickupStoreCode ? ` na loja ${p.pickupStoreCode}` : ''}!`
                          : p.statusLabel}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 text-sm font-bold text-[#8C2B2B]">Pedido cancelado</div>
                  )}

                  {/* Itens */}
                  <div className="mt-2 text-[13px] text-[#6B6456]">
                    {p.items.map((it) => `${it.qtd}× ${it.nome}`).join(' · ')}
                  </div>

                  {/* Rastreio */}
                  {p.trackingCode && (
                    <div className="mt-3">
                      <button
                        className="w-full py-2.5 rounded-lg text-[13px] font-bold border border-[#B8912B] text-[#8C7325] hover:bg-[#FBF6E6]"
                        onClick={() => verRastreio(p)}
                      >
                        {r === 'loading'
                          ? 'Consultando rastreio…'
                          : r
                            ? 'Esconder rastreio'
                            : `📦 Ver rastreio (${p.trackingCode})`}
                      </button>
                      {r && r !== 'loading' && (
                        <div className="mt-2 bg-[#FCFBF7] border border-[#EDE7D8] rounded-xl p-3">
                          {r.error && (
                            <div className="text-[13px] text-[#8C2B2B]">
                              Não consegui consultar agora ({r.error}). Acompanhe direto nos{' '}
                              <a
                                className="underline font-bold"
                                href={`https://rastreamento.correios.com.br/app/index.php?objetos=${encodeURIComponent(p.trackingCode)}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Correios
                              </a>.
                            </div>
                          )}
                          {!r.error && (
                            <>
                              {r.lastStatus && (
                                <div className="text-[13px] font-bold text-[#2A2620] mb-1.5">
                                  {r.delivered ? '✅ ' : '🚚 '}
                                  {r.lastStatus}
                                </div>
                              )}
                              <ul className="space-y-1">
                                {r.events.map((ev, i) => (
                                  <li key={i} className="text-[12px] text-[#6B6456] flex gap-1.5">
                                    <span className="text-[#B8912B]">•</span>
                                    <span>
                                      <b>{ev.date} {ev.time}</b> — {ev.description}
                                      {ev.location ? ` (${ev.location})` : ''}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Entregue → portal de trocas */}
                  {p.etapa === 3 && (
                    <a
                      href="/trocas"
                      className="mt-3 block text-center py-2.5 rounded-lg text-[13px] font-bold bg-[#FBF6E6] text-[#8C7325] border border-[#EBD9A6]"
                    >
                      Precisa trocar? Portal de Trocas →
                    </a>
                  )}
                </div>
              );
            })}

            <button
              className="w-full text-center text-sm text-[#6B6456] underline"
              onClick={() => { setData(null); setRastreio({}); }}
            >
              Consultar outro CPF
            </button>
          </div>
        )}

        <p className="text-center text-[11px] text-[#A79F8E] mt-6">
          Dúvidas? WhatsApp (13) 99625-6238 · Lurd&apos;s Plus Size
        </p>
      </div>
    </div>
  );
}
