'use client';

/**
 * /retaguarda/campanhas — Vendas por CAMPANHA (De/Até).
 *
 * Cruza os pedidos do site com a campanha de origem (utmCampaign capturada do
 * Order Attribution do WooCommerce no sync). Mostra receita REAL do site por
 * campanha — não o número modelado do Gerenciador de Anúncios.
 *
 * Fonte: GET /orders/report/campanhas?from=YYYY-MM-DD&to=YYYY-MM-DD.
 *
 * IMPORTANTE: só reflete o que foi capturado a partir de quando as campanhas do
 * Meta passaram a mandar UTM na URL (Parâmetros de URL com {{campaign.name}}).
 * NÃO é retroativo. Pedidos sem UTM caem em "Sem campanha / Direto".
 *
 * PEDIDO = PAGO (24/08). Antes a tela dizia "não cancelados" e contava cartão
 * RECUSADO e PIX/link nunca pago como receita — 24,7% do total do site novo em
 * 30 dias. Agora só entra o que tem prova de pagamento, e o descartado aparece
 * na coluna "Não pagos" pra o buraco ser visível em vez de sumir.
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Megaphone, Calendar, Download, Loader2, TrendingUp, ShoppingBag, DollarSign, AlertTriangle } from 'lucide-react';

interface CampanhaRow {
  campanha: string;
  source: string | null;
  medium: string | null;
  pedidos: number;
  receita: number;
  cancelados: number;
  /** Cartão recusado / PIX vencido / link não aberto — nunca virou dinheiro. */
  naoPagos: number;
  naoPagosReceita: number;
  /** % do grupo que veio da origem exibida (o resto é mistura). */
  origemPct: number;
  origensDistintas: number;
  comUtm: boolean;
  ticketMedio: number;
}
interface CampanhasReport {
  from: string;
  to: string;
  totalPedidos: number;
  totalReceita: number;
  totalNaoPagos: number;
  totalNaoPagosReceita: number;
  totalCancelados: number;
  ticketMedioGeral: number;
  campanhas: CampanhaRow[];
}

function fmtMoney(v: number) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtInt(v: number) {
  return v.toLocaleString('pt-BR');
}
function todayIso() {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

export default function CampanhasPage() {
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [data, setData] = useState<CampanhasReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) window.location.href = '/login';
  }, []);

  async function carregar(e?: React.FormEvent) {
    e?.preventDefault();
    if (!from || !to) {
      setError('Escolhe o período (de / até) antes de gerar.');
      return;
    }
    if (from > to) {
      setError('Data inicial não pode ser maior que a final.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ from, to });
      const res = await api<CampanhasReport>(`/orders/report/campanhas?${q}`);
      setData(res);
    } catch (e: any) {
      setError(e?.message ?? 'Falha ao carregar');
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  function setAtalho(dias: number) {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - (dias - 1));
    const fmt = (d: Date) => {
      const o = d.getTimezoneOffset() * 60000;
      return new Date(d.getTime() - o).toISOString().slice(0, 10);
    };
    setFrom(fmt(start));
    setTo(fmt(end));
  }

  function setMesAtual() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const fmt = (d: Date) => {
      const o = d.getTimezoneOffset() * 60000;
      return new Date(d.getTime() - o).toISOString().slice(0, 10);
    };
    setFrom(fmt(start));
    setTo(fmt(now));
  }

  function exportCSV() {
    if (!data) return;
    const lines: string[] = [];
    lines.push(`Vendas por campanha — ${data.from} até ${data.to}`);
    lines.push('');
    lines.push('Campanha;Origem;Meio;Pedidos pagos;Receita paga;Ticket medio;Nao pagos;Valor nao pago;Cancelados');
    for (const c of data.campanhas) {
      lines.push([
        c.campanha,
        c.source ?? '',
        c.medium ?? '',
        c.pedidos,
        c.receita.toFixed(2).replace('.', ','),
        c.ticketMedio.toFixed(2).replace('.', ','),
        c.naoPagos,
        c.naoPagosReceita.toFixed(2).replace('.', ','),
        c.cancelados,
      ].join(';'));
    }
    lines.push('');
    lines.push(`TOTAL;;;${data.totalPedidos};${data.totalReceita.toFixed(2).replace('.', ',')};${data.ticketMedioGeral.toFixed(2).replace('.', ',')};${data.totalNaoPagos};${data.totalNaoPagosReceita.toFixed(2).replace('.', ',')};${data.totalCancelados}`);
    const csv = lines.join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `campanhas_${data.from}_a_${data.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const maxReceita = data ? Math.max(...data.campanhas.map((c) => c.receita), 1) : 1;

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Megaphone className="w-6 h-6" /> Vendas por campanha
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Receita REAL do site por campanha de origem — não o número modelado do Gerenciador de Anúncios.
        </p>
      </div>

      {/* Aviso: depende do UTM no Meta + não retroativo */}
      <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
        <b>Como funciona:</b> cada pedido guarda a campanha que gerou o clique, lida do
        Order Attribution do WooCommerce. Pra vir o nome exato, as campanhas do Meta precisam
        mandar <span className="font-mono">utm_campaign=&#123;&#123;campaign.name&#125;&#125;</span> nos
        <b> Parâmetros de URL</b>. Pedidos sem UTM aparecem como <b>&ldquo;Sem campanha / Direto&rdquo;</b>.
        Não é retroativo — só vale a partir de quando o UTM foi configurado.
      </div>

      {/* Seletor de período */}
      <form
        onSubmit={carregar}
        className="bg-white rounded-lg shadow border p-4 mb-6 flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="block text-xs text-slate-500 mb-1">De</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            max={todayIso()}
            className="px-3 py-2 border rounded text-sm"
            required
          />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Até</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            max={todayIso()}
            className="px-3 py-2 border rounded text-sm"
            required
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          <button type="button" onClick={() => setAtalho(1)} className="px-3 py-2 text-xs text-slate-600 border rounded hover:bg-slate-50">Hoje</button>
          <button type="button" onClick={() => setAtalho(2)} className="px-3 py-2 text-xs text-slate-600 border rounded hover:bg-slate-50">Ontem+Hoje</button>
          <button type="button" onClick={() => setAtalho(7)} className="px-3 py-2 text-xs text-slate-600 border rounded hover:bg-slate-50">7 dias</button>
          <button type="button" onClick={setMesAtual} className="px-3 py-2 text-xs text-slate-600 border rounded hover:bg-slate-50">Mês</button>
        </div>
        <button
          type="submit"
          disabled={loading || !from || !to}
          className="px-4 py-2 bg-brand text-white rounded hover:bg-brand-dark text-sm font-semibold disabled:opacity-50 flex items-center gap-2"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calendar className="w-4 h-4" />}
          Gerar
        </button>
        {data && (
          <button
            type="button"
            onClick={exportCSV}
            className="px-3 py-2 bg-white border rounded text-sm hover:bg-slate-50 flex items-center gap-2 ml-auto"
          >
            <Download className="w-4 h-4" /> CSV
          </button>
        )}
      </form>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
      )}

      {data && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="bg-white rounded-lg shadow border p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs"><ShoppingBag className="w-4 h-4" /> Pedidos PAGOS</div>
              <div className="text-2xl font-bold mt-1">{fmtInt(data.totalPedidos)}</div>
            </div>
            <div className="bg-white rounded-lg shadow border p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs"><DollarSign className="w-4 h-4" /> Receita recebida</div>
              <div className="text-2xl font-bold mt-1 text-emerald-700">{fmtMoney(data.totalReceita)}</div>
              <div className="text-[11px] text-slate-400 mt-1">com frete, como a cliente pagou</div>
            </div>
            <div className="bg-white rounded-lg shadow border p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs"><TrendingUp className="w-4 h-4" /> Ticket médio</div>
              <div className="text-2xl font-bold mt-1">{fmtMoney(data.ticketMedioGeral)}</div>
            </div>
            {/* O que a tela DESCARTOU. Fica visível de propósito: era isso que
                antes entrava como receita e fazia o número não bater com a
                percepção de quem acompanha os pedidos todo dia. */}
            <div className={`rounded-lg shadow border p-4 ${data.totalNaoPagos > 0 ? 'bg-amber-50 border-amber-300' : 'bg-white'}`}>
              <div className="flex items-center gap-2 text-slate-500 text-xs">
                <AlertTriangle className={`w-4 h-4 ${data.totalNaoPagos > 0 ? 'text-amber-600' : ''}`} /> Não pagos (fora do total)
              </div>
              <div className={`text-2xl font-bold mt-1 ${data.totalNaoPagos > 0 ? 'text-amber-700' : 'text-slate-400'}`}>
                {fmtInt(data.totalNaoPagos)}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                {data.totalNaoPagos > 0
                  ? `${fmtMoney(data.totalNaoPagosReceita)} — cartão recusado, PIX vencido ou link não aberto`
                  : 'nenhuma tentativa de pagamento perdida'}
                {data.totalCancelados > 0 ? ` · ${fmtInt(data.totalCancelados)} cancelado(s)` : ''}
              </div>
            </div>
          </div>

          {/* Tabela por campanha */}
          <div className="bg-white rounded-lg shadow border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 text-slate-600 text-xs uppercase">
                    <th className="text-left px-4 py-2">Campanha</th>
                    <th className="text-left px-4 py-2">Origem</th>
                    <th className="text-right px-4 py-2">Pedidos pagos</th>
                    <th className="text-right px-4 py-2">Receita</th>
                    <th className="text-right px-4 py-2">Ticket médio</th>
                    <th className="text-right px-4 py-2">Não pagos</th>
                    <th className="text-right px-4 py-2">Cancelados</th>
                  </tr>
                </thead>
                <tbody>
                  {data.campanhas.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-400">Nenhum pedido no período.</td></tr>
                  )}
                  {data.campanhas.map((c) => (
                    <tr key={c.campanha} className="border-t hover:bg-slate-50">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          {c.comUtm ? (
                            <span className="inline-flex items-center gap-1 text-violet-700 font-semibold">
                              <Megaphone className="w-3.5 h-3.5" /> {c.campanha}
                            </span>
                          ) : (
                            <span className="text-slate-500">{c.campanha}</span>
                          )}
                        </div>
                        {/* Barra proporcional à receita */}
                        <div className="mt-1 h-1.5 bg-slate-100 rounded overflow-hidden">
                          <div
                            className="h-full bg-violet-400"
                            style={{ width: `${Math.max(2, (c.receita / maxReceita) * 100)}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-2 text-slate-500 text-xs">
                        {c.source ? `${c.source}${c.medium ? ` / ${c.medium}` : ''}` : '—'}
                        {/* O balde "Direto" junta origens diferentes. Sem este
                            aviso a linha parece dizer que TODOS vieram dali. */}
                        {c.origensDistintas > 1 && (
                          <div className="text-[11px] text-slate-400">
                            {c.origemPct}% · +{c.origensDistintas - 1} outra{c.origensDistintas > 2 ? 's' : ''}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right font-medium">{fmtInt(c.pedidos)}</td>
                      <td className="px-4 py-2 text-right font-semibold text-emerald-700">{fmtMoney(c.receita)}</td>
                      <td className="px-4 py-2 text-right">{fmtMoney(c.ticketMedio)}</td>
                      <td className="px-4 py-2 text-right">
                        {c.naoPagos > 0 ? (
                          <span className="text-amber-700" title={`${fmtMoney(c.naoPagosReceita)} tentados e não pagos`}>
                            {fmtInt(c.naoPagos)}
                            <span className="block text-[11px] text-amber-600/80">{fmtMoney(c.naoPagosReceita)}</span>
                          </span>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-400">{c.cancelados > 0 ? fmtInt(c.cancelados) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                {data.campanhas.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 bg-slate-50 font-bold">
                      <td className="px-4 py-2">TOTAL</td>
                      <td className="px-4 py-2"></td>
                      <td className="px-4 py-2 text-right">{fmtInt(data.totalPedidos)}</td>
                      <td className="px-4 py-2 text-right text-emerald-700">{fmtMoney(data.totalReceita)}</td>
                      <td className="px-4 py-2 text-right">{fmtMoney(data.ticketMedioGeral)}</td>
                      <td className="px-4 py-2 text-right text-amber-700">
                        {data.totalNaoPagos > 0 ? fmtInt(data.totalNaoPagos) : '—'}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-400">
                        {data.totalCancelados > 0 ? fmtInt(data.totalCancelados) : '—'}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
